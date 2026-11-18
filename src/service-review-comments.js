'use strict';
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const MAX_COMMENTS = 20_000, MAX_BYTES = 16 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, 'value') && d.enumerable; });
const time = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bodyValid = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 1000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const opaqueId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !/[\\/\x00-\x1f\x7f]/.test(value);
const fail = code => Object.assign(new Error(code), { code });
const immutable = value => Object.fromEntries(['projectId', 'revisionId', 'authorId', 'anchor', 'body'].map(key => [key, value[key]]));
const fields = ['id', 'projectId', 'revisionId', 'authorId', 'anchor', 'body', 'status', 'createdAt', 'resolvedAt', 'resolvedBy'];

function validateServiceReviewAnchor(value) {
  if (exact(value, ['kind', 'timelineId', 'clipId']) && value.kind === 'clip' && opaqueId(value.timelineId) && opaqueId(value.clipId)) return structuredClone(value);
  if (exact(value, ['kind', 'timelineId', 'startFrame', 'endFrame']) && value.kind === 'range' && opaqueId(value.timelineId)
    && Number.isSafeInteger(value.startFrame) && value.startFrame >= 0 && Number.isSafeInteger(value.endFrame) && value.endFrame > value.startFrame) return structuredClone(value);
  throw fail('comment-anchor-invalid');
}

function createServiceReviewAnchorVerifier(manifest) {
  if (manifest?.format !== 'resolve-api-observation') throw fail('comment-revision-unsupported');
  try { validateResolveRevisionManifest(manifest); } catch { throw fail('comment-anchor-unverified'); }
  const timelines = new Map(manifest.snapshot.timelines.map(timeline => [timeline.id, { start: timeline.start_frame,
    end: timeline.items.reduce((end, item) => Math.max(end, item.end_frame), 0), clips: new Set(timeline.items.map(item => item.id)) }]));
  return input => {
    const anchor = validateServiceReviewAnchor(input), timeline = timelines.get(anchor.timelineId);
    if (!timeline || (anchor.kind === 'clip' ? !timeline.clips.has(anchor.clipId)
      : anchor.startFrame < timeline.start || !timeline.clips.size || anchor.endFrame > timeline.end)) throw fail('comment-anchor-unverified');
    return anchor;
  };
}
function assertServiceReviewAnchor(manifest, input) { return createServiceReviewAnchorVerifier(manifest)(input); }

function validateServiceReviewCommentsState(value) {
  if (value?.version > 1) throw fail('comment-state-newer-version');
  const invalid = () => { throw fail('comment-state-invalid'); };
  if (!exact(value, ['version', 'comments', 'idempotency']) || value.version !== 1 || !Array.isArray(value.comments) || !Array.isArray(value.idempotency)
    || value.comments.length > MAX_COMMENTS || value.idempotency.length !== value.comments.length) invalid();
  const comments = new Map();
  for (const item of value.comments) {
    if (!exact(item, fields) || !['id', 'projectId', 'revisionId', 'authorId'].every(key => validId(item[key])) || comments.has(item.id)
      || !bodyValid(item.body) || !time(item.createdAt) || !['open', 'resolved'].includes(item.status)
      || (item.status === 'open' ? item.resolvedAt !== null || item.resolvedBy !== null
        : !time(item.resolvedAt) || Date.parse(item.resolvedAt) < Date.parse(item.createdAt) || !validId(item.resolvedBy))) invalid();
    try { validateServiceReviewAnchor(item.anchor); } catch { invalid(); }
    comments.set(item.id, item);
  }
  const keys = new Set(), references = new Set();
  for (const item of value.idempotency) {
    if (!exact(item, ['keyHash', 'requestHash', 'commentId']) || typeof item.keyHash !== 'string' || !SHA.test(item.keyHash)
      || keys.has(item.keyHash) || !comments.has(item.commentId) || references.has(item.commentId)
      || item.requestHash !== fingerprint(immutable(comments.get(item.commentId)))) invalid();
    keys.add(item.keyHash); references.add(item.commentId);
  }
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { invalid(); }
  if (bytes > MAX_BYTES) invalid(); return structuredClone(value);
}

