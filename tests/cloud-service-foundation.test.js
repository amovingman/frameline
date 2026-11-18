const test = require('node:test');
const assert = require('node:assert/strict');
const { API_VERSION, PROJECT_API_CONTRACTS, createRequestContext, responseEnvelope,
  pageToken, readPageToken } = require('../src/project-api-contracts');
const { createCloudHistoryStore, migrateServiceState, manifestStorageKey, validateState } = require('../src/cloud-history-store');
const { fingerprint } = require('../src/project-api-contracts');
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
  assert.deepEqual(migrateServiceState(v1), { ...v1, schemaVersion: 3, idempotency: {} });
  const store = createCloudHistoryStore(); store.createProject({ projectId: 'project-1', name: 'Film' });
  const referenced = store.putManifest('project-1', { clips: [] });
  const unused = store.putManifest('project-1', { clips: ['unused'] });
  store.createRevision({ projectId: 'project-1', manifestId: referenced.id, authorId: 'user-1', message: 'Save' });
  const backup = createServiceBackup(store); const restored = restoreServiceBackup(backup);
  assert.deepEqual(restored.snapshot(), store.snapshot());
  assert.equal(runRestoreDrill(store).verified, true);
  assert.deepEqual(retentionReport(store), { schemaVersion: 2, retainedManifests: [{ projectId: 'project-1', manifestId: referenced.id }],
    eligibleUnreferencedManifests: [{ projectId: 'project-1', manifestId: unused.id }], deletionPerformed: false });
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

test('authorized projects independently store identical public manifest hashes and retention follows scoped references', () => {
  const { createIdentityService } = require('../src/identity-service');
  const { createAccessControl } = require('../src/access-control');
  const { createAuthorizedProjectService } = require('../src/authorized-project-service');
  const identity = createIdentityService(); const access = createAccessControl(); const history = createCloudHistoryStore();
  const alice = identity.createAccount('alice@example.test', 'alice fixture password');
  const bob = identity.createAccount('bob@example.test', 'bob fixture password');
  const aliceContext = { accessToken: identity.signIn('alice@example.test', 'alice fixture password').accessToken };
  const bobContext = { accessToken: identity.signIn('bob@example.test', 'bob fixture password').accessToken };
  for (const [user, id] of [[alice, 'project-a'], [bob, 'project-b']]) {
    const team = access.createTeam(user.id, 'Editors'); history.createProject({ projectId: id, name: id }); access.registerProject(user.id, id, team.id);
  }
  const service = createAuthorizedProjectService({ identity, access, history }); const document = { clips: ['shared metadata'] };
  const a = service.putManifest(aliceContext, 'project-a', document);
  assert.throws(() => service.getManifest(bobContext, 'project-b', a.id), { code: 'manifest-not-found' });
  assert.throws(() => service.createRevision(bobContext, { projectId: 'project-b', manifestId: a.id, message: 'Not uploaded here' }), { code: 'manifest-not-found' });
  assert.throws(() => service.getManifest(aliceContext, 'project-b', a.id), { code: 'forbidden' });
  const b = service.putManifest(bobContext, 'project-b', document); assert.equal(a.id, b.id); assert.equal(a.created, true); assert.equal(b.created, true);
  assert.equal(service.putManifest(bobContext, 'project-b', document).created, false);
  assert.equal(service.getManifest(aliceContext, 'project-a', a.id).projectId, 'project-a');
  assert.equal(service.getManifest(bobContext, 'project-b', b.id).projectId, 'project-b');
  service.createRevision(aliceContext, { projectId: 'project-a', manifestId: a.id, message: 'Retained in A' });
  assert.deepEqual(retentionReport(history), { schemaVersion: 2,
    retainedManifests: [{ projectId: 'project-a', manifestId: a.id }],
    eligibleUnreferencedManifests: [{ projectId: 'project-b', manifestId: a.id }], deletionPerformed: false });
  assert.deepEqual(Object.keys(history.snapshot().manifests).sort(), [manifestStorageKey('project-a', a.id), manifestStorageKey('project-b', a.id)].sort());
  const restored = restoreServiceBackup(createServiceBackup(history));
  assert.deepEqual(restored.snapshot(), history.snapshot()); assert.deepEqual(retentionReport(restored), retentionReport(history));
});

