'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { createIdentityService, validateIdentityState } = require('./identity-service');
const { createAccessControl, validateAccessState } = require('./access-control');
const { createCloudHistoryStore } = require('./cloud-history-store');
const { createAuthorizedProjectService } = require('./authorized-project-service');
const { validateRevisionManifest } = require('./revision-manifest');
const { fingerprint } = require('./project-api-contracts');

const MAX_STATE_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 96 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const date = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value));
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\\/\x00-\x1f\x7f]/.test(value);
function fail(code) { return Object.assign(new Error(code), { code }); }

function validateHistory(input) {
  if (!exact(input, ['schemaVersion', 'projects', 'manifests', 'revisions', 'idempotency']) || input.schemaVersion !== 2
    || !['projects', 'manifests', 'revisions', 'idempotency'].every(key => record(input[key]))) throw fail('collaboration-state-invalid');
  for (const key of ['projects', 'manifests', 'revisions', 'idempotency']) {
    if (Object.keys(input[key]).length > 100000) throw fail('collaboration-state-invalid');
  }
  for (const [id, project] of Object.entries(input.projects)) {
    if (!validId(id) || !exact(project, ['id', 'name', 'branches', 'createdAt']) || project.id !== id
      || !text(project.name, 120) || !date(project.createdAt) || !record(project.branches)
      || !Object.hasOwn(project.branches, 'main') || Object.keys(project.branches).length > 10000
      || Object.entries(project.branches).some(([name, head]) => !validId(name) || head !== null && !validId(head))) throw fail('collaboration-state-invalid');
  }
  for (const [id, manifest] of Object.entries(input.manifests)) {
    if (!exact(manifest, ['id', 'projectId', 'document', 'createdAt']) || manifest.id !== id
      || !validId(manifest.projectId) || !Object.hasOwn(input.projects, manifest.projectId)
      || id !== `sha256:${fingerprint(manifest.document)}` || !date(manifest.createdAt)) throw fail('collaboration-state-invalid');
    try { validateRevisionManifest(manifest.document); } catch { throw fail('collaboration-state-invalid'); }
  }
  for (const [id, revision] of Object.entries(input.revisions)) {
    if (!exact(revision, ['id', 'projectId', 'manifestId', 'parentRevisionId', 'authorId', 'message', 'sourceRevisionId', 'createdAt'])
      || !validId(id) || revision.id !== id || !['projectId', 'manifestId', 'authorId'].every(key => validId(revision[key]))
      || revision.parentRevisionId !== null && !validId(revision.parentRevisionId)
      || revision.sourceRevisionId !== null && !validId(revision.sourceRevisionId)
      || !text(revision.message, 240) || !date(revision.createdAt)) throw fail('collaboration-state-invalid');
    if (!Object.hasOwn(input.projects, revision.projectId) || !Object.hasOwn(input.manifests, revision.manifestId)
      || input.manifests[revision.manifestId].projectId !== revision.projectId
      || revision.parentRevisionId !== null && (!Object.hasOwn(input.revisions, revision.parentRevisionId)
        || input.revisions[revision.parentRevisionId].projectId !== revision.projectId)) throw fail('collaboration-state-invalid');
  }
  for (const project of Object.values(input.projects)) for (const id of Object.values(project.branches)) {
    if (id !== null && (!Object.hasOwn(input.revisions, id) || input.revisions[id].projectId !== project.id)) throw fail('collaboration-state-invalid');
  }
  for (const [key, entry] of Object.entries(input.idempotency)) {
    if (!validId(key) || !exact(entry, ['requestHash', 'result']) || !SHA.test(entry.requestHash)) throw fail('collaboration-state-invalid');
    const result = entry.result;
    if (exact(result, ['projectId', 'branch', 'revisionId'])) {
      if (!Object.hasOwn(input.projects, result.projectId) || !Object.hasOwn(input.projects[result.projectId].branches, result.branch)
        || input.revisions[result.revisionId]?.projectId !== result.projectId) throw fail('collaboration-state-invalid');
    } else if (exact(result, ['id', 'name', 'branches', 'createdAt'])) {
      const project = input.projects[result.id];
      if (!project || project.name !== result.name || project.createdAt !== result.createdAt
        || !exact(result.branches, ['main']) || result.branches.main !== null) throw fail('collaboration-state-invalid');
    } else if (!input.revisions[result?.id] || fingerprint(input.revisions[result.id]) !== fingerprint(result)) throw fail('collaboration-state-invalid');
  }
  let checked;
  try { checked = createCloudHistoryStore(input).snapshot(); } catch { throw fail('collaboration-state-invalid'); }
  const done = new Set();
  for (const revision of Object.values(checked.revisions)) {
    let current = revision; const visiting = new Set();
    while (current && !done.has(current.id)) {
      if (visiting.has(current.id)) throw fail('collaboration-state-invalid');
      visiting.add(current.id); current = checked.revisions[current.parentRevisionId];
    }
    for (const id of visiting) done.add(id);
  }
  return checked;
}

