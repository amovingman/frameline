const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createRevisionSyncService } = require('../src/revision-sync');
const { createRevisionCache } = require('../src/revision-cache');

const manifest = marker => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
  sourceHash: marker.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 },
  clips: [], media: [], warnings: [] });
function bundle(count, projectId = randomUUID()) {
  const records = []; let parentRevisionId = null;
  for (let index = 0; index < count; index++) {
    const record = { id: randomUUID(), projectId, parentRevisionId, author: 'Local editor',
      createdAt: new Date(index).toISOString(), message: `Revision ${index + 1}`, editorVersion: null,
      manifestVersion: 2, contentHash: String(index + 1).repeat(64), manifest: manifest(String(index + 1)) };
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    const { manifest: _manifest, ...summary } = record;
    summary.recordHash = createHash('sha256').update(bytes).digest('hex'); records.push({ summary, bytes });
    parentRevisionId = record.id;
  }
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: parentRevisionId }, records };
}

test('pushes immutable local history idempotently and fetches metadata without media', () => {
  const remote = createCloudHistoryStore(); remote.createProject({ projectId: 'remote-1', name: 'Film' });
  const sync = createRevisionSyncService(remote); const local = bundle(2);
  const pushed = sync.push({ remoteProjectId: 'remote-1', bundle: local, authorId: 'user-1' });
  assert.equal(pushed.pushed, 2); assert.equal(sync.divergence({ remoteProjectId: 'remote-1', bundle: local }).status, 'in-sync');
  assert.equal(sync.push({ remoteProjectId: 'remote-1', bundle: local, authorId: 'user-1' }).pushed, 0);
  const fetched = sync.fetch({ remoteProjectId: 'remote-1' });
  assert.equal(fetched.revisions.length, 2); assert.equal(fetched.manifests.length, 2);
  assert.equal(fetched.mediaFetched, false); assert.doesNotMatch(JSON.stringify(fetched), /file:\/\//);
});

test('classifies local-ahead, remote-ahead, and divergence with explicit actions', () => {
  const remote = createCloudHistoryStore(); remote.createProject({ projectId: 'remote-1', name: 'Film' });
  const sync = createRevisionSyncService(remote); const base = bundle(1);
  assert.deepEqual(sync.divergence({ remoteProjectId: 'remote-1', bundle: base }).actions, ['push']);
  sync.push({ remoteProjectId: 'remote-1', bundle: base, authorId: 'user-1' });
  const empty = { format: 'frameline-revisions', version: 1, projectId: randomUUID(), branches: { main: null }, records: [] };
  assert.equal(sync.divergence({ remoteProjectId: 'remote-1', bundle: empty }).status, 'remote-ahead');
  const unrelated = bundle(1);
  const divergence = sync.divergence({ remoteProjectId: 'remote-1', bundle: unrelated });
  assert.equal(divergence.status, 'diverged');
  assert.deepEqual(divergence.actions, ['fetch', 'create-reconciliation-branch']);
  assert.throws(() => sync.push({ remoteProjectId: 'remote-1', bundle: unrelated, authorId: 'user-1' }),
    { code: 'sync-reconciliation-required' });
});

test('push advances only the verified append and rejects stale concurrent branch work', () => {
  const remote = createCloudHistoryStore(); remote.createProject({ projectId: 'remote-1', name: 'Film' });
  const sync = createRevisionSyncService(remote); const local = bundle(2);
  const firstOnly = structuredClone(local); firstOnly.records = [local.records[0]];
  firstOnly.branches.main = local.records[0].summary.id;
  sync.push({ remoteProjectId: 'remote-1', bundle: firstOnly, authorId: 'user-1' });
  assert.equal(sync.divergence({ remoteProjectId: 'remote-1', bundle: local }).status, 'local-ahead');
  assert.equal(sync.push({ remoteProjectId: 'remote-1', bundle: local, authorId: 'user-1' }).pushed, 1);
});

test('reports revision-level push progress and honors cancellation between revisions', () => {
  const remote = createCloudHistoryStore(); remote.createProject({ projectId: 'remote-1', name: 'Film' });
  const sync = createRevisionSyncService(remote); const local = bundle(2); const progress = [];
  const result = sync.push({ remoteProjectId: 'remote-1', bundle: local, authorId: 'user-1' },
    { onProgress: value => progress.push(value) });
  assert.equal(result.pushed, 2);
  assert.deepEqual(progress, [{ completed: 0, total: 2 }, { completed: 1, total: 2 }, { completed: 2, total: 2 }]);

  const canceled = new AbortController(); canceled.abort();
  const other = createCloudHistoryStore(); other.createProject({ projectId: 'remote-2', name: 'Film' });
  assert.throws(() => createRevisionSyncService(other).push(
    { remoteProjectId: 'remote-2', bundle: bundle(1), authorId: 'user-1' }, { signal: canceled.signal }),
  { code: 'sync-cancelled' });
  assert.equal(other.getBranch('remote-2', 'main').revisionId, null);
});

test('a concurrent branch writer wins without being overwritten', () => {
  const store = createCloudHistoryStore(); store.createProject({ projectId: 'remote-1', name: 'Film' });
  let competingHead = null; let injectRace = true;
  const remote = Object.fromEntries(['putManifest', 'createRevision', 'getBranch', 'getRevision', 'getManifest',
    'findRevisionBySource'].map(name => [name, store[name].bind(store)]));
  remote.compareAndSwapBranch = input => {
    if (injectRace) {
      injectRace = false;
      const competingManifest = store.putManifest('remote-1', manifest('9'));
      const competing = store.createRevision({ projectId: 'remote-1', manifestId: competingManifest.id,
        parentRevisionId: input.expectedRevisionId, authorId: 'user-2', message: 'Concurrent work' });
      store.compareAndSwapBranch({ ...input, revisionId: competing.id, idempotencyKey: null });
      competingHead = competing.id;
    }
    return store.compareAndSwapBranch(input);
  };
  const sync = createRevisionSyncService(remote);
  assert.throws(() => sync.push({ remoteProjectId: 'remote-1', bundle: bundle(1), authorId: 'user-1' }),
    error => error.code === 'sync-branch-conflict' && error.recoverable === true
      && error.actions.join(',') === 'fetch,create-reconciliation-branch');
  assert.equal(store.getBranch('remote-1', 'main').revisionId, competingHead);
  assert.equal(store.getRevision('remote-1', competingHead).message, 'Concurrent work');
});

test('fetch caches verified metadata for offline browsing and rejects cache tampering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-revision-cache-'));
  try {
    const remote = createCloudHistoryStore(); remote.createProject({ projectId: 'remote-1', name: 'Film' });
    const cache = createRevisionCache({ directory });
    const sync = createRevisionSyncService(remote, { cache }); const local = bundle(2);
    sync.push({ remoteProjectId: 'remote-1', bundle: local, authorId: 'user-1' });
    const fetched = sync.fetch({ remoteProjectId: 'remote-1' });
    const offline = sync.fetchCached({ remoteProjectId: 'remote-1' });
    assert.deepEqual(offline, fetched); assert.equal(offline.mediaFetched, false);
    assert.doesNotMatch(JSON.stringify(offline), /file:\/\//);
    const snapshot = path.join(directory, 'snapshots', fs.readdirSync(path.join(directory, 'snapshots'))[0]);
    fs.appendFileSync(snapshot, 'tampered');
    assert.throws(() => sync.fetchCached({ remoteProjectId: 'remote-1' }), { code: 'revision-cache-corrupt' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
