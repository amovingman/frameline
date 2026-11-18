'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { API_VERSION } = require('../src/project-api-contracts');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const secret = 'disposable-credential-123456789';
const setup = fetch => createRevisionHttpClient({ origin: 'https://api.example.test', getAccessToken: async () => secret, fetch });

test('token refresh connectivity failures remain retryable while sensitive accessor failures stay generic', async () => {
  for (const [code, expected] of [['service-offline', 'sync-network-unavailable'], ['sync-network-unavailable', 'sync-network-unavailable'],
    ['service-sign-in-required', 'access-token-invalid'], ['credential-storage-unavailable', 'access-token-invalid'],
    ['/Users/private/token', 'access-token-invalid']]) {
    let requests = 0;
    const client = createRevisionHttpClient({ origin: 'https://api.example.test', getAccessToken: async () => {
      throw Object.assign(new Error('/Users/private Bearer private-token'), { code });
    }, fetch: async () => { requests++; throw new Error('must not send'); } });
    await assert.rejects(client.getBranch('film-1', 'main'), error => error.code === expected
      && error.message === expected && !/private|Users|Bearer/.test(JSON.stringify(error)));
    assert.equal(requests, 0);
  }
});
const reply = (options, data, status = 200) => new Response(JSON.stringify({ apiVersion: API_VERSION,
  requestId: options.headers['x-request-id'], ...(status === 200 ? { data } : { error: { code: data } }) }),
{ status, headers: { 'content-type': 'application/json' } });

test('HTTPS metadata client binds credentials to headers, preserves request IDs and sends route-scoped fields', async () => {
  const calls = [], client = setup(async (url, options) => { calls.push({ url, options }); return reply(options, { ok: true }); });
  await client.createRevision({ projectId: 'project-1', manifestId: 'sha256:abc', parentRevisionId: null,
    sourceRevisionId: 'source-1', message: 'Initial revision', authorId: 'untrusted-display-author', idempotencyKey: 'retry-1' });
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.example.test/projects/project-1/revisions');
  assert(!url.includes(secret)); assert.equal(options.headers.authorization, `Bearer ${secret}`);
  assert.equal(options.headers['x-api-version'], API_VERSION); assert.equal(options.headers['idempotency-key'], 'retry-1');
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  assert.deepEqual(JSON.parse(options.body), { manifestId: 'sha256:abc', parentRevisionId: null,
    message: 'Initial revision', sourceRevisionId: 'source-1' });
  await client.getManifest('project-1', 'sha256:abc');
  assert.equal(calls[1].url, 'https://api.example.test/projects/project-1/manifests/sha256%3Aabc');
  await client.findRevisionBySource('project-1', 'source-1');
  assert.equal(calls[2].url, 'https://api.example.test/projects/project-1/revisions/by-source/source-1');
  await client.putManifest('project-1', { schemaVersion: 2 }); assert.equal(calls[3].options.method, 'PUT');
  await client.compareAndSwapBranch({ projectId: 'project-1', branch: 'main', revisionId: 'revision-1', expectedRevisionId: null });
  assert.equal(calls[4].options.method, 'PUT');
});

test('network client refuses insecure origins, redirect forwarding, invalid IDs and expired binding envelopes', async () => {
  for (const origin of ['http://api.example.test', 'http://127.0.0.1', 'https://user:password@example.test',
    'https://api.example.test/path', 'https://api.example.test/?token=secret', 'https://api.example.test/#secret']) {
    assert.throws(() => createRevisionHttpClient({ origin, getAccessToken: () => secret }), { code: 'secure-transport-required' });
  }
  assert.throws(() => createRevisionHttpClient({ origin: 'http://localhost:1234', getAccessToken: () => secret, allowLoopbackHttp: true }), { code: 'secure-transport-required' });
  assert.doesNotThrow(() => createRevisionHttpClient({ origin: 'http://127.0.0.1:1234', getAccessToken: () => secret, allowLoopbackHttp: true }));
  const invalid = setup(async () => new Response('{}', { status: 302, headers: { location: 'https://other.test', 'content-type': 'application/json' } }));
  await assert.rejects(invalid.getBranch('project', 'main'), { code: 'sync-response-invalid' });
  assert.throws(() => invalid.getBranch('../project', 'main'), { code: 'sync-request-invalid' });
  assert.throws(() => invalid.getBranch(1234, 'main'), { code: 'sync-request-invalid' });
  await assert.rejects(invalid.createRevision({ projectId: 'project', idempotencyKey: 1234 }), { code: 'sync-request-invalid' });
  for (const envelope of [{ apiVersion: API_VERSION, requestId: 'wrong', data: {} }, { apiVersion: 'future', data: {} }]) {
    const client = setup(async () => new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }));
    await assert.rejects(client.getBranch('project', 'main'), { code: 'sync-response-invalid' });
  }
  const invalidUtf8 = setup(async (_url, options) => new Response(Buffer.concat([
    Buffer.from(`{"apiVersion":"${API_VERSION}","requestId":"${options.headers['x-request-id']}","data":"`),
    Buffer.from([0xff]), Buffer.from('"}')]), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(invalidUtf8.getBranch('project', 'main'), { code: 'sync-response-invalid' });
});

test('request and streamed response bounds reject oversized payloads before trusting metadata', async () => {
  let sent = 0;
  const bounded = createRevisionHttpClient({ origin: 'https://api.example.test', maxBytes: 256,
    getAccessToken: () => secret, fetch: async () => { sent++; return new Response('x'.repeat(257), { headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(bounded.putManifest('project', { data: 'x'.repeat(256) }), { code: 'sync-request-too-large' }); assert.equal(sent, 0);
  await assert.rejects(bounded.getBranch('project', 'main'), { code: 'sync-response-too-large' });
  const declared = setup(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(declared.getBranch('project', 'main'), { code: 'sync-response-too-large' });
});

test('client sanitizes network and service failures and honors aborts without exposing credentials or remote text', async () => {
  const client = setup(async () => { throw new Error(`/Users/private/connection ${secret}`); });
  await assert.rejects(client.getBranch('project', 'main'), error => error.code === 'sync-network-unavailable'
    && !JSON.stringify(error).includes(secret) && !error.message.includes('/Users/'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.getBranch('project', 'main', { signal: controller.signal }), { code: 'sync-cancelled' });
  for (const [status, code, expected] of [[403, 'forbidden', 'forbidden'], [409, 'branch-head-changed', 'branch-head-changed'],
    [400, `/Users/private/${secret}`, 'sync-service-failed'], [503, 'internal-error', 'sync-network-unavailable']]) {
    const remote = setup(async (_url, options) => reply(options, code, status));
    await assert.rejects(remote.getBranch('project', 'main'), { code: expected });
  }
  const timeout = createRevisionHttpClient({ origin: 'https://api.example.test', getAccessToken: () => secret, timeoutMs: 2,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture timeout fallback')), 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(timeout.getBranch('project', 'main'), { code: 'sync-network-unavailable' });
});
