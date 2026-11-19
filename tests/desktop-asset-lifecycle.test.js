'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDesktopAssetLifecycle } = require('../src/desktop-asset-lifecycle');
const { createAssetLifecycleIntents } = require('../src/asset-lifecycle-intents');
const { lifecycleFixture, owner } = require('./fixtures/asset-lifecycle-service');
const fail = code => Object.assign(new Error('private secret /private/camera'), { code });
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function fixture(t) {
  const f = await lifecycleFixture(t), a = await f.upload(), journal = path.join(f.directory, 'intents');
  const account = { status: 'connected', origin: 'https://studio.example.test', account: { id: 'owner-id' },
    projects: [{ id: 'film', name: 'Film', role: 'owner' }, { id: 'other-film', name: 'Other film', role: 'owner' }] };
  const calls = [], events = [], hooks = {}, controllers = []; let controller;
  const methods = ['getLifecycleReport', 'setHold', 'setRetentionPolicy', 'planCleanup'];
  const client = Object.fromEntries(methods.map(method => [method, (...args) => {
    calls.push({ method, args: structuredClone(args.slice(0, -1)) });
    return hooks[method] ? hooks[method](...args) : f.store[method](owner, ...args);
  }]));
  const connection = { getState: () => structuredClone(account), getAssetClient: () => client, async refreshProjects() { calls.push({ method: 'refreshProjects' }); return structuredClone(account); } };
  function open() {
    controller = createDesktopAssetLifecycle({ connection, intents: createAssetLifecycleIntents({ directory: journal }), onChange: state => events.push(state) }); controllers.push(controller);
  }
  open(); t.after(async () => { for (const c of controllers) await c.dispose(); });
  const input = extra => ({ scopeId: events.at(-1)?.scopeId, ...extra });
  const ready = async () => { await controller.initialize(); await controller.selectProject('film'); await controller.refreshReport(); await controller.selectAsset(input({ assetId: a.assetId })); };
  const hold = () => { const row = events.at(-1).items.find(item => item.assetId === a.assetId);
    return controller.setHold(input({ assetId: a.assetId, expectedVersion: row?.hold.version, held: true, reason: 'manual', until: null })); };
  return { ...f, account, client, calls, events, hooks, a, input, ready, hold, journal,
    get controller() { return controller; }, async restart() { await controller.dispose(); open(); return controller.initialize(); } };
}
test('lifecycle discovery is independent of local editor selection; sign-in and owner role gate the project catalog', async t => {
  const f = await fixture(t); await f.controller.initialize(); assert.equal(f.calls.length, 0);
  f.account.projects[0].role = 'viewer'; await f.controller.connectionChanged();
  const state = await f.controller.getState(); assert.deepEqual(state.projects.map(item => item.id), ['other-film']);
  assert.equal((await f.controller.selectProject('film')).error, 'lifecycle-owner-required');
  f.account.status = 'not-configured'; await f.controller.connectionChanged(); assert.equal((await f.controller.getState()).projects.length, 0);
});
test('desktop holds and retention use reviewed versions, journal exact requests, publish receipts and require a fresh report', async t => {
  const f = await fixture(t); await f.ready(); let state = await f.hold();
  assert.equal(state.outcome.result.held, true); assert.equal(state.pending, null); assert.equal(state.ready, false);
  assert.equal(f.calls.find(c => c.method === 'setHold').args[2].expectedVersion, 0);
  assert.equal(JSON.stringify(state).includes('idempotencyKey'), false);
  await f.controller.refreshReport(); state = await f.controller.setRetention(f.input({ expectedVersion: 0, minimumArchiveAgeMs: 86400000 }));
  assert.equal(state.outcome.result.minimumArchiveAgeMs, 86400000); assert.equal(state.pending, null);
  assert.equal((await fs.stat(path.join(f.journal, 'lifecycle-intents.json'))).mode & 0o777, 0o600);
});
test('ambiguous mutations recover the exact key after restart and historical retry does not replace a later server release', async t => {
  const f = await fixture(t); await f.ready();
  f.hooks.setHold = async (...args) => { await f.store.setHold(owner, ...args); throw fail('asset-network-unavailable'); };
  const failed = await f.hold(); assert(failed.pending); const key = f.calls.find(c => c.method === 'setHold').args[2].idempotencyKey;
  await f.store.setHold(owner, 'film', f.a.assetId, { expectedVersion: 1, held: false, reason: null, until: null, idempotencyKey: 'external-release' });
  await f.restart(); delete f.hooks.setHold;
  const state = await f.controller.retry(f.input({ pendingId: failed.pending.id }));
  assert.equal(state.outcome.result.version, 1); assert.equal(state.pending, null);
  assert.equal(f.calls.filter(c => c.method === 'setHold').at(-1).args[2].idempotencyKey, key);
  assert.equal((await f.store.getHold(owner, 'film', f.a.assetId)).version, 2);
});
test('pending requests block replacements and require explicit scoped dismissal after an owner-reviewed check', async t => {
  const f = await fixture(t); await f.ready(); f.hooks.setHold = () => { throw fail('asset-network-unavailable'); };
  const pending = (await f.hold()).pending;
  assert.equal((await f.hold()).error, 'asset-lifecycle-retry-required');
  assert.equal((await f.controller.dismiss(f.input({ pendingId: pending.id, reviewed: false }))).error, 'lifecycle-selection-changed');
  assert.equal((await f.controller.dismiss(f.input({ pendingId: pending.id, reviewed: true }))).pending, null);
});
test('account changes, permission loss and project selection discard late replies and prevent stale commands', async t => {
  const f = await fixture(t); await f.ready(); const old = f.input({ assetId: f.a.assetId, expectedVersion: 0, held: true, reason: 'manual', until: null });
  const waiting = gate(); f.hooks.getLifecycleReport = async (...args) => { await waiting.promise; return f.store.getLifecycleReport(owner, ...args); };
  const request = f.controller.refreshReport(); await Promise.resolve();
  f.account.account.id = 'another-account'; await f.controller.connectionChanged(); waiting.resolve(); await request;
  let state = await f.controller.getState(); assert.equal(state.items.length, 0); assert.equal(state.plan, null);
  assert.equal((await f.controller.setHold(old)).error, 'lifecycle-selection-changed');
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); state = await f.controller.getState(); assert.equal(state.projects.some(p => p.id === 'film'), false);
});
test('paging rejects changed snapshots rather than merging incompatible pages; plans use only loaded selected IDs', async t => {
  const f = await fixture(t); await f.ready();
  const report = await f.store.getLifecycleReport(owner, 'film', { afterAssetId: null, limit: 100 });
  const otherAsset = `sha256:${'f'.repeat(64)}`;
  f.hooks.getLifecycleReport = async (_pid, input) => input.afterAssetId === null
    ? { ...report, totalAssets: 2, nextAssetId: report.items[0].assetId }
    : { ...report, totalAssets: 2, stateHash: 'b'.repeat(64), items: [{ ...report.items[0], assetId: otherAsset,
      hold: { ...report.items[0].hold, assetId: otherAsset } }], nextAssetId: null };
  await f.controller.refreshReport(); const changed = await f.controller.loadMore(); assert.equal(changed.error, 'lifecycle-report-changed'); assert.equal(changed.items.length, 0);
  delete f.hooks.getLifecycleReport; await f.controller.refreshReport();
  assert.equal((await f.controller.selectForPlan(f.input({ assetIds: [otherAsset] }))).error, 'asset-lifecycle-invalid');
  await f.controller.selectForPlan(f.input({ assetIds: [f.a.assetId] })); const planned = await f.controller.preparePlan(f.input({}));
  assert.equal(planned.plan.ready, false); assert.equal(planned.plan.deletionPerformed, false);
});
test('reviewed report and plan exports recheck the service state and preserve existing destinations', async t => {
  const f = await fixture(t); await f.ready();
  let state = await f.controller.prepareExport(f.input({ kind: 'report' }));
  const output = path.join(f.directory, 'report.json'); state = await f.controller.saveExport(f.input({ hash: state.exportReview.hash }), output);
  assert.equal(state.outcome.kind, 'exported'); const artifact = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(artifact.content.complete, true); assert.equal(artifact.content.pages.length, 1);
  assert.doesNotMatch(JSON.stringify(artifact), /idempotencyKey|accessToken|\/private\//);
  state = await f.controller.prepareExport(f.input({ kind: 'report' }));
  assert.equal((await f.controller.saveExport(f.input({ hash: state.exportReview.hash }), output)).error, 'lifecycle-destination-exists');
  state = await f.controller.prepareExport(f.input({ kind: 'report' }));
  await f.store.setHold(owner, 'film', f.a.assetId, { expectedVersion: 0, held: true, reason: 'manual', until: null, idempotencyKey: 'external' });
  assert.equal((await f.controller.saveExport(f.input({ hash: state.exportReview.hash }), path.join(f.directory, 'stale.json'))).error, 'lifecycle-export-stale');
  await assert.rejects(fs.stat(path.join(f.directory, 'stale.json')), { code: 'ENOENT' });
});
test('durable journal refuses replacement by another project, isolates accounts and rejects corrupted private state', async t => {
  const f = await fixture(t), journal = createAssetLifecycleIntents({ directory: f.journal });
  const value = { kind: 'hold', projectId: 'film', assetId: f.a.assetId, input: { expectedVersion: 0, held: true, reason: 'manual', until: null } };
  const first = await journal.begin('a'.repeat(64), value);
  assert.equal((await journal.begin('a'.repeat(64), value)).record.id, first.record.id);
  await assert.rejects(journal.begin('a'.repeat(64), { ...value, projectId: 'other-film' }), { code: 'asset-lifecycle-retry-required' });
  assert.equal(await journal.load('b'.repeat(64)), null);
  await fs.chmod(path.join(f.journal, 'lifecycle-intents.json'), 0o644);
  await assert.rejects(journal.load('a'.repeat(64)), { code: 'asset-lifecycle-intent-invalid' });
});
