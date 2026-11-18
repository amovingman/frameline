'use strict';
const { TextDecoder } = require('node:util');
const { API_VERSION, createRequestContext, responseEnvelope } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');

const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SERVICE_METHODS = ['putManifest', 'getManifest', 'createRevision', 'getRevision',
  'findRevisionBySource', 'getBranch', 'updateBranch'];
const ERRORS = new Map([
  ['access-token-invalid', 401], ['forbidden', 403], ['rate-limit-exceeded', 429],
  ...['project-not-found', 'manifest-not-found', 'revision-not-found', 'parent-revision-not-found',
    'branch-not-found'].map(code => [code, 404]),
  ...['branch-head-changed', 'revision-parent-mismatch', 'source-revision-exists',
    'idempotency-key-reused', 'manifest-project-mismatch', 'branch-protected',
    'branch-approval-required', 'approval-head-stale'].map(code => [code, 409]),
  ...['request-invalid', 'invalid-request-headers', 'api-version-unsupported', 'body-invalid',
    'revision-invalid', 'manifest-invalid', 'invalid-idempotency-key'].map(code => [code, 400]),
  ['secure-transport-required', 426], ['browser-request-forbidden', 403], ['route-not-found', 404],
  ['method-not-allowed', 405], ['content-type-invalid', 415], ['request-too-large', 413],
  ['response-too-large', 502], ['service-unavailable', 500]
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
function route(req) {
  // Parse origin-form paths directly: URL normalization must not hide dot segments.
  if (typeof req.url !== 'string' || req.url.length > 2048 || !req.url.startsWith('/')
    || /[?#\\\s]/.test(req.url)) throw fail('request-invalid');
  let parts;
  try { parts = req.url.slice(1).split('/').map(part => decodeURIComponent(part)); }
  catch { throw fail('request-invalid'); }
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
async function readBody(req, writing) {
  const length = header(req, 'content-length');
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw fail('request-invalid');
  if (Number(length) > MAX_HTTP_BYTES) throw fail('request-too-large');
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
      if (size > MAX_HTTP_BYTES || (!writing && size)) {
        cleanup(); reject(fail(size > MAX_HTTP_BYTES ? 'request-too-large' : 'body-invalid')); return;
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
function createRevisionHttpHandler({ service, allowLoopbackHttp = false } = {}) {
  if (!service || !SERVICE_METHODS.every(name => typeof service[name] === 'function')
    || typeof allowLoopbackHttp !== 'boolean') throw fail('http-transport-invalid');
  return async function revisionHttpHandler(req, res) {
    let context = createRequestContext();
    try {
      if (!req.socket?.encrypted && !(allowLoopbackHttp
        && ['127.0.0.1', '::1'].includes(req.socket?.remoteAddress))) throw fail('secure-transport-required');
      if (header(req, 'origin') !== undefined) throw fail('browser-request-forbidden');
      if (header(req, 'x-api-version') !== API_VERSION) throw fail('api-version-unsupported');
      context = createRequestContext({ 'x-request-id': header(req, 'x-request-id'),
        'idempotency-key': header(req, 'idempotency-key') });
      const authorization = header(req, 'authorization');
      if (typeof authorization !== 'string' || !/^Bearer [a-zA-Z0-9._~+\/-]{1,4096}={0,2}$/.test(authorization)) throw fail('access-token-invalid');
      context = { ...context, accessToken: authorization.slice(7) };
      const target = route(req);
      if (!target.methods.includes(req.method)) {
        res.setHeader('Allow', target.methods.join(', '));
        throw fail('method-not-allowed');
      }
      const body = await readBody(req, req.method !== 'GET');
      let data;
      if (target.kind === 'putManifest') {
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
      if (!req.complete) { res.shouldKeepAlive = false; req.resume(); }
      send(res, ERRORS.get(code), { apiVersion: API_VERSION, requestId: context.requestId, error: { code } });
    }
  };
}
function send(res, status, envelope) {
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(envelope)); } catch { throw fail('service-unavailable'); }
  if (bytes.length > MAX_HTTP_BYTES) throw fail('response-too-large');
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

module.exports = { createRevisionHttpHandler, MAX_HTTP_BYTES };
