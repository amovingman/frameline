'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDesktopRevisionSync } = require('../src/desktop-revision-sync');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { fingerprint } = require('../src/project-api-contracts');

const error = code => Object.assign(new Error('Bearer fixture-secret /private/fixture-location'), { code });
const manifest = index => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
  sourceHash: createHash('sha256').update(`Desktop sync fixture ${index}`).digest('hex'),
  sequence: { name: 'Desktop fixture', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
function safeState(value, directory) {
  const encoded = JSON.stringify(value);
  for (const forbidden of [directory, 'fixture-secret', 'fixture-location', 'accessToken', 'refreshToken', 'originHash',
    'recordHash', 'ciphertext', 'file://', '/private/', '/Users/']) assert(!encoded.includes(forbidden), forbidden);
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-desktop-sync-test-'));
  const store = createLocalMetadataStore(path.join(directory, 'metadata'));
  const localId = (await store.getProjectId('/private/fixture-location/cut.fcpxml')).id;
  const first = await store.saveRevision(localId, manifest(1), 'First fixture cut');
  const second = await store.saveRevision(localId, manifest(2), 'Second fixture cut', first.id);
  await store.recordSyncBase(localId, 'main', first.id, second.id);
  await store.createBranch(localId, 'alternate', second.id);
  await store.switchBranch(localId, 'main');
  const otherLocalId = (await store.getProjectId('/private/fixture-location/other.fcpxml')).id;
  await store.saveRevision(otherLocalId, manifest(3), 'Other fixture cut');
  let history = createCloudHistoryStore(); history.createProject({ projectId: 'remote-film', name: 'Remote fixture film' });
  history.createBranch('remote-film', 'review');
  let selected = { localProjectId: localId, branch: 'main' };
  let state = { version: 1, status: 'connected', connected: true, busy: false,
    origin: 'https://fixture-service.example.test', account: { id: 'account-owner', email: 'owner@example.test' },
    projects: [{ id: 'remote-film', name: 'Remote fixture film', role: 'owner', branches: ['main', 'review'] }], error: null };
  let networkFailure = false, hook = null, replyHook = null;
  const calls = [], events = [], controllers = [];
  const connection = {
    getState: () => structuredClone(state),
    getClient() {
      const actor = state.account?.id;
      return Object.fromEntries(['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch', 'getRevision',
        'getManifest', 'findRevisionBySource'].map(method => [method, async (...args) => {
        const options = args.pop(); calls.push({ method, args: structuredClone(args), actor });
        if (options?.signal?.aborted) throw error('sync-cancelled');
        if (hook) { const run = hook; hook = null; await run(method, options?.signal); }
        if (options?.signal?.aborted) throw error('sync-cancelled');
        if (networkFailure) throw error('sync-network-unavailable');
        if (!state.account || state.account.id !== actor) throw error('access-token-invalid');
        const role = state.projects.find(project => project.id === 'remote-film')?.role;
        if (!role || ['putManifest', 'createRevision', 'compareAndSwapBranch'].includes(method) && role === 'viewer') throw error('forbidden');
        if (method === 'createRevision') args[0] = { ...args[0], authorId: actor };
        const result = history[method](...args);
        return replyHook ? replyHook(method, result, args) : result;
      }]));
    }
  };
  const controllerDirectory = path.join(directory, 'desktop-service');
  function create() {
    const controller = createDesktopRevisionSync({ directory: controllerDirectory, connection, store,
      getSelection: () => structuredClone(selected), onChange: value => events.push(value) });
    controllers.push(controller); controller.connectionChanged(); return controller;
  }
  t.after(async () => {
    try { for (const controller of controllers) await controller.dispose(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return { directory, controllerDirectory, store, history, localId, otherLocalId, first, second, calls, events, create,
    state: () => state,
    changeState(patch) { state = { ...state, ...structuredClone(patch) }; },
    select(value) { selected = structuredClone(value); },
    offline(value) { networkFailure = value; },
    reply(value) { replyHook = value; }, replaceHistory(value) { history = value; },
    holdNext({ ignoreAbort = false } = {}) {
      let release, entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      hook = async (method, signal) => {
        entered({ method, signal });
        if (ignoreAbort) { await pending; return; }
        await new Promise((resolve, reject) => {
          const aborted = () => { signal?.removeEventListener('abort', aborted); reject(error('sync-cancelled')); };
          signal?.addEventListener('abort', aborted, { once: true });
          pending.then(() => { signal?.removeEventListener('abort', aborted); resolve(); });
          if (signal?.aborted) aborted();
        });
      };
      return { ready, release };
    } };
}
const bind = (controller, remoteBranch = 'main') => controller.bind({ remoteProjectId: 'remote-film', remoteBranch });

test('desktop binding pushes verified local metadata and persists a bounded safe fetched-history DTO', async t => {
  const f = await fixture(t); let controller = f.create();
  const linked = await bind(controller);
  assert.equal(linked.binding.remoteBranch, 'main'); assert.equal(linked.sync.status, 'local-ahead');
  const pushed = await controller.push(); assert.equal(pushed.error, null); assert.equal(pushed.sync.status, 'in-sync'); assert.deepEqual(pushed.operations, []);
  const before = await f.store.exportRevisions(f.localId), base = await f.store.getSyncBase(f.localId, 'main');
  const fetched = await controller.fetch();
  assert.equal(fetched.fetched.total, 2); assert.equal(fetched.fetched.shown, 2);
  assert(Number.isSafeInteger(fetched.fetched.checkedAt));
  assert.equal(fetched.fetched.revisions[0].message, 'Second fixture cut');
  assert.equal(fetched.fetched.revisions[0].authorId, 'account-owner');
  assert.deepEqual(Object.keys(fetched.fetched.revisions[0]).sort(), ['authorId', 'createdAt', 'id', 'message']);
  assert.deepEqual(await f.store.exportRevisions(f.localId), before);
  assert.equal(await f.store.getSyncBase(f.localId, 'main'), base);
  assert.equal(base, f.first.id); safeState(fetched, f.directory);
  const stamp = fetched.fetched.checkedAt; await controller.dispose(); controller = f.create();
  const reopened = await controller.getState();
  assert.equal(reopened.fetched.checkedAt, stamp); assert.deepEqual(reopened.fetched, fetched.fetched);
  assert.equal((await controller.push()).sync.status, 'in-sync');
  assert.equal(f.history.listRevisions('remote-film').items.length, 2);
  const bindingFile = path.join(f.controllerDirectory, 'bindings/bindings.json');
  assert.equal((await fs.stat(bindingFile)).mode & 0o777, 0o600);
  assert(!String(await fs.readFile(bindingFile)).includes(f.state().origin));
});

test('fetching remote-ahead history preserves the selected local branch head and its existing sync base', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller); await controller.push();
  const parent = f.history.getBranch('remote-film', 'main').revisionId;
  const stored = f.history.putManifest('remote-film', manifest(9));
  const incoming = f.history.createRevision({ projectId: 'remote-film', manifestId: stored.id,
    parentRevisionId: parent, sourceRevisionId: 'remote-only-revision', authorId: 'other-editor', message: 'Remote-only cut' });
  f.history.compareAndSwapBranch({ projectId: 'remote-film', branch: 'main', expectedRevisionId: parent, revisionId: incoming.id });
  const before = await f.store.exportRevisions(f.localId);
  assert.equal((await controller.check()).sync.status, 'remote-ahead');
  const result = await controller.fetch(); assert.equal(result.fetched.total, 3); assert.equal(result.fetched.head, incoming.id);
  assert.deepEqual(await f.store.exportRevisions(f.localId), before);
  assert.equal(await f.store.getSyncBase(f.localId, 'main'), f.first.id);
  assert.equal((await f.store.listRevisions(f.localId, 'main'))[0].id, f.second.id);
});

test('large fetched histories expose the latest 100 revision summaries with the full count and no manifests or media', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller); await controller.push();
  let head = f.history.getBranch('remote-film', 'main').revisionId;
  const stored = f.history.putManifest('remote-film', manifest(9));
  for (let index = 1; index <= 103; index++) {
    const incoming = f.history.createRevision({ projectId: 'remote-film', manifestId: stored.id,
      parentRevisionId: head, sourceRevisionId: `incoming-${index}`, authorId: 'other-editor', message: `Incoming revision ${index}` });
    f.history.compareAndSwapBranch({ projectId: 'remote-film', branch: 'main', expectedRevisionId: head, revisionId: incoming.id });
    head = incoming.id;
  }
  const state = await controller.fetch();
  assert.equal(state.fetched.total, 105); assert.equal(state.fetched.revisionCount, 105); assert.equal(state.fetched.shown, 100);
  assert.equal(state.fetched.revisions.length, 100); assert.equal(state.fetched.revisions[0].message, 'Incoming revision 103');
  assert.equal(state.fetched.revisions.at(-1).message, 'Incoming revision 4'); assert.equal(state.fetched.head, head);
  for (const revision of state.fetched.revisions) assert.deepEqual(Object.keys(revision).sort(), ['authorId', 'createdAt', 'id', 'message']);
  assert.equal(Object.hasOwn(state.fetched, 'manifests'), false); assert.equal(Object.hasOwn(state.fetched, 'media'), false);
  safeState(state, f.directory);
});

test('viewer can inspect fetched metadata but cannot enqueue or push saved revisions', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller); await controller.push();
  f.changeState({ projects: [{ ...f.state().projects[0], role: 'viewer' }] }); controller.connectionChanged();
  f.calls.length = 0;
  const denied = await controller.push();
  assert.equal(denied.error, 'service-viewer-read-only'); assert.equal(denied.operations.length, 0);
  assert.equal(f.calls.length, 0);
  const fetched = await controller.fetch(); assert.equal(fetched.fetched.total, 2); assert.equal(fetched.binding.role, 'viewer');
});

