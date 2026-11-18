const { randomUUID } = require('node:crypto');
const { fingerprint, pageToken, readPageToken } = require('./project-api-contracts');

const STORE_SCHEMA_VERSION = 3;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MANIFEST_ID = /^sha256:[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => typeof key === 'string' && Object.hasOwn(value, key);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function clone(value) { return structuredClone(value); }
function emptyState() { return { schemaVersion: STORE_SCHEMA_VERSION, projects: {}, manifests: {}, revisions: {}, idempotency: {} }; }
function manifestStorageKey(projectId, manifestId) {
  if (!validId(projectId) || typeof manifestId !== 'string' || !MANIFEST_ID.test(manifestId)) throw fail('service-state-invalid');
  return `scoped:${fingerprint({ projectId, manifestId })}`;
}

function migrateServiceState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('service-state-invalid');
  if (input.schemaVersion > STORE_SCHEMA_VERSION) throw fail('service-state-newer-version');
  if (input.schemaVersion === STORE_SCHEMA_VERSION) return clone(validateState(input));
  if ([1, 2].includes(input.schemaVersion)) {
    validateStateVersion(input, true);
    const manifests = {};
    for (const manifest of Object.values(input.manifests)) {
      const key = manifestStorageKey(manifest.projectId, manifest.id);
      if (own(manifests, key)) throw fail('service-state-invalid');
      manifests[key] = clone(manifest);
    }
    return clone(validateState({ schemaVersion: STORE_SCHEMA_VERSION, projects: input.projects, manifests,
      revisions: input.revisions, idempotency: input.schemaVersion === 1 ? {} : input.idempotency }));
  }
  throw fail('service-state-invalid');
}

function validateState(state) {
  if (state?.schemaVersion > STORE_SCHEMA_VERSION) throw fail('service-state-newer-version');
  return validateStateVersion(state, false);
}
function validateStateVersion(state, legacy) {
  if (!object(state) || (legacy ? ![1, 2].includes(state.schemaVersion) : state.schemaVersion !== STORE_SCHEMA_VERSION)
    || !object(state.projects) || !object(state.manifests) || !object(state.revisions)
    || state.schemaVersion !== 1 && !object(state.idempotency)) throw fail('service-state-invalid');
  const manifestKey = (projectId, id) => legacy ? id : manifestStorageKey(projectId, id);
  for (const [projectId, project] of Object.entries(state.projects)) {
    if (!validId(projectId) || !object(project) || project.id !== projectId || !object(project.branches)
      || !own(project.branches, 'main')) throw fail('service-state-invalid');
    for (const [name, head] of Object.entries(project.branches)) if (!validId(name) || head !== null
      && (!validId(head) || !own(state.revisions, head) || !object(state.revisions[head]) || state.revisions[head].projectId !== projectId)) throw fail('service-state-invalid');
  }
  for (const [key, manifest] of Object.entries(state.manifests)) {
    if (!object(manifest) || !validId(manifest.projectId) || !own(state.projects, manifest.projectId)
      || typeof manifest.id !== 'string' || !MANIFEST_ID.test(manifest.id) || !object(manifest.document)
      || manifest.id !== `sha256:${fingerprint(manifest.document)}` || key !== manifestKey(manifest.projectId, manifest.id)) throw fail('service-state-invalid');
  }
  const sourceIds = new Set();
  for (const [revisionId, revision] of Object.entries(state.revisions)) {
    if (!object(revision) || !validId(revisionId) || revision.id !== revisionId || !validId(revision.projectId)
      || !own(state.projects, revision.projectId) || typeof revision.manifestId !== 'string' || !MANIFEST_ID.test(revision.manifestId)
      || !own(state.manifests, manifestKey(revision.projectId, revision.manifestId))
      || state.manifests[manifestKey(revision.projectId, revision.manifestId)].projectId !== revision.projectId
      || (revision.parentRevisionId !== null && (!validId(revision.parentRevisionId) || !own(state.revisions, revision.parentRevisionId) || !object(state.revisions[revision.parentRevisionId])
        || state.revisions[revision.parentRevisionId].projectId !== revision.projectId))
      || revision.sourceRevisionId !== undefined && revision.sourceRevisionId !== null && !validId(revision.sourceRevisionId)) throw fail('service-state-invalid');
    const sourceKey = revision.sourceRevisionId ? fingerprint({ projectId: revision.projectId, sourceRevisionId: revision.sourceRevisionId }) : null;
    if (sourceKey && sourceIds.has(sourceKey)) throw fail('service-state-invalid');
    if (sourceKey) sourceIds.add(sourceKey);
  }
  const done = new Set();
  for (const revision of Object.values(state.revisions)) {
    let current = revision; const visiting = new Set();
    while (current && !done.has(current.id)) {
      if (visiting.has(current.id)) throw fail('service-state-invalid');
      visiting.add(current.id); current = current.parentRevisionId === null ? null : state.revisions[current.parentRevisionId];
    }
    for (const id of visiting) done.add(id);
  }
  for (const [key, entry] of Object.entries(state.idempotency || {})) {
    if (!validId(key) || !object(entry) || typeof entry.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.requestHash)
      || !object(entry.result)) throw fail('service-state-invalid');
  }
  return state;
}

