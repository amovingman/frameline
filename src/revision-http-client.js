'use strict';
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { API_VERSION } = require('./project-api-contracts');
const { validActivityCursor, validateProjectFeedPage } = require('./revision-http-transport');

const LIMIT = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const ERRORS = new Set(['access-token-invalid', 'forbidden', 'rate-limit-exceeded', 'project-not-found',
  'credentials-invalid', 'refresh-token-invalid',
  'manifest-not-found', 'manifest-project-mismatch', 'revision-not-found', 'parent-revision-not-found',
  'branch-not-found', 'branch-head-changed', 'revision-parent-mismatch', 'source-revision-exists',
  'idempotency-key-reused', 'branch-approval-required', 'approval-head-stale', 'request-too-large',
  'manifest-invalid', 'revision-invalid', 'invalid-idempotency-key', 'invalid-request-headers', 'activity-page-invalid',
  'activity-cursor-invalid', 'activity-state-invalid', 'activity-state-newer-version', 'activity-capacity-exceeded', 'notification-not-found']);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function segment(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail('sync-request-invalid');
  return encodeURIComponent(value);
}
function fields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}
const identifier = value => typeof value === 'string' && ID.test(value);
const bearer = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const emailAddress = value => typeof value === 'string' && value.length <= 254 && value === value.trim().toLowerCase()
  && !/[\x00-\x1f\x7f]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
function checkedSession(value) {
  if (!fields(value, ['sessionId', 'accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'])
    || !identifier(value.sessionId) || !bearer(value.accessToken) || !bearer(value.refreshToken)
    || value.accessToken === value.refreshToken || !timestamp(value.accessExpiresAt) || !timestamp(value.refreshExpiresAt)
    || value.accessExpiresAt > value.refreshExpiresAt) throw fail('sync-response-invalid');
  return value;
}