test('network failure leaves a durable scoped push which retries after a fresh controller is created', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller); f.offline(true);
  const failed = await controller.push();
  assert.equal(failed.error, 'sync-network-unavailable'); assert.equal(failed.operations.length, 1);
  assert.equal(failed.operations[0].status, 'retry-wait'); safeState(failed, f.directory);
  const id = failed.operations[0].id; await controller.dispose(); controller = f.create();
  assert.equal((await controller.getState()).operations[0].id, id);
  f.offline(false);
  const retried = await controller.retry(id); assert.equal(retried.error, null);
  assert.equal(retried.sync.status, 'in-sync'); assert.equal(retried.operations.length, 0);
  assert.equal(f.history.listRevisions('remote-film').items.length, 2);
});

test('origin, account, local project, local branch and remote branch scopes never borrow another push or cache', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller); await controller.push(); await controller.fetch();
  f.offline(true); await f.store.saveRevision(f.localId, manifest(8), 'Pending main revision', f.second.id);
  const original = await controller.push(); const originalJob = original.operations[0].id;
  const owner = structuredClone(f.state());
  const selectAndCheck = async selection => {
    f.select(selection); controller.selectionChanged(); const value = await controller.getState();
    assert.equal(value.binding, null); assert.equal(value.operations.length, 0); assert.equal(value.fetched, null); safeState(value, f.directory);
  };
  await selectAndCheck({ localProjectId: f.otherLocalId, branch: 'main' });
  await selectAndCheck({ localProjectId: f.localId, branch: 'alternate' });
  await bind(controller, 'review');
  const alternate = await controller.push(); assert.equal(alternate.operations.length, 1);
  assert.notEqual(alternate.operations[0].id, originalJob); assert.equal(alternate.operations[0].branch, 'alternate');
  f.select({ localProjectId: f.localId, branch: 'main' }); controller.selectionChanged();
  assert.equal((await controller.getState()).operations[0].id, originalJob);
  for (const patch of [{ origin: 'https://other-fixture.example.test' }, { account: { id: 'another-account', email: 'other@example.test' } }]) {
    f.changeState({ ...owner, ...patch }); controller.connectionChanged();
    const empty = await controller.getState(); assert.equal(empty.binding, null); assert.equal(empty.operations.length, 0); assert.equal(empty.fetched, null);
  }
  f.changeState(owner); controller.connectionChanged();
  assert.equal((await controller.getState()).operations[0].id, originalJob);
  await bind(controller, 'review');
  const review = await controller.getState(); assert.equal(review.operations.length, 0); assert.equal(review.fetched, null);
  await bind(controller, 'main'); assert.equal((await controller.getState()).operations[0].id, originalJob);
});

