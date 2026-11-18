'use strict';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const COMMENT_ERROR_CODES = Object.freeze(['comments-invalid', 'comment-anchor-invalid', 'comment-anchor-unverified',
  'comment-revision-unsupported', 'comment-not-found', 'comment-idempotency-conflict', 'comment-cursor-invalid', 'comment-capacity']);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const identifier = value => typeof value === 'string' && ID.test(value);
const anchorId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048
  && !/[\\/\x00-\x1f\x7f]/.test(value);
function fail(code) { return Object.assign(new Error(code), { code }); }
function validReviewCommentCursor(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [payload, signature] = value.split('.');
  return Buffer.from(payload, 'base64url').toString('base64url') === payload
    && Buffer.from(signature, 'base64url').length === 32 && Buffer.from(signature, 'base64url').toString('base64url') === signature;
}
function validateReviewCommentAnchor(value, code = 'comment-anchor-invalid') {
  if (!value || !anchorId(value.timelineId)) throw fail(code);
  if (exact(value, ['kind', 'timelineId', 'clipId']) && value.kind === 'clip' && anchorId(value.clipId)) {
    return { kind: 'clip', timelineId: value.timelineId, clipId: value.clipId };
  }
  if (exact(value, ['kind', 'timelineId', 'startFrame', 'endFrame']) && value.kind === 'range'
    && Number.isSafeInteger(value.startFrame) && Number.isSafeInteger(value.endFrame)
    && value.startFrame >= 0 && value.endFrame > value.startFrame) {
    return { kind: 'range', timelineId: value.timelineId, startFrame: value.startFrame, endFrame: value.endFrame };
  }
  throw fail(code);
}
function validBody(value) {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 1000
    && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}
function normalizeReviewCommentBody(value, code = 'comments-invalid') {
  if (typeof value !== 'string' || !validBody(value.trim())) throw fail(code);
  return value.trim();
}
function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateReviewComment(value, { projectId, revisionId, commentId = null, anchor = null, body = null } = {}) {
  const keys = ['id', 'projectId', 'revisionId', 'authorId', 'anchor', 'body', 'status', 'createdAt', 'resolvedAt', 'resolvedBy', 'canResolve'];
  if (!exact(value, keys) || !identifier(value.id) || !identifier(value.authorId)
    || !identifier(projectId) || !identifier(revisionId) || value.projectId !== projectId || value.revisionId !== revisionId
    || commentId !== null && value.id !== commentId || !validBody(value.body) || !timestamp(value.createdAt)
    || !['open', 'resolved'].includes(value.status) || typeof value.canResolve !== 'boolean'
    || (value.status === 'open' ? value.resolvedAt !== null || value.resolvedBy !== null
      : !timestamp(value.resolvedAt) || !identifier(value.resolvedBy))) throw fail('sync-response-invalid');
  const checkedAnchor = validateReviewCommentAnchor(value.anchor, 'sync-response-invalid');
  if (anchor !== null && JSON.stringify(checkedAnchor) !== JSON.stringify(validateReviewCommentAnchor(anchor, 'sync-request-invalid'))
    || body !== null && value.body !== body) throw fail('sync-response-invalid');
  return Object.fromEntries(keys.map(key => [key, key === 'anchor' ? checkedAnchor : value[key]]));
}
function validateReviewCommentsPage(value, projectId, revisionId, { limit = 20 } = {}) {
  if (!exact(value, ['projectId', 'revisionId', 'items', 'nextCursor', 'total', 'openCount'])
    || value.projectId !== projectId || value.revisionId !== revisionId
    || !identifier(projectId) || !identifier(revisionId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Array.isArray(value.items) || value.items.length > limit
    || !Number.isSafeInteger(value.total) || value.total < value.items.length
    || !Number.isSafeInteger(value.openCount) || value.openCount < 0 || value.openCount > value.total
    || value.nextCursor !== null && (!validReviewCommentCursor(value.nextCursor) || value.items.length !== limit)) throw fail('sync-response-invalid');
  const seen = new Set();
  const items = value.items.map(item => {
    const checked = validateReviewComment(item, { projectId, revisionId });
    if (seen.has(checked.id)) throw fail('sync-response-invalid'); seen.add(checked.id); return checked;
  });
  if (value.openCount < items.filter(item => item.status === 'open').length) throw fail('sync-response-invalid');
  return { projectId, revisionId, items, nextCursor: value.nextCursor, total: value.total, openCount: value.openCount };
}

module.exports = { COMMENT_ERROR_CODES, validReviewCommentCursor, validateReviewCommentAnchor, normalizeReviewCommentBody,
  validateReviewComment, validateReviewCommentsPage };
