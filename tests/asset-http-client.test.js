'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAssetHttpClient } = require('../src/asset-http-client');
const { API_VERSION } = require('../src/project-api-contracts');
const { chunkPath, MAX_CHUNK_BYTES, TICKET_TTL_MS } = require('../src/asset-http-transport');

const bytes = Buffer.from('abcd'), sha = value => createHash('sha256').update(value).digest('hex');
const assetId = `sha256:${sha(bytes)}`, uploadId = 'upload-fixture';
const identity = { version: 1, algorithm: 'sha256', contentId: assetId, size: 4, assetClass: 'original', mediaType: 'video/test' };
const upload = { uploadId, assetId, size: 4, chunkSize: 4, chunks: 1, received: [false], complete: false };
const receipt = { assetId, size: 4, chunkSize: 4, chunks: 1, verified: true };
function json(options, data, status = 200, error = false, requestId = options.headers['x-request-id']) {
  const value = JSON.stringify({ apiVersion: API_VERSION, requestId, [error ? 'error' : 'data']: data });
  return new Response(value, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(value)) } });
}
function ticket(options, method, id, at = 0) {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  return json(options, { path: `${chunkPath('film', method, id, at)}?expires=${expiresAt}&signature=${'b'.repeat(64)}`, expiresAt });
}
const factory = (fetch, extra = {}) => createAssetHttpClient({ origin: 'https://fixture.example.test', getAccessToken: () => 'a'.repeat(43), fetch, ...extra });

test('client rejects insecure origins, URL credentials and paths without issuing a request', () => {
  for (const origin of ['http://127.0.0.1', 'https://user:password@example.test', 'https://example.test/private', 'https://example.test/?token=x', 'https://example.test/#x']) {
    assert.throws(() => createAssetHttpClient({ origin, getAccessToken: () => 'a'.repeat(43) }), { code: 'secure-transport-required' });
  }
  assert.throws(() => factory(async () => {}, { verificationTimeoutMs: 24 * 60 * 60_000 + 1 }), { code: 'asset-client-invalid' });
});

test('upload and metadata acknowledgments are bound to the requested identity and upload ID', async () => {
  await assert.rejects(factory(async (_url, options) => json(options, { ...upload, assetId: `sha256:${'0'.repeat(64)}` })).beginUpload('film', identity), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...upload, uploadId: 'different' })).uploadStatus('film', uploadId), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...receipt, identity })).getAsset('film', `sha256:${'0'.repeat(64)}`), { code: 'asset-response-invalid' });
  const client = factory(async (url, options) => json(options, url.endsWith('/complete') ? { ...receipt, size: 3 } : upload));
  await client.beginUpload('film', identity); await assert.rejects(client.completeUpload('film', uploadId), { code: 'asset-response-invalid' });
});

test('ticket responses cannot redirect credentials to a different origin, path, or query shape', async () => {
  for (const wrong of ['https://other.test/chunk', '/projects/other/assets/chunks/0', '//other.test/chunk']) {
    let calls = 0;
    const client = factory(async (_url, options) => { calls++; return json(options, { path: wrong, expiresAt: Date.now() + 1000 }); });
    await assert.rejects(client.readChunk('film', assetId, 0), { code: 'asset-response-invalid' }); assert.equal(calls, 1);
  }
});

test('binary downloads verify request binding, exact geometry and SHA-256 before releasing bytes', async () => {
  for (const bad of ['checksum', 'index', 'length', 'requestId', 'too-large']) {
    const client = factory(async (url, options) => {
      if (url.endsWith('/tickets')) return ticket(options, 'GET', assetId);
      const headers = { 'content-type': 'application/octet-stream', 'x-api-version': API_VERSION,
        'x-request-id': options.headers['x-request-id'], 'x-chunk-sha256': sha(bytes), 'x-chunk-size': '4',
        'x-chunk-index': '0', 'x-asset-chunk-size': '4', 'x-asset-chunks': '1', 'x-asset-size': '4', 'content-length': '4' };
      if (bad === 'checksum') headers['x-chunk-sha256'] = '0'.repeat(64);
      if (bad === 'index') headers['x-chunk-index'] = '1';
      if (bad === 'length') headers['x-chunk-size'] = '3';
      if (bad === 'requestId') headers['x-request-id'] = 'different';
      if (bad === 'too-large') headers['content-length'] = String(MAX_CHUNK_BYTES + 1);
      return new Response(bytes, { status: 200, headers });
    });
    await assert.rejects(client.readChunk('film', assetId, 0), { code: bad === 'too-large' ? 'asset-response-too-large' : 'asset-response-invalid' });
  }
});