test('remote branch remapping advances each real destination with its own compare-and-swap idempotency keys', async t => {
  const f = await fixture(t); const controller = f.create();
  await bind(controller, 'review'); assert.equal((await controller.push()).sync.status, 'in-sync');
  const reviewHead = f.history.getBranch('remote-film', 'review').revisionId;
  assert(reviewHead); assert.equal(f.history.getBranch('remote-film', 'main').revisionId, null);
  await bind(controller, 'main'); assert.equal((await controller.push()).sync.status, 'in-sync');
  assert.equal(f.history.getBranch('remote-film', 'main').revisionId, reviewHead);
  assert.equal(f.history.listRevisions('remote-film').items.length, 2);
  const writes = f.calls.filter(call => call.method === 'compareAndSwapBranch').map(call => call.args[0]);
  assert.deepEqual(new Set(writes.map(write => write.branch)), new Set(['main', 'review']));
  assert.equal(new Set(writes.map(write => write.idempotencyKey)).size, writes.length);
});

test('selection changes abort pending work and prevent a late response from publishing another local branch outcome', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller);
  const held = f.holdNext({ ignoreAbort: true }); const checking = controller.check();
  const request = await held.ready;
  f.select({ localProjectId: f.localId, branch: 'alternate' }); controller.selectionChanged();
  assert.equal(request.signal.aborted, true); held.release();
  const result = await checking;
  assert.deepEqual(result.selection, { localProjectId: f.localId, branch: 'alternate' });
  assert.equal(result.busy, false); assert.equal(result.binding, null); assert.equal(result.sync.status, 'unbound'); assert.equal(result.error, null);
  safeState(result, f.directory);
});

