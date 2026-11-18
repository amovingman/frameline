'use strict';
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { API_VERSION } = require('./project-api-contracts');

const LIMIT = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const ERRORS = new Set(['access-token-invalid', 'forbidden', 'rate-limit-exceeded', 'project-not-found',
  'manifest-not-found', 'manifest-project-mismatch', 'revision-not-found', 'parent-revision-not-found',
  'branch-not-found', 'branch-head-changed', 'revision-parent-mismatch', 'source-revision-exists',
  'idempotency-key-reused', 'branch-approval-required', 'approval-head-stale', 'request-too-large',
  'manifest-invalid', 'revision-invalid', 'invalid-idempotency-key', 'invalid-request-headers']);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function segment(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail('sync-request-invalid');
  return encodeURIComponent(value);
}
function fields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}

// Main-process/client code only. No token, URL, response text or remote error
// message is attached to an error; redirects never forward authorization.
function createRevisionHttpClient({ origin, getAccessToken, fetch: send = globalThis.fetch,
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
  async function request(method, route, body, { signal, idempotencyKey = null } = {}) {
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw fail('sync-request-invalid');
    if (signal?.aborted) throw fail('sync-cancelled');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !ID.test(idempotencyKey))) throw fail('sync-request-invalid');
    let encoded;
    try { if (body !== undefined) encoded = JSON.stringify(body); } catch { throw fail('sync-request-invalid'); }
    if (encoded !== undefined && Buffer.byteLength(encoded) > maxBytes) throw fail('sync-request-too-large');
    let token;
    try { token = await getAccessToken(); } catch { throw fail('access-token-invalid'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~=-]{16,4096}$/.test(token)) throw fail('access-token-invalid');
    if (signal?.aborted) throw fail('sync-cancelled');
    const requestId = randomUUID(), timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { accept: 'application/json', authorization: `Bearer ${token}`, 'x-request-id': requestId, 'x-api-version': API_VERSION };
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
      if ([408, 429].includes(response.status) || response.status >= 500) throw fail('sync-network-unavailable');
      throw fail(ERRORS.has(envelope.error.code) ? envelope.error.code : 'sync-service-failed');
    }
    if (!fields(envelope, ['apiVersion', 'requestId', 'data'])) throw fail('sync-response-invalid');
    return envelope.data;
  }
  const project = id => `/projects/${segment(id)}`;
  return {
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
