'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createKeyring } = require('../src/security-controls');
const { createAssetHttpHandler, isAssetRequest, MAX_JSON_REQUEST_BYTES, MAX_ASSET_BYTES, MAX_CHUNK_BYTES } = require('../src/asset-http-transport');
const { createAssetHttpClient } = require('../src/asset-http-client');
const { API_VERSION } = require('../src/project-api-contracts');

const owner = 'o'.repeat(43), viewer = 'v'.repeat(43), outsider = 'x'.repeat(43);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({ version: 1, algorithm: 'sha256', contentId: `sha256:${sha(bytes)}`, size: bytes.length, assetClass: 'original', mediaType: 'video/test' });
class Reply extends EventEmitter {
  constructor() { super(); this.headers = {}; this.destroyed = false; this.writableEnded = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
  writeHead(status, headers) { this.status = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); }
  end(bytes) { this.bytes = Buffer.from(bytes || ''); this.writableEnded = true; }
}
function request(method, url, body, token = owner, headers = {}, encrypted = true, pending = false) {
  const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = pending ? new PassThrough() : Readable.from(bytes === null ? [] : [bytes]);
  Object.assign(req, { method, url, socket: { encrypted }, complete: false, headers: {
    'x-api-version': API_VERSION, 'x-request-id': 'asset-test', authorization: `Bearer ${token}`,
    ...(bytes !== null ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': String(bytes.length) } : {}), ...headers
  } });
  req.rawHeaders = Object.entries(req.headers).flat(); req.once('end', () => { req.complete = true; }); return req;
}
async function invoke(handler, method, url, body, token, headers, encrypted) {
  const req = request(method, url, body, token, headers, encrypted), res = new Reply(); await handler(req, res);
  return { status: res.status, headers: res.headers, bytes: res.bytes, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(res.bytes) : null };
}
async function fixture(t, { enable = true, ownerHelper = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-asset-http-')), revoked = new Set();
  const authorize = async (ctx, pid, action) => {
    if (pid !== 'film' || revoked.has(ctx.accessToken) || ctx.accessToken !== owner && !(ctx.accessToken === viewer && action === 'read')) {
      throw Object.assign(new Error('/private/auth-secret'), { code: 'forbidden' });
    }
    return { allowed: true };
  };
  const authorizePolicy = async ctx => {
    if (ctx.accessToken !== owner || revoked.has(owner)) throw Object.assign(new Error('private'), { code: 'asset-policy-forbidden' });
    return { allowed: true, actorId: 'owner-id' };
  };
  const assets = await createDurableAssetService({ directory, keyring: createKeyring({ fixture: randomBytes(32) }, 'fixture'), authorize,
    authorizePolicy, initialize: true, chunkSize: 4 });
  if (enable) await assets.setPolicy({ accessToken: owner }, 'film', { expectedVersion: 0, syncClasses: ['original'] });
  t.after(async () => { await assets.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const handler = createAssetHttpHandler({ assets, authorize, authorizePolicy: ownerHelper ? authorizePolicy : null, signingKey: randomBytes(32) });
  const call = (...args) => invoke(handler, ...args);
  const client = token => createAssetHttpClient({ origin: 'https://fixture.example.test', getAccessToken: () => token,
    fetch: async (url, options) => {
      const parsed = new URL(url), result = await call(options.method, `${parsed.pathname}${parsed.search}`,
        options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : JSON.parse(options.body), token, options.headers);
      return new Response(result.bytes, { status: result.status, headers: result.headers });
    } });
  return { handler, call, client, revoked, assets, authorize, authorizePolicy };
}

test('asset protocol round trip preserves out-of-order status, complete publication and verified viewer bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('abcdefghij'), api = f.client(owner), read = f.client(viewer);
  const upload = await api.beginUpload('film', identity(bytes)); assert.deepEqual(upload.received, [false, false, false]);
  await api.putChunk('film', upload.uploadId, 1, bytes.subarray(4, 8), sha(bytes.subarray(4, 8)));
  assert.deepEqual((await api.uploadStatus('film', upload.uploadId)).received, [false, true, false]);
  await api.putChunk('film', upload.uploadId, 0, bytes.subarray(0, 4), sha(bytes.subarray(0, 4)));
  await api.putChunk('film', upload.uploadId, 2, bytes.subarray(8), sha(bytes.subarray(8)));
  const complete = await api.completeUpload('film', upload.uploadId); assert.equal(complete.verified, true);
  assert.equal((await read.getAsset('film', complete.assetId)).identity.contentId, identity(bytes).contentId);
  const downloaded = []; for (let i = 0; i < 3; i++) downloaded.push((await read.readChunk('film', complete.assetId, i)).bytes);
  assert.deepEqual(Buffer.concat(downloaded), bytes);
  await assert.rejects(read.beginUpload('film', identity(bytes)), { code: 'forbidden' });
  await assert.rejects(f.client(outsider).getAsset('film', complete.assetId), { code: 'forbidden' });
});

test('empty assets require a verified empty chunk and explicit completion', async t => {
  const f = await fixture(t), api = f.client(owner), bytes = Buffer.alloc(0), upload = await api.beginUpload('film', identity(bytes));
  assert.equal(upload.chunks, 1); await api.putChunk('film', upload.uploadId, 0, bytes, sha(bytes));
  assert.equal((await api.uploadStatus('film', upload.uploadId)).complete, false);
  const done = await api.completeUpload('film', upload.uploadId); assert.deepEqual((await api.readChunk('film', done.assetId, 0)).bytes, bytes);
});

test('tickets are project/resource/index/method/expiry bound and redemption requires live membership', async t => {
  const f = await fixture(t), bytes = Buffer.from('abcd'), api = f.client(owner), uploaded = await api.beginUpload('film', identity(bytes));
  const result = await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: uploaded.uploadId, index: 0 });
  assert.equal(result.status, 200); const ticket = result.json.data;
  for (const changed of [ticket.path.replace('/film/', '/other/'), ticket.path.replace('/chunks/0?', '/chunks/1?'),
    `${ticket.path}&extra=1`, ticket.path.replace(/signature=./, match => `${match.slice(0, -1)}${match.endsWith('a') ? 'b' : 'a'}`),
    ticket.path.replace(/expires=([0-9]+)/, (_all, value) => `expires=${Number(value) - 1}`)]) {
    assert.notEqual((await f.call('PUT', changed, bytes, owner, { 'x-chunk-sha256': sha(bytes) })).status, 200);
  }
  assert.notEqual((await f.call('GET', ticket.path)).status, 200);
  f.revoked.add(owner);
  assert.equal((await f.call('PUT', ticket.path, bytes, owner, { 'x-chunk-sha256': sha(bytes) })).status, 403);
  f.revoked.delete(owner);
  t.mock.method(Date, 'now', () => ticket.expiresAt + 1);
  assert.equal((await f.call('PUT', ticket.path, bytes, owner, { 'x-chunk-sha256': sha(bytes) })).json.error.code, 'asset-ticket-invalid');
});

test('ticket issuance checks authorized object existence and index bounds', async t => {
  const f = await fixture(t), bytes = Buffer.from('abcd'), up = await f.client(owner).beginUpload('film', identity(bytes));
  assert.equal((await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: up.uploadId, index: 1 })).json.error.code, 'asset-chunk-invalid');
  assert.equal((await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: 'missing', index: 0 })).status, 404);
  assert.equal((await f.call('POST', '/projects/film/assets/tickets', { method: 'GET', assetId: identity(bytes).contentId, index: 0 }, viewer)).status, 404);
  assert.equal((await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: up.uploadId, index: 0 }, viewer)).status, 403);
});