test('disconnect aborts an in-flight push and another account cannot see or process the original queued intent', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller);
  const originalAccount = structuredClone(f.state());
  const held = f.holdNext(); const pushing = controller.push(); const request = await held.ready;
  const originalJob = (await controller.getState()).operations[0].id;
  f.changeState({ status: 'not-configured', connected: false, account: null, origin: null, projects: [] }); controller.connectionChanged();
  assert.equal(request.signal.aborted, true);
  const result = await pushing; assert.equal(result.busy, false); assert.equal(result.binding, null); assert.equal(result.operations.length, 0);
  f.changeState({ status: 'connected', connected: true, origin: 'https://fixture-service.example.test',
    account: { id: 'new-account', email: 'new@example.test' }, projects: [{ id: 'remote-film', name: 'Remote fixture film', role: 'editor', branches: ['main', 'review'] }] });
  controller.connectionChanged();
  const other = await controller.getState(); assert.equal(other.operations.length, 0); assert.equal(other.binding, null);
  assert.equal(f.history.listRevisions('remote-film').items.length, 0); safeState(result, f.directory);
  f.changeState(originalAccount); controller.connectionChanged();
  const restored = await controller.getState();
  assert.equal(restored.operations.length, 1); assert.equal(restored.operations[0].id, originalJob);
  assert.equal(restored.operations[0].status, 'queued'); assert.equal(restored.busy, false);
});

test('binding tampering and injected private fields fail closed without replacing the damaged mapping', async t => {
  const f = await fixture(t); const controller = f.create(); await bind(controller);
  const filename = path.join(f.controllerDirectory, 'bindings/bindings.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const mutate of [value => { value.bindings[0].accessToken = 'fixture-secret'; },
    value => { value.bindings[0].remoteProjectName = '/private/fixture-location'; },
    value => { value.bindings.push(structuredClone(value.bindings[0])); },
    value => { value.version = 2; }]) {
    const value = structuredClone(original); mutate(value); const bytes = JSON.stringify(value); await fs.writeFile(filename, bytes);
    const state = await controller.getState(); assert.equal(state.error, 'service-binding-invalid');
    assert.equal(state.binding, null); assert.equal(state.fetched, null); assert.equal(state.operations.length, 0);
    safeState(state, f.directory); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
});

test('cancel, unlink and dispose abort active work while preserving terminal state and sanitized notifications', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller);
  const held = f.holdNext(); const pushing = controller.push(); const request = await held.ready;
  const job = (await controller.getState()).operations[0]; assert(job);
  await controller.cancel(job.id); await pushing;
  assert.equal(request.signal.aborted, true); assert.equal((await controller.getState()).operations.length, 0);
  assert.equal((await controller.getState()).busy, false);
  const pending = f.holdNext(); const checking = controller.check(); const running = await pending.ready;
  const unlinked = await controller.unlink(); await checking;
  assert.equal(running.signal.aborted, true); assert.equal(unlinked.binding, null); assert.equal(unlinked.busy, false);
  await bind(controller);
  const disposing = f.holdNext(); const inFlight = controller.check(); const disposingRequest = await disposing.ready;
  await controller.dispose(); await inFlight; assert.equal(disposingRequest.signal.aborted, true);
  const count = f.events.length; controller.selectionChanged(); controller.connectionChanged();
  await assert.rejects(controller.check(), { code: 'service-sync-failed' });
  await assert.rejects(controller.bind({ remoteProjectId: 'remote-film', remoteBranch: 'main' }), { code: 'service-sync-failed' });
  assert.equal(f.events.length, count);
  for (const event of f.events) safeState(event, f.directory);
  controller = f.create(); assert.equal((await controller.getState()).operations.length, 0);
});

