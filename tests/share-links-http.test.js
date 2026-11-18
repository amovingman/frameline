'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { API_VERSION, fingerprint } = require('../src/project-api-contracts');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createRevisionHttpHandler, createShareRedeemLimiter } = require('../src/revision-http-transport');
const { validateShareLink, validateShareCreation, validateSharedRevision } = require('../src/share-links-protocol');
const { createShareViewerHandler } = require('../src/share-viewer');
const token = Buffer.alloc(32, 7).toString('base64url'), at = 1795000000000;
const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: 'f'.repeat(64),
  sequence: { name: '<img src=x onerror=alert(1)> Été 夜', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
const revision = { id: 'revision', manifestId: `sha256:${fingerprint(manifest)}`, message: 'Frozen shared revision', createdAt: new Date(at).toISOString() };
const link = () => ({ id: 'link', projectId: 'film', branch: 'main', revisionId: revision.id, revisionMessage: revision.message,
  manifestId: revision.manifestId, issuerId: 'owner', createdAt: at, expiresAt: at + 3600000, revokedAt: null, status: 'active' });
const shared = () => ({ permission: 'read', projectId: 'film', projectName: 'Shared film', revision, manifest, expiresAt: at + 3600000 });
const review = () => ({ projectId: 'film', branch: 'main', headRevisionId: revision.id, revision, links: { items: [link()], total: 1, nextCursor: null } });
const base = () => Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(name => [name, async () => ({})]));
const reply = (options, data) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data }), { headers: { 'content-type': 'application/json' } });

test('share DTOs expose only pinned metadata and reject token, identity, integrity and revocation substitutions', () => {
  assert.deepEqual(validateSharedRevision(shared()), shared());
  for (const patch of [{ token }, { tokenHash: 'a'.repeat(64) }, { revisionId: '../secret' },
    { status: 'expired', revokedAt: at }, { status: 'revoked', revokedAt: null }, { status: 'revoked', revokedAt: at - 1 }]) {
    assert.throws(() => validateShareLink({ ...link(), ...patch }, 'film'), { code: 'sync-response-invalid' });
  }
  assert.throws(() => validateShareCreation({ link: link(), token: 'bad' }, 'film'), { code: 'sync-response-invalid' });
  for (const patch of [{ authorId: 'private-owner' }, { projectName: '/private/project' }, { permission: 'write' },
    { revision: { ...revision, authorId: 'owner' } }, { manifest: { ...manifest, sourceHash: 'e'.repeat(64) } }]) {
    assert.throws(() => validateSharedRevision({ ...shared(), ...patch }), { code: 'sync-response-invalid' });
  }
});

test('anonymous SDK redemption never obtains a bearer and puts its capability only in the bounded JSON body', async () => {
  let accessed = 0; const calls = [], client = createRevisionHttpClient({ origin: 'https://share.example.test', getAccessToken: () => { accessed++; return 'fixture-bearer-123456789'; },
    fetch: async (url, options) => { calls.push({ url, options }); return reply(options, url.endsWith('/shares/redeem') ? shared()
      : url.includes('/revocation') ? { ...link(), status: 'revoked', revokedAt: at } : options.method === 'GET' ? review() : { link: link(), token }); } });
  await client.redeemShareLink({ token }); assert.equal(accessed, 0); assert.equal(calls[0].url, 'https://share.example.test/shares/redeem');
  assert.equal(calls[0].options.headers.authorization, undefined); assert.deepEqual(JSON.parse(calls[0].options.body), { token });
  assert.equal(calls[0].options.redirect, 'error'); assert(!JSON.stringify(calls[0].options.headers).includes(token));
  await client.getShareReview('film', 'main');
  await client.createShareLink({ projectId: 'film', branch: 'main', expectedHead: revision.id, ttlMs: 3600000, idempotencyKey: 'share-exact-retry' });
  await client.revokeShareLink('film', 'link'); assert.equal(accessed, 3);
  const count = calls.length;
  await assert.rejects(client.redeemShareLink({ token: 'invalid' }), { code: 'share-link-unavailable' });
  await assert.rejects(client.redeemShareLink({ token, authorId: 'owner' }), { code: 'share-link-unavailable' });
  await assert.rejects(client.createShareLink({ projectId: 'film', branch: 'main', expectedHead: revision.id, ttlMs: 1, idempotencyKey: 'bad' }));
  assert.equal(calls.length, count);
});

