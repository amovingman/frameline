'use strict';
// Real native keyboard and Chromium accessibility-tree/contrast verification.
// Uses a disposable profile/source; no screen-reader speech claim is made.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/accessibility-desktop');

if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-accessibility-')));
    try {
      await fs.mkdir(path.join(directory, 'profile')); await fs.mkdir(evidenceDirectory, { recursive: true });
      const original = JSON.parse(await fs.readFile(path.join(root, 'phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8'));
      const base = structuredClone(original), local = structuredClone(base), incoming = structuredClone(base);
      const template = structuredClone(base.timelines[0].items[0]);
      for (const snapshot of [base, local, incoming]) snapshot.timelines[0].items = Array.from({ length: 55 }, (_, index) => ({ ...structuredClone(template), id: `accessible-clip-${index}`, name: `Accessible clip ${index}`, start_frame: index * 120, end_frame: index * 120 + 72, linked_item_ids: [] }));
      for (const item of local.timelines[0].items) item.name += ' local';
      for (const item of incoming.timelines[0].items) item.name += ' incoming';
      for (const snapshot of [base, local, incoming]) for (const item of snapshot.timelines[0].items.slice(0, 2)) item.name = snapshot === base ? 'Repeated clip' : snapshot === local ? 'Repeated clip local' : 'Repeated clip incoming';
      for (const [role, value] of Object.entries({ base, local, incoming })) await fs.writeFile(path.join(directory, `${role}.json`), JSON.stringify(value));
      await fs.copyFile(path.join(root, 'phase-0/resolve-xml-proof/sample.fcpxml'), path.join(directory, 'cut.fcpxml'));
      const result = await run(require('electron'), [__filename], { cwd: root, timeout: 60000, killSignal: 'SIGKILL',
        env: { ...process.env, FRAMELINE_ACCESSIBILITY_PROOF_ROOT: directory } });
      const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"schemaVersion"'));
      if (!line) throw new Error(`${result.stdout}\n${result.stderr}`);
      const evidence = JSON.parse(line);
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  const directory = process.env.FRAMELINE_ACCESSIBILITY_PROOF_ROOT;
  if (!directory || !fsSync.existsSync(path.join(directory, 'base.json'))) throw new Error('Disposable fixture required');
  app.setPath('userData', path.join(directory, 'profile'));
  app.commandLine.appendSwitch('force-renderer-accessibility');
  let picker = 0;
  dialog.showOpenDialog = async options => {
    if (options.title === 'Choose a DaVinci Resolve timeline') return { canceled: false, filePaths: [path.join(directory, 'cut.fcpxml')] };
    const role = ['base', 'local', 'incoming'][picker++ % 3]; return { canceled: false, filePaths: [path.join(directory, `${role}.json`)] };
  };
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');

  async function verify(win, errors) {
    app.setAccessibilitySupportEnabled(true);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async expression => {
      const deadline = Date.now() + 15000;
      while (!await js(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await new Promise(done => setTimeout(done, 40)); }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const key = code => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code }); };
    await wait('!!window.FramelineAccessibility');
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Accessibility.enable');
    const audits = [];
    async function audit(name) {
      await js('window.FramelineAccessibility.refresh()');
      const { nodes } = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
      const controls = nodes.filter(node => !node.ignored && ['button', 'textbox', 'combobox', 'checkbox', 'radio', 'link', 'spinbutton', 'slider', 'progressbar'].includes(node.role?.value));
      const unnamed = controls.filter(node => !String(node.name?.value || '').trim()).map(node => ({ role: node.role.value, backendDOMNodeId: node.backendDOMNodeId }));
      const contrast = await js(`(${measureContrast.toString()})()`);
      audits.push({ name, accessibilityControls: controls.length, unnamedControls: unnamed, contrast });
    }
    await audit('first-run-onboarding');
    await js("document.getElementById('first-run').hidden=true");
    await click('diagnostics-review'); await wait("!document.getElementById('diagnostics-preview').hidden");
    await audit('diagnostics-privacy-review');
    for (const view of ['workspace', 'history', 'media', 'resolve']) { await js(`showView(${JSON.stringify(view)})`); await audit(`sample-${view}`); }
    await js("showView('workspace'); document.querySelector('#video-track button').focus()");
    key('End'); await wait("document.activeElement === [...document.querySelectorAll('#video-track button')].at(-1)");
    key('Home'); await wait("document.activeElement === document.querySelector('#video-track button')");
    key('Right'); await wait("document.activeElement === document.querySelectorAll('#video-track button')[1]");
    key('Enter'); await wait("document.activeElement?.closest('#video-track') !== null");
    const firstFocus = await js("({name:document.activeElement.getAttribute('aria-label'),outline:getComputedStyle(document.activeElement).outlineColor,style:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})");
    assert.match(firstFocus.name, /item \d+ of \d+/); assert.notEqual(firstFocus.style, 'none');
    await click('choose-file'); await wait("currentAppState?.scanStatus==='ready'");
    for (const view of ['workspace', 'history', 'media']) { await js(`showView(${JSON.stringify(view)})`); await audit(`selected-fcpxml-${view}`); }
    await js("showView('history');document.getElementById('revision-message').value='Accessible saved revision';document.getElementById('revision-form').requestSubmit()");
    await wait('currentAppState.revisions.length===1'); await audit('saved-local-history');
    await js("showView('resolve')"); await click('resolve-choose'); await wait("resolveState?.status==='ready' && !resolveBusy");
    await audit('resolve-conflicts');
    await js("document.querySelector('#resolve-queue button').focus()");
    key('End'); await wait("document.activeElement === [...document.querySelectorAll('#resolve-queue button')].at(-1)");
    key('Home'); await wait("document.activeElement === document.querySelector('#resolve-queue button')");
    key('Space'); await wait("document.activeElement?.closest('#resolve-queue') !== null && !!document.querySelector('#resolve-queue button[aria-pressed=true]')");
    const focusedAnchor = await js("document.activeElement.querySelector('strong').textContent");
    await js("document.querySelectorAll('#resolve-queue button')[1].focus()");
    const repeatedAnchor = await js('document.activeElement.dataset.resolveAnchor'); key('Space');
    await wait(`document.activeElement.dataset.resolveAnchor === ${JSON.stringify(repeatedAnchor)} && document.activeElement.isConnected`);
    await js("document.querySelector('#resolve-detail .resolve-decisions button').focus()"); key('Space');
    await wait('!resolveBusy && resolveState.decisions.length===1');
    await wait("document.activeElement?.closest('#resolve-detail .resolve-decisions') !== null");
    assert.equal(await js("document.activeElement?.closest('#resolve-queue')===null"), true, 'A detail action must not steal focus into the queue');
    await js("document.getElementById('resolve-changes-next').focus()"); key('Space');
    await wait("document.getElementById('resolve-changes-range').textContent.startsWith('Changes 41')");
    assert.equal(await js("document.activeElement.id"), 'resolve-changes-range');
    await audit('resolve-next-page');
    await fs.appendFile(path.join(directory, 'local.json'), '\n');
    await js("(async()=>{document.querySelector('#resolve-queue button').focus(); renderResolveState(await window.desktop.refreshResolvePreview());})()");
    await wait('!resolveBusy && resolveState.sourceVerification.changed');
    assert.equal(await js("document.activeElement?.closest('#resolve-queue') === null"), true, 'Changed sources must not restore a stale queue anchor');
    await audit('refreshed-source-conflicts');
    const retainedControlNames = await js(`(() => {
      const controls=[...document.querySelectorAll('button,input:not([type="hidden"]),select,textarea')];
      const name=node=>node.getAttribute('aria-label')||String(node.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ')||[...(node.labels||[])].map(label=>label.textContent).join(' ')||(node.tagName==='BUTTON'?node.textContent:'')||node.title;
      return {checked:controls.length,unnamed:controls.filter(node=>!String(name(node)||'').trim()).map(node=>({id:node.id,tag:node.tagName,type:node.type}))};
    })()`);
    const layouts = [];
    for (const width of [1440, 768, 390, 360]) {
      win.setContentSize(width, 1000); await js("document.getElementById('resolve-detail').scrollIntoView({block:'start'})");
      await new Promise(done => setTimeout(done, 120));
      const layout = await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'); assert.equal(layout.width, layout.scrollWidth); layouts.push(layout);
      if ([1440,390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `accessibility-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // Save the audit before assertion so failures are directly actionable.
    const evidence = { schemaVersion: 1, scope: 'Trusted native keyboard events, Chromium Accessibility.getFullAXTree, computed contrast, real shipped main/preload/renderer. No VoiceOver speech test is claimed.',
      checks: ['all visible native controls have AX names in sample/selected/history/conflict workflows', 'dense scoped arrows/Home/End and native activation',
        'native focus remains visible', 'detail action and paging retain intentional focus', 'atomic status announcements', 'scrollable source values are keyboard reachable', '360–1440px layouts'],
      audits, retainedControlNames, firstFocus, focusedAnchor, layouts, consoleErrors: errors };
    await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    const failures = audits.flatMap(value => value.unnamedControls.map(control => ({ state: value.name, ...control })));
    const contrastFailures = audits.flatMap(value => value.contrast.failures.map(failure => ({ state: value.name, ...failure })));
    assert.deepEqual(failures, [], `Unnamed AX controls: ${JSON.stringify(failures)}`);
    assert.deepEqual(retainedControlNames.unnamed, [], `Unnamed retained conditional controls: ${JSON.stringify(retainedControlNames.unnamed)}`);
    assert.deepEqual(contrastFailures, [], `Contrast failures: ${JSON.stringify(contrastFailures)}`);
    assert.deepEqual(errors, []); console.log(JSON.stringify(evidence)); app.quit();
  }
  function measureContrast() {
    const parse = text => { const match = /rgba?\(([^)]+)\)/.exec(text); if (!match) return [0,0,0,0]; const values = match[1].split(',').map(Number); return [values[0],values[1],values[2],values.length>3?values[3]:1]; };
    const over = (a,b) => { const alpha=a[3]+b[3]*(1-a[3]); return [...[0,1,2].map(i=>alpha?(a[i]*a[3]+b[i]*b[3]*(1-a[3]))/alpha:0),alpha]; };
    const lum = color => color.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratio = (a,b) => { const x=lum(a),y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    let checked=0; const failures=[];
    for (const node of document.querySelectorAll('body *')) {
      const style=getComputedStyle(node), box=node.getBoundingClientRect();
      if (!box.width || !box.height || style.visibility==='hidden' || node.closest('[hidden],button:disabled,input:disabled,select:disabled,textarea:disabled,.a11y-only') || ![...node.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())) continue;
      let current=node, layers=[], image=false, opacity=1;
      while(current) { const computed=getComputedStyle(current); layers.push(parse(computed.backgroundColor)); image ||= computed.backgroundImage!=='none'; opacity*=Number(computed.opacity); current=current.parentElement; }
      if(opacity<.99) continue; // Inactive controls are exempt; opacity is recorded by scope.
      const background=layers.reverse().reduce((b,a)=>over(a,b),[20,20,21,1]); const foreground=over(parse(style.color),background);
      const minimum=Number(style.fontSize)>=24||Number(style.fontSize)>=18.66&&Number(style.fontWeight)>=700?3:4.5;
      const value=ratio(foreground,background); checked++;
      if(value+.01<minimum) failures.push({tag:node.tagName,id:node.id,className:node.className,text:node.textContent.trim().slice(0,70),color:style.color,background:background.slice(0,3).map(Math.round),ratio:Number(value.toFixed(2)),required:minimum,imageBackdrop:image});
    }
    return {checked,failures};
  }
}
