'use strict';
const NOTIFICATION_ERROR_CODES = Object.freeze(['notification-invalid', 'notification-unavailable', 'notification-cursor-invalid',
  'notification-not-found', 'notification-capacity', 'notification-preference-version-conflict',
  'notification-idempotency-conflict', 'notification-delivery-unavailable']);
const TYPES = new Set(['revision.created', 'branch.changed', 'pull.completed', 'branch.protection-changed', 'approval.requested',
  'approval.recorded', 'approval.applied', 'share.created', 'share.revoked', 'member.invited', 'member.joined', 'member.role-changed',
  'member.removed', 'owner.transferred', 'project.deleted']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const id = value => typeof value === 'string' && ID.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const fail = (code = 'sync-response-invalid') => Object.assign(new Error(code), { code });
function validNotificationToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function validNotificationCursor(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [payload, signature] = value.split('.');
  return Buffer.from(payload, 'base64url').toString('base64url') === payload && validNotificationToken(signature);
}
function validateNotificationPageInput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['limit', 'cursor', 'filter'].includes(key))) throw fail('notification-invalid');
  const limit = value.limit === undefined ? 20 : value.limit, cursor = value.cursor === undefined ? null : value.cursor,
    filter = value.filter === undefined ? 'all' : value.filter;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['all', 'unread'].includes(filter)) throw fail('notification-invalid');
  if (cursor !== null && !validNotificationCursor(cursor)) throw fail('notification-cursor-invalid');
  return { limit, cursor, filter };
}
function validateAccountNotification(value) {
  const keys = ['id', 'projectId', 'projectName', 'actorId', 'subjectId', 'type', 'at', 'read', 'accessLost'];
  if (!exact(value, keys) || !id(value.id) || !TYPES.has(value.type) || !time(value.at)
    || typeof value.read !== 'boolean' || typeof value.accessLost !== 'boolean') throw fail();
  if (value.accessLost) {
    if (!['member.removed', 'project.deleted'].includes(value.type)
      || [value.projectId, value.projectName, value.actorId, value.subjectId].some(item => item !== null)) throw fail();
  } else if (!id(value.projectId) || !id(value.actorId) || value.subjectId !== null && !id(value.subjectId)
    || typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 120
    || /[\\/\x00-\x1f\x7f]/.test(value.projectName)) throw fail();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function validateAccountNotifications(value, { limit = 20, filter = 'all' } = {}) {
  if (!exact(value, ['items', 'nextCursor', 'unreadCount']) || !Array.isArray(value.items)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['all', 'unread'].includes(filter) || value.items.length > limit
    || !Number.isSafeInteger(value.unreadCount) || value.unreadCount < 0
    || value.nextCursor !== null && (!validNotificationCursor(value.nextCursor) || value.items.length !== limit)) throw fail();
  const seen = new Set(), items = value.items.map(item => {
    const checked = validateAccountNotification(item);
    if (seen.has(checked.id) || filter === 'unread' && checked.read) throw fail(); seen.add(checked.id); return checked;
  });
  if (value.unreadCount < items.filter(item => !item.read).length) throw fail();
  return { items, nextCursor: value.nextCursor, unreadCount: value.unreadCount };
}
function validateNotificationPreferences(value, projectId) {
  if (!exact(value, ['projectId', 'version', 'mode', 'digestHourUtc', 'updatedAt', 'deliveryAvailable', 'accountEmail'])
    || !id(projectId) || value.projectId !== projectId || !Number.isSafeInteger(value.version) || value.version < 0
    || !['off', 'immediate', 'daily'].includes(value.mode) || !Number.isSafeInteger(value.digestHourUtc)
    || value.digestHourUtc < 0 || value.digestHourUtc > 23 || typeof value.deliveryAvailable !== 'boolean'
    || (value.version === 0 ? value.mode !== 'off' || value.digestHourUtc !== 9 || value.updatedAt !== null : !time(value.updatedAt))
    || typeof value.accountEmail !== 'string' || value.accountEmail.length > 254 || value.accountEmail !== value.accountEmail.trim().toLowerCase()
    || /[\x00-\x1f\x7f]/.test(value.accountEmail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.accountEmail)) throw fail();
  return { projectId, version: value.version, mode: value.mode, digestHourUtc: value.digestHourUtc,
    updatedAt: value.updatedAt, deliveryAvailable: value.deliveryAvailable, accountEmail: value.accountEmail };
}
module.exports = { NOTIFICATION_ERROR_CODES, validNotificationToken, validNotificationCursor, validateNotificationPageInput,
  validateAccountNotification, validateAccountNotifications, validateNotificationPreferences };
