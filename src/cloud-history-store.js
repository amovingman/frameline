const { randomUUID } = require('node:crypto');
const { fingerprint, pageToken, readPageToken } = require('./project-api-contracts');

const STORE_SCHEMA_VERSION = 2;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }
function clone(value) { return structuredClone(value); }
function emptyState() { return { schemaVersion: STORE_SCHEMA_VERSION, projects: {}, manifests: {}, revisions: {}, idempotency: {} }; }

function migrateServiceState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('service-state-invalid');
  if (input.schemaVersion > STORE_SCHEMA_VERSION) throw fail('service-state-newer-version');
  if (input.schemaVersion === STORE_SCHEMA_VERSION) return clone(input);
  if (input.schemaVersion === 1 && input.projects && input.manifests && input.revisions) {
    return { schemaVersion: 2, projects: clone(input.projects), manifests: clone(input.manifests),
      revisions: clone(input.revisions), idempotency: {} };
  }
  throw fail('service-state-invalid');
}

function validateState(state) {
  if (state.schemaVersion !== STORE_SCHEMA_VERSION || !state.projects || !state.manifests
    || !state.revisions || !state.idempotency) throw fail('service-state-invalid');
  for (const [projectId, project] of Object.entries(state.projects)) {
    if (!ID.test(projectId) || project.id !== projectId || !project.branches || typeof project.branches !== 'object') throw fail('service-state-invalid');
    for (const head of Object.values(project.branches)) if (head !== null
      && (!state.revisions[head] || state.revisions[head].projectId !== projectId)) throw fail('service-state-invalid');
  }
  const sourceIds = new Set();
  for (const [revisionId, revision] of Object.entries(state.revisions)) {
    const sourceKey = revision.sourceRevisionId ? `${revision.projectId}:${revision.sourceRevisionId}` : null;
    if (revision.id !== revisionId || !state.projects[revision.projectId]
      || !state.manifests[revision.manifestId] || state.manifests[revision.manifestId].projectId !== revision.projectId
      || (revision.parentRevisionId && (!state.revisions[revision.parentRevisionId]
        || state.revisions[revision.parentRevisionId].projectId !== revision.projectId))
      || (sourceKey && sourceIds.has(sourceKey))) throw fail('service-state-invalid');
    if (sourceKey) sourceIds.add(sourceKey);
  }
  for (const [manifestId, manifest] of Object.entries(state.manifests)) {
    if (manifest.id !== manifestId || !state.projects[manifest.projectId]) throw fail('service-state-invalid');
  }
  return state;
}

