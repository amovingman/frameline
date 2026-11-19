'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createAssetHttpHandler } = require('../src/asset-http-transport');
const { createAssetHttpClient } = require('../src/asset-http-client');
const { API_VERSION } = require('../src/project-api-contracts');
const { lifecycleFixture, owner, editor, viewer } = require('./fixtures/asset-lifecycle-service');
class Reply extends EventEmitter {
  constructor() { super(); this.headers = {}; this.destroyed = false; this.writableEnded = false; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = String(value); }
  writeHead(status, headers) { this.status = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); }
  end(bytes) { this.bytes = Buffer.from(bytes || ''); this.writableEnded = true; }
}
async function fixture(t) {
  const f = await lifecycleFixture(t), handler = createAssetHttpHandler({ assets: f.store, authorize: f.authorize, authorizePolicy: f.authorizePolicy, signingKey: randomBytes(32) });
  t.after(() => handler.close());
  async function call(method, url, body, token = owner.accessToken, headers = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body)), req = Readable.from(bytes ? [bytes] : []);
    Object.assign(req, { method, url, socket: { encrypted: true }, complete: false, headers: { 'x-api-version': API_VERSION,
      'x-request-id': 'job-request', authorization: `Bearer ${token}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } });
    req.rawHeaders = Object.entries(req.headers).flat(); req.once('end', () => { req.complete = true; });
    const reply = new Reply(); await handler(req, reply); return { status: reply.status, headers: reply.headers, bytes: reply.bytes, json: JSON.parse(reply.bytes) };
  }
  const client = (actor = owner) => createAssetHttpClient({ origin: 'https://jobs.example.test', getAccessToken: () => actor.accessToken,
    fetch: async (url, options) => {
      const target = new URL(url), result = await call(options.method, target.pathname + target.search,
        options.body === undefined ? undefined : JSON.parse(options.body), actor.accessToken, options.headers);
      return new Response(result.bytes, { status: result.status, headers: result.headers });
    } });
  return { ...f, call, client };
}
test('job API/SDK submits, deduplicates, pages, cancels, retries, and reports project-scoped metrics', async t => {
  const f = await fixture(t), a = await f.upload(), api = f.client(), read = f.client(viewer);
  const first = await api.submitVerificationJob('film', { assetId: a.assetId, idempotencyKey: 'first' });
  assert.equal((await api.submitVerificationJob('film', { assetId: a.assetId, idempotencyKey: 'dedup' })).id, first.id);
  assert.equal((await read.listVerificationJobs('film')).items.length, 1); assert.equal((await read.getVerificationJob('film', first.id)).status, 'queued');
  const cancelled = await api.cancelVerificationJob('film', first.id, { expectedRun: 1, idempotencyKey: 'cancel' }); assert.equal(cancelled.status, 'cancelled');
  const retried = await api.retryVerificationJob('film', first.id, { expectedRun: 1, idempotencyKey: 'retry' }); assert.equal(retried.run, 2);
  assert.equal((await read.getVerificationMetrics('film')).queued, 1);
  await assert.rejects(read.submitVerificationJob('film', { assetId: a.assetId, idempotencyKey: 'denied' }), { code: 'forbidden' });
  await assert.rejects(f.client(editor).cancelVerificationJob('film', first.id, { expectedRun: 2, idempotencyKey: 'other-author' }), { code: 'asset-policy-forbidden' });
  await assert.rejects(read.getVerificationJob('other-film', first.id), { code: 'asset-job-not-found' });
});
test('worker lease routes are absent and job routes reject extra fields, query/body ambiguity and browser origins', async t => {
  const f = await fixture(t), a = await f.upload();
  assert.equal((await f.call('POST', '/projects/film/assets/jobs/claim', {})).status, 405);
  assert.equal((await f.call('POST', '/projects/film/assets/jobs/id/heartbeat', {})).status, 404);
  assert.equal((await f.call('POST', '/projects/film/assets/jobs?unexpected=1', { assetId: a.assetId, idempotencyKey: 'key' })).status, 400);
  assert.equal((await f.call('POST', '/projects/film/assets/jobs', { assetId: a.assetId, idempotencyKey: 'key', actorId: 'forged' })).status, 400);
  assert.equal((await f.call('POST', '/projects/film/assets/jobs', { assetId: a.assetId, idempotencyKey: 'key' }, owner.accessToken, { origin: 'https://browser.example' })).status, 403);
});
test('job SDK rejects response scope substitution, private lease fields and fabricated successful verification', async t => {
  const f = await fixture(t), a = await f.upload(), job = await f.client().submitVerificationJob('film', { assetId: a.assetId, idempotencyKey: 'key' });
  const responseClient = data => createAssetHttpClient({ origin: 'https://jobs.example.test', getAccessToken: () => owner.accessToken,
    fetch: async (_url, options) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data }), { status: 200 }) });
  for (const data of [{ ...job, projectId: 'another-project' }, { ...job, lease: { token: 'private' } },
    { ...job, status: 'succeeded', result: { verified: true, sha256: 'f'.repeat(64), size: job.size, checkedAt: 1000 } }]) {
    await assert.rejects(responseClient(data).getVerificationJob('film', job.id), { code: 'asset-response-invalid' });
  }
});
