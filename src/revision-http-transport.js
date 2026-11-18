'use strict';
const { TextDecoder } = require('node:util');
const { createHash } = require('node:crypto');
const { API_VERSION, createRequestContext, responseEnvelope } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');
const { validateReviewCommentAnchor, normalizeReviewCommentBody,
  validateReviewComment, validateReviewCommentsPage } = require('./review-comments-protocol');
const { validBranchReviewCursor, validateBranchReview, validateBranchProtectionPolicy,
  validateBranchApprovalRequest } = require('./branch-review-protocol');
const { validShareToken, validShareCursor, validateShareReview, validateShareCreation, validateShareLink,
  validateSharedRevision, MIN_SHARE_TTL_MS, MAX_SHARE_TTL_MS } = require('./share-links-protocol');
const { validNotificationToken, validNotificationCursor, validateAccountNotifications,
  validateNotificationPreferences } = require('./notification-protocol');

const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SERVICE_METHODS = ['putManifest', 'getManifest', 'createRevision', 'getRevision',
  'findRevisionBySource', 'getBranch', 'updateBranch'];
const ERRORS = new Map([
  ['access-token-invalid', 401], ['forbidden', 403], ['rate-limit-exceeded', 429],
  ['credentials-invalid', 401], ['refresh-token-invalid', 401],
  ...['project-not-found', 'manifest-not-found', 'revision-not-found', 'parent-revision-not-found',
    'branch-not-found'].map(code => [code, 404]),
  ...['branch-head-changed', 'revision-parent-mismatch', 'source-revision-exists',
    'idempotency-key-reused', 'manifest-project-mismatch', 'branch-protected',
    'branch-approval-required', 'approval-head-stale'].map(code => [code, 409]),
  ...['request-invalid', 'invalid-request-headers', 'api-version-unsupported', 'body-invalid',
    'revision-invalid', 'manifest-invalid', 'invalid-idempotency-key'].map(code => [code, 400]),
  ['secure-transport-required', 426], ['browser-request-forbidden', 403], ['route-not-found', 404],
  ['method-not-allowed', 405], ['content-type-invalid', 415], ['request-too-large', 413],
  ['response-too-large', 502], ['service-unavailable', 500], ['activity-page-invalid', 400], ['activity-cursor-invalid', 400],
  ['activity-state-invalid', 500], ['activity-state-newer-version', 409], ['activity-capacity-exceeded', 409], ['notification-not-found', 404],
  ...['comments-invalid', 'comment-anchor-invalid', 'comment-anchor-unverified', 'comment-revision-unsupported',
    'comment-cursor-invalid'].map(code => [code, 400]),
  ['comment-not-found', 404], ['comment-idempotency-conflict', 409], ['comment-capacity', 503],
  ...['branch-review-invalid', 'branch-review-cursor-invalid', 'approval-request-invalid'].map(code => [code, 400]),
  ...['branch-review-unavailable', 'branch-policy-version-conflict', 'branch-not-protected', 'approval-request-unavailable',
    'approval-policy-stale', 'approval-candidate-invalid', 'branch-review-idempotency-conflict'].map(code => [code, 409]),
  ['approval-forbidden', 403], ['branch-review-capacity', 503],
  ...['share-links-invalid', 'share-cursor-invalid'].map(code => [code, 400]),
  ...['share-head-stale', 'share-revision-unavailable', 'share-idempotency-conflict'].map(code => [code, 409]),
  ['share-link-not-found', 404], ['share-link-unavailable', 404], ['share-links-unavailable', 503], ['share-links-capacity', 503],
  ...['notification-invalid', 'notification-cursor-invalid'].map(code => [code, 400]),
  ...['notification-preference-version-conflict', 'notification-idempotency-conflict', 'notification-delivery-unavailable'].map(code => [code, 409]),
  ['notification-unavailable', 503], ['notification-capacity', 503]
]);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed, required) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw fail('body-invalid');
  return value;
}
function identifier(value, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !ID.test(value)) throw fail('body-invalid');
  return value;
}
function header(req, name) {
  let count = 0;
  for (let index = 0; index < (req.rawHeaders?.length || 0); index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  const value = req.headers[name];
  if (count > 1 || (value !== undefined && typeof value !== 'string')) throw fail('invalid-request-headers');
  return value;
}
const ACTIVITY_TYPES = new Set(['revision.created', 'branch.changed', 'pull.completed', 'branch.protection-changed',
  'approval.requested', 'approval.recorded', 'approval.applied', 'share.created', 'share.revoked', 'member.invited', 'member.joined',
  'member.role-changed', 'member.removed', 'owner.transferred', 'project.deleted']);
function validActivityCursor(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [payload, signature] = value.split('.');
  return Buffer.from(payload, 'base64url').toString('base64url') === payload
    && Buffer.from(signature, 'base64url').length === 32 && Buffer.from(signature, 'base64url').toString('base64url') === signature;
}
function validateProjectFeedPage(value, projectId, { limit = 20, notifications = false } = {}) {
  const exact = (item, keys) => record(item) && Object.keys(item).sort().join('|') === keys.slice().sort().join('|');
  const identifier = item => typeof item === 'string' && ID.test(item);
  if (!exact(value, ['projectId', 'items', 'nextCursor', 'unreadCount']) || value.projectId !== projectId || !identifier(value.projectId)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Array.isArray(value.items) || value.items.length > limit
    || value.nextCursor !== null && !validActivityCursor(value.nextCursor)
    || value.nextCursor !== null && value.items.length !== limit
    || (notifications ? !Number.isSafeInteger(value.unreadCount) || value.unreadCount < 0 : value.unreadCount !== null)) throw fail('sync-response-invalid');
  const seen = new Set(), keys = ['id', 'projectId', 'actorId', 'type', 'subjectId', 'at', ...(notifications ? ['read'] : [])];
  const items = value.items.map(item => {
    if (!exact(item, keys) || !identifier(item.id) || seen.has(item.id) || item.projectId !== projectId || !identifier(item.actorId)
      || !ACTIVITY_TYPES.has(item.type) || item.subjectId !== null && !identifier(item.subjectId)
      || !Number.isSafeInteger(item.at) || item.at < 0 || item.at > 8_640_000_000_000_000
      || notifications && typeof item.read !== 'boolean') throw fail('sync-response-invalid');
    seen.add(item.id); return Object.fromEntries(keys.map(key => [key, item[key]]));
  });
  if (notifications && value.unreadCount < items.filter(item => !item.read).length) throw fail('sync-response-invalid');
  // Append order is authoritative. Wall-clock timestamps can tie or move backward.
  return { projectId, items, nextCursor: value.nextCursor, unreadCount: value.unreadCount };
}
function activityPage(query) {
  const result = { limit: 20, cursor: null };
  if (query === undefined) return result;
  if (!query) throw fail('activity-page-invalid');
  const seen = new Set();
  for (const part of query.split('&')) {
    const [key, value, extra] = part.split('=');
    if (extra !== undefined || !['limit', 'cursor'].includes(key) || seen.has(key)) throw fail('activity-page-invalid');
    seen.add(key);
    if (key === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(value || '') || Number(value) > 100) throw fail('activity-page-invalid');
      result.limit = Number(value);
    } else { if (!validActivityCursor(value)) throw fail('activity-cursor-invalid'); result.cursor = value; }
  }
  return result;
}
function branchReviewPage(query) {
  const result = { limit: 20, requestCursor: null, candidateCursor: null };
  if (query === undefined) return result;
  if (!query) throw fail('branch-review-invalid');
  const seen = new Set();
  for (const part of query.split('&')) {
    const [key, value, extra] = part.split('=');
    if (extra !== undefined || !['limit', 'requestCursor', 'candidateCursor'].includes(key) || seen.has(key)) throw fail('branch-review-invalid');
    seen.add(key);
    if (key === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(value || '') || Number(value) > 100) throw fail('branch-review-invalid');
      result.limit = Number(value);
    } else { if (!validBranchReviewCursor(value)) throw fail('branch-review-cursor-invalid'); result[key] = value; }
  }
  return result;
}
function notificationPage(query) {
  const result = { limit: 20, cursor: null, filter: 'all' };
  if (query === undefined) return result;
  if (!query) throw fail('notification-invalid');
  const seen = new Set();
  for (const part of query.split('&')) {
    const [key, value, extra] = part.split('=');
    if (extra !== undefined || !['limit', 'cursor', 'filter'].includes(key) || seen.has(key)) throw fail('notification-invalid'); seen.add(key);
    if (key === 'limit') { if (!/^[1-9][0-9]{0,2}$/.test(value || '') || Number(value) > 100) throw fail('notification-invalid'); result.limit = Number(value); }
    else if (key === 'filter') { if (!['all', 'unread'].includes(value)) throw fail('notification-invalid'); result.filter = value; }
    else { if (!validNotificationCursor(value)) throw fail('notification-cursor-invalid'); result.cursor = value; }
  }
  return result;
}
function route(req) {
  // Parse origin-form paths directly: URL normalization must not hide dot segments.
  if (typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/')
    || /[#\\\s]/.test(req.url)) throw fail('request-invalid');
  const [pathname, query, extra] = req.url.split('?'); if (extra !== undefined) throw fail('request-invalid');
  let parts;
  try { parts = pathname.slice(1).split('/').map(part => decodeURIComponent(part)); }
  catch { throw fail('request-invalid'); }
  if (parts.some(part => !ID.test(part))) throw fail('request-invalid');
  if (parts.length === 2 && parts[0] === 'notifications' && parts[1] === 'unsubscribe') {
    if (query !== undefined) throw fail('request-invalid'); return { kind: 'unsubscribeNotifications', methods: ['POST'], anonymous: true };
  }
  if (parts.length === 2 && parts[0] === 'account' && parts[1] === 'notifications') {
    return { kind: 'getAccountNotifications', methods: ['GET'], page: notificationPage(query) };
  }
  if (parts.length === 2 && parts[0] === 'shares' && parts[1] === 'redeem') {
    if (query !== undefined) throw fail('request-invalid');
    return { kind: 'redeemShareLink', methods: ['POST'], anonymous: true };
  }
  if (parts[0] === 'projects' && parts[2] === 'branches' && parts.length === 5 && parts[4] === 'share-links') {
    let page;
    if (req.method === 'GET') {
      try { page = activityPage(query); }
      catch (error) { throw fail(error.code === 'activity-cursor-invalid' ? 'share-cursor-invalid' : 'share-links-invalid'); }
      if (page.cursor !== null && !validShareCursor(page.cursor)) throw fail('share-cursor-invalid');
    } else if (query !== undefined) throw fail('request-invalid');
    return { projectId: parts[1], branch: parts[3], kind: req.method === 'GET' ? 'getShareReview' : 'createShareLink', methods: ['GET', 'POST'], page };
  }
  if (parts[0] === 'projects' && parts[2] === 'branches' && parts.length === 5 && parts[4] === 'review') {
    return { projectId: parts[1], branch: parts[3], kind: 'getBranchReview', methods: ['GET'], page: branchReviewPage(query) };
  }
  if (req.url.length > 4096) throw fail('request-invalid');
  if (parts[0] === 'projects' && ID.test(parts[1] || '') && parts.length === 3 && ['activity', 'notifications'].includes(parts[2])) {
    return { projectId: parts[1], kind: parts[2] === 'activity' ? 'listActivity' : 'listNotifications', methods: ['GET'], page: activityPage(query) };
  }
  if (parts[0] === 'projects' && parts[2] === 'revisions' && parts[4] === 'comments' && parts.length === 5) {
    let page;
    if (req.method === 'GET') {
      try { page = activityPage(query); }
      catch (error) { throw fail(error.code === 'activity-cursor-invalid' ? 'comment-cursor-invalid' : 'comments-invalid'); }
    } else if (query !== undefined) throw fail('request-invalid');
    return { projectId: parts[1], revisionId: parts[3], kind: req.method === 'GET' ? 'listReviewComments' : 'addReviewComment',
      methods: ['GET', 'POST'], page };
  }
  if (query !== undefined || req.url.length > 2048) throw fail('request-invalid');
  if (parts[0] === 'account' && parts[1] === 'notifications') {
    if (parts.length === 4 && parts[3] === 'read') return { kind: 'markAccountNotificationRead', item: parts[2], methods: ['PUT'] };
    if (parts.length === 3 && parts[2] === 'disable-delivery') return { kind: 'disableNotificationDelivery', methods: ['POST'] };
  }
  if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'notification-preferences') {
    return { projectId: parts[1], kind: req.method === 'GET' ? 'getNotificationPreferences' : 'setNotificationPreferences', methods: ['GET', 'PUT'] };
  }
  if (parts[0] === 'projects' && parts.length === 5 && parts[2] === 'share-links' && parts[4] === 'revocation') {
    return { projectId: parts[1], item: parts[3], kind: 'revokeShareLink', methods: ['PUT'] };
  }
  if (parts[0] === 'projects' && parts[2] === 'branches') {
    if (parts.length === 5 && ['protection', 'approval-requests'].includes(parts[4])) {
      return { projectId: parts[1], branch: parts[3], kind: parts[4] === 'protection' ? 'setBranchProtection' : 'requestBranchApproval',
        methods: [parts[4] === 'protection' ? 'PUT' : 'POST'] };
    }
    if (parts.length === 7 && parts[4] === 'approval-requests' && parts[6] === 'approval') {
      return { projectId: parts[1], branch: parts[3], item: parts[5], kind: 'approveBranchRequest', methods: ['PUT'] };
    }
  }
  if (parts[0] === 'projects' && parts[2] === 'revisions' && parts[4] === 'comments'
    && parts.length === 7 && parts[6] === 'resolve') {
    return { projectId: parts[1], revisionId: parts[3], item: parts[5], kind: 'resolveReviewComment', methods: ['PUT'] };
  }
  if (parts[0] === 'projects' && ID.test(parts[1] || '') && parts.length === 5 && parts[2] === 'notifications' && parts[4] === 'read') {
    return { projectId: parts[1], item: parts[3], kind: 'markNotificationRead', methods: ['PUT'] };
  }
  if (parts.length === 1 && parts[0] === 'account') return { kind: 'account', methods: ['GET'] };
  if (parts.length === 1 && parts[0] === 'projects') return { kind: 'projects', methods: ['GET'] };
  if (parts[0] === 'auth' && parts[1] === 'sessions') {
    if (parts.length === 2) return { kind: 'signIn', methods: ['POST'], anonymous: true };
    if (parts.length === 3 && parts[2] === 'refresh') return { kind: 'refreshSession', methods: ['POST'], anonymous: true };
    if (parts.length === 3 && parts[2] === 'sign-out') return { kind: 'signOut', methods: ['POST'], anonymous: true };
  }
  if (parts[0] !== 'projects' || !ID.test(parts[1] || '')) throw fail('route-not-found');
  if (parts.some(part => !ID.test(part))) throw fail('request-invalid');
  const [, projectId, resource, item, sourceId] = parts;
  if (resource === 'manifests' && parts.length === 3) return { projectId, kind: 'putManifest', methods: ['PUT'] };
  if (resource === 'manifests' && parts.length === 4) return { projectId, item, kind: 'getManifest', methods: ['GET'] };
  if (resource === 'revisions' && parts.length === 3) return { projectId, kind: 'createRevision', methods: ['POST'] };
  if (resource === 'revisions' && parts.length === 5 && item === 'by-source') {
    return { projectId, item: sourceId, kind: 'findRevisionBySource', methods: ['GET'] };
  }
  if (resource === 'revisions' && parts.length === 4) return { projectId, item, kind: 'getRevision', methods: ['GET'] };
  if (resource === 'branches' && parts.length === 4) return { projectId, item, kind: 'branch', methods: ['GET', 'PUT'] };
  throw fail('route-not-found');
}
function createAuthLimiter() {
  const buckets = new Map();
  return ({ addressHash }) => {
    const now = Date.now(); let bucket = buckets.get(addressHash);
    if (!bucket || bucket.expiresAt <= now) {
      if (buckets.size >= 4096) for (const [key, value] of buckets) if (value.expiresAt <= now) buckets.delete(key);
      if (!bucket && buckets.size >= 4096) throw fail('rate-limit-exceeded');
      bucket = { count: 0, expiresAt: now + 60_000 }; buckets.set(addressHash, bucket);
    }
    if (++bucket.count > 60) throw fail('rate-limit-exceeded');
  };
}
function createShareRedeemLimiter({ now = Date.now } = {}) {
  const peers = new Map(); let global = { count: 0, expiresAt: 0 };
  return addressHash => {
    const at = now(); if (global.expiresAt <= at) global = { count: 0, expiresAt: at + 60_000 };
    if (global.count >= 120) throw fail('rate-limit-exceeded');
    let peer = peers.get(addressHash);
    if (!peer || peer.expiresAt <= at) {
      for (const [key, value] of peers) if (value.expiresAt <= at) peers.delete(key);
      if (!peer && peers.size >= 256) throw fail('rate-limit-exceeded');
      peer = { count: 0, expiresAt: at + 60_000 }; peers.set(addressHash, peer);
    }
    if (peer.count >= 20) throw fail('rate-limit-exceeded'); peer.count++; global.count++;
  };
}
function sameOrigin(req, value) {
  try { const origin = new URL(value), host = header(req, 'host');
    return typeof host === 'string' && origin.protocol === 'https:' && value === origin.origin && origin.host === host.toLowerCase();
  } catch { return false; }
}
function authBody(kind, body) {
  if (kind === 'signIn') {
    fields(body, ['email', 'password'], ['email', 'password']);
    if (typeof body.email !== 'string' || body.email.length > 254 || /[\x00-\x1f\x7f]/.test(body.email)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
      || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024) throw fail('body-invalid');
    return [body.email.trim().toLowerCase(), body.password];
  }
  fields(body, ['refreshToken'], ['refreshToken']);
  if (typeof body.refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.refreshToken)) throw fail('body-invalid');
  return [body.refreshToken];
}
async function readBody(req, writing, maxBytes = MAX_HTTP_BYTES) {
  const length = header(req, 'content-length');
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw fail('request-invalid');
  if (Number(length) > maxBytes) throw fail('request-too-large');
  if (header(req, 'content-encoding') !== undefined) throw fail('content-type-invalid');
  if (writing && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type') || '')) throw fail('content-type-invalid');
  if (!writing && (Number(length) > 0 || header(req, 'transfer-encoding') !== undefined)) throw fail('body-invalid');
  let size = 0; const chunks = [];
  await new Promise((resolve, reject) => {
    function cleanup() {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error);
    }
    function error() { cleanup(); reject(fail('body-invalid')); }
    function end() { cleanup(); resolve(); }
    function data(chunk) {
      size += chunk.length;
      if (size > maxBytes || (!writing && size)) {
        cleanup(); reject(fail(size > maxBytes ? 'request-too-large' : 'body-invalid')); return;
      }
      chunks.push(chunk);
    }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', error);
  });
  if (!writing) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw fail('body-invalid'); }
}
function revisionInput(body, projectId, idempotencyKey) {
  fields(body, ['manifestId', 'parentRevisionId', 'sourceRevisionId', 'message'], ['manifestId', 'message']);
  identifier(body.manifestId);
  if (body.parentRevisionId !== undefined) identifier(body.parentRevisionId, true);
  if (body.sourceRevisionId !== undefined) identifier(body.sourceRevisionId, true);
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 240) throw fail('body-invalid');
  return { ...body, projectId, idempotencyKey };
}

