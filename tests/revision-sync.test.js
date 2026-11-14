const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createRevisionSyncService } = require('../src/revision-sync');

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
