'use strict';
// Disposable HTTPS/preload/controller proof. Account/roles and save-picker
// destinations are fixture inputs. No real account or editor data is used.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { createAssetHttpHandler } = require('../src/asset-http-transport');
const { createAssetHttpClient } = require('../src/asset-http-client');
const { createDesktopAssetLifecycle } = require('../src/desktop-asset-lifecycle');
const { createAssetLifecycleIntents } = require('../src/asset-lifecycle-intents');
const { lifecycleFixture, owner } = require('../tests/fixtures/asset-lifecycle-service');
const root = path.resolve(__dirname, '..'), cleanup = [];
const profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'frameline-lifecycle-profile-')); app.setPath('userData', profile);
let controller, server, handler, win;
app.whenReady().then(async () => {
  const f = await lifecycleFixture({ after: callback => cleanup.push(callback) }); f.setTime(Date.now());
  const a = await f.upload('disposable desktop media');
  const tls = path.join(root, 'tests/fixtures/network-tls');
  handler = createAssetHttpHandler({ assets: f.store, authorize: f.authorize, authorizePolicy: f.authorizePolicy, signingKey: randomBytes(32) });
  server = https.createServer({ key: await fs.readFile(path.join(tls, 'server-key.pem')), cert: await fs.readFile(path.join(tls, 'server.pem')) }, handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `https://127.0.0.1:${server.address().port}`, ca = await fs.readFile(path.join(tls, 'ca.pem'));
  let requests = 0, loseAck = true;
  const send = (url, options) => new Promise((resolve, reject) => {
    requests++;
    const req = https.request(url, { method: options.method, headers: options.headers, signal: options.signal, ca }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
  const remote = createAssetHttpClient({ origin, getAccessToken: () => owner.accessToken, fetch: send });
  const client = { ...remote, async setHold(...args) {
    const result = await remote.setHold(...args);
    if (loseAck) { loseAck = false; throw Object.assign(new Error('lost fixture acknowledgment'), { code: 'asset-network-unavailable' }); }
    return result;
  } };
  const account = { origin, status: 'connected', account: { id: 'fixture-owner' }, projects: [{ id: 'film', name: 'Disposable film', role: 'owner' }] };
  const connection = { getState: () => structuredClone(account), getAssetClient: () => client, refreshProjects: async () => structuredClone(account) };
  const open = () => controller = createDesktopAssetLifecycle({ connection, intents: createAssetLifecycleIntents({ directory: path.join(f.directory, 'desktop-intents') }),
    onChange: state => { if (win && !win.isDestroyed()) win.webContents.send('asset-lifecycle:state', state); } }); open();
  ipcMain.handle('asset-lifecycle:state', () => controller.initialize());
  for (const method of ['refreshProjects', 'selectProject', 'refreshReport', 'loadMore', 'selectAsset', 'selectForPlan', 'setHold', 'setRetention', 'preparePlan', 'retry', 'dismiss', 'prepareExport'])
    ipcMain.handle(`asset-lifecycle:${method}`, (_event, input) => controller[method](input));
  const destination = path.join(f.directory, 'reviewed-plan.json');
  ipcMain.handle('asset-lifecycle:saveExport', (_event, input) => controller.saveExport(input, destination));
  for (const channel of ['onboarding:get', 'app:get-state', 'service:state', 'asset-transfer:state', 'project-activity:state', 'collaboration:get-state',
    'resolve-service:state', 'resolve-history:list-projects', 'resolve-comments:state', 'resolve:get-review-state', 'resolve-trial:state', 'media-audit:state',
    'branch-review:state', 'share-links:state', 'account-updates:state', 'project-presets:state', 'shared-storage:state']) ipcMain.handle(channel, () => null);
  win = new BrowserWindow({ width: 1440, height: 1100, show: true, webPreferences: { preload: path.join(root, 'src/preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async expression => { const deadline = Date.now() + 15000; while (!await js(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await new Promise(done => setTimeout(done, 50));
  } };
  const click = id => js(`document.getElementById(${JSON.stringify('lifecycle-' + id)}).click()`);
  const select = async () => {
    await js("showView('history'); document.getElementById('lifecycle-project').value='film'; document.getElementById('lifecycle-project').dispatchEvent(new Event('change'))");
    await wait("!document.getElementById('lifecycle-refresh').disabled");
  };
  const report = async () => { await click('refresh'); await wait("document.getElementById('lifecycle-assets').children.length === 1 && !document.getElementById('lifecycle-refresh').disabled"); };
  const inspect = async () => { await js("document.querySelector('#lifecycle-assets button').click()"); await wait("!document.getElementById('lifecycle-hold-fields').disabled"); };
  await win.loadFile(path.join(root, 'src/index.html')); await wait("!document.getElementById('lifecycle-project').disabled");
  await select(); await report(); await inspect();
  await click('hold-review'); assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 0);
  await click('mutation-confirm'); await wait("!document.getElementById('lifecycle-pending').hidden && !document.getElementById('lifecycle-retry').disabled");
  assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 1);
  await controller.dispose(); open(); win.reload();
  await wait("!document.getElementById('lifecycle-retry').disabled"); await click('retry');
  await wait("document.getElementById('lifecycle-pending').hidden && document.getElementById('lifecycle-status').textContent.includes('Service confirmed')");
  assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 1);
  await select(); await report(); await inspect(); await click('release-review'); await click('mutation-confirm');
  await wait("document.getElementById('lifecycle-status').textContent.includes('the release')");
  await report(); await js("document.getElementById('lifecycle-days').value='0'"); await click('retention-review'); await click('mutation-confirm');
  await wait("document.getElementById('lifecycle-status').textContent.includes('the waiting period')");
  await remote.setArchived('film', a.assetId, { expectedArchived: false, archived: true }); f.setTime(Date.now()); await report(); await inspect();
  await js("const c=document.querySelector('#lifecycle-assets input'); c.checked=true; c.dispatchEvent(new Event('change'))");
  await wait("!document.getElementById('lifecycle-plan-prepare').disabled"); await click('plan-prepare');
  await wait("!document.getElementById('lifecycle-plan-export').disabled");
  assert.equal((await controller.getState()).plan.ready, false);
  await click('plan-export'); await wait("!document.getElementById('lifecycle-export-save').disabled"); await click('export-save');
  await wait("document.getElementById('lifecycle-status').textContent.includes('export saved')");
  const artifact = JSON.parse(await fs.readFile(destination, 'utf8')); assert.equal(artifact.content.deletionPerformed, false);
  assert.equal(artifact.content.items[0].assetId, a.assetId); assert.equal(JSON.stringify(artifact).includes(owner.accessToken), false);
  await js("document.getElementById('lifecycle-filter').value='held'; document.getElementById('lifecycle-filter').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('lifecycle-assets').children.length"), 0);
  await js("document.getElementById('lifecycle-filter').value='all'; document.getElementById('lifecycle-filter').dispatchEvent(new Event('change'))");
  const out = path.join(root, 'phase-0/asset-lifecycle-desktop'); await fs.mkdir(out, { recursive: true }); const layouts = [];
  for (const width of [1440, 768, 390, 360]) {
    win.setContentSize(width, 1100); await js("document.getElementById('asset-lifecycle-panel').scrollIntoView({block:'start'})");
    await new Promise(done => setTimeout(done, 100));
    const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})"); assert.equal(layout.width, layout.scrollWidth); layouts.push(layout);
    if (width === 1440 || width === 390) {
      await fs.writeFile(path.join(out, `lifecycle-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await js("document.getElementById('lifecycle-plan').scrollIntoView({block:'start'})");
      await fs.writeFile(path.join(out, `lifecycle-plan-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }
  account.status = 'not-configured'; await controller.connectionChanged(); await wait("document.getElementById('lifecycle-report-area').hidden");
  assert.equal(await js("document.getElementById('lifecycle-export').hidden"), true);
  account.status = 'connected'; account.projects[0].role = 'viewer'; await controller.connectionChanged();
  assert.equal((await controller.getState()).projects.length, 0);
  await remote.setArchived('film', a.assetId, { expectedArchived: true, archived: false });
  assert.deepEqual((await f.store.readChunk(owner, 'film', a.assetId, 0)).bytes, a.bytes.subarray(0, 4));
  assert.deepEqual(errors, []);
  const evidence = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: 'Disposable fixture-authorized HTTPS asset API, real Electron preload/controller; controller restart and page reload; fixture save destination',
    networkRequests: requests, checks: ['explicit hold review', 'lost acknowledgment survived private-journal/controller restart', 'same-key retry without duplicate hold version',
      'reviewed hold release', 'reviewed retention change', 'asset details and loaded-row filters', 'blocked cleanup plan', 'exact reviewed plan export',
      'sign-out clears private rows and export', 'viewer has no owner project access', 'media bytes retained', 'no browser errors'], layouts };
  await fs.writeFile(path.join(out, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence, null, 2));
  await controller.dispose(); await handler.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  for (const callback of cleanup) await callback(); win.destroy(); app.quit();
}).catch(async error => {
  console.error(error); await controller?.dispose(); await handler?.close(); server?.closeAllConnections(); server?.close();
  for (const callback of cleanup) await callback(); app.exit(1);
});
