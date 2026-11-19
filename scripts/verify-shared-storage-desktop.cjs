'use strict';
// Disposable real Electron/preload/controller/filesystem proof. Native picker
// results are fixture selections; no studio volume or userData is touched.
// Run: node_modules/.bin/electron scripts/verify-shared-storage-desktop.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { createDesktopSharedStorage } = require('../src/desktop-shared-storage');
const root = path.resolve(__dirname, '..');
let controller, directory, win;
app.whenReady().then(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-storage-desktop-')));
  const volume = path.join(directory, 'studio'); await fs.mkdir(volume);
  await fs.writeFile(path.join(volume, 'take.mov'), 'verified camera data');
  const request = { schemaVersion: 1, projectId: 'disposable-film', sourceHash: 'a'.repeat(64), assets: [{
    id: 'shot-001', relativePath: 'take.mov', assetClass: 'original', expected: {
      size: 20, sha256: createHash('sha256').update('verified camera data').digest('hex') }
  }] };
  const requestFile = path.join(directory, 'request.json'), destination = path.join(directory, 'proposal.json');
  await fs.writeFile(requestFile, JSON.stringify(request));
  const open = () => controller = createDesktopSharedStorage({ directory: path.join(directory, 'private'),
    onChange: state => { if (win && !win.isDestroyed()) win.webContents.send('shared-storage:state', state); } }); open();
  ipcMain.handle('shared-storage:state', () => controller.initialize());
  ipcMain.handle('shared-storage:register', (_event, label) => controller.register(volume, label));
  ipcMain.handle('shared-storage:select', (_event, id) => controller.select(id));
  for (const method of ['rename', 'forget', 'check', 'verify', 'prepareProposal']) ipcMain.handle(`shared-storage:${method}`, (_event, input) => controller[method](input));
  ipcMain.handle('shared-storage:cancel', () => controller.cancel());
  ipcMain.handle('shared-storage:reconnect', (_event, input) => controller.reconnect(input, volume));
  ipcMain.handle('shared-storage:import', () => controller.importRequest(requestFile));
  ipcMain.handle('shared-storage:export', (_event, input) => controller.exportProposal(input, destination));
  // Unrelated product services are unavailable in this isolated proof.
  for (const channel of ['onboarding:get', 'app:get-state', 'service:state', 'asset-transfer:state', 'project-activity:state',
    'collaboration:get-state', 'resolve-service:state', 'resolve-history:list-projects', 'resolve-comments:state',
    'resolve:get-review-state', 'resolve-trial:state', 'media-audit:state', 'branch-review:state', 'share-links:state',
    'account-updates:state', 'project-presets:state', 'asset-lifecycle:state']) ipcMain.handle(channel, () => null);
  win = new BrowserWindow({ width: 1440, height: 1100, show: true, webPreferences: { preload: path.join(root, 'src/preload.js'),
    sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async expression => {
    const until = Date.now() + 15000;
    while (!await js(expression)) { if (Date.now() > until) throw new Error(`Timed out: ${expression}`); await new Promise(done => setTimeout(done, 50)); }
  };
  const click = async id => { await js(`document.getElementById(${JSON.stringify(id)}).click()`); };
  await win.loadFile(path.join(root, 'src/index.html'));
  await wait("!document.getElementById('storage-import').disabled");
  await js("showView('history'); document.getElementById('storage-label').value = 'Picture archive'; document.getElementById('storage-label').dispatchEvent(new Event('input'))");
  await click('storage-register'); await wait("document.getElementById('storage-status').textContent.includes('registered on this computer')");
  const id = controller.getState().selectedId;
  await click('storage-import'); await wait("!document.getElementById('storage-verify').disabled");
  await click('storage-verify'); await wait("!document.getElementById('storage-prepare').disabled");
  assert.equal(controller.getState().report.items[0].verified, true);
  await click('storage-prepare'); await wait("!document.getElementById('storage-export').disabled");
  await click('storage-export'); await wait("document.getElementById('storage-status').textContent.includes('proposal saved')");
  const exported = JSON.parse(await fs.readFile(destination, 'utf8'));
  assert.equal(exported.executable, false); assert.equal(exported.assets[0].assetClass, 'original');
  assert.equal(JSON.stringify(exported).includes(directory), false);
  assert.equal(await fs.readFile(path.join(volume, 'take.mov'), 'utf8'), 'verified camera data');
  const screenshotDirectory = path.join(root, 'phase-0/shared-storage-desktop'); await fs.mkdir(screenshotDirectory, { recursive: true });
  const layouts = [];
  for (const width of [1440, 768, 390, 360]) {
    win.setContentSize(width, 1100);
    await js("document.getElementById('shared-storage-panel').scrollIntoView({block:'start'})");
    await new Promise(done => setTimeout(done, 150));
    const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelWidth:document.getElementById('shared-storage-panel').getBoundingClientRect().width})");
    assert.equal(layout.scrollWidth, layout.width, `overflow at ${width}`); layouts.push(layout);
    if (width === 1440 || width === 390) await fs.writeFile(path.join(screenshotDirectory, `storage-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await controller.dispose(); open(); await win.reload(); await wait("!document.getElementById('storage-import').disabled");
  await js(`showView('history'); document.getElementById('storage-volume').value = ${JSON.stringify(id)}; document.getElementById('storage-volume').dispatchEvent(new Event('change'))`);
  await wait("document.getElementById('storage-report-title').textContent === 'Last saved media check'");
  assert.equal(await js("document.getElementById('storage-prepare').disabled"), true);
  await click('storage-import'); await wait("!document.getElementById('storage-verify').disabled");
  await fs.writeFile(path.join(volume, 'take.mov'), 'wrong camera footage');
  await click('storage-verify'); await wait("document.getElementById('storage-report-summary').textContent === '0 of 1 verified.'");
  assert.equal(await js("document.getElementById('storage-prepare').disabled"), true);
  assert.equal(await js("document.getElementById('storage-results').textContent.includes('Content differs')"), true);
  await click('storage-forget'); assert.equal(await js("document.getElementById('storage-forget-review').hidden"), false);
  await click('storage-forget-cancel'); assert.equal(controller.getState().volumes.length, 1);
  assert.deepEqual(errors, []);
  const evidence = { schemaVersion: 1, scope: 'Disposable local folder; native picker selections supplied by harness',
    checks: ['real preload/controller asset verification', 'reviewed path-free export', 'media unchanged by verification',
      'desktop and narrow layouts', 'registry and historical report recovery after controller restart and page reload',
      'content changes block proposals', 'forget cancellation preserves registration', 'no browser console errors'], layouts };
  await fs.writeFile(path.join(screenshotDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  await controller.dispose(); await fs.rm(directory, { recursive: true, force: true }); app.quit();
}).catch(async error => {
  console.error(error); await controller?.dispose(); if (directory) await fs.rm(directory, { recursive: true, force: true }); app.exit(1);
});