test('TLS, Origin, encoded traversal, duplicate headers, body caps and checksum rejection fail closed', async t => {
  const f = await fixture(t), bytes = Buffer.from('abcd'), upload = await f.client(owner).beginUpload('film', identity(bytes));
  assert.equal((await f.call('GET', '/projects/film/assets/uploads/missing', undefined, owner, {}, false)).status, 426);
  assert.equal((await f.call('GET', '/projects/film/assets/uploads/missing', undefined, owner, { origin: 'https://other.test' })).status, 403);
  assert.equal((await f.call('GET', '/projects/film/assets/%2e%2e')).status, 400);
  assert.equal((await f.call('POST', '/projects/film/assets/uploads', { identity: identity(bytes), privatePath: '/private/source' })).status, 400);
  assert.equal((await f.call('POST', '/projects/film/assets/uploads', undefined, owner,
    { 'content-type': 'application/json', 'content-length': String(MAX_JSON_REQUEST_BYTES + 1) })).status, 413);
  const req = request('GET', `/projects/film/assets/uploads/${upload.uploadId}`), res = new Reply();
  req.rawHeaders.push('Authorization', `Bearer ${owner}`); await f.handler(req, res); assert.equal(res.status, 400);
  const ticket = (await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: upload.uploadId, index: 0 })).json.data.path;
  const duplicate = request('PUT', ticket, bytes, owner, { 'x-chunk-sha256': sha(bytes) }), duplicateReply = new Reply();
  duplicate.rawHeaders.push('X-Chunk-Sha256', sha(bytes)); await f.handler(duplicate, duplicateReply); assert.equal(duplicateReply.status, 400);
  assert.equal((await f.call('PUT', ticket, bytes, owner, { 'x-chunk-sha256': '0'.repeat(64) })).status, 400);
  assert.equal((await f.call('PUT', ticket, Buffer.from('abcde'), owner, { 'x-chunk-sha256': sha(Buffer.from('abcde')) })).status, 413);
  assert.deepEqual((await f.client(owner).uploadStatus('film', upload.uploadId)).received, [false]);
  assert(isAssetRequest({ url: '/projects/film/assets/invalid?query' })); assert(!isAssetRequest({ url: '/projects/film/revisions' }));
});

