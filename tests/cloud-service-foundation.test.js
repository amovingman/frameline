const test = require('node:test');
const assert = require('node:assert/strict');
const { API_VERSION, PROJECT_API_CONTRACTS, createRequestContext, responseEnvelope,
  pageToken, readPageToken } = require('../src/project-api-contracts');
const { createCloudHistoryStore, migrateServiceState } = require('../src/cloud-history-store');
const { createServiceBackup, restoreServiceBackup, runRestoreDrill, retentionReport } = require('../src/service-maintenance');

test('versioned contracts cover collaboration resources and return traceable envelopes', () => {
  const responses = new Set(PROJECT_API_CONTRACTS.map(item => item.response));
  for (const response of ['User', 'Session', 'Team', 'Invitation', 'Project', 'Member', 'MemberPage',
    'Branch', 'Revision', 'Manifest', 'PullPlan', 'ActivityPage', 'DeletionReport']) assert.equal(responses.has(response), true);
  const context = createRequestContext({ 'x-request-id': 'request-1', 'idempotency-key': 'retry-1' });
  assert.deepEqual(responseEnvelope(context, { ok: true }), { apiVersion: API_VERSION, requestId: 'request-1', data: { ok: true } });
  assert.throws(() => createRequestContext({ 'x-request-id': '../bad' }), { code: 'invalid-request-headers' });
});

test('signed pagination tokens reject tampering', () => {
  const secret = 'a sufficiently long secret'; const token = pageToken(12, secret);
  assert.equal(readPageToken(token, secret), 12);
  assert.throws(() => readPageToken(`${token}x`, secret), { code: 'invalid-page-token' });
});

test('immutable manifests, revisions and compare-and-swap branch heads preserve concurrent work', () => {
  const store = createCloudHistoryStore();
  const project = store.createProject({ projectId: 'project-1', name: 'Launch film' });
  const manifest = store.putManifest(project.id, { schemaVersion: 1, clips: [] });
  assert.equal(store.putManifest(project.id, { clips: [], schemaVersion: 1 }).id, manifest.id);
  const revision = store.createRevision({ projectId: project.id, manifestId: manifest.id,
    authorId: 'user-1', message: 'Initial cut', idempotencyKey: 'revision-retry' });
  assert.equal(store.createRevision({ projectId: project.id, manifestId: manifest.id,
    authorId: 'user-1', message: 'Initial cut', idempotencyKey: 'revision-retry' }).id, revision.id);
  store.compareAndSwapBranch({ projectId: project.id, branch: 'main', revisionId: revision.id, expectedRevisionId: null });
  assert.throws(() => store.compareAndSwapBranch({ projectId: project.id, branch: 'main',
    revisionId: revision.id, expectedRevisionId: null }), { code: 'branch-head-changed' });
  assert.throws(() => store.createRevision({ projectId: project.id, manifestId: manifest.id,
    authorId: 'user-1', message: 'Different', idempotencyKey: 'revision-retry' }), { code: 'idempotency-key-reused' });
});

test('revision listing is bounded and cursor based', () => {
  const store = createCloudHistoryStore(undefined, { pageSecret: 'another sufficiently long secret' });
  store.createProject({ projectId: 'project-1', name: 'Film' });
  const manifest = store.putManifest('project-1', { schemaVersion: 1 });
  for (let i = 0; i < 3; i++) store.createRevision({ projectId: 'project-1', manifestId: manifest.id,
    authorId: 'user-1', message: `Revision ${i}` });
  const first = store.listRevisions('project-1', { limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  assert.equal(store.listRevisions('project-1', { limit: 2, cursor: first.nextCursor }).items.length, 1);
});

test('schema migration, verified backups, restore drills and retention reports are deterministic', () => {
  const v1 = { schemaVersion: 1, projects: {}, manifests: {}, revisions: {} };
  assert.deepEqual(migrateServiceState(v1), { ...v1, schemaVersion: 2, idempotency: {} });
  const store = createCloudHistoryStore(); store.createProject({ projectId: 'project-1', name: 'Film' });
  const referenced = store.putManifest('project-1', { clips: [] });
  const unused = store.putManifest('project-1', { clips: ['unused'] });
  store.createRevision({ projectId: 'project-1', manifestId: referenced.id, authorId: 'user-1', message: 'Save' });
  const backup = createServiceBackup(store); const restored = restoreServiceBackup(backup);
  assert.deepEqual(restored.snapshot(), store.snapshot());
  assert.equal(runRestoreDrill(store).verified, true);
  assert.deepEqual(retentionReport(store), { schemaVersion: 1, retainedManifestIds: [referenced.id],
    eligibleUnreferencedManifestIds: [unused.id], deletionPerformed: false });
  backup.state.projects['project-1'].name = 'tampered';
  assert.throws(() => restoreServiceBackup(backup), { code: 'backup-invalid' });
});

test('state validation rejects cross-project branch, parent and manifest references', () => {
  const store = createCloudHistoryStore();
  store.createProject({ projectId: 'project-1', name: 'One' }); store.createProject({ projectId: 'project-2', name: 'Two' });
  const manifest = store.putManifest('project-1', { schemaVersion: 1 });
  const revision = store.createRevision({ projectId: 'project-1', manifestId: manifest.id, authorId: 'user-1', message: 'Save' });
  const state = store.snapshot(); state.projects['project-2'].branches.main = revision.id;
  assert.throws(() => createCloudHistoryStore(state), { code: 'service-state-invalid' });
});
