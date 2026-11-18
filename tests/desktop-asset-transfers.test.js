'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { createDesktopAssetTransfers, safeAssetTransferError } = require('../src/desktop-asset-transfers');
const { fingerprint } = require('../src/project-api-contracts');
const fileEngine = require('../src/asset-file-transfer');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createKeyring } = require('../src/security-controls');

const fail = code => Object.assign(new Error('/private/access-token-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bytes = Buffer.from('disposable media');
const identity = { version: 1, algorithm: 'sha256', contentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  size: bytes.length, assetClass: 'original', mediaType: null };
function abortable(signal) { return new Promise((_resolve, reject) => {
  if (signal.aborted) { reject(fail('asset-cancelled')); return; }
  signal.addEventListener('abort', () => reject(fail('asset-cancelled')), { once: true });
}); }
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-desktop-assets-'))), directory = path.join(parent, 'transfers');
  const source = path.join(parent, 'source.bin'); await fs.writeFile(source, bytes, { mode: 0o600 });
  const state = { status: 'connected', connected: true, origin: 'https://service.example.test', account: { id: 'owner', email: 'owner@example.test' },
    projects: [{ id: 'remote', name: 'Remote film', role: 'editor', branches: ['main', 'review'] }] };
  const selection = { originHash: fingerprint(state.origin), accountId: 'owner', localProjectId: 'local', localBranch: 'main', remoteProjectId: 'remote', remoteBranch: 'main', role: 'editor' };
  const counters = { inspect: 0, upload: 0, download: 0, begin: 0, cancel: 0 }, events = [], controllers = [];
  const control = { holdInspect: false, holdUpload: false, failUpload: null, reused: false, started: deferred(), inspectStarted: deferred() };
  const client = {
    async getAsset() { if (!control.reused) throw fail('asset-not-found'); return { assetId: identity.contentId, identity }; },
    async beginUpload() { counters.begin++; return { uploadId: 'upload-fixture' }; },
    async cancelVerification() { counters.cancel++; return { uploadId: 'upload-fixture', cancelled: true }; }
  };
  const engine = {
    async inspectAssetFile(filename, { signal, onProgress, assetClass }) {
      counters.inspect++; assert.equal(filename, source); assert.equal(assetClass, 'original');
      await onProgress({ phase: 'hashing', bytes: 0, totalBytes: bytes.length }); control.inspectStarted.resolve();
      if (control.holdInspect) await abortable(signal);
      return { identity: structuredClone(identity) };
    },
    async uploadAssetFile({ client: api, projectId, filename, signal, onProgress, maxBytesPerSecond }) {
      counters.upload++; assert.equal(projectId, 'remote'); assert.equal(filename, source); assert(maxBytesPerSecond === null || maxBytesPerSecond >= 1024);
      await api.beginUpload(projectId, identity); await onProgress({ phase: 'uploading', bytes: bytes.length, totalBytes: bytes.length });
      await onProgress({ phase: 'verifying', bytes: 0, totalBytes: null }); control.started.resolve();
      if (control.holdUpload) try { await abortable(signal); } catch (problem) { await api.cancelVerification(projectId, 'upload-fixture'); throw problem; }
      if (control.failUpload) throw fail(control.failUpload);
      return { assetId: identity.contentId, size: bytes.length, chunkSize: 4, chunks: Math.ceil(bytes.length / 4), verified: true };
    },
    async downloadAssetFile({ destination, workDirectory, onProgress }) {
      counters.download++; assert((await fs.lstat(path.dirname(workDirectory))).isDirectory());
      await onProgress({ phase: 'downloading', bytes: bytes.length, totalBytes: bytes.length });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      return { assetId: identity.contentId, size: bytes.length, verified: true, alreadyPresent: false };
    }
  };
  const connection = { getState: () => structuredClone(state), getAssetClient: () => client };
  const make = (chosenEngine = engine) => { const value = createDesktopAssetTransfers({ directory, connection, getSelection: async () => structuredClone(selection),
    engine: chosenEngine, onChange: value => events.push(value) }); controllers.push(value); return value; };
  t.after(async () => { for (const value of controllers) await value.dispose(); await fs.rm(parent, { recursive: true, force: true }); });
  return { directory, parent, source, state, selection, counters, control, events, make, engine, client };
}
async function waitState(controller, predicate) {
  const deadline = Date.now() + 3000;
  while (true) { const value = await controller.getState(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('controller state did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const prepare = (value, f) => value.prepareUpload({ filename: f.source, name: 'source.bin', assetClass: 'original', maxBytesPerSecond: null });

test('preparation exposes a path-free hash review and sends no media before explicit confirmation', async t => {
  const f = await fixture(t), value = f.make(), reviewed = await prepare(value, f);
  assert.equal(reviewed.review.identity.contentId, identity.contentId); assert.equal(reviewed.review.estimatedUploadBytes, bytes.length);
  assert.equal(reviewed.review.reused, false); assert.equal(f.counters.upload, 0); assert.equal(f.counters.begin, 0);
  assert.doesNotMatch(JSON.stringify(reviewed), /\/private\/|\/var\/|filename|destination|sourcePath|access-token/);
  await value.confirmUpload(reviewed.review.id); const done = await waitState(value, state => !state.busy && state.jobs[0]?.status === 'completed');
  assert.equal(done.jobs[0].bytes, bytes.length); assert.equal(f.counters.upload, 1); assert(done.jobs[0].completedAt);
  const journal = path.join(f.directory, 'transfers.json'); assert.equal((await fs.stat(journal)).mode & 0o777, 0o600);
  const privateState = JSON.parse(await fs.readFile(journal)); assert.equal(privateState.jobs[0].filename, f.source);
  assert.doesNotMatch(JSON.stringify(f.events), /\/private\/|\/var\/|access-token-secret|"filename"|"destination"/);
});

test('clear review cancels and drains foreground hashing before a transfer job exists', async t => {
  const f = await fixture(t), value = f.make(); f.control.holdInspect = true;
  const preparing = prepare(value, f); await f.control.inspectStarted.promise;
  const progress = await value.getState(); assert.equal(progress.preparing.phase, 'hashing'); assert.equal(progress.busy, true);
  await value.clearReview(); await preparing;
  const stopped = await value.getState(); assert.equal(stopped.busy, false); assert.equal(stopped.review, null); assert.equal(stopped.jobs.length, 0);
  assert.equal(f.counters.begin, 0);
});

test('verification is indeterminate until receipt and explicit cancellation stops the server job', async t => {
  const f = await fixture(t), value = f.make(); f.control.holdUpload = true;
  const reviewed = await prepare(value, f); await value.confirmUpload(reviewed.review.id); await f.control.started.promise;
  const running = await value.getState(); assert.equal(running.jobs[0].stage, 'verifying'); assert.equal(running.jobs[0].totalBytes, null);
  assert.equal(running.jobs[0].status, 'running'); assert.equal(running.jobs[0].canCancel, true);
  await value.cancel(running.jobs[0].id); const stopped = await value.getState();
  assert.equal(stopped.jobs[0].status, 'cancelled'); assert.equal(f.counters.cancel, 1); assert.equal(stopped.jobs[0].canResume, true);
});

test('same-scope notifications preserve active work while changed targets abort and hide it', async t => {
  const f = await fixture(t), value = f.make(); f.control.holdUpload = true;
  const reviewed = await prepare(value, f); await value.confirmUpload(reviewed.review.id); await f.control.started.promise;
  await value.selectionChanged(); await value.connectionChanged(); assert.equal((await value.getState()).jobs[0].status, 'running');
  f.selection.remoteBranch = 'review'; await value.selectionChanged(); await waitState(value, state => !state.busy);
  assert.equal((await value.getState()).jobs.length, 0); assert.equal(f.counters.cancel, 1);
  f.selection.remoteBranch = 'main'; const recovered = await value.getState(); assert.equal(recovered.jobs[0].status, 'paused');
  assert.equal(recovered.jobs[0].error, 'asset-selection-changed');
});

test('restart performs no automatic media IO or network and only explicit matching-scope resume proceeds', async t => {
  const f = await fixture(t), first = f.make(); f.control.holdUpload = true;
  const reviewed = await prepare(first, f); await first.confirmUpload(reviewed.review.id); await f.control.started.promise;
  await first.dispose(); const calls = { ...f.counters }, next = f.make();
  const restored = await next.getState(); assert.equal(restored.jobs[0].status, 'paused'); assert.deepEqual(f.counters, calls);
  f.selection.localBranch = 'other'; assert.equal((await next.getState()).jobs.length, 0);
  await next.resume(restored.jobs[0].id); assert.deepEqual(f.counters, calls);
  f.selection.localBranch = 'main'; f.state.projects[0].role = 'viewer';
  assert.equal((await next.getState()).jobs[0].canResume, false); await next.resume(restored.jobs[0].id); assert.deepEqual(f.counters, calls);
  f.state.projects[0].role = 'editor'; f.control.holdUpload = false;
  await next.resume(restored.jobs[0].id); await waitState(next, state => state.jobs[0]?.status === 'completed'); assert.equal(f.counters.upload, 2);
  const third = f.make(); assert.equal((await third.getState()).jobs[0].status, 'completed'); assert.equal(f.counters.upload, 2);
});

test('viewers may download but cannot prepare uploads and download intent precedes engine work', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'viewer';
  assert.equal((await prepare(value, f)).error, 'asset-viewer-read-only'); assert.equal(f.counters.inspect, 0);
  const destination = path.join(f.parent, 'download.bin');
  await value.startDownload({ assetId: identity.contentId, destination, name: 'download.bin', maxBytesPerSecond: 1024 });
  const done = await waitState(value, state => state.jobs[0]?.status === 'completed'); assert.equal(done.jobs[0].direction, 'download');
  assert.deepEqual(await fs.readFile(destination), bytes); assert.equal(f.counters.download, 1);
});

test('concurrent confirmations create only one job and a capacity-bounded journal rejects tampering', async t => {
  const f = await fixture(t), value = f.make(); f.control.holdUpload = true;
  const reviewed = await prepare(value, f); await Promise.all([value.confirmUpload(reviewed.review.id), value.confirmUpload(reviewed.review.id)]);
  await f.control.started.promise; assert.equal((await value.getState()).jobs.length, 1); assert.equal(f.counters.upload, 1);
  await value.cancel((await value.getState()).jobs[0].id);
  const journal = path.join(f.directory, 'transfers.json'), original = await fs.readFile(journal), bad = JSON.parse(original);
  bad.jobs[0].rawToken = 'access-token-secret'; await fs.writeFile(journal, JSON.stringify(bad));
  const rejected = await value.getState(); assert.equal(rejected.error, 'asset-transfer-journal-invalid'); assert.equal(rejected.jobs.length, 0);
  assert.doesNotMatch(JSON.stringify(rejected), /access-token-secret|\/private\/|\/var\//);
});

test('offline scope retains job visibility without enabling transfers and errors remain allowlisted', async t => {
  const f = await fixture(t), value = f.make(); f.control.failUpload = 'asset-network-unavailable';
  const reviewed = await prepare(value, f); await value.confirmUpload(reviewed.review.id); await waitState(value, state => !state.busy);
  f.state.status = 'offline'; f.state.connected = false; const offline = await value.getState();
  assert.equal(offline.jobs.length, 1); assert.equal(offline.available, false); assert.equal(offline.jobs[0].canResume, false);
  assert.equal(safeAssetTransferError(fail('/private/token-secret')), 'asset-local-io-failed');
});

test('missing observed journals fail closed in the current and freshly reopened controllers', async t => {
  const f = await fixture(t), value = f.make(); const reviewed = await prepare(value, f); await value.confirmUpload(reviewed.review.id);
  await waitState(value, state => state.jobs[0]?.status === 'completed');
  assert.equal((await fs.stat(path.join(f.directory, 'initialized.json'))).mode & 0o777, 0o600);
  await fs.unlink(path.join(f.directory, 'transfers.json'));
  assert.equal((await value.getState()).error, 'asset-transfer-journal-invalid');
  const reopened = f.make(); assert.equal((await reopened.getState()).error, 'asset-transfer-journal-invalid');
  const calls = f.counters.download;
  await reopened.startDownload({ assetId: identity.contentId, destination: path.join(f.parent, 'refused.bin'), name: 'refused.bin' });
  assert.equal(f.counters.download, calls); await assert.rejects(fs.access(path.join(f.directory, 'transfers.json')), { code: 'ENOENT' });
});

test('dispose dynamically drains a control accepted before shutdown and lifecycle calls remain inert', async t => {
  const f = await fixture(t), value = f.make();
  const start = value.startDownload({ assetId: identity.contentId, destination: path.join(f.parent, 'stopped.bin'), name: 'stopped.bin' });
  const stopping = value.dispose(); await Promise.all([start, stopping]);
  await value.selectionChanged(); await value.connectionChanged();
  assert.equal(f.counters.download, 0); assert.equal((await value.getState()).busy, false);
});

test('controller integrates the real file engine with durable upload and exclusive download receipts', async t => {
  const f = await fixture(t), assets = await createDurableAssetService({ directory: path.join(f.parent, 'service-assets'),
    keyring: createKeyring({ test: randomBytes(32) }, 'test'), authorize: async () => true, initialize: true, chunkSize: 4 });
  const ctx = { accessToken: 'private-test-token', requestId: 'controller-test' };
  Object.assign(f.client, {
    getAsset: (pid, aid) => assets.getAsset(ctx, pid, aid),
    beginUpload: (pid, value) => assets.beginUpload(ctx, pid, value),
    putChunk: (pid, uid, index, chunk, checksum, options) => assets.putChunk(ctx, pid, uid, index, chunk, checksum, options),
    completeUpload: (pid, uid, options) => assets.completeUpload(ctx, pid, uid, options),
    readChunk: (pid, aid, index, options) => assets.readChunk(ctx, pid, aid, index, options)
  });
  const value = f.make(fileEngine);
  try {
    const reviewed = await prepare(value, f); assert.equal(reviewed.review.identity.contentId, identity.contentId);
    await value.confirmUpload(reviewed.review.id); await waitState(value, state => !state.busy && state.jobs[0]?.status === 'completed');
    f.state.projects[0].role = 'viewer'; const destination = path.join(f.parent, 'real-download.bin');
    await value.startDownload({ assetId: identity.contentId, destination, name: 'real-download.bin' });
    const done = await waitState(value, state => state.jobs.find(job => job.direction === 'download')?.status === 'completed');
    assert.deepEqual(await fs.readFile(destination), bytes); assert.equal(done.jobs.length, 2);
    await value.dispose(); const reopened = f.make(fileEngine), restored = await reopened.getState();
    assert(restored.jobs.every(job => job.status === 'completed')); assert.deepEqual(restored.jobs.map(job => job.completedAt), done.jobs.map(job => job.completedAt));
    assert.doesNotMatch(JSON.stringify(restored), /private-test-token|\/private\/|\/var\//);
  } finally { await value.dispose(); await assets.close(); }
});

test('the real engine refuses changed reviewed source bytes before beginning a server upload', async t => {
  const f = await fixture(t);
  f.client.putChunk = async () => { throw new Error('changed source must not transfer'); };
  f.client.completeUpload = async () => { throw new Error('changed source must not publish'); };
  const value = f.make(fileEngine), reviewed = await prepare(value, f);
  await fs.writeFile(f.source, 'changed disposable bytes', { mode: 0o600 });
  await value.confirmUpload(reviewed.review.id);
  const failed = await waitState(value, state => state.jobs[0]?.status === 'failed');
  assert.equal(failed.jobs[0].error, 'asset-identity-mismatch'); assert.equal(f.counters.begin, 0);
});