test('the maximum 65536-chunk received bitmap fits the bounded metadata response', async () => {
  const value = { uploadId: 'largest', assetId: `sha256:${'a'.repeat(64)}`, size: MAX_ASSET_BYTES, chunkSize: MAX_CHUNK_BYTES,
    chunks: 65536, received: Array(65536).fill(false), complete: false };
  const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'completeUpload', 'getAsset', 'readChunk'].map(name => [name, async () => value]));
  const handler = createAssetHttpHandler({ assets, authorize: async () => true, signingKey: randomBytes(32) });
  const result = await invoke(handler, 'POST', '/projects/film/assets/uploads', { identity: { ...identity(Buffer.alloc(0)), size: MAX_ASSET_BYTES, contentId: value.assetId } });
  assert.equal(result.status, 200); assert.equal(result.json.data.received.length, 65536); await handler.close();
});

test('eight pending bodies cap admission and abort releases permits without authorizing storage mutations', async () => {
  let calls = 0;
  const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'completeUpload', 'getAsset', 'readChunk'].map(name => [name, async () => { calls++; throw new Error('must not run'); }]));
  const handler = createAssetHttpHandler({ assets, authorize: async () => true, signingKey: randomBytes(32) });
  const pending = [];
  for (let i = 0; i < 8; i++) {
    const req = request('POST', '/projects/film/assets/uploads', undefined, owner, { 'content-type': 'application/json' }, true, true), res = new Reply();
    pending.push({ req, res, task: handler(req, res) });
  }
  const rejected = await invoke(handler, 'POST', '/projects/film/assets/uploads', { identity: identity(Buffer.alloc(0)) });
  assert.equal(rejected.status, 503);
  for (const item of pending) { item.req.emit('aborted'); item.req.end(); } await Promise.all(pending.map(item => item.task));
  assert.equal(calls, 0);
  const after = await invoke(handler, 'POST', '/projects/film/assets/uploads', {}); assert.equal(after.status, 400);
});

const completed = { assetId: `sha256:${'a'.repeat(64)}`, size: 4, chunkSize: 4, chunks: 1, verified: true };
function verificationFixture() {
  const pending = [], calls = { status: 0 }; let permitted = true;
  const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'getAsset', 'readChunk'].map(name => [name, async () => { calls.status++; throw new Error('pending verification must not query asset store'); }]));
  assets.completeUpload = (_ctx, _pid, uid, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('asset-cancelled'), { code: 'asset-cancelled' })), { once: true });
    pending.push({ uid, signal, resolve });
  });
  const handler = createAssetHttpHandler({ assets, authorize: async () => permitted, signingKey: randomBytes(32) });
  return { handler, pending, calls, allow(value) { permitted = value; }, call: (...args) => invoke(handler, ...args) };
}

test('completion polling is nonblocking, independent of response lifetime and reauthorizes every poll', async () => {
  const f = verificationFixture(), route = '/projects/film/assets/uploads/slow/complete';
  const first = await f.call('POST', route, {}); assert.equal(first.status, 202); assert.deepEqual(first.json.data, { uploadId: 'slow', status: 'verifying' });
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].signal.aborted, false);
  assert.equal((await f.call('POST', route, {})).status, 202); assert.equal(f.pending.length, 1); assert.equal(f.calls.status, 0);
  f.allow(false); assert.equal((await f.call('POST', route, {})).status, 403);
  f.pending[0].resolve(completed); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.call('POST', route, {})).status, 403);
  f.allow(true); assert.deepEqual((await f.call('POST', route, {})).json.data, completed); await f.handler.close();
});

