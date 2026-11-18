'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { inspectAssetFile, uploadAssetFile, downloadAssetFile } = require('../src/asset-file-transfer');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { createKeyring } = require('../src/security-controls');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, bytes = Buffer.from('abcdefghij')) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-file-transfer-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); const filename = path.join(root, 'source.mov'); await fs.writeFile(filename, bytes);
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  const store = await createDurableAssetService({ directory: path.join(root, 'service'), keyring, authorize: async () => ({ allowed: true }), initialize: true, chunkSize: 4 }); t.after(() => store.close());
  const calls = { put: [], read: [], cancel: 0 }; const client = Object.fromEntries(['beginUpload', 'uploadStatus', 'completeUpload', 'getAsset'].map(name => [name, (...args) => store[name]({}, ...args)]));
  client.putChunk = (...args) => { calls.put.push(args[2]); return store.putChunk({}, ...args); };
  client.readChunk = (...args) => { calls.read.push(args[2]); return store.readChunk({}, ...args); };
  client.cancelVerification = async () => { calls.cancel++; return { cancelled: true }; };
  return { root, filename, bytes, store, client, calls, identity: (await inspectAssetFile(filename)).identity,
    destination: path.join(root, 'download.mov'), workDirectory: path.join(root, 'download-work') };
}

test('inspect and real filesystem upload stream exact identities and path-free progress/receipt', async t => {
  const f = await fixture(t); const progress = [];
  const result = await uploadAssetFile({ ...f, projectId: 'film', onProgress: value => progress.push(value) });
  assert.deepEqual(result, { assetId: f.identity.contentId, size: f.bytes.length, chunkSize: 4, chunks: 3, verified: true });
  assert.deepEqual(f.calls.put, [0, 1, 2]);
  assert.ok(progress.some(value => value.phase === 'hashing')); assert.ok(progress.some(value => value.phase === 'uploading')); assert.ok(progress.some(value => value.phase === 'verifying'));
  assert.ok(progress.every(value => Object.keys(value).sort().join('|') === 'bytes|phase|totalBytes' && value.bytes >= 0
    && (value.totalBytes === null ? value.phase === 'verifying' && value.bytes === 0 : value.bytes <= value.totalBytes)));
  assert.doesNotMatch(JSON.stringify({ result, progress }), /source\.mov|download-work|frameline-file-transfer/);
});

test('upload cancellation resumes only missing durable server chunks after rehashing the source', async t => {
  const f = await fixture(t); const controller = new AbortController();
  await assert.rejects(uploadAssetFile({ ...f, projectId: 'film', signal: controller.signal, onProgress(value) {
    if (value.phase === 'uploading' && value.bytes === 4) controller.abort();
  } }), { code: 'asset-cancelled' });
  assert.deepEqual(f.calls.put, [0]); const begin = await f.client.beginUpload('film', f.identity); assert.deepEqual(begin.received, [true, false, false]);
  const resumed = await uploadAssetFile({ ...f, projectId: 'film' }); assert.equal(resumed.verified, true); assert.deepEqual(f.calls.put, [0, 1, 2]);
});

test('changed, replaced and symbolic-link sources never complete under the reviewed identity', async t => {
  const f = await fixture(t); await fs.writeFile(f.filename, Buffer.from('different!'));
  await assert.rejects(uploadAssetFile({ ...f, projectId: 'film' }), { code: 'asset-identity-mismatch' }); assert.deepEqual(f.calls.put, []);
  await fs.writeFile(f.filename, f.bytes); const linked = path.join(f.root, 'source-link.mov'); await fs.symlink(f.filename, linked);
  await assert.rejects(inspectAssetFile(linked), { code: 'asset-file-invalid' });
  const original = f.client.putChunk; f.client.putChunk = async (...args) => {
    const result = await original(...args); await fs.rename(f.filename, path.join(f.root, 'old-source.mov')); await fs.writeFile(f.filename, f.bytes); return result;
  };
  await assert.rejects(uploadAssetFile({ ...f, projectId: 'film' }), { code: 'asset-source-changed' });
  assert.equal((await f.client.beginUpload('film', f.identity)).complete, false);
});

test('inspection catches mutation during hashing and callback errors expose only allowlisted codes', async t => {
  const f = await fixture(t, Buffer.alloc(1024 * 1024 + 1, 7)); let changed = false;
  await assert.rejects(inspectAssetFile(f.filename, { async onProgress(value) {
    if (!changed && value.bytes > 0) { changed = true; await fs.writeFile(f.filename, Buffer.alloc(f.bytes.length, 8)); }
  } }), { code: 'asset-source-changed' });
  await assert.rejects(inspectAssetFile(f.filename, { onProgress() { throw Object.assign(new Error('/Users/private Bearer token'), { code: '/Users/private' }); } }),
    error => error.code === 'asset-progress-failed' && error.message === error.code);
});

test('cancellation during remote verification attempts explicit cancellation without claiming to undo publication', async t => {
  const f = await fixture(t); const controller = new AbortController(); const complete = f.client.completeUpload;
  f.client.completeUpload = async (_projectId, _uploadId, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'asset-cancelled' })), { once: true }); setImmediate(() => controller.abort());
  });
  await assert.rejects(uploadAssetFile({ ...f, projectId: 'film', signal: controller.signal }), { code: 'asset-cancelled' }); assert.equal(f.calls.cancel, 1);
  f.client.completeUpload = complete; assert.equal((await uploadAssetFile({ ...f, projectId: 'film' })).verified, true);
});

