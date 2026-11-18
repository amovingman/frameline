'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { createIdentityService, validateIdentityState } = require('./identity-service');
const { createAccessControl, validateAccessState } = require('./access-control');
const { createCloudHistoryStore, migrateServiceState, manifestStorageKey } = require('./cloud-history-store');
const { createAuthorizedProjectService } = require('./authorized-project-service');
const { validateRevisionManifest } = require('./revision-manifest');
const { fingerprint } = require('./project-api-contracts');
const { createProjectActivity, validateActivityState } = require('./project-activity');
const { createServiceReviewComments, validateServiceReviewCommentsState, createServiceReviewAnchorVerifier } = require('./service-review-comments');
const { createServiceBranchProtection, validateServiceBranchProtectionState } = require('./service-branch-protection');
const { createServiceShareLinks, validateServiceShareLinksState } = require('./service-share-links');
const { createServiceNotifications, validateServiceNotificationsState } = require('./service-notifications');
const { createServiceProjectPresets, validateServiceProjectPresetsState } = require('./service-project-presets');

const MAX_STATE_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 96 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const date = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value));
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\\/\x00-\x1f\x7f]/.test(value);
function fail(code) { return Object.assign(new Error(code), { code }); }

function validateHistory(input) {
  input = migrateServiceState(input);
  if (!exact(input, ['schemaVersion', 'projects', 'manifests', 'revisions', 'idempotency']) || input.schemaVersion !== 3
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
  for (const [key, manifest] of Object.entries(input.manifests)) {
    if (!exact(manifest, ['id', 'projectId', 'document', 'createdAt']) || key !== manifestStorageKey(manifest.projectId, manifest.id)
      || !validId(manifest.projectId) || !Object.hasOwn(input.projects, manifest.projectId)
      || manifest.id !== `sha256:${fingerprint(manifest.document)}` || !date(manifest.createdAt)) throw fail('collaboration-state-invalid');
    try { validateRevisionManifest(manifest.document); } catch { throw fail('collaboration-state-invalid'); }
  }
  for (const [id, revision] of Object.entries(input.revisions)) {
    if (!exact(revision, ['id', 'projectId', 'manifestId', 'parentRevisionId', 'authorId', 'message', 'sourceRevisionId', 'createdAt'])
      || !validId(id) || revision.id !== id || !['projectId', 'manifestId', 'authorId'].every(key => validId(revision[key]))
      || revision.parentRevisionId !== null && !validId(revision.parentRevisionId)
      || revision.sourceRevisionId !== null && !validId(revision.sourceRevisionId)
      || !text(revision.message, 240) || !date(revision.createdAt)) throw fail('collaboration-state-invalid');
    const key = manifestStorageKey(revision.projectId, revision.manifestId);
    if (!Object.hasOwn(input.projects, revision.projectId) || !Object.hasOwn(input.manifests, key)
      || input.manifests[key].projectId !== revision.projectId
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
    if (input?.schemaVersion > 7) throw fail('collaboration-state-newer-version');
    const legacy = input?.schemaVersion === 1;
    if (!exact(input, ['schemaVersion', 'generation', 'paginationKey', 'identity', 'access', 'history', ...(legacy ? [] : ['activity']), ...(input?.schemaVersion >= 3 ? ['comments'] : []), ...(input?.schemaVersion >= 4 ? ['branchProtection'] : []), ...(input?.schemaVersion >= 5 ? ['shareLinks'] : []), ...(input?.schemaVersion >= 6 ? ['notifications'] : []), ...(input?.schemaVersion === 7 ? ['projectPresets'] : [])]) || ![1, 2, 3, 4, 5, 6, 7].includes(input.schemaVersion)
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
    const activity = validateActivityState(legacy ? { version: 1, events: [], receipts: {} } : input.activity);
    const invitations = new Map(access.invitations.map(item => [item.id, item]));
    for (const event of activity.events) {
      if (!projects.has(event.projectId) || !users.has(event.actorId) || event.recipientIds.some(id => !users.has(id))) throw fail('collaboration-state-invalid');
      if (['revision.created', 'pull.completed'].includes(event.type) && (!Object.hasOwn(history.revisions, event.subjectId)
        || history.revisions[event.subjectId].projectId !== event.projectId)) throw fail('collaboration-state-invalid');
      if (event.type === 'branch.changed' && !Object.hasOwn(history.projects[event.projectId].branches, event.subjectId)) throw fail('collaboration-state-invalid');
      if (event.type === 'member.invited' && invitations.get(event.subjectId)?.projectId !== event.projectId) throw fail('collaboration-state-invalid');
      if (['member.joined', 'member.role-changed', 'member.removed', 'owner.transferred'].includes(event.type) && !users.has(event.subjectId)) throw fail('collaboration-state-invalid');
      if (event.type === 'project.deleted' && access.projects.find(project => project.id === event.projectId).deletedAt === null) throw fail('collaboration-state-invalid');
    }
    const comments = validateServiceReviewCommentsState(input.schemaVersion >= 3 ? input.comments : { version: 1, comments: [], idempotency: [] });
    const commentAnchors = new Map();
    for (const comment of comments.comments) {
      const revision = history.revisions[comment.revisionId];
      if (!users.has(comment.authorId) || comment.resolvedBy !== null && !users.has(comment.resolvedBy)
        || !projects.has(comment.projectId) || !revision || revision.projectId !== comment.projectId) throw fail('collaboration-state-invalid');
      if (!commentAnchors.has(revision.id)) commentAnchors.set(revision.id,
        createServiceReviewAnchorVerifier(history.manifests[manifestStorageKey(comment.projectId, revision.manifestId)].document));
      commentAnchors.get(revision.id)(comment.anchor);
    }
    const branchProtection = validateServiceBranchProtectionState(input.schemaVersion >= 4 ? input.branchProtection
      : { version: 1, policies: [], requests: [], idempotency: [] });
    const branchExists = item => projects.has(item.projectId) && Object.hasOwn(history.projects[item.projectId].branches, item.branch);
    const expectedEvents = new Map(), actualEvents = new Map();
    const countEvent = (map, type, projectId, actorId, subjectId) => { const key = JSON.stringify([type, projectId, actorId, subjectId]); map.set(key, (map.get(key) || 0) + 1); };
    for (const policy of branchProtection.policies) {
      if (!branchExists(policy) || !users.has(policy.updatedBy)) throw fail('collaboration-state-invalid');
      countEvent(expectedEvents, 'branch.protection-changed', policy.projectId, policy.updatedBy, policy.branch);
    }
    const requests = new Map(branchProtection.requests.map(item => [item.id, item]));
    // An applied receipt must remain on this branch's append-only ancestry.
    // Forest intervals avoid walking a long chain once per historical request.
    const intervals = new Map();
    if (branchProtection.requests.some(item => item.applied)) {
      const children = new Map();
      for (const revision of Object.values(history.revisions)) {
        if (!children.has(revision.parentRevisionId)) children.set(revision.parentRevisionId, []);
        children.get(revision.parentRevisionId).push(revision.id);
      }
      let position = 0;
      const stack = (children.get(null) || []).map(id => ({ id, exit: false }));
      while (stack.length) {
        const item = stack.pop();
        if (item.exit) { intervals.get(item.id).end = position; continue; }
        intervals.set(item.id, { start: position++, end: null });
        stack.push({ id: item.id, exit: true });
        for (const id of children.get(item.id) || []) stack.push({ id, exit: false });
      }
    }
    for (const request of branchProtection.requests) {
      const revision = history.revisions[request.revisionId];
      if (!branchExists(request) || !users.has(request.requesterId) || !revision || revision.projectId !== request.projectId
        || revision.parentRevisionId !== request.expectedHead || request.approvals.some(item => !users.has(item.actorId) || item.actorId === revision.authorId)
        || request.applied && request.approvals.filter(item => Date.parse(item.at) <= Date.parse(request.applied.at)).length < request.requiredApprovals) throw fail('collaboration-state-invalid');
      if (request.applied) {
        const candidate = intervals.get(request.revisionId), current = intervals.get(history.projects[request.projectId].branches[request.branch]);
        if (!candidate || !current || current.start < candidate.start || current.start >= candidate.end) throw fail('collaboration-state-invalid');
      }
      countEvent(expectedEvents, 'approval.requested', request.projectId, request.requesterId, request.id);
      for (const approval of request.approvals) countEvent(expectedEvents, 'approval.recorded', request.projectId, approval.actorId, request.id);
      if (request.applied) countEvent(expectedEvents, 'approval.applied', request.projectId, request.applied.actorId, request.id);
    }
    for (const receipt of branchProtection.idempotency) if (!branchExists(receipt) || !users.has(receipt.actorId)) throw fail('collaboration-state-invalid');
    for (const event of activity.events) if (['branch.protection-changed', 'approval.requested', 'approval.recorded', 'approval.applied'].includes(event.type)) {
      if (event.type === 'branch.protection-changed' ? !Object.hasOwn(history.projects[event.projectId].branches, event.subjectId)
        : requests.get(event.subjectId)?.projectId !== event.projectId) throw fail('collaboration-state-invalid');
      countEvent(actualEvents, event.type, event.projectId, event.actorId, event.subjectId);
    }
    if (fingerprint([...expectedEvents.entries()].sort()) !== fingerprint([...actualEvents.entries()].sort())) throw fail('collaboration-state-invalid');
    const shareLinks = validateServiceShareLinksState(input.schemaVersion >= 5 ? input.shareLinks : { version: 1, links: [], idempotency: [] }, input.paginationKey);
    const links = new Map(shareLinks.links.map(item => [item.id, item]));
    const expectedShareEvents = new Map(), actualShareEvents = new Map();
    for (const link of shareLinks.links) {
      const revision = history.revisions[link.revisionId];
      if (!branchExists(link) || !users.has(link.issuerId) || link.revokedBy !== null && !users.has(link.revokedBy)
        || !revision || revision.projectId !== link.projectId || revision.manifestId !== link.manifestId) throw fail('collaboration-state-invalid');
      countEvent(expectedShareEvents, 'share.created', link.projectId, link.issuerId, link.id);
      if (link.revokedBy !== null) countEvent(expectedShareEvents, 'share.revoked', link.projectId, link.revokedBy, link.id);
    }
    for (const event of activity.events) if (['share.created', 'share.revoked'].includes(event.type)) {
      if (links.get(event.subjectId)?.projectId !== event.projectId) throw fail('collaboration-state-invalid');
      countEvent(actualShareEvents, event.type, event.projectId, event.actorId, event.subjectId);
    }
    if (fingerprint([...expectedShareEvents.entries()].sort()) !== fingerprint([...actualShareEvents.entries()].sort())) throw fail('collaboration-state-invalid');
    const notifications = validateServiceNotificationsState(input.schemaVersion >= 6 ? input.notifications
      : { version: 1, preferences: [], consents: [], idempotency: [], jobs: [] }, input.paginationKey);
    const eventPositions = new Map(activity.events.map((event, index) => [event.id, { event, index }]));
    const consents = new Map(notifications.consents.map(item => [item.id, item]));
    for (const item of [...notifications.preferences, ...notifications.consents, ...notifications.idempotency, ...notifications.jobs]) {
      if (!users.has(item.userId) || !projects.has(item.projectId)) throw fail('collaboration-state-invalid');
    }
    for (const consent of notifications.consents) if (consent.afterSequence > activity.events.length
      || consent.afterSequence > 0 && activity.events[consent.afterSequence - 1].id !== consent.afterEventId) throw fail('collaboration-state-invalid');
    for (const job of notifications.jobs) {
      const consent = consents.get(job.consentId); let previous = -1;
      for (const eventId of job.eventIds) {
        const item = eventPositions.get(eventId);
        if (!item || item.event.projectId !== job.projectId || !item.event.recipientIds.includes(job.userId)
          || item.index < consent.afterSequence || item.index <= previous) throw fail('collaboration-state-invalid');
        previous = item.index;
      }
    }
    const projectPresets = validateServiceProjectPresetsState(input.schemaVersion === 7 ? input.projectPresets
      : { version: 1, presets: [], saveReceipts: [], creations: [] });
    const teams = new Set(access.teams.map(team => team.id));
    for (const preset of projectPresets.presets) if (!teams.has(preset.teamId)
      || !users.has(preset.createdBy) || !users.has(preset.updatedBy)) throw fail('collaboration-state-invalid');
    for (const receipt of [...projectPresets.saveReceipts, ...projectPresets.creations]) {
      if (!teams.has(receipt.teamId) || !users.has(receipt.actorId)) throw fail('collaboration-state-invalid');
    }
    const projectAccess = new Map(access.projects.map(project => [project.id, project]));
    for (const creation of projectPresets.creations) {
      const project = history.projects[creation.projectId];
      if (!project || project.name !== creation.projectName || projectAccess.get(creation.projectId)?.teamId !== creation.teamId
        || creation.branches.some(branch => !Object.hasOwn(project.branches, branch))) throw fail('collaboration-state-invalid');
    }
    const output = { schemaVersion: 7, generation: input.generation, paginationKey: input.paginationKey, identity, access, history, activity, comments, branchProtection, shareLinks, notifications, projectPresets };
    if (Buffer.byteLength(JSON.stringify(output)) > MAX_STATE_BYTES) throw fail('collaboration-state-invalid');
    return output;
  } catch (error) {
    throw fail(error.code === 'collaboration-state-newer-version' ? error.code : 'collaboration-state-invalid');
  }
}

async function createDurableCollaborationService({ directory, keyring, now = () => Date.now(),
  deliverRecovery = null, storage = fs, lockTimeoutMs = 5000, initialize = false, notificationDeliveryAvailable = false,
  assetPolicyDefaultsEnabled = false } = {}) {
  const validRing = ring => ring && typeof ring.encrypt === 'function' && typeof ring.decrypt === 'function';
  if (!path.isAbsolute(directory || '') || !validRing(keyring) || typeof now !== 'function'
    || typeof initialize !== 'boolean' || typeof notificationDeliveryAvailable !== 'boolean' || typeof assetPolicyDefaultsEnabled !== 'boolean'
    || deliverRecovery !== null && typeof deliverRecovery !== 'function'
    || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30000) throw fail('collaboration-service-invalid');
  try {
    if (initialize) await storage.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await storage.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('collaboration-storage-unavailable');
    directory = await storage.realpath(directory);
  } catch { throw fail('collaboration-storage-unavailable'); }
  const filename = path.join(directory, 'collaboration.enc.json');
  let ring = keyring, pending = Promise.resolve(), closing = false, uncertain = false, observedKeyId = null, initialized = false, needsMigration = false;
  function validateEnvelope(value) {
    const base64 = (text, length = null) => typeof text === 'string' && Buffer.from(text, 'base64').toString('base64') === text
      && (length === null || Buffer.from(text, 'base64').length === length);
    if (!exact(value, ['version', 'keyId', 'algorithm', 'iv', 'tag', 'ciphertext'])
      || value.version !== 1 || value.algorithm !== 'aes-256-gcm' || !validId(value.keyId)
      || !base64(value.iv, 12) || !base64(value.tag, 16) || !base64(value.ciphertext) || !value.ciphertext) throw fail('collaboration-state-invalid');
  }
  async function read() {
    let handle;
    observedKeyId = null; needsMigration = false;
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
      const original = ring.decrypt(file.record), value = validateCollaborationState(original);
      needsMigration = fingerprint(original) !== fingerprint(value);
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
    const paginationKey = state?.paginationKey || randomBytes(32).toString('base64url');
    let access, activity, previousAccess = state?.access || { teams: [], projects: [], invitations: [] };
    access = createAccessControl({ initialState: state?.access, now, onProjectEvent: event => {
      if (!activity || !access) throw fail('collaboration-state-invalid');
      const after = access.snapshot(), beforeProject = previousAccess.projects.find(project => project.id === event.projectId);
      const afterProject = after.projects.find(project => project.id === event.projectId);
      const beforeRole = beforeProject?.roles.find(member => member.userId === event.subjectId)?.role;
      const afterRole = afterProject?.roles.find(member => member.userId === event.subjectId)?.role;
      const noop = ['member.joined', 'member.role-changed'].includes(event.type) && beforeRole === afterRole;
      if (!noop) activity.record({ ...event, type: event.type === 'member.joined' && beforeRole ? 'member.role-changed' : event.type,
        recipientIds: [...(afterProject?.roles.map(member => member.userId) || []), ...(event.type === 'member.removed' ? [event.subjectId] : [])] });
      previousAccess = after;
    } });
    activity = createProjectActivity({ access, now, initialState: state?.activity, paginationKey });
    const history = createCloudHistoryStore(state?.history, { pageSecret: paginationKey });
    const comments = createServiceReviewComments({ history, access, initialState: state?.comments, paginationKey, now });
    const branchProtection = createServiceBranchProtection({ history, access, activity, initialState: state?.branchProtection, paginationKey, now });
    const shareLinks = createServiceShareLinks({ history, access, activity, initialState: state?.shareLinks, paginationKey, now,
      isActiveUser: userId => identity.getUser(userId).status === 'active' });
    const notifications = createServiceNotifications({ identity, access, history, activity, initialState: state?.notifications,
      paginationKey, now, deliveryAvailable: notificationDeliveryAvailable });
    const projectPresets = createServiceProjectPresets({ identity, access, history, initialState: state?.projectPresets || null,
      mediaAvailable: assetPolicyDefaultsEnabled, now });
    const snapshot = () => validateCollaborationState({ schemaVersion: 7, generation: state?.generation || 0, paginationKey,
      identity: identity.snapshot(), access: access.snapshot(), history: history.snapshot(), activity: activity.snapshot(), comments: comments.snapshot(), branchProtection: branchProtection.snapshot(), shareLinks: shareLinks.snapshot(), notifications: notifications.snapshot(), projectPresets: projectPresets.snapshot() });
    const actor = context => identity.authenticate(context?.accessToken).userId;
    return { identity, access, history, activity, comments, branchProtection, shareLinks, notifications, projectPresets, snapshot, actor };
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
        if (!previous || needsMigration || rotate || fingerprint(previous) !== fingerprint(value)) {
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
    const before = world.access.snapshot();
    world.notifications.disable(userId);
    const result = world.identity.deleteAccount(userId, password); world.access.removeUser(userId);
    const after = world.access.snapshot();
    for (const project of before.projects) if (project.roles.some(member => member.userId === userId)) {
      const current = after.projects.find(item => item.id === project.id);
      if (!current.roles.some(member => member.userId === userId)) world.activity.record({ projectId: project.id, actorId: userId,
        type: 'member.removed', subjectId: userId, recipientIds: current.roles.map(member => member.userId) });
    }
    return result;
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
    notifications: Object.fromEntries(['schedule', 'claim', 'prepare', 'acknowledge', 'fail']
      .map(method => [method, (...args) => transact(world => world.notifications[method](...args))])),
    teams: { create: (context, name) => transact(world => world.access.createTeam(world.actor(context), name)),
      invite: (context, teamId, email, role) => transact(world => world.access.invite(world.actor(context), teamId, email, role)) },
    projects: { list: context => transact(world => {
      const userId = world.actor(context), history = world.history.snapshot();
      return { projects: world.access.snapshot().projects.flatMap(project => {
        const role = project.deletedAt === null && project.roles.find(member => member.userId === userId)?.role;
        return role ? [{ id: project.id, name: history.projects[project.id].name, role,
          branches: Object.keys(history.projects[project.id].branches).sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)) }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
    }), create: (context, input) => transact(world => {
      const actor = world.actor(context), before = world.access.snapshot().projects.find(project => project.id === input.projectId);
      if (before) world.access.authorize(actor, { projectId: input.projectId, resource: 'project', action: 'write' });
      const value = world.history.createProject(input);
      if (!before) world.access.registerProject(actor, value.id, input.teamId);
      else if (before.teamId !== input.teamId) throw fail('project-access-invalid');
      return value;
    }), delete: (context, projectId) => transact(world => world.access.deleteProject(world.actor(context), projectId)),
    getInitialAssetPolicy: (context, projectId) => transact(world => world.projectPresets.initialPolicy(world.actor(context), projectId)) },
    service: Object.fromEntries(['putManifest', 'createRevision', 'updateBranch', 'getManifest', 'getRevision',
      'findRevisionBySource', 'listRevisions', 'getBranch', 'listActivity', 'listNotifications', 'markNotificationRead', 'authorizeAsset', 'authorizeAssetPolicy',
      'listReviewComments', 'addReviewComment', 'resolveReviewComment', 'getBranchReview', 'setBranchProtection', 'requestBranchApproval', 'approveBranchRequest',
      'getShareReview', 'createShareLink', 'revokeShareLink', 'redeemShareLink', 'getAccountNotifications', 'markAccountNotificationRead',
      'getNotificationPreferences', 'setNotificationPreferences', 'disableNotificationDelivery', 'unsubscribeNotifications',
      'listPresetTeams', 'listProjectPresets', 'saveProjectPreset', 'previewProjectFromPreset', 'createProjectFromPreset']
      .map(method => [method, (...args) => transact(world => createAuthorizedProjectService(world)[method](...args))])),
    getStatus: () => transact(world => ({ schemaVersion: 7, generation: world.snapshot().generation })),
    rotateEncryption: next => validRing(next) ? transact(() => ({ rotated: true }), { rotate: next })
      : Promise.reject(fail('collaboration-service-invalid')),
    close: async () => { closing = true; await pending; }
  };
}
module.exports = { createDurableCollaborationService, validateCollaborationState, MAX_STATE_BYTES };