test('verification jobs are capped, explicitly cancellable, drained on close and restartable from the store', async () => {
  const f = verificationFixture();
  for (let i = 0; i < 8; i++) assert.equal((await f.call('POST', `/projects/film/assets/uploads/job-${i}/complete`, {})).status, 202);
  assert.equal((await f.call('POST', '/projects/film/assets/uploads/job-8/complete', {})).status, 503);
  const cancelled = await f.call('DELETE', '/projects/film/assets/uploads/job-0/complete');
  assert.deepEqual(cancelled.json.data, { uploadId: 'job-0', cancelled: true });
  assert.equal((await f.call('DELETE', '/projects/film/assets/uploads/job-0/complete')).json.data.cancelled, false);
  assert.equal((await f.call('POST', '/projects/film/assets/uploads/job-8/complete', {})).status, 202);
  await f.handler.close(); assert(f.pending.every(item => item.signal.aborted));
  assert.equal((await f.call('POST', '/projects/film/assets/uploads/job-0/complete', {})).status, 503);
  const reopened = verificationFixture(); assert.equal((await reopened.call('POST', '/projects/film/assets/uploads/job-0/complete', {})).status, 202);
  await reopened.handler.close();
});

test('settled verification receipts retain at most 128 entries and failures reveal only allowed codes', async () => {
  let calls = 0;
  const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'getAsset', 'readChunk'].map(name => [name, async () => { throw new Error('unused'); }]));
  assets.completeUpload = async (_ctx, _pid, uid) => { calls++; if (uid === 'private') throw Object.assign(new Error('/private/token'), { code: '/private/token' }); return completed; };
  const handler = createAssetHttpHandler({ assets, authorize: async () => true, signingKey: randomBytes(32) });
  for (let i = 0; i < 130; i++) { await invoke(handler, 'POST', `/projects/film/assets/uploads/job-${i}/complete`, {}); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(calls, 130); assert.equal((await invoke(handler, 'POST', '/projects/film/assets/uploads/job-129/complete', {})).status, 200);
  assert.equal((await invoke(handler, 'POST', '/projects/film/assets/uploads/job-0/complete', {})).status, 202);
  await invoke(handler, 'POST', '/projects/film/assets/uploads/private/complete', {}); await new Promise(resolve => setImmediate(resolve));
  const failure = await invoke(handler, 'POST', '/projects/film/assets/uploads/private/complete', {});
  assert.equal(failure.json.error.code, 'service-unavailable'); assert.doesNotMatch(failure.bytes.toString(), /private|token/); await handler.close();
});

test('long verification renews its credential only through live same-actor authorization', async t => {
  for (const scenario of ['same actor', 'different actor', 'removed actor', 'initial authorizer has no actor ID']) await t.test(scenario, async () => {
    const fresh = 'n'.repeat(43), other = 's'.repeat(43), expired = new Set(), removed = new Set();
    let first = true, context, release;
    const gate = new Promise(resolve => { release = resolve; });
    const actors = new Map([[owner, 'owner-id'], [fresh, 'owner-id'], [other, 'other-id']]);
    const authorize = async ctx => {
      const actorId = actors.get(ctx.accessToken);
      if (!actorId || expired.has(ctx.accessToken)) throw Object.assign(new Error('private'), { code: 'access-token-invalid' });
      if (removed.has(actorId)) throw Object.assign(new Error('private'), { code: 'forbidden' });
      if (scenario === 'initial authorizer has no actor ID' && first) return { allowed: true };
      return { allowed: true, actorId };
    };
    const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'getAsset', 'readChunk'].map(name => [name, async () => { throw new Error('unused'); }]));
    assets.completeUpload = async captured => { context = captured; await gate; await authorize(captured); return completed; };
    const handler = createAssetHttpHandler({ assets, authorize, signingKey: randomBytes(32) }), route = '/projects/film/assets/uploads/renewable/complete';
    assert.equal((await invoke(handler, 'POST', route, {})).status, 202); first = false;
    const originalContext = context; expired.add(owner);
    if (scenario === 'removed actor') removed.add('owner-id');
    const token = scenario === 'different actor' ? other : fresh;
    const poll = await invoke(handler, 'POST', route, {}, token);
    assert.equal(poll.status, scenario === 'removed actor' ? 403 : 202);
    assert.equal(context, originalContext); assert.equal(context.accessToken, scenario === 'same actor' ? fresh : owner);
    release(); await new Promise(resolve => setImmediate(resolve));
    const finalToken = scenario === 'removed actor' ? other : token;
    const result = await invoke(handler, 'POST', route, {}, finalToken);
    assert.equal(result.status, scenario === 'same actor' ? 200 : 401); await handler.close();
  });
});