function createServiceReviewComments({ history, access, initialState = null, paginationKey, now = Date.now } = {}) {
  if (!history || typeof history.getRevision !== 'function' || typeof history.getManifest !== 'function'
    || !access || typeof access.authorize !== 'function' || typeof access.roleFor !== 'function'
    || typeof paginationKey !== 'string' || paginationKey.length < 32 || paginationKey.length > 256 || typeof now !== 'function') throw fail('comments-invalid');
  let state = initialState === null ? { version: 1, comments: [], idempotency: [] } : validateServiceReviewCommentsState(initialState);
  const authorize = (actorId, projectId, action) => {
    if (!validId(actorId) || !validId(projectId)) throw fail('comments-invalid');
    return access.authorize(actorId, { projectId, resource: 'comment', action });
  };
  const publicComment = (item, actorId) => ({ ...structuredClone(item), canResolve: item.status === 'open' && (item.authorId === actorId || access.roleFor(actorId, item.projectId) === 'owner') });
  function manifest(projectId, revisionId) {
    if (!validId(revisionId)) throw fail('comments-invalid');
    const revision = history.getRevision(projectId, revisionId), value = history.getManifest(projectId, revision.manifestId).document;
    if (value?.format !== 'resolve-api-observation') throw fail('comment-revision-unsupported');
    try { validateResolveRevisionManifest(value); } catch { throw fail('comment-anchor-unverified'); }
    return value;
  }
  function commit(next) {
    if (next.comments.length > MAX_COMMENTS || Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('comment-capacity');
    state = next;
  }
  function add(actorId, input) {
    if (!exact(input, ['projectId', 'revisionId', 'anchor', 'body', 'idempotencyKey']) || !validId(input.idempotencyKey)
      || typeof input.body !== 'string' || !bodyValid(input.body.trim())) throw fail('comments-invalid');
    authorize(actorId, input.projectId, 'write');
    const anchor = assertServiceReviewAnchor(manifest(input.projectId, input.revisionId), input.anchor), body = input.body.trim();
    const keyHash = fingerprint({ actorId, projectId: input.projectId, revisionId: input.revisionId, idempotencyKey: input.idempotencyKey });
    const content = { projectId: input.projectId, revisionId: input.revisionId, authorId: actorId, anchor, body }, requestHash = fingerprint(content);
    const replay = state.idempotency.find(item => item.keyHash === keyHash);
    if (replay) {
      if (replay.requestHash !== requestHash) throw fail('comment-idempotency-conflict');
      return publicComment(state.comments.find(item => item.id === replay.commentId), actorId);
    }
    const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('comments-invalid');
    const comment = { id: randomUUID(), ...content, status: 'open', createdAt: new Date(at).toISOString(), resolvedAt: null, resolvedBy: null };
    commit({ version: 1, comments: [...state.comments, comment], idempotency: [...state.idempotency, { keyHash, requestHash, commentId: comment.id }] });
    return publicComment(comment, actorId);
  }
  function resolve(actorId, input) {
    if (!exact(input, ['projectId', 'revisionId', 'commentId']) || !validId(input.commentId)) throw fail('comments-invalid');
    authorize(actorId, input.projectId, 'read'); manifest(input.projectId, input.revisionId);
    const index = state.comments.findIndex(item => item.id === input.commentId && item.projectId === input.projectId && item.revisionId === input.revisionId);
    if (index < 0) throw fail('comment-not-found');
    const item = state.comments[index];
    if (item.authorId !== actorId && access.roleFor(actorId, input.projectId) !== 'owner') throw fail('forbidden');
    if (item.status === 'open') {
      const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('comments-invalid');
      const comments = state.comments.slice(); comments[index] = { ...item, status: 'resolved', resolvedAt: new Date(Math.max(at, Date.parse(item.createdAt))).toISOString(), resolvedBy: actorId };
      commit({ ...state, comments });
    }
    return publicComment(state.comments[index], actorId);
  }
  function sign(value) { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', paginationKey).update(payload).digest('base64url')}`; }
  function cursorValue(cursor, actorId, projectId, revisionId) {
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw fail('comment-cursor-invalid');
    const [payload, signature] = cursor.split('.'), expected = createHmac('sha256', paginationKey).update(payload).digest('base64url');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw fail('comment-cursor-invalid');
    let value; try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) throw new Error(); value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('comment-cursor-invalid'); }
    if (!exact(value, ['v', 'actorId', 'projectId', 'revisionId', 'anchor', 'before']) || value.v !== 1 || value.actorId !== actorId
      || value.projectId !== projectId || value.revisionId !== revisionId || !validId(value.anchor) || !validId(value.before)) throw fail('comment-cursor-invalid');
    return value;
  }
  function list(actorId, projectId, revisionId, options = {}) {
    authorize(actorId, projectId, 'read'); manifest(projectId, revisionId);
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some(key => !['limit', 'cursor'].includes(key))
      || !exact(options, Object.keys(options))) throw fail('comments-invalid');
    const { limit = 20, cursor = null } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('comments-invalid');
    const comments = state.comments.filter(item => item.projectId === projectId && item.revisionId === revisionId);
    let anchor = comments.length - 1, before = comments.length;
    if (cursor !== null) {
      const value = cursorValue(cursor, actorId, projectId, revisionId);
      anchor = comments.findIndex(item => item.id === value.anchor); before = comments.findIndex(item => item.id === value.before);
      if (anchor < 0 || before < 0 || before > anchor) throw fail('comment-cursor-invalid');
    }
    const remaining = comments.slice(0, Math.min(anchor + 1, before)).reverse(), selected = remaining.slice(0, limit);
    return { projectId, revisionId, items: selected.map(item => publicComment(item, actorId)), total: comments.length,
      openCount: comments.filter(item => item.status === 'open').length,
      nextCursor: remaining.length > limit ? sign({ v: 1, actorId, projectId, revisionId, anchor: comments[anchor].id, before: selected.at(-1).id }) : null };
  }
  return { add, list, resolve, snapshot: () => structuredClone(state) };
}

module.exports = { createServiceReviewComments, validateServiceReviewCommentsState, validateServiceReviewAnchor, assertServiceReviewAnchor,
  createServiceReviewAnchorVerifier, MAX_COMMENTS, MAX_BYTES };
