'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createAssetHttpHandler } = require('../src/asset-http-transport');
const { createAssetHttpClient } = require('../src/asset-http-client');
const { API_VERSION } = require('../src/project-api-contracts');
const { lifecycleFixture, owner, editor, viewer, holdInput, page } = require('./fixtures/asset-lifecycle-service');
class Reply extends EventEmitter {
  constructor() { super(); this.headers = {}; this.destroyed = false; this.writableEnded = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
  writeHead(status, headers) { this.status = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); }
  end(bytes) { this.bytes = Buffer.from(bytes || ''); this.writableEnded = true; }
}
async function fixture(t) {
  const f = await lifecycleFixture(t), handler = createAssetHttpHandler({ assets: f.store, authorize: f.authorize, authorizePolicy: f.authorizePolicy, signingKey: randomBytes(32) });
  t.after(() => handler.close());
  async function call(method, url, body, token = owner.accessToken, headers = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = Readable.from(bytes === null ? [] : [bytes]);
    Object.assign(req, { method, url, socket: { encrypted: true }, complete: false, headers: {
      'x-api-version': API_VERSION, 'x-request-id': 'lifecycle-request', authorization: `Bearer ${token}`,
      ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers
    } });
    req.rawHeaders = Object.entries(req.headers).flat(); req.once('end', () => { req.complete = true; });
    const response = new Reply(); await handler(req, response); return { status: response.status, headers: response.headers, bytes: response.bytes, json: JSON.parse(response.bytes) };
  }
  const client = (actor = owner) => createAssetHttpClient({ origin: 'https://fixture.example.test', getAccessToken: () => actor.accessToken,
    fetch: async (url, options) => {
      const route = new URL(url), reply = await call(options.method, route.pathname + route.search,
        options.body === undefined ? undefined : JSON.parse(options.body), actor.accessToken, options.headers);
      return new Response(reply.bytes, { status: reply.status, headers: reply.headers });
    } });
  return { ...f, call, client, handler };
}
test('asset SDK and HTTPS handler carry hold, release, retention, reports and non-executable cleanup plans', async t => {
  const f = await fixture(t), a = await f.upload(), api = f.client();
  assert.equal((await api.getHold('film', a.assetId)).version, 0);
  const held = await api.setHold('film', a.assetId, holdInput()); assert.equal(held.held, true);
  assert.deepEqual(await api.setHold('film', a.assetId, holdInput()), held);
  const release = holdInput(1, { held: false, reason: null, until: null }); assert.equal((await api.setHold('film', a.assetId, release)).version, 2);
  assert.equal((await api.getRetentionPolicy('film')).minimumArchiveAgeMs, 30 * 86400000);
  await api.setRetentionPolicy('film', { expectedVersion: 0, minimumArchiveAgeMs: 0, idempotencyKey: 'retention' });
  await api.setArchived('film', a.assetId, { expectedArchived: false, archived: true });
  const report = await api.getLifecycleReport('film'); assert.equal(report.items[0].cleanupCandidate, true);
  const plan = await api.planCleanup('film', { assetIds: [a.assetId], expectedStateHash: report.stateHash });
  assert.equal(plan.ready, false); assert.equal(plan.deletionPerformed, false); assert.equal(plan.candidateBytes, a.bytes.length);
});
test('lifecycle routes reject non-owners, browser origins, query ambiguity, extra input and wrong methods', async t => {
  const f = await fixture(t), a = await f.upload();
  for (const actor of [editor, viewer]) {
    const api = f.client(actor);
    for (const action of [() => api.getHold('film', a.assetId), () => api.setHold('film', a.assetId, holdInput()),
      () => api.getRetentionPolicy('film'), () => api.getLifecycleReport('film')]) await assert.rejects(action(), error => ['asset-policy-forbidden', 'forbidden'].includes(error.code));
  }
  const route = '/projects/film/assets/lifecycle/report';
  assert.equal((await f.call('POST', route + '?limit=100', page)).status, 400);
  assert.equal((await f.call('GET', route)).status, 405);
  assert.equal((await f.call('POST', route, page, owner.accessToken, { origin: 'https://malicious.example' })).status, 403);
  assert.equal((await f.call('POST', route, { ...page, deletionAllowed: true })).status, 400);
  const result = await f.call('POST', '/projects/film/assets/lifecycle/plan', { assetIds: [a.assetId], expectedStateHash: 'a'.repeat(64) });
  assert.equal(result.status, 409); assert.equal(result.json.error.code, 'asset-lifecycle-plan-stale');
  f.revoked.add(owner.accessToken); await assert.rejects(f.client().getHold('film', a.assetId), { code: 'forbidden' });
});
test('lifecycle SDK rejects wrong response scope, changed requested settings, and fabricated deletion readiness', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  const report = await f.store.getLifecycleReport(owner, 'film', page), hold = await f.store.setHold(owner, 'film', a.assetId, holdInput());
  const current = await f.store.getLifecycleReport(owner, 'film', page);
  const plan = await f.store.planCleanup(owner, 'film', { assetIds: [a.assetId], expectedStateHash: current.stateHash });
  const responseClient = data => createAssetHttpClient({ origin: 'https://fixture.example.test', getAccessToken: () => owner.accessToken,
    fetch: async (_url, options) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data }), { status: 200 }) });
  await assert.rejects(responseClient({ ...hold, projectId: 'other-film' }).getHold('film', a.assetId), { code: 'asset-response-invalid' });
  await assert.rejects(responseClient({ ...hold, reason: 'contractual' }).setHold('film', a.assetId, holdInput()), { code: 'asset-response-invalid' });
  await assert.rejects(responseClient({ ...report, projectId: 'other-film' }).getLifecycleReport('film'), { code: 'asset-response-invalid' });
  await assert.rejects(responseClient({ ...plan, ready: true }).planCleanup('film', { assetIds: [a.assetId], expectedStateHash: current.stateHash }), { code: 'asset-response-invalid' });
  await assert.rejects(responseClient(plan).planCleanup('film', { assetIds: [`sha256:${'f'.repeat(64)}`], expectedStateHash: current.stateHash }), { code: 'asset-response-invalid' });
});