test('a chunk request disconnected while queued for status never waits for missed body events', async t => {
  for (const mode of ['destroyed', 'aborted']) await t.test(mode, async () => {
    const bytes = Buffer.from('abcd'), value = { uploadId: 'queued', assetId: identity(bytes).contentId,
      size: 4, chunkSize: 4, chunks: 1, received: [false], complete: false };
    let blocked = false, release, entered, writes = 0;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const assets = Object.fromEntries(['beginUpload', 'completeUpload', 'getAsset', 'readChunk'].map(name => [name, async () => { throw new Error('unused'); }]));
    assets.uploadStatus = async () => { if (blocked) { entered(); await gate; } return value; };
    assets.assertUploadAllowed = async () => ({ allowed: true });
    assets.putChunk = async () => { writes++; throw new Error('aborted body must not be written'); };
    const handler = createAssetHttpHandler({ assets, authorize: async () => true, signingKey: randomBytes(32) });
    const issued = await invoke(handler, 'POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: value.uploadId, index: 0 });
    blocked = true;
    const req = request('PUT', issued.json.data.path, undefined, owner, { 'content-type': 'application/octet-stream',
      'content-length': '4', 'x-chunk-sha256': sha(bytes) }, true, true), res = new Reply();
    const task = handler(req, res); await waiting;
    if (mode === 'destroyed') req.destroy(); else { req.aborted = true; req.emit('aborted'); }
    release();
    let timer;
    try { await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('queued request did not drain')), 200); })]); }
    finally { clearTimeout(timer); req.destroy(); await handler.close(); }
    assert.equal(writes, 0); assert([400, 409].includes(res.status));
  });
});

test('an already-ended empty GET remains valid even after normal stream auto-destruction', async () => {
  const bytes = Buffer.from('abcd'), meta = { assetId: identity(bytes).contentId, size: 4, chunkSize: 4, chunks: 1, identity: identity(bytes) };
  const assets = Object.fromEntries(['beginUpload', 'uploadStatus', 'putChunk', 'completeUpload', 'readChunk'].map(name => [name, async () => { throw new Error('unused'); }]));
  assets.getAsset = async () => meta;
  const handler = createAssetHttpHandler({ assets, authorize: async () => true, signingKey: randomBytes(32) });
  const req = request('GET', `/projects/film/assets/${encodeURIComponent(meta.assetId)}`), res = new Reply();
  const ended = new Promise(resolve => req.once('end', resolve)); req.resume(); await ended; await new Promise(resolve => setImmediate(resolve));
  assert.equal(req.readableEnded, true); await handler(req, res); assert.equal(res.status, 200);
  const consumed = request('POST', '/projects/film/assets/uploads', { identity: identity(bytes) }), rejected = new Reply();
  const consumedEnd = new Promise(resolve => consumed.once('end', resolve)); consumed.resume(); await consumedEnd;
  await handler(consumed, rejected); assert.equal(rejected.status, 400); await handler.close();
});

test('project policy defaults to none, owner CAS enables classes, and read metadata remains member scoped', async t => {
  const f = await fixture(t, { enable: false }), api = f.client(owner), read = f.client(viewer), bytes = Buffer.from('abcd');
  assert.deepEqual(await read.getPolicy('film'), { projectId: 'film', version: 0, syncClasses: [] });
  assert.equal((await read.getUsage('film')).logicalBytes, 0);
  await assert.rejects(api.beginUpload('film', identity(bytes)), { code: 'asset-policy-excluded' });
  await assert.rejects(read.setPolicy('film', { expectedVersion: 0, syncClasses: ['original'] }), { code: 'asset-policy-forbidden' });
  assert.deepEqual(await api.setPolicy('film', { expectedVersion: 0, syncClasses: ['original'] }), { projectId: 'film', version: 1, syncClasses: ['original'] });
  await assert.rejects(api.setPolicy('film', { expectedVersion: 0, syncClasses: [] }), { code: 'asset-policy-version-conflict' });
  for (const method of ['getPolicy', 'getUsage']) await assert.rejects(f.client(outsider)[method]('film'), { code: 'forbidden' });
  const absent = await read.getAvailability('film', identity(bytes).contentId);
  assert.deepEqual(absent, { projectId: 'film', assetId: identity(bytes).contentId, cloudPresent: false, excluded: false, archived: false, assetClass: null, size: null });
});

