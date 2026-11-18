'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createDesktopResolveServiceSync } = require('../src/desktop-resolve-service-sync');
const { createDesktopRevisionSync } = require('../src/desktop-revision-sync');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const snapshot = (projectId = 'resolve-editor-project') => ({ schema_version: 3, resolve_version: '21.1.2.10', project_id: projectId,
  project_name: 'Disposable Resolve', timelines: [{ id: 'timeline', name: 'Timeline', start_frame: 0,
    tracks: [{ type: 'video', index: 1, name: 'Video 1' }], items: [{ id: 'clip', track_type: 'video', track_index: 1, type: 'video', name: 'Original clip',
      start_frame: 0, end_frame: 10, source_start_frame: 0, source_end_frame: 10, media_pool_id: 'media', linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }] }] });
const scan = () => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: 'f'.repeat(64),
  sequence: { name: 'Export', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
const failure = code => Object.assign(new Error('/private/credential-secret'), { code });
const clone = value => structuredClone(value);
function safe(state, directory) {
  const text = JSON.stringify(state);
  for (const value of [directory, '/private/', 'credential-secret', 'requestSha256', 'requestId', 'proofHash', 'recordHash', 'privateResult', 'timelines', 'snapshot', 'sources']) assert(!text.includes(value), value);
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-resolve-service-')), controllers = [];
  t.after(async () => { try { for (const controller of controllers) await controller.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  const actualStore = createLocalMetadataStore(path.join(directory, 'metadata')), original = snapshot();
  const projectId = (await actualStore.getResolveProjectId(original.project_id, 'Disposable Resolve')).id;
  const first = await actualStore.saveRevision(projectId, createResolveRevisionManifest(original), 'Base');
  const otherSnapshot = snapshot('other-editor-project'), otherId = (await actualStore.getResolveProjectId(otherSnapshot.project_id, 'Other Resolve')).id;
  await actualStore.saveRevision(otherId, createResolveRevisionManifest(otherSnapshot), 'Other base');
  const exportId = (await actualStore.getProjectId('/private/export.fcpxml')).id; await actualStore.saveRevision(exportId, scan(), 'Export base');
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'remote-resolve', name: 'Resolve' }); history.createBranch('remote-resolve', 'review');
  history.createProject({ projectId: 'remote-export', name: 'Export' });
  let connectionState = { version: 1, status: 'connected', connected: true, busy: false, origin: 'https://fixture.example.test', account: { id: 'owner', email: 'owner@example.test' },
    projects: [{ id: 'remote-resolve', name: 'Resolve', role: 'owner', branches: ['main', 'review'] }, { id: 'remote-export', name: 'Export', role: 'owner', branches: ['main'] }], error: null };
  let offline = false, hook = null, time = 2000, invalidations = 0;
  let capture = { manifest: createResolveRevisionManifest(original), verification: { mode: 'verified-capture', generation: 1,
    requestId: 'a'.repeat(32), requestSha256: 'b'.repeat(64), acceptedAt: 1000 } };
  const calls = [], events = [];
  const store = { ...actualStore, async getResolveRevisionGraph(...args) { const result = await actualStore.getResolveRevisionGraph(...args); if (hook) await hook('graph', args, result); return result; },
    async exportRevisions(...args) { const result = await actualStore.exportRevisions(...args); if (hook) await hook('export', args, result); return result; } };
  const connection = { getState: () => clone(connectionState), getClient: () => {
    const actor = connectionState.account?.id;
    return Object.fromEntries(['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch', 'getRevision', 'getManifest', 'findRevisionBySource'].map(method => [method, async (...args) => {
      const options = args.pop(); calls.push(method);
      if (options?.signal?.aborted) throw failure('sync-cancelled'); if (offline) throw failure('sync-network-unavailable');
      if (connectionState.account?.id !== actor) throw failure('access-token-invalid');
      if (method === 'createRevision') args[0] = { ...args[0], authorId: actor };
      return history[method](...args);
    }]));
  } };
  function create() { const value = createDesktopResolveServiceSync({ directory: path.join(directory, 'resolve-sync'), connection, store,
    getCapture: () => clone(capture), now: () => time, onChange: state => events.push(state), onInvalidate: () => { invalidations++; } }); controllers.push(value); value.connectionChanged(); return value; }
  const controller = create();
  async function prepare(branch = 'main') { await controller.select(projectId); await controller.bind({ remoteProjectId: 'remote-resolve', remoteBranch: branch });
    assert.equal((await controller.push()).error, null); await controller.fetch(); }
  return { directory, store, actualStore, projectId, otherId, exportId, first, original, history, connection, calls, events, controller, create, prepare,
    invalidations: () => invalidations, capture: () => clone(capture), setCapture: value => { capture = clone(value); },
    changeAccount: patch => { connectionState = { ...connectionState, ...clone(patch) }; }, setTime: value => { time = value; },
    setHook: value => { hook = value; }, offline: value => { offline = value; }, controllers };
}

test('Resolve preview uses private captured sources, preserves history and publishes only a detached summary', async t => {
  const f = await fixture(t); await f.prepare('review'); const current = snapshot(); current.timelines[0].items[0].name = 'Unsaved local name';
  f.setCapture({ ...f.capture(), manifest: createResolveRevisionManifest(current) });
  const before = await f.actualStore.exportRevisions(f.projectId), network = f.calls.length;
  const state = await f.controller.preview({ source: 'verified-capture' }); assert.equal(state.comparison.status, 'ready');
  assert.equal(state.comparison.result.decisionCount, 1); assert.equal(state.comparison.result.source, 'verified-capture');
  const preview = await f.controller.getPreview(); assert(preview.sources.local.includes('Unsaved local name'));
  assert.equal(preview.binding.scope.remoteBranch, 'review'); assert.equal(preview.plan.safeToApply, false);
  assert.equal(f.calls.length, network); assert.deepEqual(await f.actualStore.exportRevisions(f.projectId), before);
  const sources = await f.controller.readPreviewSources(preview.binding); assert.equal(sources.local, preview.sources.local);
  assert.equal(f.invalidations(), 0, 'unchanged source revalidation must preserve the accepted review');
  preview.sources.local = 'tampered'; assert.notEqual((await f.controller.getPreview()).sources.local, 'tampered');
  await assert.rejects(f.controller.readPreviewSources({ privatePath: '/private/credential-secret' }), { code: 'service-resolve-preview-stale' });
  for (const event of [...f.events, state]) safe(event, f.directory);
});

test('capture expiry clears accepted private preview and its public ready claim', async t => {
  const f = await fixture(t); await f.prepare(); await f.controller.preview({ source: 'verified-capture' });
  const binding = (await f.controller.getPreview()).binding; f.setTime(301001);
  const state = await f.controller.getState(); assert.notEqual(state.comparison.status, 'ready'); assert.equal(state.comparison.result, null);
  assert.equal(await f.controller.getPreview(), null); assert(f.invalidations() >= 1);
  await assert.rejects(f.controller.readPreviewSources(binding), { code: 'service-resolve-preview-stale' });
  f.setTime(2000); await f.controller.preview({ source: 'verified-capture' }); f.setTime(999);
  assert.notEqual((await f.controller.getState()).comparison.status, 'ready'); assert.equal(await f.controller.getPreview(), null);
});

test('capture generation or account changes during verified reads cannot publish late preview sources', async t => {
  const f = await fixture(t); await f.prepare(); let graphs = 0;
  f.setHook(async method => { if (method === 'graph' && ++graphs === 2) { const value = f.capture(); value.verification.generation++; f.setCapture(value); f.controller.captureChanged(); } });
  const changed = await f.controller.preview({ source: 'verified-capture' }); assert.notEqual(changed.comparison.status, 'ready'); assert.equal(await f.controller.getPreview(), null);
  f.setHook(null); await f.controller.preview({ source: 'verified-capture' });
  graphs = 0; f.setHook(async method => { if (method === 'graph' && ++graphs === 2) { f.changeAccount({ account: { id: 'other-account', email: 'other@example.test' } }); f.controller.connectionChanged(); } });
  const other = await f.controller.preview({ source: 'verified-capture' }); assert.equal(other.account.id, 'other-account'); assert.equal(other.binding, null);
  assert.equal(other.comparison.result, null); assert.equal(await f.controller.getPreview(), null); safe(other, f.directory);
});

test('selection races reject old graph results and never return another project private sources', async t => {
  const f = await fixture(t); await f.prepare(); let entered, release, hold = true;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.setHook(async (method, args) => { if (method === 'graph' && args[0] === f.projectId && hold) { hold = false; entered(); await blocked; } });
  const preview = f.controller.preview({ source: 'verified-capture' }); await ready;
  await f.controller.select(f.otherId); release(); const state = await preview;
  assert.equal(state.local.projectId, f.otherId); assert.equal(state.binding, null); assert.equal(state.comparison.result, null);
  assert.equal(await f.controller.getPreview(), null); safe(state, f.directory);
});

test('local head mutation and explicit branch reselection invalidate accepted preview bindings', async t => {
  const f = await fixture(t); await f.prepare(); await f.controller.preview({ source: 'saved-head' }); const prior = await f.controller.getPreview();
  const changed = snapshot(); changed.timelines[0].items[0].name = 'Saved child';
  await f.actualStore.saveRevision(f.projectId, createResolveRevisionManifest(changed), 'Child', f.first.id);
  assert.equal(await f.controller.getPreview(), null); await assert.rejects(f.controller.readPreviewSources(prior.binding), { code: 'service-resolve-preview-stale' });
  await f.controller.push(); await f.controller.fetch(); await f.controller.preview({ source: 'saved-head' });
  await f.actualStore.createBranch(f.projectId, 'alternate', (await f.actualStore.exportRevisions(f.projectId)).branches.main);
  const requests = f.calls.length;
  await assert.rejects(f.controller.push(), { code: 'service-selection-changed' }); assert.equal(f.calls.length, requests);
  assert.equal(await f.controller.getPreview(), null);
  await f.controller.select(f.projectId); const next = await f.controller.getState(); assert.equal(next.local.branch, 'alternate');
  assert.equal(next.binding, null); assert.equal(next.comparison.result, null); assert.equal(await f.controller.getPreview(), null);
});

test('FCPXML and Resolve bindings, durable queued intents and cache do not borrow each other', async t => {
  const f = await fixture(t), exportController = createDesktopRevisionSync({ directory: path.join(f.directory, 'export-sync'), connection: f.connection, store: f.store,
    getSelection: () => ({ localProjectId: f.exportId, branch: 'main' }) }); f.controllers.push(exportController);
  await exportController.bind({ remoteProjectId: 'remote-export', remoteBranch: 'main' });
  await f.controller.select(f.projectId); await f.controller.bind({ remoteProjectId: 'remote-resolve', remoteBranch: 'main' }); f.offline(true);
  const exportState = await exportController.push(), resolveState = await f.controller.push();
  assert.equal(exportState.operations.length, 1); assert.equal(resolveState.operations.length, 1); assert.notEqual(exportState.operations[0].id, resolveState.operations[0].id);
  f.offline(false); await f.controller.retry(resolveState.operations[0].id); await f.controller.fetch();
  assert.equal((await f.controller.getState()).operations.length, 0); assert.equal((await exportController.getState()).operations[0].id, exportState.operations[0].id);
  assert.equal((await exportController.getState()).fetched, null); assert.equal((await f.controller.getState()).binding.remoteProjectId, 'remote-resolve');
});

test('an account replacement during the wrapper action preflight cannot dispatch the original click under the new account', async t => {
  const f = await fixture(t); await f.prepare(); let entered, release, hold = true;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.setHook(async method => { if (method === 'graph' && hold) { hold = false; entered(); await blocked; } });
  const pushing = f.controller.push(); await ready; const requests = f.calls.length;
  f.changeAccount({ account: { id: 'replacement-account', email: 'other@example.test' } }); f.controller.connectionChanged(); release();
  await assert.rejects(pushing, { code: 'service-selection-changed' }); assert.equal(f.calls.length, requests);
  assert.equal((await f.controller.getState()).account.id, 'replacement-account'); assert.equal(await f.controller.getPreview(), null);
});

test('a local head changed between verified reads refuses current sources and a fresh wrapper never restores an accepted live preview', async t => {
  const f = await fixture(t); await f.prepare(); let graphs = 0;
  f.setHook(async method => { if (method === 'graph' && ++graphs === 2) {
    const value = snapshot(); value.timelines[0].items[0].name = 'Concurrent save';
    await f.actualStore.saveRevision(f.projectId, createResolveRevisionManifest(value), 'Concurrent save', f.first.id);
  } });
  const changed = await f.controller.preview({ source: 'verified-capture' }); assert.equal(changed.comparison.result, null); assert.equal(await f.controller.getPreview(), null);
  f.setHook(null); await f.controller.select(f.projectId); await f.controller.push(); await f.controller.fetch();
  await f.controller.preview({ source: 'verified-capture' }); assert(await f.controller.getPreview()); await f.controller.dispose();
  const reopened = f.create(); await reopened.select(f.projectId);
  const restored = await reopened.getState(); assert.equal(restored.base.status, 'recorded'); assert.equal(restored.comparison.result, null); assert.equal(await reopened.getPreview(), null);
});

test('capture replacement retires an accepted binding even when its snapshot bytes are identical', async t => {
  const f = await fixture(t); await f.prepare(); await f.controller.preview({ source: 'verified-capture' }); const before = await f.controller.getPreview();
  const current = f.capture(); current.verification.generation++; f.setCapture(current); f.controller.captureChanged();
  assert.equal(f.invalidations(), 1); assert.equal(await f.controller.getPreview(), null);
  await assert.rejects(f.controller.readPreviewSources(before.binding), { code: 'service-resolve-preview-stale' });
  await f.controller.preview({ source: 'verified-capture' }); const after = await f.controller.getPreview(); assert.notEqual(after.id, before.id);
  assert.equal(after.sources.local, before.sources.local); assert.notDeepEqual(after.binding.localVerification, before.binding.localVerification);
});

test('every Resolve service action returns the decorated local selection with its real queue and history result', async t => {
  const f = await fixture(t); await f.controller.select(f.projectId);
  const local = (await f.controller.getState()).local;
  const checkResult = async result => {
    assert.deepEqual(result.local, local); assert.deepEqual(result.local, (await f.controller.getState()).local);
    safe(result, f.directory); return result;
  };
  assert.equal((await checkResult(await f.controller.bind({ remoteProjectId: 'remote-resolve', remoteBranch: 'main' }))).binding.remoteProjectId, 'remote-resolve');
  assert.equal((await checkResult(await f.controller.check())).sync.status, 'local-ahead');
  assert.equal((await checkResult(await f.controller.push())).sync.status, 'in-sync');
  assert.equal((await checkResult(await f.controller.fetch())).fetched.total, 1);
  f.offline(true);
  const queued = await checkResult(await f.controller.push()); assert.equal(queued.operations.length, 1);
  const cancelled = await checkResult(await f.controller.cancel(queued.operations[0].id)); assert.deepEqual(cancelled.operations, []);
  const pending = await checkResult(await f.controller.push()); assert.equal(pending.operations.length, 1);
  f.offline(false);
  const retried = await checkResult(await f.controller.retry(pending.operations[0].id));
  assert.equal(retried.sync.status, 'in-sync'); assert.deepEqual(retried.operations, []);
  const unlinked = await checkResult(await f.controller.unlink()); assert.equal(unlinked.binding, null);
  assert.equal(unlinked.fetched, null); assert.deepEqual(unlinked.operations, []);
});

test('retirement during the private preview getter returns null without dereferencing a retired binding', async t => {
  const f = await fixture(t); await f.prepare(); await f.controller.preview({ source: 'verified-capture' });
  assert(await f.controller.getPreview());
  let entered, release, exports = 0;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  // getPreview first validates its public state, then independently validates
  // the private source result. Hold that second read without changing scope.
  f.setHook(async method => { if (method === 'export' && ++exports === 2) { entered(); await blocked; } });
  const pending = f.controller.getPreview(); await ready;
  f.setTime(301001); const retired = await f.controller.getState();
  assert.equal(retired.comparison.result, null); assert.equal(f.invalidations(), 1);
  release(); assert.equal(await pending, null);
  assert.equal(await f.controller.getPreview(), null);
});

test('retirement during source revalidation cannot resurrect the accepted private review', async t => {
  const f = await fixture(t); await f.prepare(); await f.controller.preview({ source: 'verified-capture' });
  const accepted = await f.controller.getPreview(); let graphs = 0, holdNextExport = false, entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.setHook(async method => {
    // Once the second capture read begins, the pure comparison has already
    // been assembled. Hold its final local-history recheck before delivery.
    if (method === 'graph' && ++graphs === 2) holdNextExport = true;
    if (method === 'export' && holdNextExport) { holdNextExport = false; entered(); await blocked; }
  });
  const pending = f.controller.readPreviewSources(accepted.binding);
  const rejected = assert.rejects(pending, { code: 'service-resolve-preview-stale' });
  await ready; f.setTime(301001);
  assert.equal((await f.controller.getState()).comparison.result, null); assert.equal(f.invalidations(), 1);
  // Restore the clock before releasing the unchanged proof. The binding and
  // generic controller generation still match; retirement itself must win.
  f.setTime(2000); release(); await rejected;
  assert.equal(await f.controller.getPreview(), null);
  await assert.rejects(f.controller.readPreviewSources(accepted.binding), { code: 'service-resolve-preview-stale' });
});
