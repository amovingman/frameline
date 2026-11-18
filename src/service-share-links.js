'use strict';
const { randomUUID, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');
const MIN_TTL_MS = 60 * 60 * 1000, MAX_TTL_MS = 30 * 24 * MIN_TTL_MS;
const MAX_LINKS = 10_000, MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/, MANIFEST = /^sha256:[a-f0-9]{64}$/;
const id = value => typeof value === 'string' && ID.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const ttl = value => Number.isSafeInteger(value) && value >= MIN_TTL_MS && value <= MAX_TTL_MS;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, 'value') && d.enumerable; });
const fail = code => Object.assign(new Error(code), { code });
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const tokenFor = (key, linkId) => createHmac('sha256', key).update('frameline:immutable-share-link:v1\0').update(linkId).digest('base64url');
const privateFields = ['id', 'projectId', 'branch', 'revisionId', 'manifestId', 'issuerId', 'createdAt', 'expiresAt', 'revokedAt', 'revokedBy', 'tokenHash'];
const publicFields = ['id', 'projectId', 'branch', 'revisionId', 'manifestId', 'issuerId', 'createdAt', 'expiresAt', 'revokedAt'];
const revisionSummary = value => Object.fromEntries(['id', 'manifestId', 'message', 'createdAt'].map(key => [key, value[key]]));
function validateServiceShareLinksState(value, paginationKey) {
  const invalid = () => { throw fail('share-state-invalid'); };
  if (value?.version > 1) throw fail('share-state-newer-version');
  if (typeof paginationKey !== 'string' || paginationKey.length < 32 || paginationKey.length > 256
    || !exact(value, ['version', 'links', 'idempotency']) || value.version !== 1 || !Array.isArray(value.links)
    || !Array.isArray(value.idempotency) || value.links.length > MAX_LINKS || value.idempotency.length !== value.links.length) invalid();
  const links = new Map(), hashes = new Set();
  for (const item of value.links) {
    if (!exact(item, privateFields) || !['id', 'projectId', 'branch', 'revisionId', 'issuerId'].every(key => id(item[key])) || links.has(item.id)
      || typeof item.manifestId !== 'string' || !MANIFEST.test(item.manifestId) || !time(item.createdAt) || !time(item.expiresAt)
      || !ttl(item.expiresAt - item.createdAt) || (item.revokedAt === null ? item.revokedBy !== null : !time(item.revokedAt) || item.revokedAt < item.createdAt || !id(item.revokedBy))
      || typeof item.tokenHash !== 'string' || !SHA.test(item.tokenHash) || hashes.has(item.tokenHash)
      || tokenHash(tokenFor(paginationKey, item.id)) !== item.tokenHash) invalid();
    links.set(item.id, item); hashes.add(item.tokenHash);
  }
  const keys = new Set(), references = new Set();
  for (const item of value.idempotency) {
    if (!exact(item, ['keyHash', 'requestHash', 'actorId', 'projectId', 'branch', 'expectedHead', 'ttlMs', 'linkId'])
      || !['actorId', 'projectId', 'branch', 'expectedHead', 'linkId'].every(key => id(item[key]))
      || typeof item.keyHash !== 'string' || !SHA.test(item.keyHash) || keys.has(item.keyHash) || references.has(item.linkId) || !ttl(item.ttlMs)) invalid();
    const link = links.get(item.linkId);
    if (!link || link.issuerId !== item.actorId || link.projectId !== item.projectId || link.branch !== item.branch
      || link.revisionId !== item.expectedHead || link.expiresAt - link.createdAt !== item.ttlMs
      || item.requestHash !== fingerprint({ actorId: item.actorId, projectId: item.projectId, branch: item.branch, expectedHead: item.expectedHead, ttlMs: item.ttlMs })) invalid();
    keys.add(item.keyHash); references.add(item.linkId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid();
  return structuredClone(value);
}

function createServiceShareLinks({ history, access, isActiveUser, activity = null, paginationKey, initialState = null, now = Date.now } = {}) {
  if (!history || !['getBranch', 'getRevision', 'getManifest', 'snapshot'].every(key => typeof history[key] === 'function')
    || !access || typeof access.authorize !== 'function' || typeof access.roleFor !== 'function' || typeof isActiveUser !== 'function'
    || typeof paginationKey !== 'string' || paginationKey.length < 32 || paginationKey.length > 256 || typeof now !== 'function') throw fail('share-links-invalid');
  let state = initialState == null ? { version: 1, links: [], idempotency: [] } : validateServiceShareLinksState(initialState, paginationKey);
  const clock = () => { const at = now(); if (!time(at)) throw fail('share-links-invalid'); return at; };
  function authorize(actorId, projectId) {
    if (!id(actorId) || !id(projectId)) throw fail('share-links-invalid');
    access.authorize(actorId, { projectId, resource: 'project', action: 'write' });
  }
  function head(projectId, branch) { if (!id(branch)) throw fail('share-links-invalid'); return history.getBranch(projectId, branch).revisionId; }
  function available(value) {
    try { return isActiveUser(value.issuerId) === true && access.roleFor(value.issuerId, value.projectId) === 'owner'; } catch { return false; }
  }
  function status(value, at = clock()) { return value.revokedAt !== null ? 'revoked' : at >= value.expiresAt ? 'expired' : !available(value) ? 'unavailable' : 'active'; }
  function publicLink(value, at = clock()) {
    return { ...Object.fromEntries(publicFields.map(key => [key, value[key]])),
      revisionMessage: history.getRevision(value.projectId, value.revisionId).message, status: status(value, at) };
  }
  function commit(next, event) {
    if (next.links.length > MAX_LINKS || Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('share-links-capacity');
    activity?.record({ ...event, recipientIds: access.listProjectMembers(event.actorId, event.projectId).map(item => item.userId) });
    state = next;
  }
  function create(actorId, input) {
    if (!exact(input, ['projectId', 'branch', 'expectedHead', 'ttlMs', 'idempotencyKey']) || !id(input.expectedHead) || !id(input.idempotencyKey) || !ttl(input.ttlMs)) throw fail('share-links-invalid');
    authorize(actorId, input.projectId); const current = head(input.projectId, input.branch);
    const content = { actorId, projectId: input.projectId, branch: input.branch, expectedHead: input.expectedHead, ttlMs: input.ttlMs };
    const keyHash = fingerprint({ kind: 'immutable-share-link', actorId, projectId: input.projectId, branch: input.branch, idempotencyKey: input.idempotencyKey });
    const requestHash = fingerprint(content), replay = state.idempotency.find(item => item.keyHash === keyHash);
    if (replay) {
      if (replay.requestHash !== requestHash) throw fail('share-idempotency-conflict');
      const value = state.links.find(item => item.id === replay.linkId);
      return { link: publicLink(value), token: tokenFor(paginationKey, value.id) };
    }
    if (current === null || current !== input.expectedHead) throw fail('share-head-stale');
    const revision = history.getRevision(input.projectId, current), stored = history.getManifest(input.projectId, revision.manifestId);
    try { validateRevisionManifest(stored.document); if (revision.manifestId !== `sha256:${fingerprint(stored.document)}`) throw Error(); }
    catch { throw fail('share-revision-unavailable'); }
    const at = clock(); if (!time(at + input.ttlMs)) throw fail('share-links-invalid');
    const linkId = randomUUID(), token = tokenFor(paginationKey, linkId);
    const value = { id: linkId, projectId: input.projectId, branch: input.branch, revisionId: revision.id, manifestId: revision.manifestId,
      issuerId: actorId, createdAt: at, expiresAt: at + input.ttlMs, revokedAt: null, revokedBy: null, tokenHash: tokenHash(token) };
    commit({ version: 1, links: [...state.links, value], idempotency: [...state.idempotency, { keyHash, requestHash, ...content, linkId }] },
      { projectId: input.projectId, actorId, type: 'share.created', subjectId: linkId });
    return { link: publicLink(value, at), token };
  }
  function revoke(actorId, input) {
    if (!exact(input, ['projectId', 'linkId']) || !id(input.linkId)) throw fail('share-links-invalid');
    authorize(actorId, input.projectId);
    const value = state.links.find(item => item.id === input.linkId && item.projectId === input.projectId);
    if (!value) throw fail('share-link-not-found');
    if (value.revokedAt !== null) return publicLink(value);
    const next = { ...value, revokedAt: Math.max(clock(), value.createdAt), revokedBy: actorId };
    commit({ ...state, links: state.links.map(item => item === value ? next : item) }, { projectId: input.projectId, actorId, type: 'share.revoked', subjectId: value.id });
    return publicLink(next);
  }
  function redeem(input) {
    try {
      if (!exact(input, ['token']) || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)
        || Buffer.from(input.token, 'base64url').toString('base64url') !== input.token) throw Error();
      const hash = tokenHash(input.token), value = state.links.find(item => item.tokenHash === hash);
      if (!value || status(value) !== 'active') throw Error();
      const revision = history.getRevision(value.projectId, value.revisionId), stored = history.getManifest(value.projectId, value.manifestId);
      if (revision.manifestId !== value.manifestId || value.manifestId !== `sha256:${fingerprint(stored.document)}`) throw Error();
      validateRevisionManifest(stored.document);
      const project = history.snapshot().projects[value.projectId];
      return structuredClone({ permission: 'read', projectId: value.projectId, projectName: project.name, revision: revisionSummary(revision), manifest: stored.document, expiresAt: value.expiresAt });
    } catch { throw fail('share-link-unavailable'); }
  }
  function sign(value) { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', paginationKey).update(payload).digest('base64url')}`; }
  function getReview(actorId, projectId, branch, options = {}) {
    authorize(actorId, projectId); const currentHead = head(projectId, branch);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).some(key => !['limit', 'cursor'].includes(key)) || !exact(options, Object.keys(options))) throw fail('share-links-invalid');
    const { limit = 20, cursor = null } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('share-links-invalid');
    const links = state.links.filter(item => item.projectId === projectId && item.branch === branch), expected = { v: 1, actorId, projectId, branch, head: currentHead };
    let anchor = links.length - 1, before = links.length;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw fail('share-cursor-invalid');
      const [payload, signature] = cursor.split('.'), hmac = createHmac('sha256', paginationKey).update(payload).digest('base64url');
      if (!timingSafeEqual(Buffer.from(hmac), Buffer.from(signature))) throw fail('share-cursor-invalid');
      let value; try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) throw Error(); value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('share-cursor-invalid'); }
      if (!exact(value, [...Object.keys(expected), 'anchor', 'before']) || Object.keys(expected).some(key => value[key] !== expected[key])) throw fail('share-cursor-invalid');
      anchor = links.findIndex(item => item.id === value.anchor); before = links.findIndex(item => item.id === value.before);
      if (anchor < 0 || before < 0 || before > anchor) throw fail('share-cursor-invalid');
    }
    const remaining = links.slice(0, Math.min(anchor + 1, before)).reverse(), selected = remaining.slice(0, limit), at = clock();
    return { projectId, branch, headRevisionId: currentHead, revision: currentHead === null ? null : revisionSummary(history.getRevision(projectId, currentHead)),
      links: { items: selected.map(item => publicLink(item, at)), total: links.length,
        nextCursor: remaining.length > limit ? sign({ ...expected, anchor: links[anchor].id, before: selected.at(-1).id }) : null } };
  }
  return { create, revoke, redeem, getReview, snapshot: () => structuredClone(state) };
}
module.exports = { createServiceShareLinks, validateServiceShareLinksState, MIN_TTL_MS, MAX_TTL_MS, MAX_LINKS, MAX_BYTES };