// This factory never creates or starts a server. The caller owns TLS, header/body
// timeouts, maxHeaderSize, connection limits and shutdown. Proxy headers are not
// transport evidence. Plain HTTP is supported solely for explicit loopback tests.
function createRevisionHttpHandler({ service, allowLoopbackHttp = false, identity = null, listProjects = null,
  authRateLimit = () => {} } = {}) {
  if (!service || !SERVICE_METHODS.every(name => typeof service[name] === 'function')
    || typeof allowLoopbackHttp !== 'boolean' || typeof authRateLimit !== 'function'
    || identity !== null && !['signIn', 'refresh', 'signOut', 'authenticate', 'getUser'].every(name => typeof identity[name] === 'function')
    || listProjects !== null && typeof listProjects !== 'function') throw fail('http-transport-invalid');
  const globalAuthLimit = createAuthLimiter();
  const shareRedeemLimit = createShareRedeemLimiter(); let shareRedeems = 0;
  const unsubscribeLimit = createShareRedeemLimiter(); let unsubscribes = 0;
  return async function revisionHttpHandler(req, res) {
    let context = createRequestContext(), shareAdmitted = false, shareRequest = false, unsubscribeAdmitted = false, unsubscribeRequest = false;
    try {
      if (!req.socket?.encrypted && !(allowLoopbackHttp
        && ['127.0.0.1', '::1'].includes(req.socket?.remoteAddress))) throw fail('secure-transport-required');
      const requestOrigin = header(req, 'origin');
      if (header(req, 'x-api-version') !== API_VERSION) throw fail('api-version-unsupported');
      context = createRequestContext({ 'x-request-id': header(req, 'x-request-id'),
        'idempotency-key': header(req, 'idempotency-key') });
      const target = route(req);
      shareRequest = target.kind === 'redeemShareLink';
      unsubscribeRequest = target.kind === 'unsubscribeNotifications';
      if (requestOrigin !== undefined && !((shareRequest || unsubscribeRequest) && sameOrigin(req, requestOrigin))) throw fail('browser-request-forbidden');
      if (!target.methods.includes(req.method)) {
        res.setHeader('Allow', target.methods.join(', '));
        throw fail('method-not-allowed');
      }
      const authorization = header(req, 'authorization');
      if (!target.anonymous) {
        if (typeof authorization !== 'string' || !/^Bearer [a-zA-Z0-9._~+\/-]{1,4096}={0,2}$/.test(authorization)) throw fail('access-token-invalid');
        context = { ...context, accessToken: authorization.slice(7) };
      } else {
        const rateContext = { addressHash: createHash('sha256').update(String(req.socket?.remoteAddress || 'unknown')).digest('hex'), action: target.kind };
        if (target.kind === 'redeemShareLink') {
          if (typeof service.redeemShareLink !== 'function') throw fail('route-not-found');
          if (authorization !== undefined) throw fail('share-link-unavailable');
          if (shareRedeems >= 8) throw fail('share-links-unavailable');
          shareRedeemLimit(rateContext.addressHash); shareRedeems++; shareAdmitted = true;
        } else if (unsubscribeRequest) {
          if (typeof service.unsubscribeNotifications !== 'function') throw fail('route-not-found');
          if (unsubscribes >= 8) throw fail('notification-unavailable');
          unsubscribeLimit(rateContext.addressHash); unsubscribes++; unsubscribeAdmitted = true;
        } else { if (!identity) throw fail('route-not-found'); globalAuthLimit(rateContext); await authRateLimit(rateContext); }
      }
      if (['listActivity', 'listNotifications', 'markNotificationRead', 'listReviewComments', 'addReviewComment', 'resolveReviewComment',
        'getBranchReview', 'setBranchProtection', 'requestBranchApproval', 'approveBranchRequest', 'getShareReview', 'createShareLink', 'revokeShareLink',
        'getAccountNotifications', 'markAccountNotificationRead', 'getNotificationPreferences', 'setNotificationPreferences', 'disableNotificationDelivery']
        .includes(target.kind) && typeof service[target.kind] !== 'function') throw fail('route-not-found');
      let body;
      try { body = await readBody(req, req.method !== 'GET', shareRequest || unsubscribeRequest ? 512 : target.anonymous ? 8192
        : ['markNotificationRead', 'resolveReviewComment', 'setBranchProtection', 'requestBranchApproval', 'approveBranchRequest', 'createShareLink', 'revokeShareLink',
          'markAccountNotificationRead', 'setNotificationPreferences', 'disableNotificationDelivery'].includes(target.kind) ? 1024
          : target.kind === 'addReviewComment' ? 24 * 1024 : MAX_HTTP_BYTES); }
      catch (error) {
        if (unsubscribeRequest && ['body-invalid', 'content-type-invalid'].includes(error.code)) {
          body = null;
          if (error.code === 'content-type-invalid') { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); req.pause(); }
        } else throw error;
      }
      let data;
      if (unsubscribeRequest) {
        data = record(body) && Object.keys(body).join('|') === 'token' && validNotificationToken(body.token)
          ? await service.unsubscribeNotifications({ token: body.token }) : { unsubscribed: true };
        if (!record(data) || Object.keys(data).join('|') !== 'unsubscribed' || data.unsubscribed !== true) throw fail('service-unavailable');
        data = { unsubscribed: true };
      } else if (target.kind === 'getAccountNotifications') {
        data = validateAccountNotifications(await service.getAccountNotifications(context, target.page), target.page);
      } else if (target.kind === 'markAccountNotificationRead') {
        fields(body, ['read'], ['read']); if (body.read !== true) throw fail('notification-invalid');
        const result = await service.markAccountNotificationRead(context, target.item);
        if (!record(result) || Object.keys(result).sort().join('|') !== 'eventId|read' || result.eventId !== target.item || result.read !== true) throw fail('service-unavailable');
        data = { eventId: result.eventId, read: true };
      } else if (target.kind === 'getNotificationPreferences') {
        data = validateNotificationPreferences(await service.getNotificationPreferences(context, target.projectId), target.projectId);
      } else if (target.kind === 'setNotificationPreferences') {
        fields(body, ['expectedVersion', 'mode', 'digestHourUtc'], ['expectedVersion', 'mode', 'digestHourUtc']);
        if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0 || !['off', 'immediate', 'daily'].includes(body.mode)
          || !Number.isSafeInteger(body.digestHourUtc) || body.digestHourUtc < 0 || body.digestHourUtc > 23) throw fail('notification-invalid');
        if (context.idempotencyKey === null) throw fail('invalid-idempotency-key');
        data = validateNotificationPreferences(await service.setNotificationPreferences(context, { projectId: target.projectId,
          ...body, idempotencyKey: context.idempotencyKey }), target.projectId);
        if (data.mode !== body.mode || data.digestHourUtc !== body.digestHourUtc || ![body.expectedVersion, body.expectedVersion + 1].includes(data.version)) throw fail('service-unavailable');
      } else if (target.kind === 'disableNotificationDelivery') {
        fields(body, [], []); const result = await service.disableNotificationDelivery(context);
        if (!record(result) || Object.keys(result).join('|') !== 'disabled' || result.disabled !== true) throw fail('service-unavailable'); data = { disabled: true };
      } else if (target.kind === 'redeemShareLink') {
        if (!record(body) || Object.keys(body).join('|') !== 'token' || !validShareToken(body.token)) throw fail('share-link-unavailable');
        data = validateSharedRevision(await service.redeemShareLink({ token: body.token }));
      } else if (target.kind === 'getShareReview') {
        data = validateShareReview(await service.getShareReview(context, target.projectId, target.branch, target.page), target.projectId, target.branch, target.page);
      } else if (target.kind === 'createShareLink') {
        fields(body, ['expectedHead', 'ttlMs'], ['expectedHead', 'ttlMs']); identifier(body.expectedHead);
        if (!Number.isSafeInteger(body.ttlMs) || body.ttlMs < MIN_SHARE_TTL_MS || body.ttlMs > MAX_SHARE_TTL_MS) throw fail('share-links-invalid');
        if (context.idempotencyKey === null) throw fail('invalid-idempotency-key');
        data = validateShareCreation(await service.createShareLink(context, { projectId: target.projectId, branch: target.branch,
          ...body, idempotencyKey: context.idempotencyKey }), target.projectId, { branch: target.branch, revisionId: body.expectedHead });
        if (data.link.expiresAt - data.link.createdAt !== body.ttlMs) throw fail('service-unavailable');
      } else if (target.kind === 'revokeShareLink') {
        fields(body, ['revoked'], ['revoked']); if (body.revoked !== true) throw fail('body-invalid');
        data = validateShareLink(await service.revokeShareLink(context, { projectId: target.projectId, linkId: target.item }), target.projectId, { linkId: target.item });
        if (data.status !== 'revoked') throw fail('service-unavailable');
      } else if (target.kind === 'getBranchReview') {
        data = validateBranchReview(await service.getBranchReview(context, target.projectId, target.branch, target.page),
          target.projectId, target.branch, target.page);
      } else if (target.kind === 'setBranchProtection') {
        fields(body, ['expectedVersion', 'requiredApprovals'], ['expectedVersion', 'requiredApprovals']);
        if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0 || !Number.isSafeInteger(body.requiredApprovals)
          || body.requiredApprovals < 0 || body.requiredApprovals > 5) throw fail('branch-review-invalid');
        if (context.idempotencyKey === null) throw fail('invalid-idempotency-key');
        data = validateBranchProtectionPolicy(await service.setBranchProtection(context, { projectId: target.projectId,
          branch: target.branch, ...body, idempotencyKey: context.idempotencyKey }));
        if (data.requiredApprovals !== body.requiredApprovals || ![body.expectedVersion, body.expectedVersion + 1].includes(data.version)) throw fail('service-unavailable');
      } else if (target.kind === 'requestBranchApproval') {
        fields(body, ['expectedHead', 'revisionId', 'policyVersion'], ['expectedHead', 'revisionId', 'policyVersion']);
        identifier(body.expectedHead, true); identifier(body.revisionId);
        if (!Number.isSafeInteger(body.policyVersion) || body.policyVersion < 0) throw fail('approval-request-invalid');
        if (context.idempotencyKey === null) throw fail('invalid-idempotency-key');
        data = validateBranchApprovalRequest(await service.requestBranchApproval(context, { projectId: target.projectId,
          branch: target.branch, ...body, idempotencyKey: context.idempotencyKey }), { projectId: target.projectId,
          branch: target.branch, expectedHead: body.expectedHead, revisionId: body.revisionId, policyVersion: body.policyVersion });
      } else if (target.kind === 'approveBranchRequest') {
        fields(body, ['approved'], ['approved']); if (body.approved !== true) throw fail('body-invalid');
        data = validateBranchApprovalRequest(await service.approveBranchRequest(context, { projectId: target.projectId,
          branch: target.branch, requestId: target.item }), { projectId: target.projectId, branch: target.branch, requestId: target.item });
      } else if (target.kind === 'listReviewComments') {
        data = validateReviewCommentsPage(await service.listReviewComments(context, target.projectId, target.revisionId, target.page),
          target.projectId, target.revisionId, target.page);
      } else if (target.kind === 'addReviewComment') {
        fields(body, ['anchor', 'body'], ['anchor', 'body']);
        const anchor = validateReviewCommentAnchor(body.anchor), text = normalizeReviewCommentBody(body.body);
        if (context.idempotencyKey === null) throw fail('invalid-idempotency-key');
        data = validateReviewComment(await service.addReviewComment(context, { projectId: target.projectId,
          revisionId: target.revisionId, anchor, body: text, idempotencyKey: context.idempotencyKey }),
        { projectId: target.projectId, revisionId: target.revisionId, anchor, body: text });
      } else if (target.kind === 'resolveReviewComment') {
        fields(body, ['resolved'], ['resolved']); if (body.resolved !== true) throw fail('body-invalid');
        data = validateReviewComment(await service.resolveReviewComment(context,
          { projectId: target.projectId, revisionId: target.revisionId, commentId: target.item }),
        { projectId: target.projectId, revisionId: target.revisionId, commentId: target.item });
        if (data.status !== 'resolved') throw fail('service-unavailable');
      } else if (target.kind === 'listActivity' || target.kind === 'listNotifications') {
        data = validateProjectFeedPage(await service[target.kind](context, target.projectId, target.page), target.projectId,
          { limit: target.page.limit, notifications: target.kind === 'listNotifications' });
      } else if (target.kind === 'markNotificationRead') {
        fields(body, ['read'], ['read']); if (body.read !== true) throw fail('body-invalid');
        const result = await service.markNotificationRead(context, target.projectId, target.item);
        if (!record(result) || Object.keys(result).sort().join('|') !== 'eventId|read' || result.eventId !== target.item || result.read !== true) throw fail('service-unavailable');
        data = { eventId: result.eventId, read: true };
      } else if (target.anonymous) {
        const method = target.kind === 'refreshSession' ? 'refresh' : target.kind;
        data = await identity[method](...authBody(target.kind, body));
      } else if (target.kind === 'account' || target.kind === 'projects') {
        if (!identity || target.kind === 'projects' && !listProjects) throw fail('route-not-found');
        const session = await identity.authenticate(context.accessToken);
        if (target.kind === 'projects') data = await listProjects(context);
        else {
          const user = await identity.getUser(session.userId);
          if (!user || user.status !== 'active') throw fail('access-token-invalid');
          data = { id: user.id, email: user.email, status: 'active' };
        }
      } else if (target.kind === 'putManifest') {
        fields(body, ['manifest'], ['manifest']);
        try { validateRevisionManifest(body.manifest); } catch { throw fail('manifest-invalid'); }
        data = await service.putManifest(context, target.projectId, body.manifest);
      } else if (target.kind === 'createRevision') {
        data = await service.createRevision(context, revisionInput(body, target.projectId, context.idempotencyKey));
      } else if (target.kind === 'branch' && req.method === 'PUT') {
        fields(body, ['expectedRevisionId', 'revisionId'], ['expectedRevisionId', 'revisionId']);
        identifier(body.expectedRevisionId, true); identifier(body.revisionId);
        data = await service.updateBranch(context, { projectId: target.projectId, branch: target.item,
          ...body, idempotencyKey: context.idempotencyKey });
      } else {
        const method = target.kind === 'branch' ? 'getBranch' : target.kind;
        data = await service[method](context, target.projectId, target.item);
      }
      send(res, 200, responseEnvelope(context, data));
    } catch (error) {
      const code = ERRORS.has(error?.code) ? error.code : 'service-unavailable';
      if (!req.complete) { res.shouldKeepAlive = false;
        if (shareRequest || unsubscribeRequest) { res.setHeader('Connection', 'close'); req.pause(); }
        else req.resume();
      }
      send(res, ERRORS.get(code), { apiVersion: API_VERSION, requestId: context.requestId, error: { code } });
    } finally { if (shareAdmitted) shareRedeems--; if (unsubscribeAdmitted) unsubscribes--; }
  };
}
function send(res, status, envelope) {
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(envelope)); } catch { throw fail('service-unavailable'); }
  if (bytes.length > MAX_HTTP_BYTES) throw fail('response-too-large');
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(bytes);
}

module.exports = { createRevisionHttpHandler, MAX_HTTP_BYTES, validActivityCursor, validateProjectFeedPage, createShareRedeemLimiter };
