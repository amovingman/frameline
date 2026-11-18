'use strict';
const { fingerprint } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');
const SHARE_ERROR_CODES = Object.freeze(['share-links-invalid', 'share-links-unavailable', 'share-links-capacity',
  'share-cursor-invalid', 'share-head-stale', 'share-revision-unavailable', 'share-idempotency-conflict',
  'share-link-not-found', 'share-link-unavailable']);
const MIN_SHARE_TTL_MS = 3_600_000, MAX_SHARE_TTL_MS = 2_592_000_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const id = value => typeof value === 'string' && ID.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const message = value => typeof value === 'string' && value.trim().length > 0 && value === value.trim()
  && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value);
const manifestId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fail = (code = 'sync-response-invalid') => Object.assign(new Error(code), { code });
function validShareToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function validShareCursor(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [payload, signature] = value.split('.');
  return Buffer.from(payload, 'base64url').toString('base64url') === payload && validShareToken(signature);
}
function validateSharePageInput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['limit', 'cursor'].includes(key))) throw fail('share-links-invalid');
  const limit = value.limit === undefined ? 20 : value.limit, cursor = value.cursor === undefined ? null : value.cursor;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('share-links-invalid');
  if (cursor !== null && !validShareCursor(cursor)) throw fail('share-cursor-invalid');
  return { limit, cursor };
}
function validateRevision(value) {
  if (!exact(value, ['id', 'manifestId', 'message', 'createdAt']) || !id(value.id) || !manifestId(value.manifestId)
    || !message(value.message) || !iso(value.createdAt)) throw fail();
  return { id: value.id, manifestId: value.manifestId, message: value.message, createdAt: value.createdAt };
}
function validateShareLink(value, projectId, { branch = null, linkId = null, revisionId = null } = {}) {
  const keys = ['id', 'projectId', 'branch', 'revisionId', 'revisionMessage', 'manifestId', 'issuerId', 'createdAt', 'expiresAt', 'revokedAt', 'status'];
  if (!exact(value, keys) || !id(projectId) || value.projectId !== projectId || !id(value.id) || !id(value.branch)
    || branch !== null && value.branch !== branch || linkId !== null && value.id !== linkId
    || !id(value.revisionId) || revisionId !== null && value.revisionId !== revisionId
    || !message(value.revisionMessage) || !manifestId(value.manifestId) || !id(value.issuerId)
    || !time(value.createdAt) || !time(value.expiresAt) || value.expiresAt - value.createdAt < MIN_SHARE_TTL_MS
    || value.expiresAt - value.createdAt > MAX_SHARE_TTL_MS || value.revokedAt !== null && !time(value.revokedAt)
    || !['active', 'expired', 'revoked', 'unavailable'].includes(value.status)
    || (value.status === 'revoked') !== (value.revokedAt !== null)
    || value.revokedAt !== null && value.revokedAt < value.createdAt) throw fail();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function validateShareCreation(value, projectId, context = {}) {
  if (!exact(value, ['link', 'token']) || !validShareToken(value.token)) throw fail();
  return { link: validateShareLink(value.link, projectId, context), token: value.token };
}
function validateShareReview(value, projectId, branch, { limit = 20 } = {}) {
  if (!exact(value, ['projectId', 'branch', 'headRevisionId', 'revision', 'links']) || !id(projectId) || !id(branch)
    || value.projectId !== projectId || value.branch !== branch || value.headRevisionId !== null && !id(value.headRevisionId)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !exact(value.links, ['items', 'nextCursor', 'total'])
    || !Array.isArray(value.links.items) || value.links.items.length > limit || !Number.isSafeInteger(value.links.total)
    || value.links.total < value.links.items.length || value.links.nextCursor !== null && (!validShareCursor(value.links.nextCursor)
      || value.links.items.length !== limit)) throw fail();
  const revision = value.revision === null ? null : validateRevision(value.revision);
  if ((revision?.id ?? null) !== value.headRevisionId) throw fail();
  const seen = new Set(), items = value.links.items.map(item => {
    const checked = validateShareLink(item, projectId, { branch }); if (seen.has(checked.id)) throw fail(); seen.add(checked.id); return checked;
  });
  return { projectId, branch, headRevisionId: value.headRevisionId, revision, links: { items, nextCursor: value.links.nextCursor, total: value.links.total } };
}
function validateSharedRevision(value) {
  if (!exact(value, ['permission', 'projectId', 'projectName', 'revision', 'manifest', 'expiresAt']) || value.permission !== 'read'
    || !id(value.projectId) || typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 120
    || /[\\/\x00-\x1f\x7f]/.test(value.projectName) || !time(value.expiresAt)) throw fail();
  const revision = validateRevision(value.revision);
  try { validateRevisionManifest(value.manifest); } catch { throw fail(); }
  if (revision.manifestId !== `sha256:${fingerprint(value.manifest)}`) throw fail();
  return { permission: 'read', projectId: value.projectId, projectName: value.projectName, revision,
    manifest: structuredClone(value.manifest), expiresAt: value.expiresAt };
}
module.exports = { SHARE_ERROR_CODES, MIN_SHARE_TTL_MS, MAX_SHARE_TTL_MS, validShareToken, validShareCursor,
  validateSharePageInput, validateShareLink, validateShareCreation, validateShareReview, validateSharedRevision };