function validateCollaborationState(input) {
  try {
    if (input?.schemaVersion > 1) throw fail('collaboration-state-newer-version');
    if (!exact(input, ['schemaVersion', 'generation', 'paginationKey', 'identity', 'access', 'history']) || input.schemaVersion !== 1
      || !Number.isSafeInteger(input.generation) || input.generation < 0
      || typeof input.paginationKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.paginationKey)) throw fail('collaboration-state-invalid');
    const identity = validateIdentityState(input.identity), access = validateAccessState(input.access), history = validateHistory(input.history);
    const users = new Map(identity.users.map(user => [user.id, user]));
    for (const team of access.teams) for (const member of team.members) {
      if (!users.has(member.userId) || member.role === 'owner' && users.get(member.userId).status !== 'active') throw fail('collaboration-state-invalid');
    }
    const projects = new Set(access.projects.map(project => project.id));
    if (Object.keys(history.projects).some(id => !projects.has(id)) || access.projects.some(project => !Object.hasOwn(history.projects, project.id))) throw fail('collaboration-state-invalid');
    for (const project of access.projects) for (const member of project.roles) {
      if (!users.has(member.userId) || project.deletedAt === null && users.get(member.userId).status !== 'active') throw fail('collaboration-state-invalid');
    }
    for (const revision of Object.values(history.revisions)) if (!users.has(revision.authorId)) throw fail('collaboration-state-invalid');
    const output = { schemaVersion: 1, generation: input.generation, paginationKey: input.paginationKey, identity, access, history };
    if (Buffer.byteLength(JSON.stringify(output)) > MAX_STATE_BYTES) throw fail('collaboration-state-invalid');
    return output;
  } catch (error) {
    throw fail(error.code === 'collaboration-state-newer-version' ? error.code : 'collaboration-state-invalid');
  }
}

