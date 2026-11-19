'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { API_VERSION } = require('./project-api-contracts');
const { validateHoldInput, validateRetentionInput, validateReportInput, validatePlanInput,
  validateHold, validateRetention, validateReport, validatePlan } = require('./asset-lifecycle-protocol');
const { chunkPath, validateIdentity, validateUpload, validateMetadata, validateComplete, validateProgress,
  validatePolicy, validateUsage, validateAvailability, validClasses,
  MAX_CHUNK_BYTES, MAX_JSON_REQUEST_BYTES, MAX_JSON_RESPONSE_BYTES, MAX_ASSET_BYTES, TICKET_TTL_MS } = require('./asset-http-transport');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, ASSET = /^sha256:[a-f0-9]{64}$/, SHA = /^[a-f0-9]{64}$/;
const ERRORS = new Set(['access-token-invalid', 'forbidden', 'asset-forbidden', 'project-not-found', 'asset-not-found', 'upload-not-found',
  'asset-upload-not-found', 'asset-ticket-invalid', 'asset-identity-collision', 'asset-chunk-conflict', 'upload-incomplete',
  'asset-upload-incomplete', 'asset-content-mismatch', 'asset-identity-invalid', 'asset-chunk-invalid', 'asset-chunk-corrupt',
  'asset-state-invalid', 'asset-state-newer-version', 'asset-key-rotation-required', 'asset-capacity-exceeded', 'asset-request-invalid',
  'asset-storage-unavailable', 'asset-storage-uncertain', 'asset-cancelled', 'request-too-large', 'body-invalid', 'request-invalid', 'invalid-request-headers',
  'asset-policy-excluded', 'asset-policy-forbidden', 'asset-policy-invalid', 'asset-policy-version-conflict', 'asset-archived', 'asset-archive-invalid', 'asset-archive-conflict',
  'asset-lifecycle-invalid', 'asset-lifecycle-version-conflict', 'asset-lifecycle-idempotency-conflict', 'asset-lifecycle-plan-stale']);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