function createCloudHistoryStore(initialState = emptyState(), { pageSecret = 'frameline-test-secret-change-me' } = {}) {
  let state = validateState(migrateServiceState(initialState));
  function project(projectId) { if (!validId(projectId) || !own(state.projects, projectId)) throw fail('project-not-found'); return state.projects[projectId]; }
  function executeIdempotent(key, operation, input, action) {
    if (key === null || key === undefined) return action();
    if (!validId(key)) throw fail('invalid-idempotency-key');
    const requestHash = fingerprint({ operation, input });
    const previous = own(state.idempotency, key) ? state.idempotency[key] : null;
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
      if (!validId(projectId) || typeof name !== 'string' || !name.trim() || name.length > 120) throw fail('project-invalid');
      if (own(state.projects, projectId)) throw fail('project-exists');
      const result = { id: projectId, name: name.trim(), branches: { main: null }, createdAt: new Date().toISOString() };
      state.projects[projectId] = result; return clone(result);
    });
  }
  function putManifest(projectId, manifest) {
    project(projectId);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw fail('manifest-invalid');
    const id = `sha256:${fingerprint(manifest)}`;
    const key = manifestStorageKey(projectId, id); const existing = own(state.manifests, key) ? state.manifests[key] : null;
    if (existing && fingerprint(existing.document) !== fingerprint(manifest)) throw fail('manifest-hash-collision');
    state.manifests[key] ||= { id, projectId, document: clone(manifest), createdAt: new Date().toISOString() };
    return { id, created: !existing };
  }
  function createRevision({ projectId, manifestId, parentRevisionId = null, authorId, message,
    sourceRevisionId = null, idempotencyKey = null }) {
    return executeIdempotent(idempotencyKey, 'create-revision', { projectId, manifestId, parentRevisionId, authorId, message, sourceRevisionId }, () => {
      project(projectId);
      if (typeof manifestId !== 'string' || !MANIFEST_ID.test(manifestId)
        || !own(state.manifests, manifestStorageKey(projectId, manifestId))) throw fail('manifest-not-found');
      if (parentRevisionId !== null && (!validId(parentRevisionId) || !own(state.revisions, parentRevisionId) || state.revisions[parentRevisionId].projectId !== projectId)) throw fail('parent-revision-not-found');
      if (!validId(authorId) || typeof message !== 'string' || !message.trim() || message.length > 240
        || (sourceRevisionId !== null && !validId(sourceRevisionId))) throw fail('revision-invalid');
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
      if (!validId(branch) || !Object.hasOwn(target.branches, branch)) throw fail('branch-not-found');
      const revision = own(state.revisions, revisionId) ? state.revisions[revisionId] : null;
      if (!revision || revision.projectId !== projectId) throw fail('revision-not-found');
      if (target.branches[branch] !== expectedRevisionId) throw fail('branch-head-changed');
      if (revision.parentRevisionId !== expectedRevisionId) throw fail('revision-parent-mismatch');
      target.branches[branch] = revisionId;
      return { projectId, branch, revisionId };
    });
  }
  function createBranch(projectId, branch, fromRevisionId = null) {
    const target = project(projectId);
    if (!validId(branch) || Object.hasOwn(target.branches, branch)) throw fail('branch-invalid');
    if (fromRevisionId !== null && (!validId(fromRevisionId) || !own(state.revisions, fromRevisionId) || state.revisions[fromRevisionId].projectId !== projectId)) throw fail('revision-not-found');
    target.branches[branch] = fromRevisionId; return { projectId, branch, revisionId: fromRevisionId };
  }
  function getManifest(projectId, manifestId) {
    project(projectId);
    if (typeof manifestId !== 'string' || !MANIFEST_ID.test(manifestId)) throw fail('manifest-not-found');
    const key = manifestStorageKey(projectId, manifestId); const value = own(state.manifests, key) ? state.manifests[key] : null;
    if (!value || value.projectId !== projectId) throw fail('manifest-not-found');
    return clone(value);
  }
  function getRevision(projectId, revisionId) {
    project(projectId); const value = own(state.revisions, revisionId) ? state.revisions[revisionId] : null;
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
    if (!validId(branch) || !Object.hasOwn(target.branches, branch)) throw fail('branch-not-found');
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

module.exports = { STORE_SCHEMA_VERSION, emptyState, migrateServiceState, validateState, createCloudHistoryStore, manifestStorageKey };