// Main-process/client code only. No token, URL, response text or remote error
// message is attached to an error; redirects never forward authorization.
function createRevisionHttpClient({ origin, getAccessToken = () => null, fetch: send = globalThis.fetch,
  allowLoopbackHttp = false, timeoutMs = 30000, maxBytes = LIMIT } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw fail('sync-origin-invalid'); }
  const loopback = ['127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || !(base.protocol === 'https:' || allowLoopbackHttp === true && loopback && base.protocol === 'http:')) {
    throw fail('secure-transport-required');
  }
  if (typeof getAccessToken !== 'function' || typeof send !== 'function' || typeof allowLoopbackHttp !== 'boolean'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > LIMIT) throw fail('sync-client-invalid');
  async function request(method, route, body, { signal, idempotencyKey = null, anonymous = false } = {}) {
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw fail('sync-request-invalid');
    if (signal?.aborted) throw fail('sync-cancelled');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !ID.test(idempotencyKey))) throw fail('sync-request-invalid');
    let encoded;
    try { if (body !== undefined) encoded = JSON.stringify(body); } catch { throw fail('sync-request-invalid'); }
    if (encoded !== undefined && Buffer.byteLength(encoded) > maxBytes) throw fail('sync-request-too-large');
    let token;
    if (!anonymous) {
      try { token = await getAccessToken(); }
      catch (error) {
        throw fail(['service-offline', 'sync-network-unavailable'].includes(error?.code) ? 'sync-network-unavailable' : 'access-token-invalid');
      }
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~=-]{16,4096}$/.test(token)) throw fail('access-token-invalid');
    }
    if (signal?.aborted) throw fail('sync-cancelled');
    const requestId = randomUUID(), timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { accept: 'application/json', 'x-request-id': requestId, 'x-api-version': API_VERSION };
    if (!anonymous) headers.authorization = `Bearer ${token}`;
    if (encoded !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
    let response, bytes;
    try {
      response = await send(new URL(route, base).href, { method, headers, body: encoded, signal: combined,
        redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (response.redirected || response.status >= 300 && response.status < 400) throw fail('sync-response-invalid');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw fail('sync-response-invalid');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw fail('sync-response-too-large');
      if (!response.body || typeof response.body.getReader !== 'function') throw fail('sync-response-invalid');
      const reader = response.body.getReader(), chunks = []; let count = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          count += next.value.byteLength;
          if (count > maxBytes) { await reader.cancel().catch(() => {}); throw fail('sync-response-too-large'); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks, count);
    } catch (error) {
      if (signal?.aborted) throw fail('sync-cancelled');
      if (error.code === 'sync-response-invalid' || error.code === 'sync-response-too-large') {
        await response?.body?.cancel().catch(() => {}); throw fail(error.code);
      }
      throw fail('sync-network-unavailable');
    }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('sync-response-invalid'); }
    if (envelope?.apiVersion !== API_VERSION || envelope.requestId !== requestId) throw fail('sync-response-invalid');
    if (!response.ok) {
      if (!fields(envelope, ['apiVersion', 'requestId', 'error']) || !fields(envelope.error, ['code'])) throw fail('sync-response-invalid');
      if (anonymous && response.status === 429 && envelope.error.code === 'rate-limit-exceeded') throw fail('rate-limit-exceeded');
      if (envelope.error.code === 'activity-state-invalid') throw fail('activity-state-invalid');
      if ([408, 429].includes(response.status) || response.status >= 500) throw fail('sync-network-unavailable');
      throw fail(ERRORS.has(envelope.error.code) ? envelope.error.code : 'sync-service-failed');
    }
    if (!fields(envelope, ['apiVersion', 'requestId', 'data'])) throw fail('sync-response-invalid');
    return envelope.data;
  }
  const project = id => `/projects/${segment(id)}`;
  async function feed(projectId, resource, page, options) {
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => !['limit', 'cursor'].includes(key))) throw fail('activity-page-invalid');
    const limit = page.limit === undefined ? 20 : page.limit, cursor = page.cursor === undefined ? null : page.cursor;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('activity-page-invalid');
    if (cursor !== null && !validActivityCursor(cursor)) throw fail('activity-cursor-invalid');
    const result = await request('GET', `${project(projectId)}/${resource}?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`, undefined, options);
    return validateProjectFeedPage(result, projectId, { limit, notifications: resource === 'notifications' });
  }
  return {
    listActivity: (projectId, page = {}, options = {}) => feed(projectId, 'activity', page, options),
    listNotifications: (projectId, page = {}, options = {}) => feed(projectId, 'notifications', page, options),
    markNotificationRead: async (projectId, eventId, input = { read: true }, options = {}) => {
      if (!fields(input, ['read']) || input.read !== true) throw fail('sync-request-invalid');
      const result = await request('PUT', `${project(projectId)}/notifications/${segment(eventId)}/read`, { read: true }, options);
      if (!fields(result, ['eventId', 'read']) || result.eventId !== eventId || result.read !== true) throw fail('sync-response-invalid');
      return { eventId, read: true };
    },
    signIn: async (email, password, options = {}) => {
      if (typeof email !== 'string' || !emailAddress(email.trim().toLowerCase())
        || typeof password !== 'string' || password.length < 1 || password.length > 1024) throw fail('sync-request-invalid');
      return checkedSession(await request('POST', '/auth/sessions', { email: email.trim().toLowerCase(), password }, { ...options, anonymous: true }));
    },
    refreshSession: async (refreshToken, options = {}) => {
      if (!bearer(refreshToken)) throw fail('sync-request-invalid');
      return checkedSession(await request('POST', '/auth/sessions/refresh', { refreshToken }, { ...options, anonymous: true }));
    },
    signOut: async (refreshToken, options = {}) => {
      if (!bearer(refreshToken)) throw fail('sync-request-invalid');
      const result = await request('POST', '/auth/sessions/sign-out', { refreshToken }, { ...options, anonymous: true });
      if (!fields(result, ['signedOut']) || result.signedOut !== true) throw fail('sync-response-invalid'); return result;
    },
    getAccount: async options => {
      const result = await request('GET', '/account', undefined, options);
      if (!fields(result, ['id', 'email', 'status']) || !identifier(result.id) || !emailAddress(result.email)
        || result.status !== 'active') throw fail('sync-response-invalid'); return result;
    },
    listProjects: async options => {
      const result = await request('GET', '/projects', undefined, options); const ids = new Set();
      if (!fields(result, ['projects']) || !Array.isArray(result.projects) || result.projects.length > 10_000
        || result.projects.some(item => {
          if (!fields(item, ['id', 'name', 'role', 'branches']) || !identifier(item.id) || ids.has(item.id)
            || !label(item.name) || !['owner', 'editor', 'viewer'].includes(item.role) || !Array.isArray(item.branches)
            || item.branches.length > 10_000 || !item.branches.every(identifier)
            || new Set(item.branches).size !== item.branches.length) return true;
          ids.add(item.id); return false;
        })) throw fail('sync-response-invalid'); return result;
    },
    putManifest: (id, manifest, options) => request('PUT', `${project(id)}/manifests`, { manifest }, options),
    createRevision: (input, options = {}) => request('POST', `${project(input.projectId)}/revisions`, {
      manifestId: input.manifestId, parentRevisionId: input.parentRevisionId ?? null, message: input.message,
      sourceRevisionId: input.sourceRevisionId ?? null }, { ...options, idempotencyKey: input.idempotencyKey ?? null }),
    compareAndSwapBranch: (input, options = {}) => request('PUT', `${project(input.projectId)}/branches/${segment(input.branch)}`, {
      revisionId: input.revisionId, expectedRevisionId: input.expectedRevisionId ?? null },
    { ...options, idempotencyKey: input.idempotencyKey ?? null }),
    getBranch: (id, branch, options) => request('GET', `${project(id)}/branches/${segment(branch)}`, undefined, options),
    getRevision: (id, revision, options) => request('GET', `${project(id)}/revisions/${segment(revision)}`, undefined, options),
    getManifest: (id, manifest, options) => request('GET', `${project(id)}/manifests/${segment(manifest)}`, undefined, options),
    findRevisionBySource: (id, source, options) => request('GET', `${project(id)}/revisions/by-source/${segment(source)}`, undefined, options)
  };
}
module.exports = { createRevisionHttpClient };
