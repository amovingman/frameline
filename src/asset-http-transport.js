'use strict';
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { API_VERSION, createRequestContext } = require('./project-api-contracts');
const { validateHoldInput, validateRetentionInput, validateReportInput, validatePlanInput,
  validateHold, validateRetention, validateReport, validatePlan } = require('./asset-lifecycle-protocol');
const { validateJobSubmit, validateJobAction, validateJobPageInput, validateAssetJob, validateJobPage, validateJobMetrics } = require('./asset-jobs-protocol');

const MAX_CHUNK_BYTES = 1024 * 1024, MAX_JSON_REQUEST_BYTES = 64 * 1024, MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 ** 3, TICKET_TTL_MS = 5 * 60_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, ASSET = /^sha256:[a-f0-9]{64}$/, SHA = /^[a-f0-9]{64}$/;
const ERROR_STATUS = new Map([
  ['access-token-invalid', 401], ['forbidden', 403], ['asset-forbidden', 403], ['asset-ticket-invalid', 403], ['browser-request-forbidden', 403],
  ['project-not-found', 404], ['asset-not-found', 404], ['upload-not-found', 404], ['asset-upload-not-found', 404], ['route-not-found', 404],
  ['asset-identity-collision', 409], ['asset-chunk-conflict', 409], ['upload-incomplete', 409], ['asset-upload-incomplete', 409],
  ['asset-content-mismatch', 409], ['asset-identity-invalid', 400], ['asset-chunk-invalid', 400], ['request-invalid', 400],
  ['invalid-request-headers', 400], ['api-version-unsupported', 400], ['body-invalid', 400], ['content-type-invalid', 415],
  ['request-too-large', 413], ['method-not-allowed', 405], ['secure-transport-required', 426], ['asset-cancelled', 409],
  ['asset-service-busy', 503], ['asset-storage-unavailable', 503], ['asset-storage-uncertain', 503], ['asset-request-timeout', 408],
  ['asset-chunk-corrupt', 500], ['asset-state-invalid', 500], ['service-unavailable', 500],
  ['asset-key-rotation-required', 409], ['asset-capacity-exceeded', 413], ['asset-request-invalid', 400],
  ['asset-state-newer-version', 500], ['asset-service-closed', 503], ['asset-policy-excluded', 403], ['asset-policy-forbidden', 403],
  ['asset-policy-invalid', 400], ['asset-policy-version-conflict', 409], ['asset-archived', 403], ['asset-archive-invalid', 400], ['asset-archive-conflict', 409],
  ['asset-lifecycle-invalid', 400], ['asset-lifecycle-version-conflict', 409], ['asset-lifecycle-idempotency-conflict', 409], ['asset-lifecycle-plan-stale', 409],
  ['asset-job-invalid', 400], ['asset-job-not-found', 404], ['asset-job-forbidden', 403], ['asset-job-idempotency-conflict', 409],
  ['asset-job-run-stale', 409], ['asset-job-state-conflict', 409], ['asset-job-attempts-exhausted', 409]
]);
function fail(code) { return Object.assign(new Error(code), { code }); }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function validateIdentity(value) {
  if (!exact(value, ['version', 'algorithm', 'contentId', 'size', 'assetClass', 'mediaType']) || value.version !== 1 || value.algorithm !== 'sha256'
    || typeof value.contentId !== 'string' || !ASSET.test(value.contentId) || !integer(value.size, MAX_ASSET_BYTES)
    || !['original', 'proxy', 'audio', 'graphics', 'other'].includes(value.assetClass)
    || value.mediaType !== null && (typeof value.mediaType !== 'string' || value.mediaType.length > 127
      || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(value.mediaType))) throw fail('asset-identity-invalid');
  return structuredClone(value);
}
function geometry(value) {
  return typeof value.assetId === 'string' && ASSET.test(value.assetId) && integer(value.size, MAX_ASSET_BYTES)
    && integer(value.chunkSize, MAX_CHUNK_BYTES) && value.chunkSize > 0 && integer(value.chunks, 65536)
    && value.chunks === Math.max(1, Math.ceil(value.size / value.chunkSize));
}
function validateUpload(value) {
  if (!exact(value, ['uploadId', 'assetId', 'size', 'chunkSize', 'chunks', 'received', 'complete']) || !ID.test(value.uploadId || '')
    || !geometry(value) || !Array.isArray(value.received) || value.received.length !== value.chunks
    || value.received.some(item => typeof item !== 'boolean') || typeof value.complete !== 'boolean'
    || value.complete && !value.received.every(Boolean)) throw fail('asset-response-invalid');
  return structuredClone(value);
}
function validateMetadata(value) {
  if (!exact(value, ['assetId', 'size', 'chunkSize', 'chunks', 'identity']) || !geometry(value)) throw fail('asset-response-invalid');
  const identity = validateIdentity(value.identity);
  if (identity.contentId !== value.assetId || identity.size !== value.size) throw fail('asset-response-invalid');
  return { assetId: value.assetId, size: value.size, chunkSize: value.chunkSize, chunks: value.chunks, identity };
}
function validateComplete(value) {
  if (!exact(value, ['assetId', 'size', 'chunkSize', 'chunks', 'verified']) || !geometry(value) || value.verified !== true) throw fail('asset-response-invalid');
  return structuredClone(value);
}
function validateProgress(value) {
  if (!exact(value, ['receivedBytes', 'totalBytes', 'complete']) || !integer(value.totalBytes, MAX_ASSET_BYTES)
    || !integer(value.receivedBytes, value.totalBytes) || value.complete !== false) throw fail('asset-response-invalid');
  return structuredClone(value);
}
const ASSET_CLASSES = ['audio', 'graphics', 'original', 'other', 'proxy'];
function validClasses(value) { return Array.isArray(value) && value.length <= 5 && value.every(item => ASSET_CLASSES.includes(item)) && new Set(value).size === value.length; }
function validatePolicy(value) {
  if (!exact(value, ['projectId', 'version', 'syncClasses']) || !ID.test(value.projectId || '') || !integer(value.version)
    || !validClasses(value.syncClasses) || value.version === 0 && value.syncClasses.length !== 0
    || JSON.stringify(value.syncClasses) !== JSON.stringify([...value.syncClasses].sort())) throw fail('asset-response-invalid');
  return structuredClone(value);
}
function validateUsage(value) {
  const fields = ['assetCount', 'logicalBytes', 'availableBytes', 'archivedBytes', 'excludedBytes', 'inProgressUploads', 'inProgressReceivedBytes', 'inProgressDeclaredBytes'];
  if (!exact(value, ['projectId', ...fields]) || !ID.test(value.projectId || '') || fields.some(key => !integer(value[key]))
    || value.assetCount > 10000 || value.inProgressUploads > 10000 || value.availableBytes > value.logicalBytes
    || value.archivedBytes > value.logicalBytes || value.excludedBytes > value.logicalBytes || value.inProgressReceivedBytes > value.inProgressDeclaredBytes
    || value.availableBytes + value.archivedBytes + value.excludedBytes !== value.logicalBytes
    || value.assetCount === 0 && value.logicalBytes !== 0 || value.inProgressUploads === 0 && value.inProgressDeclaredBytes !== 0) throw fail('asset-response-invalid');
  return structuredClone(value);
}
function validateAvailability(value) {
  if (!exact(value, ['projectId', 'assetId', 'cloudPresent', 'excluded', 'archived', 'assetClass', 'size']) || !ID.test(value.projectId || '')
    || !ASSET.test(value.assetId || '') || ['cloudPresent', 'excluded', 'archived'].some(key => typeof value[key] !== 'boolean')
    || value.cloudPresent && (!ASSET_CLASSES.includes(value.assetClass) || !integer(value.size, MAX_ASSET_BYTES))
    || !value.cloudPresent && (value.excluded || value.archived || value.assetClass !== null || value.size !== null)) throw fail('asset-response-invalid');
  return structuredClone(value);
}
function header(req, name) {
  let count = 0; for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  const value = req.headers[name];
  if (count > 1 || value !== undefined && typeof value !== 'string') throw fail('invalid-request-headers');
  return value;
}
const segment = value => encodeURIComponent(value);
function chunkPath(projectId, kind, id, index) {
  return `/projects/${segment(projectId)}/assets/${kind === 'PUT' ? `uploads/${segment(id)}` : segment(id)}/chunks/${index}`;
}
function parseRoute(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/') || /[\s#\\]/.test(raw)) throw fail('request-invalid');
  const split = raw.split('?'); if (split.length > 2) throw fail('request-invalid');
  let parts; try { parts = split[0].slice(1).split('/').map(decodeURIComponent); } catch { throw fail('request-invalid'); }
  if (parts[0] !== 'projects' || !ID.test(parts[1] || '') || parts[2] !== 'assets'
    || parts.some(part => !ID.test(part)) || `/${parts.map(segment).join('/')}` !== split[0]) throw fail('request-invalid');
  const projectId = parts[1]; let result;
  if (parts.length === 4 && parts[3] === 'uploads') result = { kind: 'begin', methods: ['POST'] };
  else if (parts.length === 4 && parts[3] === 'tickets') result = { kind: 'ticket', methods: ['POST'] };
  else if (parts.length === 4 && parts[3] === 'policy') result = { kind: 'policy', methods: ['GET', 'PUT'] };
  else if (parts.length === 4 && parts[3] === 'usage') result = { kind: 'usage', methods: ['GET'] };
  else if (parts.length === 4 && parts[3] === 'retention') result = { kind: 'retention', methods: ['GET', 'PUT'] };
  else if (parts.length === 4 && parts[3] === 'jobs') result = { kind: 'jobs-submit', methods: ['POST'] };
  else if (parts.length === 5 && parts[3] === 'jobs' && parts[4] === 'list') result = { kind: 'jobs-list', methods: ['POST'] };
  else if (parts.length === 5 && parts[3] === 'jobs' && parts[4] === 'metrics') result = { kind: 'jobs-metrics', methods: ['GET'] };
  else if (parts.length === 5 && parts[3] === 'jobs') result = { kind: 'jobs-read', id: parts[4], methods: ['GET'] };
  else if (parts.length === 6 && parts[3] === 'jobs' && ['cancel', 'retry'].includes(parts[5])) result = { kind: `jobs-${parts[5]}`, id: parts[4], methods: ['POST'] };
  else if (parts.length === 5 && parts[3] === 'lifecycle' && parts[4] === 'report') result = { kind: 'lifecycle-report', methods: ['POST'] };
  else if (parts.length === 5 && parts[3] === 'lifecycle' && parts[4] === 'plan') result = { kind: 'cleanup-plan', methods: ['POST'] };
  else if (parts.length === 5 && ASSET.test(parts[3] || '') && parts[4] === 'hold') result = { kind: 'hold', id: parts[3], methods: ['GET', 'PUT'] };
  else if (parts.length === 5 && ASSET.test(parts[3] || '') && parts[4] === 'availability') result = { kind: 'availability', id: parts[3], methods: ['GET'] };
  else if (parts.length === 5 && ASSET.test(parts[3] || '') && parts[4] === 'archive') result = { kind: 'archive', id: parts[3], methods: ['PUT'] };
  else if (parts[3] === 'uploads' && ID.test(parts[4] || '') && parts.length === 5) result = { kind: 'status', id: parts[4], methods: ['GET'] };
  else if (parts[3] === 'uploads' && ID.test(parts[4] || '') && parts.length === 6 && parts[5] === 'complete') result = { kind: 'complete', id: parts[4], methods: ['POST', 'DELETE'] };
  else if (parts[3] === 'uploads' && ID.test(parts[4] || '') && parts.length === 7 && parts[5] === 'chunks') result = { kind: 'put', id: parts[4], rawIndex: parts[6], methods: ['PUT'] };
  else if (ASSET.test(parts[3] || '') && parts.length === 4) result = { kind: 'metadata', id: parts[3], methods: ['GET'] };
  else if (ASSET.test(parts[3] || '') && parts.length === 6 && parts[4] === 'chunks') result = { kind: 'read', id: parts[3], rawIndex: parts[5], methods: ['GET'] };
  else throw fail('route-not-found');
  if (result.rawIndex !== undefined) {
    if (!/^(0|[1-9][0-9]{0,4})$/.test(result.rawIndex) || !integer(Number(result.rawIndex), 65535)) throw fail('request-invalid');
    result.index = Number(result.rawIndex);
  }
  if (!['put', 'read'].includes(result.kind) && split.length !== 1) throw fail('request-invalid');
  return { ...result, projectId, pathname: split[0], query: split[1] ?? null };
}
function isAssetRequest(req) { return typeof req?.url === 'string' && /^\/projects\/[^/]+\/assets(?:\/|\?|$)/.test(req.url); }
async function readBody(req, { kind = 'json', max = MAX_JSON_REQUEST_BYTES, writing = true, signal = null } = {}) {
  if (signal?.aborted) throw fail('asset-cancelled');
  if (req.aborted || req.destroyed && !req.readableEnded) throw fail('body-invalid');
  const length = header(req, 'content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || !integer(Number(length)))) throw fail('request-invalid');
  if (Number(length) > max) throw fail('request-too-large');
  if (header(req, 'content-encoding') !== undefined) throw fail('content-type-invalid');
  if (!writing && (Number(length) > 0 || header(req, 'transfer-encoding') !== undefined)) throw fail('body-invalid');
  const type = header(req, 'content-type') || '';
  if (writing && !(kind === 'binary' ? type === 'application/octet-stream' : /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))) throw fail('content-type-invalid');
  if (req.readableEnded) {
    if (writing) throw fail('body-invalid');
    return null;
  }
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(fail('asset-request-timeout')), 30_000);
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', broken); req.off('aborted', broken); signal?.removeEventListener('abort', cancelled); };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const broken = () => finish(fail('body-invalid'));
    const cancelled = () => finish(fail('asset-cancelled'));
    const data = bytes => { size += bytes.length; if (size > max || !writing && size) finish(fail(size > max ? 'request-too-large' : 'body-invalid')); else chunks.push(bytes); };
    const end = () => finish();
    req.on('data', data); req.once('end', end); req.once('error', broken); req.once('aborted', broken);
    signal?.addEventListener('abort', cancelled, { once: true });
  });
  const bytes = Buffer.concat(chunks, size);
  if (!writing) return null; if (kind === 'binary') return bytes;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('body-invalid'); }
}
function createAssetHttpHandler({ assets, authorize, authorizePolicy = null, signingKey } = {}) {
  if (!assets || !['beginUpload', 'uploadStatus', 'putChunk', 'completeUpload', 'getAsset', 'readChunk'].every(name => typeof assets[name] === 'function')
    || typeof authorize !== 'function' || authorizePolicy !== null && typeof authorizePolicy !== 'function'
    || !Buffer.isBuffer(signingKey) || signingKey.length !== 32) throw fail('asset-http-invalid');
  const key = Buffer.from(signingKey); let active = 0, closing = false;
  const verifications = new Map();
  function pruneVerifications() {
    let settled = [...verifications.values()].filter(job => job.status !== 'verifying').length;
    for (const [id, job] of verifications) if (settled > 128 && job.status !== 'verifying') { verifications.delete(id); settled--; }
  }
  function verifyUpload(context, projectId, uploadId, actorId) {
    if (closing) throw fail('asset-service-busy');
    const actor = typeof actorId === 'string' && ID.test(actorId) ? actorId : null;
    const id = JSON.stringify([projectId, uploadId]); let job = verifications.get(id);
    if (!job) {
      if ([...verifications.values()].filter(value => value.status === 'verifying').length >= 8) throw fail('asset-service-busy');
      job = { status: 'verifying', controller: new AbortController(), result: null, error: null, promise: null,
        actorId: actor, context: structuredClone(context) };
      verifications.set(id, job);
      // Verification is independent of the short-lived polling HTTP request.
      job.promise = Promise.resolve().then(() => assets.completeUpload(job.context, projectId, uploadId, { signal: job.controller.signal }))
        .then(value => { job.result = validateComplete(value); job.status = 'complete'; }, error => {
          job.error = ERROR_STATUS.has(error?.code) ? error.code : 'service-unavailable'; job.status = 'failed';
        }).catch(() => { job.error = 'service-unavailable'; job.status = 'failed'; }).finally(pruneVerifications);
    } else if (job.status === 'verifying' && actor !== null && job.actorId === actor) {
      // Only a fresh authorization for the same authenticated actor may renew
      // a long verification's token. The store rechecks this token before commit.
      job.context.accessToken = context.accessToken;
    }
    if (job.status === 'failed') { verifications.delete(id); throw fail(job.error); }
    return job.status === 'complete' ? { status: 200, data: job.result } : { status: 202, data: { uploadId, status: 'verifying' } };
  }
  const signature = (method, pathname, expiresAt) => createHmac('sha256', key).update(`${method}\n${pathname}\n${expiresAt}`).digest('hex');
  async function allowed(context, projectId, action) {
    const result = await authorize(context, projectId, action);
    if (result !== true && result?.allowed !== true) throw fail('asset-forbidden');
    return result === true ? { allowed: true } : result;
  }
  async function ownerAllowed(context, projectId) {
    const result = await authorizePolicy?.(context, projectId, 'write');
    if (result?.allowed !== true || typeof result.actorId !== 'string' || !ID.test(result.actorId)) throw fail('asset-policy-forbidden');
  }
  async function uploadAllowed(context, projectId, uploadId) {
    if (typeof assets.assertUploadAllowed !== 'function') throw fail('asset-policy-forbidden');
    const result = await assets.assertUploadAllowed(context, projectId, uploadId);
    if (result?.allowed !== true) throw fail('asset-policy-forbidden');
  }
  async function downloadAllowed(context, projectId, assetId) {
    const value = validateAvailability(await assets.getAvailability(context, projectId, assetId));
    if (value.projectId !== projectId || value.assetId !== assetId) throw fail('service-unavailable');
    if (value.excluded) throw fail('asset-policy-excluded'); if (value.archived) throw fail('asset-archived');
  }
  function verifyTicket(target, method) {
    if (target.query === null || !/^expires=[0-9]+&signature=[a-f0-9]{64}$/.test(target.query)) throw fail('asset-ticket-invalid');
    const [expires, signed] = target.query.split('&').map(value => value.split('=')[1]); const expiresAt = Number(expires), now = Date.now();
    if (!integer(expiresAt) || String(expiresAt) !== expires || expiresAt <= now || expiresAt > now + TICKET_TTL_MS) throw fail('asset-ticket-invalid');
    const expected = signature(method, target.pathname, expiresAt);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signed))) throw fail('asset-ticket-invalid');
  }
  const handler = async function assetHttpHandler(req, res) {
    let context = createRequestContext(), admitted = false;
    const controller = new AbortController(), aborted = () => controller.abort();
    req.once('aborted', aborted); res.once('close', aborted);
    function json(status, data, error = false) {
      const bytes = Buffer.from(JSON.stringify({ apiVersion: API_VERSION, requestId: context.requestId, [error ? 'error' : 'data']: data }));
      if (bytes.length > MAX_JSON_RESPONSE_BYTES) throw fail('service-unavailable');
      if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); }
    }
    try {
      if (!req.socket?.encrypted) throw fail('secure-transport-required');
      if (header(req, 'origin') !== undefined) throw fail('browser-request-forbidden');
      if (header(req, 'x-api-version') !== API_VERSION) throw fail('api-version-unsupported');
      context = createRequestContext({ 'x-request-id': header(req, 'x-request-id'), 'idempotency-key': header(req, 'idempotency-key') });
      const auth = header(req, 'authorization');
      if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw fail('access-token-invalid');
      context = { ...context, accessToken: auth.slice(7) };
      const target = parseRoute(req.url);
      if (!target.methods.includes(req.method)) { res.setHeader('Allow', target.methods.join(', ')); throw fail('method-not-allowed'); }
      if (closing) throw fail('asset-service-busy');
      if (active >= 8) throw fail('asset-service-busy'); active++; admitted = true;
      await allowed(context, target.projectId, ['metadata', 'read', 'ticket', 'policy', 'usage', 'availability', 'archive', 'jobs-list', 'jobs-read', 'jobs-metrics'].includes(target.kind) ? 'read' : 'write');
      if (['archive', 'hold', 'retention', 'lifecycle-report', 'cleanup-plan'].includes(target.kind)
        || target.kind === 'policy' && req.method === 'PUT') await ownerAllowed(context, target.projectId);
      let result;
      if (target.kind === 'put' || target.kind === 'read') verifyTicket(target, req.method);
      if (target.kind.startsWith('jobs-')) {
        const body = await readBody(req, { writing: req.method !== 'GET', signal: controller.signal });
        if (target.kind === 'jobs-submit') result = validateAssetJob(await assets.submitVerificationJob(context, target.projectId, validateJobSubmit(body)));
        else if (target.kind === 'jobs-list') result = validateJobPage(await assets.listVerificationJobs(context, target.projectId, validateJobPageInput(body)));
        else if (target.kind === 'jobs-metrics') result = validateJobMetrics(await assets.getVerificationMetrics(context, target.projectId));
        else if (target.kind === 'jobs-read') result = validateAssetJob(await assets.getVerificationJob(context, target.projectId, target.id));
        else result = validateAssetJob(await assets[target.kind === 'jobs-cancel' ? 'cancelVerificationJob' : 'retryVerificationJob'](
          context, target.projectId, target.id, validateJobAction(body)));
        if (result.projectId !== target.projectId || target.id && result.id !== target.id) throw fail('service-unavailable');
      } else if (['hold', 'retention', 'lifecycle-report', 'cleanup-plan'].includes(target.kind)) {
        const body = await readBody(req, { writing: req.method !== 'GET', signal: controller.signal });
        await ownerAllowed(context, target.projectId);
        if (target.kind === 'hold') {
          result = validateHold(req.method === 'GET' ? await assets.getHold(context, target.projectId, target.id)
            : await assets.setHold(context, target.projectId, target.id, validateHoldInput(body)));
          if (result.assetId !== target.id) throw fail('service-unavailable');
        } else if (target.kind === 'retention') result = validateRetention(req.method === 'GET'
          ? await assets.getRetentionPolicy(context, target.projectId)
          : await assets.setRetentionPolicy(context, target.projectId, validateRetentionInput(body)));
        else if (target.kind === 'lifecycle-report') result = validateReport(await assets.getLifecycleReport(context, target.projectId, validateReportInput(body)));
        else result = validatePlan(await assets.planCleanup(context, target.projectId, validatePlanInput(body)));
        if (result.projectId !== target.projectId) throw fail('service-unavailable');
      } else if (target.kind === 'policy') {
        if (req.method === 'GET') { await readBody(req, { writing: false, signal: controller.signal }); result = validatePolicy(await assets.getPolicy(context, target.projectId)); }
        else {
          const body = await readBody(req, { signal: controller.signal });
          if (!exact(body, ['expectedVersion', 'syncClasses']) || !integer(body.expectedVersion) || !validClasses(body.syncClasses)) throw fail('asset-policy-invalid');
          await ownerAllowed(context, target.projectId); result = validatePolicy(await assets.setPolicy(context, target.projectId, body));
        }
      } else if (target.kind === 'usage') {
        await readBody(req, { writing: false, signal: controller.signal }); result = validateUsage(await assets.getUsage(context, target.projectId));
      } else if (target.kind === 'availability') {
        await readBody(req, { writing: false, signal: controller.signal }); result = validateAvailability(await assets.getAvailability(context, target.projectId, target.id));
      } else if (target.kind === 'archive') {
        const body = await readBody(req, { signal: controller.signal });
        if (!exact(body, ['expectedArchived', 'archived']) || typeof body.expectedArchived !== 'boolean' || typeof body.archived !== 'boolean') throw fail('asset-archive-invalid');
        await ownerAllowed(context, target.projectId); result = validateAvailability(await assets.setArchived(context, target.projectId, target.id, body));
      } else if (target.kind === 'begin') {
        const body = await readBody(req, { signal: controller.signal }); if (!exact(body, ['identity'])) throw fail('body-invalid');
        result = validateUpload(await assets.beginUpload(context, target.projectId, validateIdentity(body.identity)));
      } else if (target.kind === 'status') {
        await readBody(req, { writing: false, signal: controller.signal }); result = validateUpload(await assets.uploadStatus(context, target.projectId, target.id));
      } else if (target.kind === 'complete') {
        if (req.method === 'DELETE') {
          await readBody(req, { writing: false, signal: controller.signal });
          await allowed(context, target.projectId, 'write');
          const id = JSON.stringify([target.projectId, target.id]), job = verifications.get(id);
          const running = job?.status === 'verifying';
          if (running) { job.controller.abort(); await job.promise; }
          if (job && verifications.get(id) === job) verifications.delete(id);
          // A cancellation cannot undo publication that won the completion race.
          json(200, { uploadId: target.id, cancelled: !!running && job.status === 'failed' && job.error === 'asset-cancelled' }); return;
        }
        const body = await readBody(req, { signal: controller.signal }); if (!exact(body, [])) throw fail('body-invalid');
        if (closing) throw fail('asset-service-busy');
        const authorization = await allowed(context, target.projectId, 'write');
        const verification = verifyUpload(context, target.projectId, target.id, authorization.actorId);
        json(verification.status, verification.data); return;
      } else if (target.kind === 'metadata') {
        await readBody(req, { writing: false, signal: controller.signal }); result = validateMetadata(await assets.getAsset(context, target.projectId, target.id));
      } else if (target.kind === 'ticket') {
        const body = await readBody(req, { signal: controller.signal });
        if (!body || !['GET', 'PUT'].includes(body.method) || !integer(body.index, 65535)
          || !exact(body, body.method === 'PUT' ? ['method', 'uploadId', 'index'] : ['method', 'assetId', 'index'])) throw fail('body-invalid');
        let metadata, id;
        if (body.method === 'PUT') {
          if (!ID.test(body.uploadId || '')) throw fail('body-invalid');
          await allowed(context, target.projectId, 'write'); id = body.uploadId;
          await uploadAllowed(context, target.projectId, id);
          metadata = validateUpload(await assets.uploadStatus(context, target.projectId, id));
        } else {
          if (!ASSET.test(body.assetId || '')) throw fail('body-invalid'); id = body.assetId;
          await downloadAllowed(context, target.projectId, id);
          metadata = validateMetadata(await assets.getAsset(context, target.projectId, id));
        }
        if (body.index >= metadata.chunks) throw fail('asset-chunk-invalid');
        const pathname = chunkPath(target.projectId, body.method, id, body.index), expiresAt = Date.now() + TICKET_TTL_MS;
        result = { path: `${pathname}?expires=${expiresAt}&signature=${signature(body.method, pathname, expiresAt)}`, expiresAt };
      } else if (target.kind === 'put') {
        const checksum = header(req, 'x-chunk-sha256'); if (!SHA.test(checksum || '')) throw fail('asset-chunk-invalid');
        await uploadAllowed(context, target.projectId, target.id);
        const status = validateUpload(await assets.uploadStatus(context, target.projectId, target.id));
        if (target.index >= status.chunks) throw fail('asset-chunk-invalid');
        const expected = Math.min(status.chunkSize, Math.max(0, status.size - target.index * status.chunkSize));
        const bytes = await readBody(req, { kind: 'binary', max: expected, signal: controller.signal });
        if (bytes.length !== expected || hash(bytes) !== checksum) throw fail('asset-chunk-invalid');
        result = validateProgress(await assets.putChunk(context, target.projectId, target.id, target.index, bytes, checksum, { signal: controller.signal }));
      } else {
        await readBody(req, { writing: false, signal: controller.signal });
        await downloadAllowed(context, target.projectId, target.id);
        const metadata = validateMetadata(await assets.getAsset(context, target.projectId, target.id));
        if (target.index >= metadata.chunks) throw fail('asset-chunk-invalid');
        const chunk = await assets.readChunk(context, target.projectId, target.id, target.index, { signal: controller.signal });
        const expected = Math.min(metadata.chunkSize, Math.max(0, metadata.size - target.index * metadata.chunkSize));
        if (!chunk || !Buffer.isBuffer(chunk.bytes) || chunk.bytes.length !== expected || chunk.totalBytes !== metadata.size
          || chunk.chunks !== metadata.chunks || !SHA.test(chunk.checksum || '') || hash(chunk.bytes) !== chunk.checksum) throw fail('asset-chunk-corrupt');
        await allowed(context, target.projectId, 'read');
        if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.bytes.length,
          'x-api-version': API_VERSION, 'x-request-id': context.requestId, 'x-chunk-sha256': chunk.checksum,
          'x-chunk-size': expected, 'x-chunk-index': target.index, 'x-asset-chunk-size': metadata.chunkSize,
          'x-asset-chunks': metadata.chunks, 'x-asset-size': metadata.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(chunk.bytes); }
        return;
      }
      json(200, result);
    } catch (error) {
      const code = ERROR_STATUS.has(error?.code) ? error.code : 'service-unavailable';
      if (!req.complete) { res.shouldKeepAlive = false; req.resume(); }
      json(ERROR_STATUS.get(code), { code }, true);
    } finally { if (admitted) active--; req.off('aborted', aborted); res.off('close', aborted); }
  };
  handler.close = () => {
    closing = true;
    for (const job of verifications.values()) if (job.status === 'verifying') job.controller.abort();
    return Promise.allSettled([...verifications.values()].map(job => job.promise)).then(() => {});
  };
  return handler;
}
module.exports = { createAssetHttpHandler, isAssetRequest, chunkPath, validateIdentity, validateUpload, validateMetadata,
  validateComplete, validateProgress, validatePolicy, validateUsage, validateAvailability, validClasses,
  MAX_CHUNK_BYTES, MAX_JSON_REQUEST_BYTES, MAX_JSON_RESPONSE_BYTES, MAX_ASSET_BYTES, TICKET_TTL_MS };
