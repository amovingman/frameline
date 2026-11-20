'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDesktopAssetLifecycle } = require('../src/desktop-asset-lifecycle');
const { createAssetLifecycleIntents } = require('../src/asset-lifecycle-intents');
const { lifecycleFixture, owner } = require('./fixtures/asset-lifecycle-service');
const { fingerprint } = require('../src/project-api-contracts');
const references = (projectId, revisions = [], complete = true) => { const body = { projectId, revisions, complete }; return { ...body, stateHash: fingerprint(body) }; };
const fail = code => Object.assign(new Error('private secret /private/camera'), { code });
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function fixture(t, extra = {}) {
  const snapshots = new Map();
  const f = await lifecycleFixture(t, { ownerBoundaryDeduplication: true, withRevisionReferences: async (_context, pid, operation) => operation(snapshots.get(pid) || references(pid), {
    authorize: () => ({ allowed: true, actorId: 'owner-id' }), authorizePolicy: () => ({ allowed: true, actorId: 'owner-id' }),
    getInitialPolicy: () => ({ projectId: pid, version: 0, syncClasses: [] }) }), ...extra }), a = await f.upload(), journal = path.join(f.directory, 'intents');
  const account = { status: 'connected', origin: 'https://studio.example.test', account: { id: 'owner-id' },
    projects: [{ id: 'film', name: 'Film', role: 'owner' }, { id: 'other-film', name: 'Other film', role: 'owner' }] };
  const calls = [], events = [], hooks = {}, controllers = []; let controller;
  const methods = ['getOwnerAssetReport', 'setHold', 'setRetentionPolicy', 'planGarbageCollection', 'garbageCollect'];
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
  return { ...f, snapshots, account, client, calls, events, hooks, a, input, ready, hold, journal,
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
  const waiting = gate(); f.hooks.getOwnerAssetReport = async (...args) => { await waiting.promise; return f.store.getOwnerAssetReport(owner, ...args); };
  const request = f.controller.refreshReport(); await Promise.resolve();
  f.account.account.id = 'another-account'; await f.controller.connectionChanged(); waiting.resolve(); await request;
  let state = await f.controller.getState(); assert.equal(state.items.length, 0); assert.equal(state.plan, null);
  assert.equal((await f.controller.setHold(old)).error, 'lifecycle-selection-changed');
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); state = await f.controller.getState(); assert.equal(state.projects.some(p => p.id === 'film'), false);
});
test('paging rejects changed snapshots rather than merging incompatible pages; plans use only loaded selected IDs', async t => {
  const f = await fixture(t); await f.ready();
  const report = await f.store.getOwnerAssetReport(owner, 'film', { afterAssetId: null, limit: 100 });
  const otherAsset = `sha256:${'f'.repeat(64)}`;
  f.hooks.getOwnerAssetReport = async (_pid, input) => input.afterAssetId === null
    ? { ...report, totalAssets: 2, nextAssetId: report.items[0].assetId }
    : { ...report, totalAssets: 2, stateHash: 'b'.repeat(64), items: [{ ...report.items[0], assetId: otherAsset,
      identity: { ...report.items[0].identity, contentId: otherAsset }, hold: { ...report.items[0].hold, assetId: otherAsset } }], nextAssetId: null };
  await f.controller.refreshReport(); const changed = await f.controller.loadMore(); assert.equal(changed.error, 'lifecycle-report-changed'); assert.equal(changed.items.length, 0);
  delete f.hooks.getOwnerAssetReport; await f.controller.refreshReport();
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

async function collectionPlan(f) {
  await f.ready();
  await f.store.setRetentionPolicy(owner, 'film', { expectedVersion: 0, minimumArchiveAgeMs: 0, idempotencyKey: 'zero-retention' });
  await f.store.setArchived(owner, 'film', f.a.assetId, { expectedArchived: false, archived: true });
  await f.controller.refreshReport();
  await f.controller.selectForPlan(f.input({ assetIds: [f.a.assetId] }));
  return f.controller.preparePlan(f.input({}));
}
test('reviewed collection uses canonical references, releases membership while preserving shared bytes and saves an exact durable receipt', async t => {
  const f = await fixture(t); const shared = await f.upload('media bytes', 'other-film');
  let state = await collectionPlan(f); assert.equal(state.report.schemaVersion, 2); assert.equal(state.plan.ready, true);
  assert.equal(state.plan.releaseBytes, f.a.bytes.length); assert.equal(state.plan.physicalBytesReclaimable, 0);
  const planId = state.plan.planId;
  assert.equal((await f.controller.executeCollection(f.input({ planId, confirmed: false }))).error, 'lifecycle-selection-changed');
  state = await f.controller.preparePlan(f.input({}));
  state = await f.controller.executeCollection(f.input({ planId: state.plan.planId, confirmed: true }));
  assert.equal(state.error, null); assert.equal(state.receipt.deletionPerformed, true); assert.equal(state.receipt.logicalBytesReleased, f.a.bytes.length);
  assert.equal(state.receipt.physicalBytesScheduled, 0); assert.equal(state.pending, null); assert.equal(state.ready, false);
  assert.equal((await f.store.readChunk(owner, 'other-film', shared.assetId, 0)).bytes.toString(), 'medi');
  const receipt = structuredClone(state.receipt);
  state = await f.restart(); assert.deepEqual(state.receipt, receipt);
  await f.controller.selectProject('film');
  state = await f.controller.prepareExport(f.input({ kind: 'receipt' }));
  const output = path.join(f.directory, 'collection-receipt.json');
  state = await f.controller.saveExport(f.input({ hash: state.exportReview.hash }), output);
  assert.equal(state.outcome.kind, 'exported'); const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(saved.schemaVersion, 2); assert.deepEqual(saved.content, receipt);
  assert.doesNotMatch(JSON.stringify(saved), /idempotencyKey|accessToken|\/private\/|uploads/);
  await f.controller.refreshReport(); assert.equal((await f.controller.getState()).items.length, 0);
});
test('lost collection acknowledgment survives service/controller restart and retries only the exact original operation', async t => {
  const f = await fixture(t); let state = await collectionPlan(f);
  f.hooks.garbageCollect = async (...args) => { await f.store.garbageCollect(owner, ...args); throw fail('asset-network-unavailable'); };
  state = await f.controller.executeCollection(f.input({ planId: state.plan.planId, confirmed: true }));
  assert.equal(state.error, 'asset-network-unavailable'); assert.equal(state.pending.kind, 'gc'); assert.equal(state.receipt, null);
  const pending = state.pending, first = f.calls.find(call => call.method === 'garbageCollect').args[1];
  assert.doesNotMatch(JSON.stringify(pending), /idempotencyKey/);
  await f.reopen(); state = await f.restart(); assert.equal(state.pending.id, pending.id); delete f.hooks.garbageCollect;
  state = await f.controller.retry(f.input({ pendingId: pending.id }));
  assert.equal(state.error, null); assert.equal(state.pending, null); assert.equal(state.receipt.logicalBytesReleased, f.a.bytes.length);
  assert.deepEqual(f.calls.filter(call => call.method === 'garbageCollect').at(-1).args[1], first);
  assert.deepEqual((await f.restart()).receipt, state.receipt);
});
test('retained revisions and unverified coverage block collection; changed holds reject already reviewed plans without deleting', async t => {
  const f = await fixture(t); const identity = (await f.state()).uploads[0].identity;
  f.snapshots.set('film', references('film', [{ revisionId: 'retained-revision', manifestId: `sha256:${'b'.repeat(64)}`, sourceHash: 'c'.repeat(64), assets: [identity] }]));
  let state = await collectionPlan(f); assert.equal(state.plan.ready, false); assert.deepEqual(state.plan.items[0].retainedBy, ['retained-revision']);
  assert.equal((await f.controller.executeCollection(f.input({ planId: state.plan.planId, confirmed: true }))).error, 'lifecycle-selection-changed');
  assert.equal(f.calls.filter(call => call.method === 'garbageCollect').length, 0);
  f.snapshots.set('film', references('film', [], false)); await f.controller.refreshReport();
  await f.controller.selectForPlan(f.input({ assetIds: [f.a.assetId] })); state = await f.controller.preparePlan(f.input({}));
  assert.deepEqual(state.plan.items[0].blockers, ['revision-references-unverified']);
  f.snapshots.set('film', references('film')); await f.controller.refreshReport();
  await f.controller.selectForPlan(f.input({ assetIds: [f.a.assetId] })); state = await f.controller.preparePlan(f.input({}));
  await f.store.setHold(owner, 'film', f.a.assetId, { expectedVersion: 0, held: true, reason: 'manual', until: null, idempotencyKey: 'changed-hold' });
  state = await f.controller.executeCollection(f.input({ planId: state.plan.planId, confirmed: true }));
  assert.equal(state.error, 'asset-lifecycle-plan-stale'); assert.equal(state.pending, null); assert.equal(state.ready, false);
  assert.equal((await f.store.getOwnerAssetReport(owner, 'film', { afterAssetId: null, limit: 100 })).totalAssets, 1);
});
test('collection receipts are request-bound; malformed acknowledgments keep recovery and account changes hide prior receipts', async t => {
  const f = await fixture(t); let state = await collectionPlan(f);
  f.hooks.garbageCollect = async (...args) => ({ ...await f.store.garbageCollect(owner, ...args), operationId: 'd'.repeat(64) });
  state = await f.controller.executeCollection(f.input({ planId: state.plan.planId, confirmed: true }));
  assert.equal(state.error, 'asset-response-invalid'); assert.equal(state.receipt, null); assert.equal(state.pending.kind, 'gc');
  delete f.hooks.garbageCollect; state = await f.controller.retry(f.input({ pendingId: state.pending.id })); assert(state.receipt);
  f.account.account.id = 'another-account'; await f.controller.connectionChanged(); state = await f.controller.getState();
  assert.equal(state.receipt, null); assert.equal(state.pending, null);
});
test('schema1 pending journals migrate without changing a request identity and GC journal input remains strict', async t => {
  const f = await fixture(t), binding = 'e'.repeat(64), journal = createAssetLifecycleIntents({ directory: f.journal });
  const old = await journal.begin(binding, { kind: 'hold', projectId: 'film', assetId: f.a.assetId,
    input: { expectedVersion: 0, held: true, reason: 'manual', until: null } });
  const filename = path.join(f.journal, 'lifecycle-intents.json'), prior = JSON.parse(await fs.readFile(filename, 'utf8'));
  await fs.writeFile(filename, JSON.stringify({ schemaVersion: 1, entries: prior.entries }));
  const reopened = createAssetLifecycleIntents({ directory: f.journal }); assert.deepEqual(await reopened.load(binding), old.record);
  await reopened.complete(binding, old.record.id); const upgraded = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(upgraded.schemaVersion, 2); assert.deepEqual(upgraded.receipts, []);
  await assert.rejects(reopened.begin(binding, { kind: 'gc', projectId: 'film', assetId: null,
    input: { assetIds: [f.a.assetId], expectedStateHash: 'a'.repeat(64), planId: 'b'.repeat(64), confirmed: true } }), { code: 'asset-lifecycle-intent-invalid' });
});