test('download cancellation resumes verified private chunks and publishes exact bytes without overwriting', async t => {
  const f = await fixture(t); await uploadAssetFile({ ...f, projectId: 'film' }); const controller = new AbortController();
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId, signal: controller.signal, onProgress(value) {
    if (value.phase === 'downloading' && value.bytes === 4) controller.abort();
  } }), { code: 'asset-cancelled' });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' }); assert.deepEqual(f.calls.read, [0]);
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.workDirectory, 'checkpoint.json'))); assert.equal(checkpoint.hashes[0], sha(f.bytes.subarray(0, 4)));
  const result = await downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId });
  assert.deepEqual(result, { assetId: f.identity.contentId, size: f.bytes.length, verified: true, alreadyPresent: false });
  assert.deepEqual(await fs.readFile(f.destination), f.bytes); assert.deepEqual(f.calls.read, [0, 1, 2]);
  assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.workDirectory, 'checkpoint.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.workDirectory, 'chunk-0.bin'))).mode & 0o777, 0o600);
  assert.equal((await downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId })).alreadyPresent, true); assert.deepEqual(f.calls.read, [0, 1, 2]);
});

test('checkpoint bindings, private permissions and tampered cached bytes fail closed before reuse', async t => {
  const f = await fixture(t); await uploadAssetFile({ ...f, projectId: 'film' }); const controller = new AbortController();
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId, signal: controller.signal,
    onProgress(value) { if (value.phase === 'downloading' && value.bytes === 4) controller.abort(); } }), { code: 'asset-cancelled' });
  const filename = path.join(f.workDirectory, 'checkpoint.json'); const original = await fs.readFile(filename); const checkpoint = JSON.parse(original);
  for (const changed of [{ ...checkpoint, projectId: 'other' }, { ...checkpoint, chunkSize: 8 }, { ...checkpoint, filename: '/Users/private' }]) {
    await fs.writeFile(filename, JSON.stringify(changed)); await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-checkpoint-invalid' });
  }
  await fs.writeFile(filename, original); await fs.chmod(filename, 0o644);
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-checkpoint-invalid' }); await fs.chmod(filename, 0o600);
  await fs.writeFile(path.join(f.workDirectory, 'chunk-0.bin'), 'evil');
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-cache-corrupt' }); assert.deepEqual(f.calls.read, [0]);
});

test('destination collisions and symlinks are preserved, including a race immediately before publication', async t => {
  const f = await fixture(t); await uploadAssetFile({ ...f, projectId: 'film' }); await fs.writeFile(f.destination, 'existing user bytes');
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-destination-exists' }); assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing user bytes');
  await fs.unlink(f.destination); await fs.symlink(f.filename, f.destination);
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-destination-exists' }); assert.equal((await fs.lstat(f.destination)).isSymbolicLink(), true);
  await fs.unlink(f.destination);
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId, async onProgress(value) {
    if (value.phase === 'verifying') await fs.writeFile(f.destination, 'racing user bytes', { flag: 'wx' });
  } }), { code: 'asset-destination-exists' }); assert.equal(await fs.readFile(f.destination, 'utf8'), 'racing user bytes');
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.frameline-asset-')), false);
});

test('valid per-chunk checksums cannot substitute for a wrong full-file asset hash', async t => {
  const f = await fixture(t); const forged = Buffer.from('xxxxxxxxxx');
  f.client.getAsset = async () => ({ assetId: f.identity.contentId, size: 10, chunkSize: 4, chunks: 3, identity: f.identity });
  f.client.readChunk = async (_pid, _aid, index) => { const bytes = forged.subarray(index * 4, index * 4 + 4); return { bytes, checksum: sha(bytes), chunks: 3, totalBytes: 10 }; };
  await assert.rejects(downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }), { code: 'asset-identity-mismatch' });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('rate limits pace real transfers, remain cancellable and reject invalid configuration', async t => {
  const f = await fixture(t, Buffer.alloc(128, 7)); const started = Date.now();
  await uploadAssetFile({ ...f, projectId: 'film', maxBytesPerSecond: 1024 }); assert.ok(Date.now() - started >= 120);
  await assert.rejects(uploadAssetFile({ ...f, projectId: 'film', maxBytesPerSecond: 1 }), { code: 'asset-rate-invalid' });
  const controller = new AbortController(); const pending = downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId, maxBytesPerSecond: 1024, signal: controller.signal,
    onProgress(value) { if (value.phase === 'downloading' && value.bytes === 0) setImmediate(() => controller.abort()); } });
  await assert.rejects(pending, { code: 'asset-cancelled' }); await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('empty files upload, download and verify without weakening exclusive publication', async t => {
  const f = await fixture(t, Buffer.alloc(0)); await uploadAssetFile({ ...f, projectId: 'film' });
  const result = await downloadAssetFile({ ...f, projectId: 'film', assetId: f.identity.contentId }); assert.equal(result.size, 0); assert.equal((await fs.stat(f.destination)).size, 0);
});

test('server whole-file verification stays indeterminate until a verified receipt is returned', async t => {
  const f = await fixture(t); const complete = f.client.completeUpload; const progress = []; let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.client.completeUpload = async (...args) => { entered(); await new Promise(resolve => { finish = resolve; }); return complete(...args); };
  const pending = uploadAssetFile({ ...f, projectId: 'film', onProgress: value => progress.push(value) }); await waiting;
  assert.deepEqual(progress.at(-1), { phase: 'verifying', bytes: 0, totalBytes: null });
  assert.equal(progress.some(value => value.phase === 'verifying' && value.totalBytes !== null), false);
  finish(); assert.equal((await pending).verified, true);
  assert.deepEqual(progress.at(-1), { phase: 'verifying', bytes: f.bytes.length, totalBytes: f.bytes.length });
});