async function createDurableCollaborationService({ directory, keyring, now = () => Date.now(),
  deliverRecovery = null, storage = fs, lockTimeoutMs = 5000, initialize = false } = {}) {
  const validRing = ring => ring && typeof ring.encrypt === 'function' && typeof ring.decrypt === 'function';
  if (!path.isAbsolute(directory || '') || !validRing(keyring) || typeof now !== 'function'
    || typeof initialize !== 'boolean'
    || deliverRecovery !== null && typeof deliverRecovery !== 'function'
    || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30000) throw fail('collaboration-service-invalid');
  try {
    if (initialize) await storage.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await storage.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('collaboration-storage-unavailable');
    directory = await storage.realpath(directory);
  } catch { throw fail('collaboration-storage-unavailable'); }
  const filename = path.join(directory, 'collaboration.enc.json');
  let ring = keyring, pending = Promise.resolve(), closing = false, uncertain = false, observedKeyId = null, initialized = false;
  function validateEnvelope(value) {
    const base64 = (text, length = null) => typeof text === 'string' && Buffer.from(text, 'base64').toString('base64') === text
      && (length === null || Buffer.from(text, 'base64').length === length);
    if (!exact(value, ['version', 'keyId', 'algorithm', 'iv', 'tag', 'ciphertext'])
      || value.version !== 1 || value.algorithm !== 'aes-256-gcm' || !validId(value.keyId)
      || !base64(value.iv, 12) || !base64(value.tag, 16) || !base64(value.ciphertext) || !value.ciphertext) throw fail('collaboration-state-invalid');
  }
  async function read() {
    let handle;
    observedKeyId = null;
    try {
      handle = await storage.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size < 2 || stat.size > MAX_FILE_BYTES) throw fail('collaboration-state-invalid');
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) throw fail('collaboration-state-invalid');
      const file = JSON.parse(bytes.toString('utf8'));
      if (file?.schemaVersion > 1) throw fail('collaboration-state-newer-version');
      if (!exact(file, ['schemaVersion', 'generation', 'record']) || file.schemaVersion !== 1) throw fail('collaboration-state-invalid');
      validateEnvelope(file.record);
      const value = validateCollaborationState(ring.decrypt(file.record));
      if (file.generation !== value.generation) throw fail('collaboration-state-invalid');
      observedKeyId = file.record.keyId;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail(error.code === 'collaboration-state-newer-version' ? error.code : 'collaboration-state-invalid');
    } finally { await handle?.close(); }
  }
  async function syncDirectory() {
    const handle = await storage.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function write(value, encryptWith = ring, rotating = false) {
    const temporary = path.join(directory, `.collaboration-${randomUUID()}.tmp`); let replacing = false;
    try {
      const expected = fingerprint(value), encrypted = structuredClone(encryptWith.encrypt(structuredClone(value)));
      validateEnvelope(encrypted);
      if (fingerprint(validateCollaborationState(encryptWith.decrypt(structuredClone(encrypted)))) !== expected) throw fail('collaboration-state-invalid');
      if (!rotating && observedKeyId !== null && encrypted.keyId !== observedKeyId) throw fail('collaboration-key-rotation-required');
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, generation: value.generation, record: encrypted }));
      if (bytes.length > MAX_FILE_BYTES) throw fail('collaboration-storage-unavailable');
      const handle = await storage.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      replacing = true; await storage.rename(temporary, filename); await syncDirectory();
    } catch (error) {
      if (replacing) { uncertain = true; throw fail('collaboration-storage-uncertain'); }
      if (error.code === 'collaboration-key-rotation-required') throw fail(error.code);
      throw fail('collaboration-storage-unavailable');
    } finally { await storage.rm(temporary, { force: true }).catch(() => {}); }
  }
  function hydrate(state, effects) {
    const identity = createIdentityService({ initialState: state?.identity, now,
      deliverRecovery: async delivery => { effects.push(delivery); } });
    const access = createAccessControl({ initialState: state?.access, now });
    const paginationKey = state?.paginationKey || randomBytes(32).toString('base64url');
    const history = createCloudHistoryStore(state?.history, { pageSecret: paginationKey });
    const snapshot = () => validateCollaborationState({ schemaVersion: 1, generation: state?.generation || 0, paginationKey,
      identity: identity.snapshot(), access: access.snapshot(), history: history.snapshot() });
    const actor = context => identity.authenticate(context?.accessToken).userId;
    return { identity, access, history, snapshot, actor };
  }
  function transact(action, { rotate = null } = {}) {
    if (closing) return Promise.reject(fail('collaboration-service-closed'));
    const next = pending.then(async () => {
      if (uncertain) throw fail('collaboration-storage-uncertain');
      let release;
      try { release = await acquireMetadataLock(directory, lockTimeoutMs); }
      catch { throw fail('collaboration-service-busy'); }
      let output, effects = [];
      try {
        const previous = await read();
        if (!previous && (initialized || !initialize)) throw fail('collaboration-state-invalid');
        const world = hydrate(previous, effects);
        output = await action(world);
        const value = world.snapshot();
        if (!previous || rotate || fingerprint(previous) !== fingerprint(value)) {
          if (value.generation === Number.MAX_SAFE_INTEGER) throw fail('collaboration-state-invalid');
          value.generation++; await write(value, rotate || ring, rotate !== null);
          if (rotate) ring = rotate;
        }
        initialized = true;
      } finally {
        try { await release(); } catch { uncertain = true; throw fail('collaboration-storage-uncertain'); }
      }
      // Delivery occurs only after the hashed recovery state is durable. A failed
      // delivery stays generic and does not roll back a committed credential change.
      for (const delivery of effects) void Promise.resolve().then(() => deliverRecovery?.(delivery)).catch(() => {});
      return structuredClone(output);
    });
    pending = next.catch(() => {}); return next;
  }
  await transact(() => null);
  try { await syncDirectory(); } catch { throw fail('collaboration-storage-unavailable'); }
  const identity = Object.fromEntries(['createAccount', 'signIn', 'authenticate', 'refresh', 'signOut', 'getUser', 'completeRecovery']
    .map(method => [method, (...args) => transact(world => world.identity[method](...args))]));
  identity.beginRecovery = email => deliverRecovery ? transact(world => world.identity.beginRecovery(email))
    : Promise.reject(fail('collaboration-recovery-not-configured'));
  identity.deleteAccount = (context, password) => transact(world => {
    const userId = world.actor(context);
    if (!world.access.accountRemovalPlan(userId).ready) throw fail('ownership-transfer-required');
    const result = world.identity.deleteAccount(userId, password); world.access.removeUser(userId); return result;
  });
  const members = {
    invite: (context, projectId, email, role) => transact(world => world.access.inviteProject(world.actor(context), projectId, email, role)),
    accept: (context, token) => transact(world => {
      const userId = world.actor(context); return world.access.acceptInvitation(token, userId, world.identity.getUser(userId).email);
    }),
    setRole: (context, projectId, userId, role) => transact(world => world.access.setProjectRole(world.actor(context), projectId, userId, role)),
    remove: (context, projectId, userId) => transact(world => world.access.removeProjectMember(world.actor(context), projectId, userId)),
    transferOwnership: (context, projectId, userId) => transact(world => world.access.transferProjectOwnership(world.actor(context), projectId, userId))
  };
  return {
    identity, members,
    teams: { create: (context, name) => transact(world => world.access.createTeam(world.actor(context), name)),
      invite: (context, teamId, email, role) => transact(world => world.access.invite(world.actor(context), teamId, email, role)) },
    projects: { create: (context, input) => transact(world => {
      const actor = world.actor(context), before = world.access.snapshot().projects.find(project => project.id === input.projectId);
      if (before) world.access.authorize(actor, { projectId: input.projectId, resource: 'project', action: 'write' });
      const value = world.history.createProject(input);
      if (!before) world.access.registerProject(actor, value.id, input.teamId);
      else if (before.teamId !== input.teamId) throw fail('project-access-invalid');
      return value;
    }), delete: (context, projectId) => transact(world => world.access.deleteProject(world.actor(context), projectId)) },
    service: Object.fromEntries(['putManifest', 'createRevision', 'updateBranch', 'getManifest', 'getRevision',
      'findRevisionBySource', 'listRevisions', 'getBranch', 'listActivity', 'listNotifications', 'markNotificationRead', 'authorizeAsset']
      .map(method => [method, (...args) => transact(world => createAuthorizedProjectService(world)[method](...args))])),
    getStatus: () => transact(world => ({ schemaVersion: 1, generation: world.snapshot().generation })),
    rotateEncryption: next => validRing(next) ? transact(() => ({ rotated: true }), { rotate: next })
      : Promise.reject(fail('collaboration-service-invalid')),
    close: async () => { closing = true; await pending; }
  };
}
module.exports = { createDurableCollaborationService, validateCollaborationState, MAX_STATE_BYTES };
