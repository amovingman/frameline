'use strict';
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { createRevisionHttpClient } = require('./revision-http-client');
const { createAssetHttpClient } = require('./asset-http-client');
const { createRevisionMediaWorkflow } = require('./revision-media-workflow');
const MAX_INPUT = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const fail = code => Object.assign(new Error(code), { code });
const SAFE = new Set(['revision-media-input-invalid', 'revision-media-review-required', 'revision-media-review-changed', 'revision-media-owner-required', 'revision-media-binding-required',
  'revision-media-manifest-invalid', 'revision-media-observation-invalid', 'revision-media-policy-changed', 'revision-media-source-unavailable',
  'revision-media-source-changed', 'revision-media-coverage-incomplete', 'revision-media-download-blocked', 'revision-media-cancelled',
  'access-token-invalid', 'forbidden', 'project-not-found', 'revision-not-found', 'manifest-not-found', 'branch-not-found',
  'branch-head-changed', 'revision-parent-mismatch', 'idempotency-key-reused', 'source-revision-exists', 'branch-approval-required',
  'asset-revision-media-missing', 'asset-revision-identity-mismatch', 'asset-revision-unavailable', 'asset-revision-references-unavailable',
  'sync-network-unavailable', 'sync-response-invalid', 'sync-cancelled', 'asset-policy-excluded', 'asset-policy-forbidden',
  'asset-policy-version-conflict', 'asset-not-found', 'asset-archived', 'asset-identity-collision', 'asset-source-changed',
  'asset-identity-mismatch', 'asset-destination-exists', 'asset-checkpoint-invalid', 'asset-cache-corrupt', 'asset-cancelled',
  'asset-network-unavailable', 'asset-response-invalid', 'asset-storage-unavailable', 'asset-storage-uncertain',
  'asset-local-io-failed', 'asset-local-io-uncertain', 'asset-transfer-busy', 'scan-cancelled', 'source-changed',
  'media-revision-source-changed', 'media-revision-capture-invalid', 'media-revision-source-unavailable']);