const number = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
function fail(code) { return Object.assign(new Error(code), { code }); }
function segment(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('asset-request-invalid'); return encodeURIComponent(value); }
function asset(value) { if (typeof value !== 'string' || !ASSET.test(value)) throw fail('asset-request-invalid'); return segment(value); }
function index(value) { if (!number(value, 65535)) throw fail('asset-request-invalid'); return value; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function createAssetHttpClient({ origin, getAccessToken, fetch: send = globalThis.fetch, timeoutMs = 30000,
  verificationTimeoutMs = 30 * 60_000 } = {}) {
  let base; try { base = new URL(origin); } catch { throw fail('asset-origin-invalid'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw fail('secure-transport-required');
  if (typeof getAccessToken !== 'function' || typeof send !== 'function' || !number(timeoutMs, 120000) || timeoutMs < 1
    || !number(verificationTimeoutMs, 24 * 60 * 60_000) || verificationTimeoutMs < 1) throw fail('asset-client-invalid');
  const uploads = new Map();
  function remember(pid, value) {
    const key = JSON.stringify([pid, value.uploadId]), previous = uploads.get(key);
    if (previous && ['assetId', 'size', 'chunkSize', 'chunks'].some(field => previous[field] !== value[field])) throw fail('asset-response-invalid');
    if (!uploads.has(key) && uploads.size >= 1024) uploads.delete(uploads.keys().next().value);
    uploads.set(key, structuredClone(value)); return value;
  }
  async function request(method, route, { body, bytes, checksum, signal, binary = false, withStatus = false } = {}) {
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw fail('asset-request-invalid');
    if (signal?.aborted) throw fail('asset-cancelled');
    let encoded;
    try { if (body !== undefined) encoded = JSON.stringify(body); } catch { throw fail('asset-request-invalid'); }
    if (encoded !== undefined && Buffer.byteLength(encoded) > MAX_JSON_REQUEST_BYTES) throw fail('asset-request-too-large');
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let token; try {
      token = await new Promise((resolve, reject) => {
        const aborted = () => reject(fail(signal?.aborted ? 'asset-cancelled' : 'asset-network-unavailable'));
        if (combined.aborted) { aborted(); return; }
        combined.addEventListener('abort', aborted, { once: true });
        Promise.resolve().then(getAccessToken).then(resolve, reject).finally(() => combined.removeEventListener('abort', aborted));
      });
    } catch (error) {
      if (signal?.aborted) throw fail('asset-cancelled');
      throw fail(['service-offline', 'sync-network-unavailable', 'asset-network-unavailable'].includes(error?.code) ? 'asset-network-unavailable' : 'access-token-invalid');
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('access-token-invalid');
    if (signal?.aborted) throw fail('asset-cancelled');
    const requestId = randomUUID();
    const headers = { authorization: `Bearer ${token}`, 'x-api-version': API_VERSION, 'x-request-id': requestId,
      accept: binary ? 'application/octet-stream, application/json' : 'application/json' };
    if (encoded !== undefined) headers['content-type'] = 'application/json';
    if (bytes !== undefined) { headers['content-type'] = 'application/octet-stream'; headers['x-chunk-sha256'] = checksum; }
    let response, contents;
    try {
      response = await send(new URL(route, base).href, { method, headers, body: bytes ?? encoded, signal: combined,
        redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.headers.get('content-encoding')) throw fail('asset-response-invalid');
      const type = response.headers.get('content-type') || '', binaryResponse = binary && response.ok;
      if (!(binaryResponse ? type === 'application/octet-stream' : /^application\/json(?:\s*;|$)/i.test(type))) throw fail('asset-response-invalid');
      const cap = binaryResponse ? MAX_CHUNK_BYTES : MAX_JSON_RESPONSE_BYTES, length = response.headers.get('content-length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !number(Number(length), cap))) throw fail('asset-response-too-large');
      if (!response.body || typeof response.body.getReader !== 'function') throw fail('asset-response-invalid');
      const reader = response.body.getReader(), chunks = []; let count = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          count += next.value.byteLength;
          if (count > cap) { await reader.cancel().catch(() => {}); throw fail('asset-response-too-large'); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      if (length !== null && Number(length) !== count) throw fail('asset-response-invalid');
      contents = Buffer.concat(chunks, count);
    } catch (error) {
      if (signal?.aborted) throw fail('asset-cancelled');
      if (['asset-response-invalid', 'asset-response-too-large'].includes(error?.code)) {
        await response?.body?.cancel().catch(() => {}); throw fail(error.code);
      }
      throw fail('asset-network-unavailable');
    }
    if (binary && response.ok) {
      if (response.headers.get('x-api-version') !== API_VERSION || response.headers.get('x-request-id') !== requestId) throw fail('asset-response-invalid');
      return { bytes: contents, headers: response.headers };
    }
    let envelope; try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); } catch { throw fail('asset-response-invalid'); }
    if (envelope?.apiVersion !== API_VERSION || envelope.requestId !== requestId) throw fail('asset-response-invalid');
    if (!response.ok) {
      if (!exact(envelope, ['apiVersion', 'requestId', 'error']) || !exact(envelope.error, ['code'])) throw fail('asset-response-invalid');
      if (ERRORS.has(envelope.error.code)) throw fail(envelope.error.code);
      throw fail([408, 429, 503].includes(response.status) || response.status >= 500 ? 'asset-network-unavailable' : 'asset-service-failed');
    }
    if (!exact(envelope, ['apiVersion', 'requestId', 'data'])) throw fail('asset-response-invalid');
    if (response.status !== 200 && !(withStatus && response.status === 202)) throw fail('asset-response-invalid');
    return withStatus ? { status: response.status, data: envelope.data } : envelope.data;
  }
  const project = id => `/projects/${segment(id)}/assets`;
  async function checked(validate, operation) {
    let value; try { value = await operation; return validate(value); }
    catch (error) { if (['asset-identity-invalid', 'asset-response-invalid'].includes(error?.code)) throw fail('asset-response-invalid'); throw error; }
  }
  async function ticket(projectId, method, id, at, options) {
    const pathname = chunkPath(projectId, method, id, at), result = await request('POST', `${project(projectId)}/tickets`, {
      ...options, body: method === 'PUT' ? { method, uploadId: id, index: at } : { method, assetId: id, index: at } });
    if (!exact(result, ['path', 'expiresAt']) || !number(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + TICKET_TTL_MS
      || typeof result.path !== 'string' || !result.path.startsWith(`${pathname}?expires=${result.expiresAt}&signature=`)
      || result.path.length !== `${pathname}?expires=${result.expiresAt}&signature=`.length + 64
      || !SHA.test(result.path.slice(-64))) throw fail('asset-response-invalid');
    return result.path;
  }
  return {
    getHold: async (pid, aid, options = {}) => {
      const result = await checked(validateHold, request('GET', `${project(pid)}/${asset(aid)}/hold`, options));
      if (result.projectId !== pid || result.assetId !== aid) throw fail('asset-response-invalid'); return result;
    },
    setHold: async (pid, aid, input, options = {}) => {
      const body = validateHoldInput(input);
      const result = await checked(validateHold, request('PUT', `${project(pid)}/${asset(aid)}/hold`, { ...options, body }));
      if (result.projectId !== pid || result.assetId !== aid || result.version !== body.expectedVersion + 1
        || ['held', 'reason', 'until'].some(key => result[key] !== body[key])) throw fail('asset-response-invalid'); return result;
    },
    getRetentionPolicy: async (pid, options = {}) => {
      const result = await checked(validateRetention, request('GET', `${project(pid)}/retention`, options));
      if (result.projectId !== pid) throw fail('asset-response-invalid'); return result;
    },
    setRetentionPolicy: async (pid, input, options = {}) => {
      const body = validateRetentionInput(input);
      const result = await checked(validateRetention, request('PUT', `${project(pid)}/retention`, { ...options, body }));
      if (result.projectId !== pid || result.version !== body.expectedVersion + 1 || result.minimumArchiveAgeMs !== body.minimumArchiveAgeMs) throw fail('asset-response-invalid'); return result;
    },
    getLifecycleReport: async (pid, input = { afterAssetId: null, limit: 100 }, options = {}) => {
      const body = validateReportInput(input);
      const result = await checked(validateReport, request('POST', `${project(pid)}/lifecycle/report`, { ...options, body }));
      if (result.projectId !== pid || result.items.length > body.limit
        || body.afterAssetId !== null && result.items.some(item => item.assetId <= body.afterAssetId)) throw fail('asset-response-invalid'); return result;
    },
    planCleanup: async (pid, input, options = {}) => {
      const body = validatePlanInput(input);
      const result = await checked(validatePlan, request('POST', `${project(pid)}/lifecycle/plan`, { ...options, body }));
      if (result.projectId !== pid || result.stateHash !== body.expectedStateHash
        || JSON.stringify(result.items.map(item => item.assetId)) !== JSON.stringify([...body.assetIds].sort())) throw fail('asset-response-invalid'); return result;
    },
    getPolicy: async (pid, options = {}) => {
      const result = await checked(validatePolicy, request('GET', `${project(pid)}/policy`, options));
      if (result.projectId !== pid) throw fail('asset-response-invalid'); return result;
    },
    setPolicy: async (pid, input, options = {}) => {
      if (!exact(input, ['expectedVersion', 'syncClasses']) || !number(input.expectedVersion) || !validClasses(input.syncClasses)) throw fail('asset-policy-invalid');
      const body = { expectedVersion: input.expectedVersion, syncClasses: [...input.syncClasses] };
      const result = await checked(validatePolicy, request('PUT', `${project(pid)}/policy`, { ...options, body }));
      if (result.projectId !== pid || result.version !== body.expectedVersion + 1 || JSON.stringify(result.syncClasses) !== JSON.stringify([...body.syncClasses].sort())) throw fail('asset-response-invalid');
      return result;
    },
    getUsage: async (pid, options = {}) => {
      const result = await checked(validateUsage, request('GET', `${project(pid)}/usage`, options));
      if (result.projectId !== pid) throw fail('asset-response-invalid'); return result;
    },
    getAvailability: async (pid, aid, options = {}) => {
      const result = await checked(validateAvailability, request('GET', `${project(pid)}/${asset(aid)}/availability`, options));
      if (result.projectId !== pid || result.assetId !== aid) throw fail('asset-response-invalid'); return result;
    },
    setArchived: async (pid, aid, input, options = {}) => {
      if (!exact(input, ['expectedArchived', 'archived']) || typeof input.expectedArchived !== 'boolean' || typeof input.archived !== 'boolean') throw fail('asset-archive-invalid');
      const body = { expectedArchived: input.expectedArchived, archived: input.archived };
      const result = await checked(validateAvailability, request('PUT', `${project(pid)}/${asset(aid)}/archive`, { ...options, body }));
      if (result.projectId !== pid || result.assetId !== aid || !result.cloudPresent || result.archived !== body.archived) throw fail('asset-response-invalid'); return result;
    },
    beginUpload: async (pid, identity, options = {}) => {
      const valid = validateIdentity(identity), result = await checked(validateUpload, request('POST', `${project(pid)}/uploads`, { ...options, body: { identity: valid } }));
      if (result.assetId !== valid.contentId || result.size !== valid.size) throw fail('asset-response-invalid');
      return remember(pid, result);
    },
    uploadStatus: async (pid, uid, options = {}) => {
      const result = await checked(validateUpload, request('GET', `${project(pid)}/uploads/${segment(uid)}`, options));
      if (result.uploadId !== uid) throw fail('asset-response-invalid'); return remember(pid, result);
    },
    putChunk: async (pid, uid, at, bytes, checksum, options = {}) => {
      project(pid); segment(uid); index(at);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_CHUNK_BYTES || typeof checksum !== 'string' || !SHA.test(checksum) || hash(bytes) !== checksum) throw fail('asset-chunk-invalid');
      const snapshot = Buffer.from(bytes), known = uploads.get(JSON.stringify([pid, uid]));
      if (known && (at >= known.chunks || snapshot.length !== Math.min(known.chunkSize, Math.max(0, known.size - at * known.chunkSize)))) throw fail('asset-chunk-invalid');
      const route = await ticket(pid, 'PUT', uid, at, options);
      const result = await checked(validateProgress, request('PUT', route, { ...options, bytes: snapshot, checksum }));
      if (known && result.totalBytes !== known.size) throw fail('asset-response-invalid'); return result;
    },
    completeUpload: async (pid, uid, options = {}) => {
      const known = uploads.get(JSON.stringify([pid, uid]));
      const route = `${project(pid)}/uploads/${segment(uid)}/complete`, deadline = AbortSignal.timeout(verificationTimeoutMs);
      if (options.signal !== undefined && options.signal !== null && !(options.signal instanceof AbortSignal)) throw fail('asset-request-invalid');
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      let delay = 100;
      try {
        while (true) {
          const reply = await request('POST', route, { ...options, signal, body: {}, withStatus: true });
          if (reply.status === 200) {
            const result = await checked(validateComplete, Promise.resolve(reply.data));
            if (known && ['assetId', 'size', 'chunkSize', 'chunks'].some(field => result[field] !== known[field])) throw fail('asset-response-invalid');
            return result;
          }
          if (!exact(reply.data, ['uploadId', 'status']) || reply.data.uploadId !== uid || reply.data.status !== 'verifying') throw fail('asset-response-invalid');
          await new Promise((resolve, reject) => {
            if (signal.aborted) { reject(fail('asset-cancelled')); return; }
            const aborted = () => { clearTimeout(timer); reject(fail('asset-cancelled')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, delay);
            signal.addEventListener('abort', aborted, { once: true });
          });
          delay = Math.min(1000, delay * 2);
        }
      } catch (error) {
        if (options.signal?.aborted) throw fail('asset-cancelled');
        if (deadline.aborted) throw fail('asset-verification-timeout');
        throw error;
      }
    },
    cancelVerification: async (pid, uid, options = {}) => {
      const result = await request('DELETE', `${project(pid)}/uploads/${segment(uid)}/complete`, options);
      if (!exact(result, ['uploadId', 'cancelled']) || result.uploadId !== uid || typeof result.cancelled !== 'boolean') throw fail('asset-response-invalid');
      return result;
    },
    getAsset: async (pid, aid, options = {}) => {
      const result = await checked(validateMetadata, request('GET', `${project(pid)}/${asset(aid)}`, options));
      if (result.assetId !== aid) throw fail('asset-response-invalid'); return result;
    },
    readChunk: async (pid, aid, at, options = {}) => {
      project(pid); asset(aid); index(at);
      const route = await ticket(pid, 'GET', aid, at, options), result = await request('GET', route, { ...options, binary: true });
      const value = name => { const raw = result.headers.get(name); if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw) || !number(Number(raw))) throw fail('asset-response-invalid'); return Number(raw); };
      const chunkSize = value('x-asset-chunk-size'), chunks = value('x-asset-chunks'), totalBytes = value('x-asset-size');
      const checksum = result.headers.get('x-chunk-sha256'), size = value('x-chunk-size');
      if (chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES || totalBytes > MAX_ASSET_BYTES || chunks > 65536
        || chunks !== Math.max(1, Math.ceil(totalBytes / chunkSize)) || at >= chunks || value('x-chunk-index') !== at
        || size !== Math.min(chunkSize, Math.max(0, totalBytes - at * chunkSize)) || result.bytes.length !== size
        || !SHA.test(checksum || '') || hash(result.bytes) !== checksum) throw fail('asset-response-invalid');
      return { bytes: result.bytes, checksum, chunks, totalBytes };
    }
  };
}
module.exports = { createAssetHttpClient };