function legacySnapshot(version = 2) {
  const store = createCloudHistoryStore(); store.createProject({ projectId: 'legacy-project', name: 'Legacy film', idempotencyKey: 'create-project' });
  const manifest = store.putManifest('legacy-project', { clips: [] });
  const first = store.createRevision({ projectId: 'legacy-project', manifestId: manifest.id, authorId: 'author-1', message: 'First', sourceRevisionId: 'source-1', idempotencyKey: 'create-first' });
  store.compareAndSwapBranch({ projectId: 'legacy-project', branch: 'main', expectedRevisionId: null, revisionId: first.id, idempotencyKey: 'advance-first' });
  store.createBranch('legacy-project', 'review', first.id);
  const second = store.createRevision({ projectId: 'legacy-project', manifestId: manifest.id, parentRevisionId: first.id, authorId: 'author-1', message: 'Second', sourceRevisionId: 'source-2', idempotencyKey: 'create-second' });
  store.compareAndSwapBranch({ projectId: 'legacy-project', branch: 'main', expectedRevisionId: first.id, revisionId: second.id, idempotencyKey: 'advance-second' });
  const state = store.snapshot(); state.schemaVersion = version;
  state.manifests = Object.fromEntries(Object.values(state.manifests).map(value => [value.id, value]));
  if (version === 1) delete state.idempotency;
  return { state, manifest, first, second };
}

test('v1 and v2 migration and old backup restore preserve complete immutable history and retry identity', () => {
  for (const version of [1, 2]) {
    const { state, manifest, first, second } = legacySnapshot(version); const original = structuredClone(state);
    const migrated = migrateServiceState(state); assert.equal(migrated.schemaVersion, 3); assert.deepEqual(state, original);
    assert.deepEqual(migrated.projects, state.projects); assert.deepEqual(migrated.revisions, state.revisions);
    assert.deepEqual(migrated.idempotency, state.idempotency || {});
    assert.deepEqual(migrated.manifests[manifestStorageKey('legacy-project', manifest.id)], state.manifests[manifest.id]);
    const backup = { format: 'frameline-service-backup', version: 1, createdAt: new Date().toISOString(), state, sha256: fingerprint(state) };
    const restored = restoreServiceBackup(backup); assert.deepEqual(restored.snapshot(), migrated);
    assert.equal(restored.getBranch('legacy-project', 'main').revisionId, second.id);
    assert.equal(restored.getBranch('legacy-project', 'review').revisionId, first.id);
    assert.equal(restored.getRevision('legacy-project', second.id).parentRevisionId, first.id);
    assert.equal(restored.findRevisionBySource('legacy-project', 'source-1').id, first.id);
    if (version === 2) assert.equal(restored.createRevision({ projectId: 'legacy-project', manifestId: manifest.id,
      authorId: 'author-1', message: 'First', sourceRevisionId: 'source-1', idempotencyKey: 'create-first' }).id, first.id);
    assert.equal(runRestoreDrill(restored).verified, true);
    assert.throws(() => validateState(state), { code: 'service-state-invalid' });
  }
});

test('scoped validation rejects duplicate aliases, wrong projects, canonical hash corruption and downgraded namespaces', () => {
  const { state: legacy } = legacySnapshot(); const original = migrateServiceState(legacy); const [key] = Object.keys(original.manifests);
  const mutations = [
    value => { value.manifests['scoped:' + '0'.repeat(64)] = structuredClone(value.manifests[key]); },
    value => { value.manifests[key].projectId = 'other-project'; },
    value => { value.manifests[key].document.clips.push('tampered'); },
    value => { value.revisions[Object.keys(value.revisions)[0]].manifestId = 'sha256:' + '0'.repeat(64); },
    value => { value.revisions[Object.keys(value.revisions)[0]].parentRevisionId = 'constructor'; },
    value => { value.schemaVersion = 2; }, value => { value.schemaVersion = 1; delete value.idempotency; }
  ];
  for (const change of mutations) { const value = structuredClone(original); change(value); assert.throws(() => createCloudHistoryStore(value), { code: 'service-state-invalid' }); }
  const duplicateLegacy = structuredClone(legacy); duplicateLegacy.manifests['sha256:' + '0'.repeat(64)] = structuredClone(Object.values(legacy.manifests)[0]);
  assert.throws(() => migrateServiceState(duplicateLegacy), { code: 'service-state-invalid' });
  assert.throws(() => createCloudHistoryStore({ ...original, schemaVersion: 4 }), { code: 'service-state-newer-version' });
});

test('manifest and history lookups require own records rather than inherited object properties', () => {
  const store = createCloudHistoryStore(); store.createProject({ projectId: 'constructor', name: 'Own project' });
  const stored = store.putManifest('constructor', { clips: [] });
  assert.equal(store.getManifest('constructor', stored.id).projectId, 'constructor');
  assert.throws(() => store.getBranch('toString', 'main'), { code: 'project-not-found' });
  assert.throws(() => store.getRevision('constructor', 'toString'), { code: 'revision-not-found' });
  const state = store.snapshot(); const [key] = Object.keys(state.manifests); const record = state.manifests[key];
  state.manifests = Object.create({ [key]: record });
  const revisionId = 'own-revision'; state.revisions[revisionId] = { id: revisionId, projectId: 'constructor', manifestId: record.id, parentRevisionId: null, authorId: 'author-1', sourceRevisionId: null };
  assert.throws(() => createCloudHistoryStore(state), { code: 'service-state-invalid' });
});
