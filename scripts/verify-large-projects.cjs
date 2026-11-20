'use strict';
// Shipped Electron main/preload/renderer and the production worker scanner.
// Native picker results select disposable, editor-saved/exported corpus bundles.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/large-projects');
const proofRoot = process.env.FRAMELINE_LARGE_PROOF_ROOT;
let corpus = process.env.FRAMELINE_LARGE_PROOF_CORPUS || null;
const cases = [{ name: 'small', count: 50, mediaCount: 50, durationFrames: 2400 }, { name: 'typical', count: 500, mediaCount: 500, durationFrames: 24000 },
  { name: 'large', count: 10000, mediaCount: 1, durationFrames: 120000 }];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const privateFree = value => assert.doesNotMatch(JSON.stringify(value), /\/Users\/|\/private\/|frameline-large-20261119|frameline-large-proof-|sourcePath|selectedPath|exportPath/);

async function canonicalSnapshot(profile) {
  const entries = [];
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name), relative = path.relative(profile, filename);
      if (item.isDirectory()) {
        if (relative === 'revisions') await visit(filename);
        else if (relative.startsWith(`revisions${path.sep}`)) await visit(filename);
      } else if (/^metadata\.json(?:\.bak)?$/.test(relative) || relative.startsWith(`revisions${path.sep}`)) entries.push([relative, sha(await fs.readFile(filename))]);
    }
  }
  await visit(profile); return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-large-proof-')));
    try {
      await fs.mkdir(path.join(directory, 'profile')); await fs.mkdir(evidenceDirectory, { recursive: true });
      const originalBundles = !!corpus;
      const provenance = JSON.parse(await fs.readFile(path.join(evidenceDirectory, 'editor-corpus.json'), 'utf8'));
      if (!corpus) {
        corpus = path.join(directory, 'corpus'); await fs.mkdir(corpus, { mode: 0o700 });
        for (const item of cases) {
          const descriptor = provenance.cases.find(entry => entry.case === item.name);
          const bytes = require('node:zlib').gunzipSync(await fs.readFile(path.join(evidenceDirectory, 'corpus', descriptor.file)));
          assert.equal(sha(bytes), descriptor.editorExportSha256);
          const bundle = path.join(corpus, `${item.name}-editor.fcpxmld`); await fs.mkdir(bundle, { mode: 0o700 });
          await fs.writeFile(path.join(bundle, 'Info.fcpxml'), bytes, { flag: 'wx', mode: 0o600 });
        }
      }
      const exports = [];
      for (const item of cases) {
        const bundle = path.join(corpus, `${item.name}-editor.fcpxmld`), bytes = await fs.readFile(path.join(bundle, 'Info.fcpxml'));
        const descriptor = provenance.cases.find(entry => entry.case === item.name);
        assert.equal(sha(bytes), descriptor.editorExportSha256); assert.equal(bytes.length, descriptor.xmlBytes);
        assert.equal(item.count, descriptor.clips); assert.equal(item.mediaCount, descriptor.referencedAssets); assert.equal(item.durationFrames, descriptor.sequenceFrames);
        exports.push({ ...item, byteLength: bytes.length, sourceHash: sha(bytes) });
      }
      await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify(exports), { mode: 0o600 });
      const result = await run(require('electron'), [__filename], { cwd: root, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, FRAMELINE_LARGE_PROOF_ROOT: directory, FRAMELINE_LARGE_PROOF_CORPUS: corpus } });
      const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"stage"'));
      if (!line) throw new Error('Missing native large-project result');
      assert.ok(!result.stdout.includes(corpus) && !result.stderr.includes(corpus), 'source locations absent from process logs');
      const native = JSON.parse(line);
      for (const item of exports) assert.equal(sha(await fs.readFile(path.join(corpus, `${item.name}-editor.fcpxmld/Info.fcpxml`))), item.sourceHash);
      const evidence = { schemaVersion: 1,
        scope: 'Shipped Electron main/preload/renderer and production worker; native picker results select disposable corpus imported, saved and exported by the installed DaVinci Resolve 21.1.2 build 21.1.20010. Synthetic data establishes bounded handling, not coverage of every real customer timeline.',
        sourceDelivery: originalBundles ? 'Original disposable editor bundles' : 'Untouched compressed XML replayed into owned temporary bundles; embedded media locations were not rewritten or recreated',
        exports, checks: ['exact 50/500/10000 clip counts and 50/500/1 referenced-media counts without truncation', 'actual worker progress and 64-reference media batches',
          'hash-bound cache replay still checks every media reference', 'real cancellation during media checking and XML parsing, followed by rescan',
          'main and renderer heartbeats during uncached large parsing', 'last-row access, original-index jump and full-dataset search',
          'bounded mounted options, keyboard navigation, focus and native accessibility tree', '360–1440px layouts without overflow',
          'original editor exports and canonical revision/history/sync-base bytes unchanged', 'path-free progress and no renderer errors'], native };
      privateFree(evidence); await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  if (!proofRoot || !corpus || !path.isAbsolute(corpus)) throw new Error('Disposable actual-editor corpus required');
  const profile = path.join(proofRoot, 'profile'); app.setPath('userData', profile);
  let selectedCase = 'small';
  dialog.showOpenDialog = async options => {
    assert.equal(options.title, 'Choose a DaVinci Resolve timeline');
    return { canceled: false, filePaths: [path.join(corpus, `${selectedCase}-editor.fcpxmld`)] };
  };
  let mainMonitor = null;
  const heartbeat = setInterval(() => {
    if (!mainMonitor) return;
    const now = performance.now(); mainMonitor.maxGapMs = Math.max(mainMonitor.maxGapMs, now - mainMonitor.last);
    mainMonitor.last = now; mainMonitor.ticks++;
    if (mainMonitor.phase === 'parsing') mainMonitor.parsingTicks++;
  }, 5); heartbeat.unref();
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
      if (channel === 'project:scan-progress' && mainMonitor) {
        mainMonitor.phase = args[0].phase; mainMonitor.events.push({ ...args[0], atMs: performance.now() - mainMonitor.started });
      }
      return send(channel, ...args);
    };
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');

  async function verify(win, errors) {
    app.setAccessibilitySupportEnabled(true);
    win.focus();
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async (expression, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (!await js(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await pause(30); }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const key = async name => {
      const keyCode = { ArrowDown: 'Down', ArrowUp: 'Up' }[name] || name;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(20);
    };
    const paint = async () => { await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(80); };
    await wait("window.desktop?.getProjectScanProgress && document.getElementById('scan-clips-search')");
    await js(`window.__largeProof = {active:false,events:[],last:0,ticks:0,parsingTicks:0,maxGapMs:0,cancel:null,cancelRequested:false};
      setInterval(()=>{const p=window.__largeProof;if(!p.active)return;const now=performance.now();p.maxGapMs=Math.max(p.maxGapMs,now-p.last);p.last=now;p.ticks++;if(p.phase==='parsing')p.parsingTicks++;},5);
      window.desktop.onProjectScanProgress(value=>{const p=window.__largeProof;if(!p.active)return;p.phase=value.phase;p.events.push({...value,atMs:performance.now()-p.started});
        if(p.cancel&&!p.cancelRequested&&value.phase===p.cancel.phase&&(value.checked||0)>=(p.cancel.checked||0)){p.cancelRequested=true;const stop=()=>document.getElementById('cancel-scan').click();if(p.cancel.delay)setTimeout(stop,p.cancel.delay);else stop();}});void 0;`);
    const expected = JSON.parse(await fs.readFile(path.join(proofRoot, 'expected.json'), 'utf8'));
    const scans = [];
    async function scan(item, { rescan = false, cancel = null, label = item.name } = {}) {
      selectedCase = item.name;
      await paint();
      const started = performance.now(); mainMonitor = { started, last: started, maxGapMs: 0, ticks: 0, parsingTicks: 0, phase: null, events: [] };
      await js(`Object.assign(window.__largeProof,{active:true,events:[],started:performance.now(),last:performance.now(),maxGapMs:0,ticks:0,parsingTicks:0,phase:null,cancel:${JSON.stringify(cancel)},cancelRequested:false})`);
      await click(rescan ? 'rescan-project' : 'choose-file');
      const terminal = cancel ? 'cancelled' : 'complete';
      await wait("window.__largeProof.events.some(e=>['complete','cancelled','failed'].includes(e.phase)) && !document.getElementById('choose-file').disabled && ['ready','error'].includes(currentAppState?.scanStatus)", 90000);
      const renderer = await js('(()=>{window.__largeProof.active=false;const {events,ticks,parsingTicks,maxGapMs,cancelRequested}=window.__largeProof;return {events,ticks,parsingTicks,maxGapMs,cancelRequested}})()');
      const main = mainMonitor; mainMonitor = null;
      const state = await js('window.desktop.getAppState()'), progress = await js('window.desktop.getProjectScanProgress()');
      privateFree(renderer.events); privateFree(main.events); privateFree(progress);
      assert.equal(progress.phase, terminal);
      const summary = { label, elapsedMs: Math.round(performance.now() - started), phases: [...new Set(renderer.events.map(event => event.phase))],
        mainHeartbeat: { ticks: main.ticks, parsingTicks: main.parsingTicks, maxGapMs: Math.round(main.maxGapMs) },
        rendererHeartbeat: { ticks: renderer.ticks, parsingTicks: renderer.parsingTicks, maxGapMs: Math.round(renderer.maxGapMs) } };
      if (cancel) {
        assert.equal(renderer.cancelRequested, true); assert.equal(state.error, 'scan-cancelled'); assert.equal(state.scan, null);
        assert.equal(await js("document.querySelectorAll('#video-track [data-scan-index],#media-list [data-scan-index]').length"), 0);
        summary.cancelled = true;
        if (cancel.phase === 'parsing') {
          assert.ok(summary.phases.includes('parsing')); assert.ok(!summary.phases.includes('inventory') && !summary.phases.includes('media'), 'XML parse was terminated before inventory publication');
          summary.parsingCancelledBeforeInventory = true;
        }
      } else {
        assert.equal(state.scan.clips.length, item.count); assert.equal(state.scan.media.length, item.mediaCount); assert.equal(state.scan.sequence.durationFrames, item.durationFrames);
        assert.equal(state.scan.sourceHash, item.sourceHash); assert.equal(progress.checked, item.mediaCount); assert.equal(progress.total, item.mediaCount);
        assert.equal(progress.bytesRead, item.byteLength); assert.equal(progress.totalBytes, item.byteLength);
        const reading = renderer.events.filter(event => event.phase === 'reading'); assert.equal(reading[0].bytesRead, 0);
        assert.equal(reading.at(-1).bytesRead, item.byteLength);
        for (let index = 1; index < reading.length; index++) assert.ok(reading[index].bytesRead > reading[index - 1].bytesRead && reading[index].bytesRead - reading[index - 1].bytesRead <= 256 * 1024);
        const media = renderer.events.filter(event => event.phase === 'media');
        assert.ok(media.length >= Math.ceil(item.mediaCount / 64)); assert.equal(media[0].checked, 0);
        for (let index = 1; index < media.length; index++) assert.equal(media[index].checked - media[index - 1].checked, 64);
        summary.mediaBatches = media.length; summary.checked = progress.checked; summary.cacheHit = progress.cacheHit;
        summary.sourceBytesVerified = progress.bytesRead; summary.readingProgressEvents = reading.length;
        assert.equal(summary.phases.includes('parsing'), !summary.cacheHit, 'only a verified inventory cache skips parsing');
        summary.clips = state.scan.clips.length; summary.media = state.scan.media.length; summary.durationFrames = state.scan.sequence.durationFrames;
        summary.mediaAvailability = Object.fromEntries([...new Set(state.scan.media.map(item => item.availability))].sort().map(availability => [availability, state.scan.media.filter(item => item.availability === availability).length]));
      }
      scans.push(summary); return { state, summary };
    }

    for (const item of expected) {
      const result = await scan(item); assert.equal(result.summary.cacheHit, false);
      await js(`window.desktop.saveRevision(${JSON.stringify(`Editor-exported ${item.name} baseline`)})`);
      assert.equal(await js('currentAppState.scan.clips.length'), item.count);
      assert.equal((await js('window.desktop.getAppState()')).revisions.length, 1);
    }
    const canonicalBefore = await canonicalSnapshot(profile); assert.equal(canonicalBefore.filter(([name]) => name.startsWith('revisions/')).length, 3);
    const large = expected.find(item => item.name === 'large');
    const typical = expected.find(item => item.name === 'typical');
    assert.ok(scans[2].mainHeartbeat.parsingTicks > 0 && scans[2].rendererHeartbeat.parsingTicks > 0, 'both event loops run while actual large XML parsing executes in worker');
    assert.equal((await scan(large, { rescan: true, label: 'large-cache-replay' })).summary.cacheHit, true);
    await scan(typical, { label: 'cancel-typical-media', cancel: { phase: 'media', checked: 0 } });
    await scan(large, { label: 'cancel-large-parsing', cancel: { phase: 'parsing', delay: 20 } });
    const recovered = await scan(large, { rescan: true, label: 'large-after-cancellation' }); assert.equal(recovered.summary.cacheHit, false);
    assert.equal((await scan(large, { rescan: true, label: 'large-cache-after-recovery' })).summary.cacheHit, true);

    const lists = [], layouts = [];
    const lastClip = recovered.state.scan.clips.at(-1);
    async function inspectList(kind, lastName, facts, query = lastName) {
      const viewport = kind === 'clips' ? 'video-track' : 'media-list', view = kind === 'clips' ? 'workspace' : 'media';
      const total = kind === 'clips' ? large.count : typical.mediaCount;
      const selected = () => js(`(()=>{const v=document.getElementById(${JSON.stringify(viewport)}),r=v.querySelector('[aria-selected="true"]');return {index:r?Number(r.dataset.scanIndex):null,position:r?.getAttribute('aria-posinset'),setSize:r?.getAttribute('aria-setsize'),mounted:v.querySelectorAll('[data-scan-index]').length,active:v.getAttribute('aria-activedescendant'),focused:document.activeElement===v,activeExists:!!document.getElementById(v.getAttribute('aria-activedescendant'))}})()`);
      const search = value => js(`(()=>{const i=document.getElementById(${JSON.stringify(`scan-${kind}-search`)});i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      const jump = async number => { await js(`document.getElementById(${JSON.stringify(`scan-${kind}-jump`)}).value=${JSON.stringify(String(number))}`); await click(`scan-${kind}-go`); await paint(); };
      await js(`showView(${JSON.stringify(view)});document.getElementById(${JSON.stringify(viewport)}).focus()`); await paint();
      let maximumMounted = 0;
      const bounded = async () => { const current = await selected(); maximumMounted = Math.max(maximumMounted, current.mounted); assert.ok(current.mounted <= 16); assert.equal(current.activeExists, true); return current; };
      await key('End'); let current = await bounded(); assert.equal(current.index, total - 1); assert.equal(current.focused, true);
      assert.equal(current.position, String(total)); assert.equal(current.setSize, String(total));
      const detail = await js(`document.getElementById(${JSON.stringify(`scan-${kind}-detail`)}).textContent`);
      assert.ok(detail.includes(lastName)); for (const fact of facts) assert.ok(detail.includes(fact), `full ${kind} detail includes ${fact}`);
      await key('Home'); assert.equal((await bounded()).index, 0);
      await key('PageDown'); assert.ok((await bounded()).index > 0);
      await key('PageUp'); assert.equal((await bounded()).index, 0);
      await key('ArrowDown'); assert.equal((await bounded()).index, 1);
      await key('ArrowUp'); assert.equal((await bounded()).index, 0);
      await search(query.toUpperCase()); current = await bounded(); assert.equal(current.index, total - 1);
      assert.equal(current.mounted, 1); assert.equal(current.setSize, '1');
      assert.ok((await js(`document.getElementById(${JSON.stringify(`scan-${kind}-range`)}).textContent`)).includes(`1 matches · ${total.toLocaleString()} total`));
      await search('zz-no-corpus-match-uniquex');
      assert.equal(await js(`document.querySelectorAll('#${viewport} [data-scan-index]').length`), 0);
      assert.equal(await js(`document.getElementById(${JSON.stringify(viewport)}).getAttribute('aria-activedescendant')`), null);
      await jump(total); current = await bounded(); assert.equal(current.index, total - 1); assert.equal(current.focused, true);
      assert.equal(await js(`document.getElementById(${JSON.stringify(`scan-${kind}-search`)}).value`), '');
      await js(`document.getElementById(${JSON.stringify(viewport)}).scrollTop=${Math.floor(total / 2)}*112`); await paint();
      current = await bounded(); assert.equal(current.index, total - 1); assert.equal(current.focused, true);
      await key('End'); await paint();
      win.webContents.debugger.attach('1.3');
      const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree'); win.webContents.debugger.detach();
      assert.ok(tree.nodes.some(node => node.role?.value === 'listbox'), `Native AX roles: ${[...new Set(tree.nodes.map(node => node.role?.value))].join(', ')}`);
      const finalLabel = `${kind === 'clips' ? 'Picture clip' : 'Referenced file'} ${total}:`;
      assert.ok(tree.nodes.some(node => node.role?.value === 'option' && node.name?.value?.includes(finalLabel) && node.name.value.includes(lastName)), `native AX exposes final ${kind} option`);
      lists.push({ kind, corpusCase: kind === 'clips' ? 'large' : 'typical', total, lastOriginalIndex: current.index, maximumMounted, searchReachesFinalRow: true,
        originalNumberJumpRestoresUnfilteredData: true, noMatchHasNoDanglingDescendant: true, keyboardAndFocusPreserved: true, finalOptionInNativeAXTree: true });
      for (const width of [1440, 768, 390, 360]) {
        win.setContentSize(width, 1100);
        await js(`document.getElementById(${JSON.stringify(viewport)}).focus()`); await key('End');
        await js(`document.getElementById(${JSON.stringify(`scan-${kind}-controls`)}).scrollIntoView({block:'start'})`); await paint();
        const layout = await js(`(()=>{const v=document.getElementById(${JSON.stringify(viewport)}),row=v.querySelector('[aria-selected="true"]'),r=row.getBoundingClientRect(),b=v.getBoundingClientRect();return {kind:${JSON.stringify(kind)},width:innerWidth,scrollWidth:document.documentElement.scrollWidth,mounted:v.querySelectorAll('[data-scan-index]').length,viewportWidth:v.clientWidth,viewportScrollWidth:v.scrollWidth,selectedOriginalIndex:Number(row.dataset.scanIndex),selectedVisible:r.top>=b.top-1&&r.bottom<=b.bottom+1}})()`);
        assert.equal(layout.width, layout.scrollWidth); assert.equal(layout.viewportWidth, layout.viewportScrollWidth); assert.ok(layout.mounted <= 16);
        assert.equal(layout.selectedOriginalIndex, total - 1); assert.equal(layout.selectedVisible, true); layouts.push(layout);
        if (process.env.FRAMELINE_LARGE_PROOF_CAPTURE !== '0' && [1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `${kind}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await inspectList('clips', lastClip.name, [`${lastClip.offsetFrames} frames`, `${lastClip.sourceInFrames} frames`, `${lastClip.durationFrames} frames`, lastClip.mediaName], String(lastClip.offsetFrames));
    const mediaNavigation = await scan(typical, { label: 'typical-reference-navigation' });
    const lastMedia = mediaNavigation.state.scan.media.at(-1);
    await inspectList('media', lastMedia.name, ['Read from the export; no relinking or upload']);

    assert.deepEqual(await canonicalSnapshot(profile), canonicalBefore);
    for (const item of expected) assert.equal(sha(await fs.readFile(path.join(corpus, `${item.name}-editor.fcpxmld/Info.fcpxml`))), item.sourceHash);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage: 'native-large-projects', scans, lists, layouts, canonicalFilesUnchanged: canonicalBefore.length,
      sourceExportsUnchanged: true, rendererErrors: errors.length, runtime: { electron: process.versions.electron, chromium: process.versions.chrome } }));
    app.quit();
  }
}