function sharedScope(f, remoteBranch = 'main', localBranch = 'main') {
  return { originHash: fingerprint(f.state().origin), accountId: f.state().account.id, localProjectId: f.localId,
    localBranch, remoteProjectId: 'remote-film', remoteBranch };
}
test('verified sharing records a scoped base and immutable proof without populating explicit fetched history', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller);
  assert.equal((await controller.getState()).base.status, 'none');
  const state = await controller.push(); assert.equal(state.error, null); assert.equal(state.base.status, 'recorded');
  assert.equal(state.base.localRevisionId, f.second.id); assert.equal(state.base.remoteRevisionId, state.sync.remoteHead);
  assert.equal(state.fetched, null); assert.equal(await f.store.getSyncBase(f.localId, 'main'), f.first.id);
  const saved = await f.store.getServiceSyncBase(sharedScope(f)); assert.equal(saved.recordHash, (await f.store.listRevisions(f.localId, 'main'))[0].recordHash);
  const proof = path.join(f.controllerDirectory, 'scopes', fingerprint(sharedScope(f)), 'cache', 'snapshots', `${saved.proofSnapshotHash}.json`);
  assert.equal((await fs.stat(proof)).mode & 0o777, 0o600);
  const stamp = state.base.verifiedAt; await controller.dispose(); f.calls.length = 0; controller = f.create();
  const restored = await controller.getState(); assert.equal(restored.base.localRevisionId, f.second.id); assert.equal(restored.base.verifiedAt, stamp);
  assert.equal(f.calls.length, 0); assert.equal(restored.fetched, null); safeState(restored, f.directory);
});
test('full ancestry preserves the shared point across local-ahead, remote-ahead and divergent histories', async t => {
  const f = await fixture(t), controller = f.create(); await bind(controller); await controller.push();
  const remoteBase = f.history.getBranch('remote-film', 'main').revisionId;
  const third = await f.store.saveRevision(f.localId, manifest(3), 'Local third cut', f.second.id); controller.selectionChanged();
  const ahead = await controller.check(); assert.equal(ahead.sync.status, 'local-ahead'); assert.equal(ahead.base.localRevisionId, f.second.id);
  const incomingManifest = f.history.putManifest('remote-film', manifest(9));
  const incoming = f.history.createRevision({ projectId: 'remote-film', manifestId: incomingManifest.id, parentRevisionId: remoteBase,
    authorId: 'other-editor', sourceRevisionId: 'other-source', message: 'Independent incoming edit' });
  f.history.compareAndSwapBranch({ projectId: 'remote-film', branch: 'main', expectedRevisionId: remoteBase, revisionId: incoming.id });
  const divergent = await controller.fetch(); assert.equal(divergent.sync.status, 'diverged'); assert.equal(divergent.base.localRevisionId, f.second.id);
  assert.equal(divergent.base.remoteRevisionId, remoteBase); assert.equal((await f.store.listRevisions(f.localId, 'main'))[0].id, third.id);
  assert.equal(divergent.fetched.total, 3); assert.equal(await f.store.getSyncBase(f.localId, 'main'), f.first.id);
});
test('a completed remote push with failed base persistence keeps the prior receipt until explicit repair', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller); await controller.push();
  const third = await f.store.saveRevision(f.localId, manifest(3), 'Third cut for receipt', f.second.id); controller.selectionChanged();
  const record = f.store.recordServiceSyncBase; let refuse = true;
  f.store.recordServiceSyncBase = input => refuse && input.candidate.localRevisionId === third.id
    ? Promise.reject(error('metadata-unavailable')) : record(input);
  const failed = await controller.push(); assert.equal(failed.error, 'metadata-unavailable'); assert.equal(failed.operations.length, 0);
  assert.equal(failed.base.status, 'unconfirmed'); assert.equal(failed.base.localRevisionId, f.second.id);
  assert.equal(f.history.listRevisions('remote-film').items.length, 3);
  await controller.dispose(); controller = f.create();
  assert.equal((await controller.getState()).base.localRevisionId, f.second.id);
  refuse = false; const repaired = await controller.check(); assert.equal(repaired.error, null); assert.equal(repaired.base.status, 'recorded');
  assert.equal(repaired.base.localRevisionId, third.id); assert.equal(f.history.listRevisions('remote-film').items.length, 3);
});
test('lost branch acknowledgments recover one shared base without duplicate remote revisions', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller); let lose = true;
  f.reply((method, result) => { if (method === 'compareAndSwapBranch' && lose) { lose = false; throw error('sync-network-unavailable'); } return result; });
  const interrupted = await controller.push(); assert.equal(interrupted.operations.length, 1); assert.equal(interrupted.base.status, 'none');
  assert.equal(f.history.listRevisions('remote-film').items.length, 1); const id = interrupted.operations[0].id;
  await controller.dispose(); controller = f.create(); const resumed = await controller.retry(id);
  assert.equal(resumed.error, null); assert.equal(resumed.base.localRevisionId, f.second.id); assert.equal(resumed.operations.length, 0);
  assert.equal(f.history.listRevisions('remote-film').items.length, 2);
});
test('a missing immutable proof is not displayed as confirmed and live verification must reproduce its recorded hash to repair it', async t => {
  const f = await fixture(t); let controller = f.create(); await bind(controller); await controller.push();
  const scope = sharedScope(f), saved = await f.store.getServiceSyncBase(scope); await controller.dispose();
  await fs.rm(path.join(f.controllerDirectory, 'scopes', fingerprint(scope), 'cache', 'snapshots', `${saved.proofSnapshotHash}.json`));
  controller = f.create(); f.calls.length = 0; const invalid = await controller.getState();
  assert.equal(invalid.base.status, 'invalid'); assert.equal(invalid.base.localRevisionId, null); assert.equal(f.calls.length, 0);
  const repaired = await controller.check(); assert.equal(repaired.error, null); assert.equal(repaired.base.status, 'recorded');
  assert.equal(repaired.base.localRevisionId, f.second.id); assert((await f.store.getServiceSyncBase(scope)).version > saved.version);
});
test('rewritten remote IDs cannot advance a confirmed shared lineage even when local source IDs and manifests match', async t => {
  const f = await fixture(t), controller = f.create(); await bind(controller); const original = await controller.push();
  const before = await f.store.getServiceSyncBase(sharedScope(f));
  const replacement = createCloudHistoryStore(); replacement.createProject({ projectId: 'remote-film', name: 'Restored remote film' });
  let parent = null;
  for (const local of [f.first, f.second]) {
    const document = await f.store.getRevision(f.localId, local.id), stored = replacement.putManifest('remote-film', document.manifest);
    const revision = replacement.createRevision({ projectId: 'remote-film', manifestId: stored.id, parentRevisionId: parent,
      sourceRevisionId: local.id, authorId: 'account-owner', message: local.message });
    replacement.compareAndSwapBranch({ projectId: 'remote-film', branch: 'main', expectedRevisionId: parent, revisionId: revision.id }); parent = revision.id;
  }
  f.replaceHistory(replacement); const changed = await controller.fetch(); assert.equal(changed.error, 'sync-base-regression');
  assert.equal(changed.base.remoteRevisionId, original.base.remoteRevisionId); assert.equal(changed.fetched.head, parent);
  assert.deepEqual(await f.store.getServiceSyncBase(sharedScope(f)), before);
});
test('another account gets separate evidence and preserves the original authenticated publisher on reused revisions', async t => {
  const f = await fixture(t), controller = f.create(); await bind(controller); const first = await controller.push();
  f.changeState({ account: { id: 'another-account', email: 'other@example.test' } }); controller.connectionChanged();
  assert.equal((await controller.getState()).base.status, 'none'); await bind(controller);
  const verified = await controller.check(); assert.equal(verified.base.localRevisionId, first.base.localRevisionId);
  const saved = await f.store.getServiceSyncBase(sharedScope(f)); assert.equal(saved.scope.accountId, 'another-account');
  assert.equal(saved.remoteAuthorId, 'account-owner'); assert.equal(f.history.listRevisions('remote-film').items.length, 2);
});
test('freshly known access removal hides saved base, fetched history and queued work', async t => {
  const f = await fixture(t), controller = f.create(); await bind(controller); await controller.push(); await controller.fetch();
  assert.equal((await controller.getState()).base.status, 'recorded');
  f.changeState({ projects: [] }); controller.connectionChanged(); const lost = await controller.getState();
  assert.equal(lost.binding, null); assert.equal(lost.base.status, 'none'); assert.equal(lost.base.localRevisionId, null);
  assert.equal(lost.fetched, null); assert.deepEqual(lost.operations, []);
});
