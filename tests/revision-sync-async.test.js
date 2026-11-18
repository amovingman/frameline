const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAsyncRevisionSyncService } = require('../src/revision-sync-async');

function bundle(count = 2) {
  const projectId = randomUUID(); const records = []; let parentRevisionId = null;
  for (let index = 0; index < count; index++) {
    const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: String(index + 1).repeat(64),
      sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
    const record = { id: randomUUID(), projectId, parentRevisionId, author: 'Editor', createdAt: new Date(index).toISOString(),
      message: `Revision ${index + 1}`, editorVersion: null, manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
    const bytes = `${JSON.stringify(record, null, 2)}\n`; const { manifest: omitted, ...summary } = record;
    summary.recordHash = createHash('sha256').update(bytes).digest('hex'); records.push({ summary, bytes }); parentRevisionId = record.id;
  }
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: parentRevisionId }, records };
}
function fixture(projectId = 'remote-1') {
  const store = createCloudHistoryStore(); store.createProject({ projectId, name: 'Film' });
  const remote = Object.fromEntries(['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch', 'getRevision', 'getManifest', 'findRevisionBySource']
    .map(name => [name, async (...args) => { await new Promise(resolve => setImmediate(resolve)); return store[name](...args); }]));
  return { store, remote, input: { remoteProjectId: projectId, bundle: bundle(), authorId: 'user-1' } };
}

test('awaits a genuinely asynchronous remote, keeps bounded retry identity, and fetches validated metadata', async () => {
  const projectId = 'r'.repeat(128); const { store, remote, input } = fixture(projectId); const keys = []; const progress = [];
  const create = remote.createRevision; remote.createRevision = async (value, opts) => { keys.push(value.idempotencyKey); return create(value, opts); };
  const sync = createAsyncRevisionSyncService(remote); const pushed = await sync.push(input, { onProgress: value => progress.push(value) });
  assert.equal(pushed.pushed, 2); assert.equal((await sync.push(input)).pushed, 0); assert.equal(keys.length, 2);
  assert.ok(keys.every(key => key.length <= 128)); assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(progress, [{ completed: 0, total: 2 }, { completed: 1, total: 2 }, { completed: 2, total: 2 }]);
  const fetched = await sync.fetch(input); assert.equal(fetched.revisions.length, 2); assert.equal(fetched.mediaFetched, false);
  assert.equal(fetched.head, store.getBranch(projectId, 'main').revisionId); assert.doesNotMatch(JSON.stringify(fetched), /file:\/\//);
});

test('lost branch acknowledgment retries by source identity without another revision', async () => {
  const { store, remote, input } = fixture(); const cas = remote.compareAndSwapBranch; let lose = true;
  remote.compareAndSwapBranch = async (...args) => { const result = await cas(...args); if (lose) { lose = false; throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); } return result; };
  const sync = createAsyncRevisionSyncService(remote);
  await assert.rejects(sync.push(input), { code: 'ECONNRESET' });
  assert.equal(store.listRevisions('remote-1').items.length, 1);
  assert.equal((await sync.push(input)).pushed, 1); assert.equal(store.listRevisions('remote-1').items.length, 2);
});

test('a competing async branch advance survives a rejected push', async () => {
  const { store, remote, input } = fixture(); const cas = remote.compareAndSwapBranch; let winner;
  remote.compareAndSwapBranch = async (value, opts) => {
    if (!winner) {
      const manifest = store.putManifest('remote-1', JSON.parse(input.bundle.records[0].bytes).manifest);
      winner = store.createRevision({ projectId: 'remote-1', manifestId: manifest.id, parentRevisionId: value.expectedRevisionId, authorId: 'user-2', message: 'Other edit' });
      store.compareAndSwapBranch({ ...value, revisionId: winner.id, idempotencyKey: null });
    }
    return cas(value, opts);
  };
  await assert.rejects(createAsyncRevisionSyncService(remote).push(input), error => error.code === 'sync-branch-conflict' && error.actualRemoteHead === winner.id);
  assert.equal(store.getBranch('remote-1', 'main').revisionId, winner.id);
});

test('aborted requests cannot publish cache or continue creating revisions', async () => {
  const { remote, input, store } = fixture(); const controller = new AbortController(); let stored = false;
  const get = remote.getBranch; remote.getBranch = async (...args) => { const value = await get(...args); controller.abort(); return value; };
  const sync = createAsyncRevisionSyncService(remote, { cache: { store() { stored = true; }, read() {} } });
  await assert.rejects(sync.push(input, { signal: controller.signal }), { code: 'sync-cancelled' });
  await assert.rejects(sync.fetch(input, { signal: controller.signal }), { code: 'sync-cancelled' });
  assert.equal(stored, false); assert.equal(store.listRevisions('remote-1').items.length, 0);
});