const fields = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && ID.test(value);
const filename = value => typeof value === 'string' && value.length <= 8192 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
function validateRevisionMediaCliRequest(value) {
  if (!fields(value, ['origin', 'accessToken', 'projectId', 'action', 'input']) || !id(value.projectId)
    || typeof value.origin !== 'string' || value.origin.length > 2048 || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken)
    || !['inspect', 'publish', 'availability', 'download', 'policy-get', 'policy-set'].includes(value.action)) throw fail('revision-media-input-invalid');
  let url; try { url = new URL(value.origin); } catch { throw fail('revision-media-input-invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('revision-media-input-invalid');
  const input = value.input;
  if (['inspect', 'publish'].includes(value.action)) {
    const keys = ['exportPath', 'branch', 'expectedHead', 'message', 'uploadMedia', ...(value.action === 'publish' ? ['idempotencyKey', 'reviewHash'] : [])];
    if (!fields(input, [...keys, 'maxBytesPerSecond', ...(value.action === 'inspect' ? ['idempotencyKey'] : [])], keys) || !filename(input.exportPath) || !['.fcpxml', '.fcpxmld'].includes(path.extname(input.exportPath).toLowerCase())
      || !id(input.branch) || input.expectedHead !== null && !id(input.expectedHead)
      || (value.action === 'publish' || input.idempotencyKey !== undefined) && !id(input.idempotencyKey)
      || value.action === 'publish' && !/^[a-f0-9]{64}$/.test(input.reviewHash || '')
      || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 240 || /[\\/\x00-\x1f\x7f]/.test(input.message) || /^[a-z]:/i.test(input.message) || typeof input.uploadMedia !== 'boolean') throw fail('revision-media-input-invalid');
  } else if (['availability', 'download'].includes(value.action)) {
    const required = ['revisionId', ...(value.action === 'download' ? ['destinationDirectory', 'workDirectory'] : [])];
    if (!fields(input, [...required, 'localFiles', 'collaboratorObservation', ...(value.action === 'download' ? ['maxBytesPerSecond'] : [])], required)
      || !id(input.revisionId) || input.localFiles !== undefined && (!Array.isArray(input.localFiles) || input.localFiles.length > 1000 || input.localFiles.some(value => !filename(value)))
      || value.action === 'download' && (!filename(input.destinationDirectory) || !filename(input.workDirectory))) throw fail('revision-media-input-invalid');
  } else if (value.action === 'policy-get') { if (!fields(input, [])) throw fail('revision-media-input-invalid'); }
  else if (!fields(input, ['expectedVersion', 'syncClasses']) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !Array.isArray(input.syncClasses) || input.syncClasses.length > 5 || new Set(input.syncClasses).size !== input.syncClasses.length
    || input.syncClasses.some(value => !['original', 'proxy', 'audio', 'graphics', 'other'].includes(value))) throw fail('revision-media-input-invalid');
  if (input.maxBytesPerSecond !== undefined && input.maxBytesPerSecond !== null
    && (!Number.isSafeInteger(input.maxBytesPerSecond) || input.maxBytesPerSecond < 1024 || input.maxBytesPerSecond > 1024 ** 3)) throw fail('revision-media-input-invalid');
  return structuredClone({ ...value, origin: url.origin });
}
async function runRevisionMediaCli({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  signal, createRevisionClient = createRevisionHttpClient, createAssetClient = createAssetHttpClient, createWorkflow = createRevisionMediaWorkflow } = {}) {
  try {
    if (signal?.aborted) throw fail('revision-media-cancelled');
    if (argv.length) throw fail('revision-media-input-invalid'); const chunks = []; let size = 0;
    for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_INPUT) throw fail('revision-media-input-invalid'); chunks.push(bytes); }
    let raw; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { throw fail('revision-media-input-invalid'); }
    const value = validateRevisionMediaCliRequest(raw), settings = { origin: value.origin, getAccessToken: () => value.accessToken };
    if (signal?.aborted) throw fail('revision-media-cancelled');
    const workflow = createWorkflow({ origin: value.origin, revisionClient: createRevisionClient(settings), assetClient: createAssetClient(settings) });
    let previous = '', lastAt = 0;
    const onProgress = progress => {
      if (!progress || !['reading', 'parsing', 'inventory', 'media', 'hashing', 'uploading', 'verifying', 'downloading', 'writing', 'complete'].includes(progress.phase)) return;
      const at = Date.now(); if (progress.phase === previous && at - lastAt < 250) return; previous = progress.phase; lastAt = at;
      const safe = { event: 'progress', phase: progress.phase };
      for (const key of ['bytes', 'totalBytes', 'checked', 'total']) if (Number.isSafeInteger(progress[key]) && progress[key] >= 0) safe[key] = progress[key];
      errorOutput.write(`${JSON.stringify(safe)}\n`);
    };
    let result;
    if (value.action === 'policy-get') result = await workflow.getPolicy({ projectId: value.projectId }, { signal });
    else if (value.action === 'policy-set') result = await workflow.setPolicy({ projectId: value.projectId, input: value.input }, { signal });
    else result = await workflow[value.action]({ projectId: value.projectId, ...value.input }, { signal, onProgress });
    const bytes = JSON.stringify(result); if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw fail('revision-media-manifest-invalid');
    output.write(`${bytes}\n`); return 0;
  } catch (error) { errorOutput.write(`${signal?.aborted ? 'revision-media-cancelled' : SAFE.has(error?.code) ? error.code : 'revision-media-operation-failed'}\n`); return 1; }
}
if (require.main === module) {
  const controller = new AbortController();
  const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  runRevisionMediaCli({ signal: controller.signal }).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('revision-media-operation-failed\n'); process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); });
}
module.exports = { validateRevisionMediaCliRequest, runRevisionMediaCli };
