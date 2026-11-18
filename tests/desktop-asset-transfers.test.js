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
  let policy = { projectId: 'remote', version: 1, syncClasses: ['original'] }, archived = false;
  const usage = () => ({ projectId: 'remote', assetCount: control.reused ? 1 : 0, logicalBytes: control.reused ? bytes.length : 0,
    availableBytes: control.reused && !archived && policy.syncClasses.includes('original') ? bytes.length : 0,
    archivedBytes: control.reused && archived && policy.syncClasses.includes('original') ? bytes.length : 0,
    excludedBytes: control.reused && !policy.syncClasses.includes('original') ? bytes.length : 0,
    inProgressUploads: 0, inProgressReceivedBytes: 0, inProgressDeclaredBytes: 0 });
  const client = {
    async getPolicy() { return structuredClone(policy); },
    async setPolicy(_pid, input) { if (input.expectedVersion !== policy.version) throw fail('asset-policy-version-conflict');
      policy = { projectId: 'remote', version: policy.version + 1, syncClasses: [...input.syncClasses].sort() }; return structuredClone(policy); },
    async getUsage() { return usage(); },
    async getAvailability(_pid, aid) { return { projectId: 'remote', assetId: aid, cloudPresent: control.reused,
      excluded: control.reused && !policy.syncClasses.includes('original'), archived: control.reused && archived,
      assetClass: control.reused ? 'original' : null, size: control.reused ? bytes.length : null }; },
    async setArchived(_pid, aid, input) { if (input.expectedArchived !== archived) throw fail('asset-archive-conflict'); archived = input.archived;
      return this.getAvailability(_pid, aid); },
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
  const make = (chosenEngine = engine) => { const value = createDesktopAssetTransfers({ directory, connection, getSelection: async () => { control.selectionHook?.(); return structuredClone(selection); },
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
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'viewer'; f.control.reused = true;
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
    keyring: createKeyring({ test: randomBytes(32) }, 'test'), authorize: async () => true,
    authorizePolicy: async () => ({ allowed: true, actorId: 'owner' }), initialize: true, chunkSize: 4 });
  const ctx = { accessToken: 'private-test-token', requestId: 'controller-test' };
  await assets.setPolicy(ctx, 'remote', { expectedVersion: 0, syncClasses: ['original'] });
  Object.assign(f.client, {
    getPolicy: pid => assets.getPolicy(ctx, pid), getUsage: pid => assets.getUsage(ctx, pid), getAvailability: (pid, aid) => assets.getAvailability(ctx, pid, aid),
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

test('storage reads are explicit and an unset policy prevents hashing or confirming media', async t => {
  const f = await fixture(t), value = f.make(); let reads = 0;
  f.client.getPolicy = async () => { reads++; return { projectId: 'remote', version: 0, syncClasses: [] }; };
  const initial = await value.getState(); assert.equal(initial.storage.status, 'idle'); assert.equal(reads, 0);
  const reviewed = await prepare(value, f); assert.equal(reviewed.error, 'asset-policy-excluded'); assert.equal(f.counters.inspect, 0);
  assert.equal(reads, 1); assert.equal(reviewed.review, null); assert.equal(f.counters.begin, 0);
  const refreshed = await value.refreshStorage(); assert.equal(refreshed.storage.status, 'ready'); assert.deepEqual(refreshed.storage.policy.syncClasses, []);
});

test('fresh confirmation detects an externally disabled class and invalidates the old review', async t => {
  const f = await fixture(t), value = f.make(), reviewed = await prepare(value, f);
  await f.client.setPolicy('remote', { expectedVersion: 1, syncClasses: [] });
  const blocked = await value.confirmUpload(reviewed.review.id); assert.equal(blocked.error, 'asset-policy-excluded');
  assert.equal(blocked.review, null); assert.equal(blocked.jobs.length, 0); assert.equal(f.counters.upload, 0); assert.equal(f.counters.begin, 0);
});

test('owner policy and archive controls refresh usage and availability without rewriting completed receipts', async t => {
  const f = await fixture(t), value = f.make();
  assert.equal((await value.refreshStorage()).storage.canManage, false);
  assert.equal((await value.savePolicy({ expectedVersion: 1, syncClasses: [] })).error, 'asset-policy-forbidden');
  f.state.projects[0].role = 'owner';
  const reviewed = await prepare(value, f); await value.confirmUpload(reviewed.review.id);
  const completed = await waitState(value, state => !state.busy && state.jobs[0]?.status === 'completed');
  f.control.reused = true;
  assert.equal((await value.checkAvailability(identity.contentId)).availability.state, 'cloud-present');
  const archived = await value.setArchived({ assetId: identity.contentId, expectedArchived: false, archived: true });
  assert.equal(archived.availability.state, 'archived'); assert.equal(archived.storage.usage.archivedBytes, bytes.length);
  assert.equal(archived.jobs[0].completedAt, completed.jobs[0].completedAt); assert.equal(archived.jobs[0].status, 'completed');
  const excluded = await value.savePolicy({ expectedVersion: 1, syncClasses: [] });
  assert.equal(excluded.storage.status, 'ready'); assert.equal(excluded.storage.usage.excludedBytes, bytes.length); assert.equal(excluded.availability, null);
  const checked = await value.checkAvailability(identity.contentId); assert.equal(checked.availability.state, 'excluded'); assert.equal(checked.availability.archived, true);
  const download = await value.startDownload({ assetId: identity.contentId, destination: path.join(f.parent, 'blocked.bin'), name: 'blocked.bin' });
  assert.equal(download.error, 'asset-policy-excluded'); assert.equal(f.counters.download, 0); assert.equal(download.jobs.length, 1);
});

test('excluded and archived existing content cannot be presented as a zero-byte reuse review', async t => {
  const f = await fixture(t), value = f.make(); f.control.reused = true; f.state.projects[0].role = 'owner';
  await f.client.setArchived('remote', identity.contentId, { expectedArchived: false, archived: true });
  const blocked = await prepare(value, f); assert.equal(blocked.error, 'asset-archived'); assert.equal(blocked.review, null);
  const missingId = `sha256:${'0'.repeat(64)}`; f.control.reused = false;
  const absent = await value.checkAvailability(missingId); assert.equal(absent.availability.state, 'not-on-service');
  assert.equal(absent.availability.assetClass, null); assert.equal(absent.availability.size, null);
});

test('stale storage replies and owner-role loss cannot overwrite the current scope or leave loading stuck', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner';
  await value.refreshStorage(); const entered = deferred(), release = deferred(), originalUsage = f.client.getUsage;
  f.client.getUsage = async () => { entered.resolve(); await release.promise; return originalUsage(); };
  const fetching = value.refreshStorage(); await entered.promise; f.selection.remoteBranch = 'review'; await value.selectionChanged(); release.resolve(); await fetching;
  const changed = await value.getState(); assert.equal(changed.storage.status, 'idle'); assert.equal(changed.storage.policy, null); assert.equal(changed.availability, null);
  f.selection.remoteBranch = 'main'; f.client.getUsage = originalUsage; await value.refreshStorage();
  const pending = deferred(), finish = deferred(), originalSet = f.client.setPolicy;
  f.client.setPolicy = async (...args) => { pending.resolve(); await finish.promise; return originalSet(...args); };
  const saving = value.savePolicy({ expectedVersion: 1, syncClasses: [] }); await pending.promise;
  f.state.projects[0].role = 'viewer'; await value.connectionChanged(); finish.resolve(); await saving;
  const stopped = await value.getState(); assert.equal(stopped.storage.canManage, false); assert.equal(stopped.storage.status, 'error');
  assert.equal(stopped.storage.error, 'asset-policy-forbidden'); assert.deepEqual(stopped.storage.policy.syncClasses, ['original']);
});

test('unconfigured state is safe and policy conflicts preserve the last confirmed policy', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner';
  await value.refreshStorage(); const conflict = await value.savePolicy({ expectedVersion: 0, syncClasses: [] });
  assert.equal(conflict.storage.status, 'error'); assert.equal(conflict.storage.error, 'asset-policy-version-conflict'); assert.equal(conflict.storage.policy.version, 1);
  f.state.status = 'not-configured'; f.state.connected = false; f.state.account = null; f.state.origin = null;
  const empty = await value.getState(); assert.equal(empty.storage.status, 'idle'); assert.equal(empty.availability, null); assert.equal(empty.scope, null);
});

test('a confirmed policy mutation wins over a newer read that completed before its commit', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner';
  const reviewed = await prepare(value, f), entered = deferred(), commit = deferred(), committed = deferred(), ack = deferred(), original = f.client.setPolicy;
  f.client.setPolicy = async (...args) => { entered.resolve(); await commit.promise; const result = await original(...args); committed.resolve(); await ack.promise; return result; };
  const saving = value.savePolicy({ expectedVersion: 1, syncClasses: [] }); await entered.promise;
  assert.equal((await value.refreshStorage()).storage.policy.version, 1);
  commit.resolve(); await committed.promise; ack.resolve(); const saved = await saving;
  assert.equal(saved.storage.policy.version, 2); assert.deepEqual(saved.storage.policy.syncClasses, []); assert.equal(saved.review, null);
  assert.equal(saved.error, 'asset-policy-excluded'); assert.equal(f.counters.upload, 0); assert(reviewed.review.id);
});

test('archive mutation acknowledgment is never suppressed by a newer storage read and stops active cached work', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner'; f.control.reused = true;
  const transferStarted = deferred();
  f.engine.downloadAssetFile = async ({ signal, onProgress }) => { f.counters.download++; await onProgress({ phase: 'downloading', bytes: bytes.length, totalBytes: bytes.length });
    transferStarted.resolve(); await abortable(signal); };
  await value.refreshStorage(); await value.startDownload({ assetId: identity.contentId, destination: path.join(f.parent, 'cancelled-cache.bin'), name: 'cancelled-cache.bin' });
  await transferStarted.promise;
  const entered = deferred(), ack = deferred(), original = f.client.setArchived;
  f.client.setArchived = async (...args) => { const result = await original.apply(f.client, args); entered.resolve(); await ack.promise; return result; };
  const archiving = value.setArchived({ assetId: identity.contentId, expectedArchived: false, archived: true }); await entered.promise;
  await value.refreshStorage(); ack.resolve(); const archived = await archiving;
  assert.equal(archived.availability.state, 'archived');
  const stopped = await waitState(value, state => !state.busy); assert.equal(stopped.jobs[0].status, 'paused'); assert.equal(stopped.jobs[0].error, 'asset-archived');
  assert.equal(stopped.jobs[0].canResume, false);
  await assert.rejects(fs.access(path.join(f.parent, 'cancelled-cache.bin')), { code: 'ENOENT' });
});