test('request and error validation never exposes credentials, URLs or remote error text', async () => {
  let calls = 0;
  const client = factory(async (_url, options) => { calls++; return json(options, { code: '/private/bearer-secret' }, 400, true); });
  await assert.rejects(client.putChunk('film', uploadId, 0, bytes, '0'.repeat(64)), { code: 'asset-chunk-invalid' }); assert.equal(calls, 0);
  await assert.rejects(client.uploadStatus('film', uploadId), { code: 'asset-service-failed', message: 'asset-service-failed' });
  const credentials = factory(async () => { throw new Error('must not send'); }, { getAccessToken: () => { throw new Error('/private/access-token-secret'); } });
  await assert.rejects(credentials.uploadStatus('film', uploadId), { code: 'access-token-invalid', message: 'access-token-invalid' });
  const offline = factory(async () => {}, { getAccessToken: () => { throw Object.assign(new Error('private'), { code: 'service-offline' }); } });
  await assert.rejects(offline.uploadStatus('film', uploadId), { code: 'asset-network-unavailable' });
});

test('verification polling awaits final receipt and explicit cancellation has its own endpoint', async () => {
  let polls = 0; const methods = [];
  const client = factory(async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'DELETE') return json(options, { uploadId, cancelled: true });
    return ++polls === 1 ? json(options, { uploadId, status: 'verifying' }, 202) : json(options, receipt);
  });
  assert.deepEqual(await client.completeUpload('film', uploadId), receipt); assert.equal(polls, 2);
  assert.deepEqual(await client.cancelVerification('film', uploadId), { uploadId, cancelled: true }); assert.deepEqual(methods, ['POST', 'POST', 'DELETE']);
});

test('aborting client polling does not silently cancel a shared server verification job', async () => {
  const controller = new AbortController(), methods = [];
  const client = factory(async (_url, options) => { methods.push(options.method); controller.abort(); return json(options, { uploadId, status: 'verifying' }, 202); });
  await assert.rejects(client.completeUpload('film', uploadId, { signal: controller.signal }), { code: 'asset-cancelled' }); assert.deepEqual(methods, ['POST']);
});

test('overall verification deadline is bounded and malformed polling receipts fail closed', async () => {
  const timed = factory(async (_url, options) => json(options, { uploadId, status: 'verifying' }, 202), { verificationTimeoutMs: 20 });
  await assert.rejects(timed.completeUpload('film', uploadId), { code: 'asset-verification-timeout' });
  const malformed = factory(async (_url, options) => json(options, { uploadId: 'different', status: 'verifying' }, 202));
  await assert.rejects(malformed.completeUpload('film', uploadId), { code: 'asset-response-invalid' });
});

test('policy, usage and availability replies are strict and bound to the requested project and content', async () => {
  const policy = { projectId: 'film', version: 1, syncClasses: ['original'] };
  const usage = { projectId: 'film', assetCount: 1, logicalBytes: 4, availableBytes: 4, archivedBytes: 0, excludedBytes: 0,
    inProgressUploads: 0, inProgressReceivedBytes: 0, inProgressDeclaredBytes: 0 };
  const present = { projectId: 'film', assetId, cloudPresent: true, excluded: false, archived: false, assetClass: 'original', size: 4 };
  assert.deepEqual(await factory(async (_url, options) => json(options, policy)).getPolicy('film'), policy);
  await assert.rejects(factory(async (_url, options) => json(options, { ...policy, projectId: 'other' })).getPolicy('film'), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...usage, privatePath: '/private/source' })).getUsage('film'), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...usage, archivedBytes: 4 })).getUsage('film'), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...present, assetId: `sha256:${'0'.repeat(64)}` })).getAvailability('film', assetId), { code: 'asset-response-invalid' });
  await assert.rejects(factory(async (_url, options) => json(options, { ...present, cloudPresent: false })).getAvailability('film', assetId), { code: 'asset-response-invalid' });
});

test('owner mutation requests validate CAS inputs and require matching version, classes and archive acknowledgment', async () => {
  let calls = 0;
  const client = factory(async (_url, options) => { calls++; return json(options, { projectId: 'film', version: 2, syncClasses: ['original'] }); });
  await assert.rejects(client.setPolicy('film', { expectedVersion: 1, syncClasses: ['private-path'] }), { code: 'asset-policy-invalid' });
  await assert.rejects(client.setPolicy('film', { expectedVersion: 1, syncClasses: ['original', 'original'] }), { code: 'asset-policy-invalid' });
  await assert.rejects(client.setArchived('film', assetId, { expectedArchived: false, archived: true, token: 'secret' }), { code: 'asset-archive-invalid' });
  assert.equal(calls, 0);
  await assert.rejects(client.setPolicy('film', { expectedVersion: 0, syncClasses: ['original'] }), { code: 'asset-response-invalid' });
  await assert.rejects(client.setPolicy('film', { expectedVersion: 1, syncClasses: [] }), { code: 'asset-response-invalid' });
  const archive = factory(async (_url, options) => json(options, { projectId: 'film', assetId, cloudPresent: true, excluded: false,
    archived: false, assetClass: 'original', size: 4 }));
  await assert.rejects(archive.setArchived('film', assetId, { expectedArchived: false, archived: true }), { code: 'asset-response-invalid' });
  const denied = factory(async (_url, options) => json(options, { code: 'asset-policy-forbidden' }, 403, true));
  await assert.rejects(denied.setPolicy('film', { expectedVersion: 0, syncClasses: [] }), { code: 'asset-policy-forbidden', message: 'asset-policy-forbidden' });
});
