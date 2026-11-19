'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), evidenceDirectory = path.join(root, 'phase-0/product-truth-desktop');
if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-truth-proof-')));
    try {
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const media = path.join(directory, 'local.jpg'); await fs.copyFile(path.join(root, 'src/assets/visuals/mountain-alps.jpg'), media);
      const sources = [pathToFileURL(media).href, pathToFileURL(path.join(directory, 'missing.mov')).href, 'https://example.test/external.mov', null];
      const assets = sources.map((src, n) => `<asset id="a${n}" name="Truth media ${n}"${src ? ` src="${src}"` : ''} start="0s" duration="1s" hasVideo="1" hasAudio="0"/>`).join('');
      const clips = sources.map((_src, n) => `<asset-clip name="Truth clip ${n}" ref="a${n}" offset="${n}s" start="0s" duration="1s"/>`).join('');
      await fs.writeFile(path.join(directory, 'truth.fcpxml'), `<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/24s"/>${assets}</resources><library><event name="Fixture"><project name="Truth fixture"><sequence format="r1" duration="4s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`);
      await fs.writeFile(path.join(directory, 'bad.fcpxml'), '<invalid>');
      const base = JSON.parse(await fs.readFile(path.join(root, 'phase-0/resolve-xml-proof/live-mapping-before-schema3.json')));
      for (const timeline of base.timelines) for (const item of timeline.items) item.linked_item_ids = [];
      const transition = { ...structuredClone(base.timelines[0].items[0]), id: 'truth-transition', name: 'Observed transition', type: 'transition', source_start_frame: 0, source_end_frame: 0 };
      base.timelines[0].items.push(transition);
      const local = structuredClone(base), incoming = structuredClone(base);
      local.timelines[0].items[0].name = incoming.timelines[0].items[0].name = 'Matching captured name';
      local.timelines[0].items.find(item => item.id === transition.id).source_start_frame = null;
      local.timelines[0].items.find(item => item.id === transition.id).source_end_frame = null;
      for (const [role, value] of Object.entries({ base, local, incoming })) await fs.writeFile(path.join(directory, `${role}.json`), JSON.stringify(value));
      const result = await run(require('electron'), [__filename], { cwd: root, timeout: 90000, env: { ...process.env, FRAMELINE_TRUTH_PROOF_ROOT: directory } });
      const line = result.stdout.split('\n').findLast(value => value.startsWith('{"schemaVersion"'));
      if (!line) throw new Error(`Missing evidence: ${result.stdout}\n${result.stderr}`);
      const evidence = JSON.parse(line); await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  const directory = process.env.FRAMELINE_TRUTH_PROOF_ROOT;
  if (!directory || !fsSync.existsSync(path.join(directory, 'truth.fcpxml'))) throw new Error('Disposable fixture required');
  const profile = path.join(directory, 'profile'); fsSync.mkdirSync(profile); app.setPath('userData', profile);
  let projectPicks = 0;
  dialog.showOpenDialog = async options => {
    if (options.title === 'Choose a DaVinci Resolve timeline') return { canceled: false, filePaths: [path.join(directory, projectPicks++ ? 'bad.fcpxml' : 'truth.fcpxml')] };
    const role = /^Choose (base|local|incoming) Resolve capture or snapshot$/.exec(options.title)?.[1];
    assert.ok(role, `Unexpected picker ${options.title}`); return { canceled: false, filePaths: [path.join(directory, `${role}.json`)] };
  };
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', value => { if (value.level === 'error') errors.push(value.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');
  async function verify(win, errors) {
    const js = code => win.webContents.executeJavaScript(code), checks = [], layouts = [];
    const wait = async expression => { const deadline = Date.now() + 15000; while (!await js(expression)) { if (Date.now() > deadline) throw new Error(`Timed out ${expression}`); await new Promise(done => setTimeout(done, 40)); } };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const sourceFiles = ['truth.fcpxml', 'bad.fcpxml', 'base.json', 'local.json', 'incoming.json'];
    const originals = await Promise.all(sourceFiles.map(name => fs.readFile(path.join(directory, name))));
    await wait("!!window.FramelineProductTruth && !!window.desktop"); await js("document.getElementById('first-run').hidden=true");
    for (const view of ['workspace', 'history', 'media']) {
      await js(`showView(${JSON.stringify(view)})`);
      assert.equal(await js("document.getElementById('product-truth').dataset.sourceKind"), 'sample');
      assert.match(await js("document.getElementById('product-truth-title').textContent"), /Sample/);
    }
    checks.push('all three example content surfaces labeled as sample beside content');
    const bootService = await js('window.desktop.getServiceState()');
    const sampleConnected = { ...bootService, version: 50000, status: 'connected', connected: true, busy: false,
      account: { id: 'truth-fixture', email: 'fixture@example.test' }, origin: 'https://fixture.example.test', binding: null, selection: null, projects: [] };
    await js(`serviceState=${JSON.stringify(sampleConnected)};renderServicePanel();showView('history')`);
    assert.match(await js("document.getElementById('product-truth-detail').textContent"), /example local history list.*Service panels.*independently/);
    assert.match(await js("document.getElementById('product-truth-service').textContent"), /Connected service/);
    await js(`serviceState=${JSON.stringify(bootService)};serviceStateVersion=serviceState.version;renderServicePanel()`);
    checks.push('sample local history explanation does not label independent connected service panels as demonstrations');
    await js("showView('resolve')"); assert.equal(await js("document.getElementById('product-truth').dataset.sourceKind"), 'empty');
    await js("showView('workspace')"); assert.equal(await js("document.querySelector('.pull-action button').disabled"), true);
    assert.match(await js("document.querySelector('.pull-action p').textContent"), /sample destination choices/);
    await click('choose-file'); await wait("currentAppState?.scanStatus === 'ready'");
    await js("showView('media')"); assert.equal(await js("document.getElementById('product-truth').dataset.sourceKind"), 'scan');
    const mediaLabels = await js("[...document.querySelectorAll('.scanned-media .media-availability')].map(node=>node.textContent)");
    assert.ok(mediaLabels.includes('Available locally')); assert.ok(mediaLabels.includes('Missing'));
    assert.ok(mediaLabels.includes('External source · not checked')); assert.ok(mediaLabels.includes('Source unspecified'));
    assert.equal(await js('assetBytes(null)'), 'Size not known yet'); assert.equal(await js('assetBytes(0)'), '0 B');
    assert.equal(await js('serviceDate(null)'), 'Time unavailable');
    checks.push('real FCPXML scan shows local, missing, unchecked external and unspecified references without fake zeros');
    // Presentation fixtures exercise existing scoped service renderers; no real account or service is claimed.
    const originalService = await js('window.desktop.getServiceState()');
    const injected = { ...originalService, version: 100000, status: 'connected', connected: true, busy: false, origin: 'https://fixture.example.test',
      account: { id: 'truth-fixture', email: 'fixture@example.test' }, projects: [{ id: 'truth-project', name: 'Truth project', role: 'owner', branches: ['main'] }],
      binding: { remoteProjectId: 'truth-project', remoteProjectName: 'Truth project', remoteBranch: 'main', role: 'owner' } };
    await js(`serviceState=${JSON.stringify(injected)};serviceState.selection={localProjectId:currentAppState.selectedProject.id,branch:currentAppState.currentBranch};renderServicePanel()`);
    assert.match(await js("document.getElementById('product-truth-service').textContent"), /Connected service/);
    for (const state of ['archived', 'excluded', 'not-on-service']) {
      await js(`document.getElementById('asset-content-id').value='sha256:'+'a'.repeat(64);assetAvailabilityNeedsCheck=false;assetTransferState={scope:{remoteProjectId:'truth-project'},availability:{assetId:'sha256:'+'a'.repeat(64),state:${JSON.stringify(state)},assetClass:'original',size:${state === 'not-on-service' ? 'null' : '123'},excluded:${state === 'excluded'},archived:${state === 'archived'},cloudPresent:${state !== 'not-on-service'}},storage:{canManage:true,policy:{version:1,syncClasses:['original']}}};renderAssetAvailability(true,false)`);
      assert.match(await js("document.getElementById('asset-availability-state').textContent"), state === 'archived' ? /Archived/ : state === 'excluded' ? /Excluded/ : /Not on this service/);
      assert.equal(await js("document.getElementById('asset-download').disabled"), true);
    }
    await js("serviceState={...serviceState,status:'offline',connected:false};renderServicePanel()");
    assert.match(await js("document.getElementById('product-truth-service').textContent"), /last successful check/);
    await js(`serviceState=${JSON.stringify(originalService)};serviceStateVersion=serviceState.version;renderServicePanel()`);
    checks.push('connected/offline presentation and archived/excluded/not-on-service remain distinct with blocked unavailable downloads');
    await click('choose-file'); await wait("currentAppState?.scanStatus === 'error'");
    assert.equal(await js("document.getElementById('product-truth').dataset.sourceKind"), 'unavailable');
    assert.equal(await js("document.querySelectorAll('.scanned-media').length"), 0);
    checks.push('failed selected export has unavailable inventory, never substituted sample values');
    await js("showView('resolve')"); await click('resolve-choose'); await wait("resolveState?.status === 'ready' && !resolveBusy");
    assert.equal(await js("document.getElementById('product-truth').dataset.sourceKind"), 'observation');
    assert.match(await js("document.querySelector('#resolve-filter option[value=\"already-applied\"]').textContent"), /Matching observations/);
    await js("document.getElementById('resolve-field').value='sourceStartFrame';document.getElementById('resolve-field').dispatchEvent(new Event('change'))");
    assert.match(await js("document.getElementById('resolve-detail').textContent"), /Not observed/);
    assert.match(await js("document.getElementById('file-notice').textContent"), /^FCPXML export:/);
    assert.equal(await js("[...document.querySelectorAll('#view-resolve button')].some(button=>button.textContent==='Apply unavailable'&&button.disabled)"), true);
    checks.push('matching captures do not claim apply; null captured field is not observed while ordinary apply stays disabled');
    await js("document.getElementById('first-run').hidden=true");
    for (const width of [1440, 768, 390, 360]) {
      win.setContentSize(width, 1100); await js("document.getElementById('product-truth').scrollIntoView({block:'start'})"); await new Promise(done => setTimeout(done, 100));
      const layout = await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'); assert.equal(layout.width, layout.scrollWidth); layouts.push(layout);
      if ([1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `truth-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    for (let n = 0; n < sourceFiles.length; n++) assert.deepEqual(await fs.readFile(path.join(directory, sourceFiles[n])), originals[n]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ schemaVersion: 1, scope: 'Shipped main/preload/renderer, disposable real source files and fixture OS picker results. Service/asset rows use explicit presentation fixtures; no external account or service is exercised.', checks, layouts, sourceBytesUnchanged: true, rendererErrors: errors.length }));
    app.quit();
  }
}