test('fetch rejects wrong project, cyclic or oversized ancestry and tampered manifests before cache update', async () => {
  const { remote, input } = fixture(); const sync = createAsyncRevisionSyncService(remote); await sync.push(input);
  const get = remote.getRevision; const getManifest = remote.getManifest; let writes = 0;
  const checked = () => createAsyncRevisionSyncService(remote, { cache: { store() { writes++; }, read() {} } });
  remote.getRevision = async (...args) => ({ ...await get(...args), projectId: 'other-project' });
  await assert.rejects(checked().fetch(input), { code: 'sync-history-invalid' });
  remote.getRevision = async (...args) => { const record = await get(...args); return { ...record, parentRevisionId: record.id }; };
  await assert.rejects(checked().fetch(input), { code: 'sync-history-invalid' });
  remote.getRevision = get;
  await assert.rejects(createAsyncRevisionSyncService(remote, { maxHistory: 1 }).fetch(input), { code: 'sync-history-invalid' });
  remote.getManifest = async (...args) => { const value = await getManifest(...args); value.document.sequence.name = 'Changed'; return value; };
  await assert.rejects(checked().fetch(input), { code: 'sync-history-invalid' }); assert.equal(writes, 0);
});

test('response projection removes unexpected server fields from offline history', async () => {
  const { remote, input } = fixture(); const sync = createAsyncRevisionSyncService(remote); await sync.push(input);
  const get = remote.getRevision; remote.getRevision = async (...args) => ({ ...await get(...args), privatePath: '/Users/private/media.mov', token: 'private-token' });
  const result = await sync.fetch(input); assert.doesNotMatch(JSON.stringify(result), /privatePath|private-token|Users/);
});

test('an existing source identity must represent the exact local manifest and parent', async () => {
  const { remote, input } = fixture(); const sync = createAsyncRevisionSyncService(remote); await sync.push(input);
  const find = remote.findRevisionBySource;
  remote.findRevisionBySource = async (...args) => { const value = await find(...args); return value ? { ...value, parentRevisionId: null } : null; };
  await assert.rejects(sync.push(input), { code: 'sync-history-invalid' });
  remote.findRevisionBySource = async (...args) => { const value = await find(...args); return value ? { ...value, message: 'Different contents' } : null; };
  await assert.rejects(sync.divergence(input), { code: 'sync-history-invalid' });
});

test('malformed remote values fail closed instead of treating coercible missing IDs as identifiers', async () => {
  const { remote, input } = fixture(); remote.getBranch = async () => ({ projectId: 'remote-1', branch: 'main' });
  const sync = createAsyncRevisionSyncService(remote);
  await assert.rejects(sync.fetch(input), { code: 'sync-history-invalid' });
  await assert.rejects(sync.fetch({ remoteProjectId: null }), { code: 'sync-branch-invalid' });
});

test('one immutable revision chain can advance two branches with independent idempotent CAS keys', async () => {
  const { store, remote, input } = fixture(); store.createBranch('remote-1', 'review');
  input.bundle.branches.review = input.bundle.branches.main;
  const sync = createAsyncRevisionSyncService(remote); const keys = new Map(); const cas = remote.compareAndSwapBranch;
  remote.compareAndSwapBranch = async (value, opts) => {
    keys.set(`${value.branch}:${value.revisionId}`, value.idempotencyKey); return cas(value, opts);
  };
  const main = await sync.push(input); const review = await sync.push({ ...input, branch: 'review' });
  assert.equal(main.pushed, 2); assert.equal(review.pushed, 2); assert.equal(review.remoteHead, main.remoteHead);
  assert.equal(store.listRevisions('remote-1').items.length, 2);
  assert.equal(store.getBranch('remote-1', 'main').revisionId, store.getBranch('remote-1', 'review').revisionId);
  assert.notEqual(keys.get(`main:${main.remoteHead}`), keys.get(`review:${review.remoteHead}`));
  assert.equal((await sync.push(input)).pushed, 0);
  assert.equal((await sync.push({ ...input, branch: 'review' })).pushed, 0);
  assert.equal(store.listRevisions('remote-1').items.length, 2);
});