test('archive and class exclusion block old and new binary tickets while retaining historical metadata and receipts', async t => {
  const f = await fixture(t), api = f.client(owner), read = f.client(viewer), bytes = Buffer.from('abcd');
  const upload = await api.beginUpload('film', identity(bytes)); await api.putChunk('film', upload.uploadId, 0, bytes, sha(bytes));
  await api.completeUpload('film', upload.uploadId);
  const issued = await f.call('POST', '/projects/film/assets/tickets', { method: 'GET', assetId: upload.assetId, index: 0 }, viewer);
  await assert.rejects(read.setArchived('film', upload.assetId, { expectedArchived: false, archived: true }), { code: 'asset-policy-forbidden' });
  const archived = await api.setArchived('film', upload.assetId, { expectedArchived: false, archived: true }); assert.equal(archived.archived, true);
  await assert.rejects(api.setArchived('film', upload.assetId, { expectedArchived: false, archived: false }), { code: 'asset-archive-conflict' });
  assert.equal((await read.getAsset('film', upload.assetId)).assetId, upload.assetId);
  assert.equal((await f.call('GET', issued.json.data.path, undefined, viewer)).json.error.code, 'asset-archived');
  await assert.rejects(read.readChunk('film', upload.assetId, 0), { code: 'asset-archived' });
  await api.setArchived('film', upload.assetId, { expectedArchived: true, archived: false });
  assert.deepEqual((await read.readChunk('film', upload.assetId, 0)).bytes, bytes);
  await api.setPolicy('film', { expectedVersion: 1, syncClasses: [] });
  const usage = await read.getUsage('film'); assert.equal(usage.excludedBytes, 4); assert.equal(usage.availableBytes, 0); assert.equal(usage.logicalBytes, 4);
  assert.equal((await read.getAvailability('film', upload.assetId)).excluded, true);
  await assert.rejects(read.readChunk('film', upload.assetId, 0), { code: 'asset-policy-excluded' });
  assert.equal((await api.completeUpload('film', upload.uploadId)).verified, true);
  const fresh = createAssetHttpHandler({ assets: f.assets, authorize: f.authorize, authorizePolicy: f.authorizePolicy, signingKey: randomBytes(32) });
  t.after(() => fresh.close());
  const route = `/projects/film/assets/uploads/${upload.uploadId}/complete`;
  assert.equal((await invoke(fresh, 'POST', route, {})).status, 202);
  const deadline = Date.now() + 3000; let result;
  do {
    result = await invoke(fresh, 'POST', route, {});
    if (result.status !== 202) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  } while (Date.now() < deadline);
  assert.equal(result.status, 200); assert.equal(result.json.data.verified, true);
});

test('a policy change blocks a previously issued PUT ticket before reading any chunk bytes', async t => {
  const f = await fixture(t), api = f.client(owner), bytes = Buffer.from('abcdefgh'), upload = await api.beginUpload('film', identity(bytes));
  await api.putChunk('film', upload.uploadId, 0, bytes.subarray(0, 4), sha(bytes.subarray(0, 4)));
  const issued = await f.call('POST', '/projects/film/assets/tickets', { method: 'PUT', uploadId: upload.uploadId, index: 1 });
  await api.setPolicy('film', { expectedVersion: 1, syncClasses: [] });
  const req = request('PUT', issued.json.data.path, undefined, owner, { 'content-type': 'application/octet-stream', 'content-length': '4', 'x-chunk-sha256': sha(bytes.subarray(4)) }, true, true), res = new Reply();
  await f.handler(req, res); req.destroy(); assert.equal(JSON.parse(res.bytes).error.code, 'asset-policy-excluded');
  assert.deepEqual((await api.uploadStatus('film', upload.uploadId)).received, [true, false]);
});

test('owner writes fail closed when the HTTP owner helper is absent', async t => {
  const f = await fixture(t, { enable: false, ownerHelper: false });
  await assert.rejects(f.client(owner).setPolicy('film', { expectedVersion: 0, syncClasses: ['original'] }), { code: 'asset-policy-forbidden' });
  assert.equal((await f.assets.getPolicy({ accessToken: owner }, 'film')).version, 0);
});