function createCloudHistoryStore(initialState = emptyState(), { pageSecret = 'frameline-test-secret-change-me' } = {}) {
  let state = validateState(migrateServiceState(initialState));
  function project(projectId) { const value = state.projects[projectId]; if (!value) throw fail('project-not-found'); return value; }
  function executeIdempotent(key, operation, input, action) {
    if (key === null || key === undefined) return action();
    if (!ID.test(key)) throw fail('invalid-idempotency-key');
    const requestHash = fingerprint({ operation, input });
    const previous = state.idempotency[key];
    if (previous) {
      if (previous.requestHash !== requestHash) throw fail('idempotency-key-reused');
      return clone(previous.result);
    }
    const result = action();
    state.idempotency[key] = { requestHash, result: clone(result) };
    return result;
  }
  function createProject({ projectId = randomUUID(), name, idempotencyKey = null }) {
    return executeIdempotent(idempotencyKey, 'create-project', { projectId, name }, () => {
      if (!ID.test(projectId) || typeof name !== 'string' || !name.trim() || name.length > 120) throw fail('project-invalid');
      if (state.projects[projectId]) throw fail('project-exists');
      const result = { id: projectId, name: name.trim(), branches: { main: null }, createdAt: new Date().toISOString() };
      state.projects[projectId] = result; return clone(result);
    });
  }
  function putManifest(projectId, manifest) {
    project(projectId);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw fail('manifest-invalid');
    const id = `sha256:${fingerprint(manifest)}`;
    const existing = state.manifests[id];
    if (existing && fingerprint(existing.document) !== fingerprint(manifest)) throw fail('manifest-hash-collision');
    state.manifests[id] ||= { id, projectId, document: clone(manifest), createdAt: new Date().toISOString() };
    if (state.manifests[id].projectId !== projectId) throw fail('manifest-project-mismatch');
    return { id, created: !existing };
  }
  function createRevision({ projectId, manifestId, parentRevisionId = null, authorId, message,
    sourceRevisionId = null, idempotencyKey = null }) {
    return executeIdempotent(idempotencyKey, 'create-revision', { projectId, manifestId, parentRevisionId, authorId, message, sourceRevisionId }, () => {
      project(projectId);
      if (!state.manifests[manifestId] || state.manifests[manifestId].projectId !== projectId) throw fail('manifest-not-found');
      if (parentRevisionId && (!state.revisions[parentRevisionId] || state.revisions[parentRevisionId].projectId !== projectId)) throw fail('parent-revision-not-found');
      if (!ID.test(authorId) || typeof message !== 'string' || !message.trim() || message.length > 240
        || (sourceRevisionId !== null && !ID.test(sourceRevisionId))) throw fail('revision-invalid');
      if (sourceRevisionId && Object.values(state.revisions).some(item => item.projectId === projectId
        && item.sourceRevisionId === sourceRevisionId)) throw fail('source-revision-exists');
      const revision = { id: randomUUID(), projectId, manifestId, parentRevisionId, authorId,
        message: message.trim(), sourceRevisionId, createdAt: new Date().toISOString() };
      state.revisions[revision.id] = revision; return clone(revision);
    });
  }
  function compareAndSwapBranch({ projectId, branch, expectedRevisionId = null, revisionId, idempotencyKey = null }) {
    return executeIdempotent(idempotencyKey, 'cas-branch', { projectId, branch, expectedRevisionId, revisionId }, () => {
      const target = project(projectId);
      if (!ID.test(branch) || !Object.hasOwn(target.branches, branch)) throw fail('branch-not-found');
      const revision = state.revisions[revisionId];
      if (!revision || revision.projectId !== projectId) throw fail('revision-not-found');
      if (target.branches[branch] !== expectedRevisionId) throw fail('branch-head-changed');
      if (revision.parentRevisionId !== expectedRevisionId) throw fail('revision-parent-mismatch');
      target.branches[branch] = revisionId;
      return { projectId, branch, revisionId };
    });
  }
  function createBranch(projectId, branch, fromRevisionId = null) {
    const target = project(projectId);
    if (!ID.test(branch) || Object.hasOwn(target.branches, branch)) throw fail('branch-invalid');
    if (fromRevisionId && (!state.revisions[fromRevisionId] || state.revisions[fromRevisionId].projectId !== projectId)) throw fail('revision-not-found');
    target.branches[branch] = fromRevisionId; return { projectId, branch, revisionId: fromRevisionId };
  }
  function getManifest(projectId, manifestId) {
    project(projectId); const value = state.manifests[manifestId];
    if (!value || value.projectId !== projectId) throw fail('manifest-not-found');
    return clone(value);
  }
  function getRevision(projectId, revisionId) {
    project(projectId); const value = state.revisions[revisionId];
    if (!value || value.projectId !== projectId) throw fail('revision-not-found');
    return clone(value);
  }
  function findRevisionBySource(projectId, sourceRevisionId) {
    project(projectId);
    const value = Object.values(state.revisions).find(item => item.projectId === projectId
      && item.sourceRevisionId === sourceRevisionId);
    return value ? clone(value) : null;
  }
  function getBranch(projectId, branch) {
    const target = project(projectId);
    if (!ID.test(branch) || !Object.hasOwn(target.branches, branch)) throw fail('branch-not-found');
    return { projectId, branch, revisionId: target.branches[branch] };
  }
  function listRevisions(projectId, { limit = 50, cursor = null } = {}) {
    project(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('page-limit-invalid');
    const start = readPageToken(cursor, pageSecret);
    const values = Object.values(state.revisions).filter(item => item.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (start > values.length) throw fail('invalid-page-token');
    const items = values.slice(start, start + limit).map(clone);
    const next = start + items.length < values.length ? pageToken(start + items.length, pageSecret) : null;
    return { items, nextCursor: next };
  }
  function snapshot() { return clone(state); }
  return { createProject, putManifest, createRevision, compareAndSwapBranch, createBranch,
    getManifest, getRevision, findRevisionBySource, getBranch, listRevisions, snapshot };
}

module.exports = { STORE_SCHEMA_VERSION, emptyState, migrateServiceState, validateState, createCloudHistoryStore };