function incoming(method, url, input, headers = {}, peer = '127.0.0.1') {
  const bytes = Buffer.from(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input)); let reads = 0;
  const req = new Readable({ read() { reads++; this.push(bytes); this.push(null); } });
  headers = { 'x-api-version': API_VERSION, host: 'share.example.test', ...headers, ...(input === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }) };
  Object.assign(req, { method, url, headers, rawHeaders: Object.entries(headers).flat(), socket: { encrypted: true, remoteAddress: peer } });
  const result = { headers: {}, reads: () => reads }, res = { setHeader(k, v) { result.headers[k.toLowerCase()] = v; },
    writeHead(status, extra) { result.status = status; Object.assign(result.headers, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v]))); },
    end(body) { result.bytes = Buffer.from(body); try { result.body = JSON.parse(body); } catch {} } };
  return { req, res, result };
}
async function call(handler, method, url, body, headers, peer) {
  const value = incoming(method, url, body, headers, peer); await handler(value.req, value.res); return value.result;
}
test('share routes preserve optional compatibility, require exact owner intent, and permit only same-origin browser redemption', async () => {
  let redeemed = 0, created = 0;
  const service = { ...base(), getShareReview: async () => review(), createShareLink: async () => { created++; return { link: link(), token }; },
    revokeShareLink: async () => ({ ...link(), status: 'revoked', revokedAt: at }), redeemShareLink: async () => { redeemed++; return shared(); } };
  const handler = createRevisionHttpHandler({ service }), route = '/projects/film/branches/main/share-links', auth = { authorization: 'Bearer fixture-token' };
  assert.equal((await call(createRevisionHttpHandler({ service: base() }), 'POST', '/shares/redeem', { token })).status, 404);
  assert.equal((await call(handler, 'GET', route, undefined, auth)).status, 200);
  for (const query of ['?limit=101', '?limit=20&limit=20', '?cursor=bad', '?token=hidden']) assert.equal((await call(handler, 'GET', route + query, undefined, auth)).status, 400);
  assert.equal((await call(handler, 'POST', route, { expectedHead: revision.id, ttlMs: 3600000 }, auth)).status, 400);
  assert.equal((await call(handler, 'POST', route, { expectedHead: revision.id, ttlMs: 3600000, issuerId: 'spoof' }, { ...auth, 'idempotency-key': 'retry' })).status, 400);
  assert.equal(created, 0);
  assert.equal((await call(handler, 'POST', '/shares/redeem', { token }, { origin: 'https://other.example.test' })).status, 403);
  const valid = await call(handler, 'POST', '/shares/redeem', { token }, { origin: 'https://share.example.test' }); assert.equal(valid.status, 200);
  assert.equal(valid.headers['access-control-allow-origin'], undefined); assert.equal(valid.headers['cache-control'], 'no-store'); assert.equal(valid.headers['referrer-policy'], 'no-referrer');
  for (const body of [{ token: 'bad' }, { token, projectId: 'film' }]) assert.equal((await call(handler, 'POST', '/shares/redeem', body)).body.error.code, 'share-link-unavailable');
  assert.equal((await call(handler, 'POST', '/shares/redeem', { token }, auth)).body.error.code, 'share-link-unavailable');
  const oversized = await call(handler, 'POST', '/shares/redeem', { token: 'x'.repeat(513) }); assert.equal(oversized.status, 413); assert.equal(oversized.reads(), 0); assert.equal(redeemed, 1);
});

test('anonymous redemption admission is eight active requests and rate accounting is peer/global bounded', async () => {
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  const handler = createRevisionHttpHandler({ service: { ...base(), redeemShareLink: async () => { entered++; await gate; return shared(); } } });
  const pending = Array.from({ length: 8 }, () => call(handler, 'POST', '/shares/redeem', { token }));
  for (let i = 0; i < 100 && entered < 8; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, 8);
  const rejected = await call(handler, 'POST', '/shares/redeem', { token }); assert.equal(rejected.status, 503); assert.equal(rejected.reads(), 0);
  release(); assert((await Promise.all(pending)).every(value => value.status === 200)); assert.equal((await call(handler, 'POST', '/shares/redeem', { token })).status, 200);
  let now = 0; const limit = createShareRedeemLimiter({ now: () => now });
  for (let peer = 0; peer < 6; peer++) for (let i = 0; i < 20; i++) limit(`peer-${peer}`);
  assert.throws(() => limit('new-peer'), { code: 'rate-limit-exceeded' }); now = 60000; limit('new-peer');
  for (let i = 0; i < 19; i++) limit('new-peer'); assert.throws(() => limit('new-peer'), { code: 'rate-limit-exceeded' });
});

test('public viewer serves only bundled TLS assets with restrictive no-cache CSP and no reflection', async () => {
  const handler = createShareViewerHandler();
  for (const route of ['/share', '/share/viewer.js', '/share/viewer.css', '/share/fonts/400.woff2']) {
    const result = await call(handler, 'GET', route); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['referrer-policy'], 'no-referrer'); assert.match(result.headers['content-security-policy'], /default-src 'none'/); assert.doesNotMatch(result.headers['content-security-policy'], /unsafe-inline|https:/);
  }
  const bad = await call(handler, 'GET', `/share?token=${token}`); assert.equal(bad.status, 404); assert(!bad.bytes.toString().includes(token));
  const plain = incoming('GET', '/share'); plain.req.socket.encrypted = false; await handler(plain.req, plain.res); assert.equal(plain.result.status, 426);
});