test('a class disabled during hashing cannot produce a new reuse or upload review', async t => {
  const f = await fixture(t), value = f.make(), entered = deferred(), finish = deferred();
  f.engine.inspectAssetFile = async (_source, { onProgress }) => { f.counters.inspect++; await onProgress({ phase: 'hashing', bytes: 0, totalBytes: bytes.length });
    entered.resolve(); await finish.promise; return { identity: structuredClone(identity) }; };
  const preparing = prepare(value, f); await entered.promise; await f.client.setPolicy('remote', { expectedVersion: 1, syncClasses: [] }); finish.resolve();
  const stopped = await preparing; assert.equal(stopped.review, null); assert.equal(stopped.error, 'asset-policy-excluded'); assert.equal(f.counters.begin, 0);
});

test('owner archive invalidates an existing zero-byte review and class exclusion disables upload resume', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner'; f.control.reused = true;
  const reviewed = await prepare(value, f); assert.equal(reviewed.review.estimatedUploadBytes, 0);
  const archived = await value.setArchived({ assetId: identity.contentId, expectedArchived: false, archived: true }); assert.equal(archived.review, null); assert.equal(archived.error, 'asset-archived');
  await value.setArchived({ assetId: identity.contentId, expectedArchived: true, archived: false });
  f.control.holdUpload = true; const again = await prepare(value, f); await value.confirmUpload(again.review.id); await f.control.started.promise;
  await value.savePolicy({ expectedVersion: 1, syncClasses: [] }); const stopped = await waitState(value, state => !state.busy);
  assert.equal(stopped.jobs[0].error, 'asset-policy-excluded'); assert.equal(stopped.jobs[0].canResume, false);
});

test('getState refreshes owner management permission even when upload permission remains unchanged', async t => {
  const f = await fixture(t), value = f.make(); f.state.projects[0].role = 'owner'; let reads = 0;
  f.control.selectionHook = () => { if (++reads === 2) f.state.projects[0].role = 'editor'; };
  const state = await value.getState(); assert.equal(state.canUpload, true); assert.equal(state.storage.canManage, false);
});

test('usage is retried when its surrounding policy version changes instead of combining inconsistent snapshots', async t => {
  const f = await fixture(t), value = f.make(); f.control.reused = true; let reads = 0;
  const original = f.client.getUsage;
  f.client.getUsage = async () => { const snapshot = await original(); if (++reads === 1) await f.client.setPolicy('remote', { expectedVersion: 1, syncClasses: [] }); return snapshot; };
  const fresh = await value.refreshStorage(); assert.equal(reads, 2); assert.equal(fresh.storage.policy.version, 2);
  assert.equal(fresh.storage.usage.availableBytes, 0); assert.equal(fresh.storage.usage.excludedBytes, bytes.length); assert.equal(fresh.storage.status, 'ready');
});
