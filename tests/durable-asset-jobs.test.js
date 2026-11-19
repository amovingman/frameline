'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { lifecycleFixture, owner, editor, viewer } = require('./fixtures/asset-lifecycle-service');
const { createAssetVerificationWorker } = require('../src/asset-verification-worker');
const { validateAssetJob } = require('../src/asset-jobs-protocol');
const fail = code => Object.assign(new Error('/private/secret bearer-credential'), { code });
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function fixture(t) {
  const f = await lifecycleFixture(t);
  const options = { workerActorContext: actorId => actorId === 'owner-id' ? owner : actorId === 'member-id' ? editor : { accessToken: 'invalid' } };
  await f.reopen(options);
  return { ...f, get store() { return f.store; }, async reopen(changes = {}) { return f.reopen({ ...options, ...changes }); } };
}
const submit = (store, assetId, key = 'first-job', actor = owner, pid = 'film') => store.submitVerificationJob(actor, pid, { assetId, idempotencyKey: key });
const action = (run, key) => ({ expectedRun: run, idempotencyKey: key });

test('verification jobs bind published content, deduplicate active exact inputs, persist receipts and omit worker secrets', async t => {
  const f = await fixture(t), a = await f.upload();
  const first = await submit(f.store, a.assetId); assert.equal(first.status, 'queued'); assert.equal(first.attempts, 0);
  assert.equal((await submit(f.store, a.assetId, 'another-key')).id, first.id);
  assert.equal((await submit(f.store, a.assetId, 'editor-key', editor)).actorId, 'member-id');
  assert.equal((await f.store.getVerificationMetrics(viewer, 'film')).totalJobs, 2);
  await f.reopen(); assert.equal((await submit(f.store, a.assetId)).id, first.id);
  await assert.rejects(submit(f.store, `sha256:${'a'.repeat(64)}`, 'first-job'), { code: 'asset-job-idempotency-conflict' });
  await assert.rejects(submit(f.store, a.assetId, 'other-project', owner, 'other-film'), { code: 'asset-not-found' });
  const claim = await f.store.worker.claim(30000); const publicValue = await f.store.getVerificationJob(viewer, 'film', claim.jobId);
  assert.equal(publicValue.status, 'running'); assert.equal(publicValue.leaseExpiresAt, 31000);
  assert.equal(JSON.stringify(publicValue).includes(claim.token), false); assert.equal(Object.hasOwn(publicValue, 'lease'), false);
  assert.equal((await fs.readFile(path.join(f.directory, 'assets.enc.json'), 'utf8')).includes(a.assetId), false);
});
test('members read scoped job pages and metrics; viewers cannot submit or mutate and editors cannot cancel another author', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId);
  assert.equal((await f.store.listVerificationJobs(viewer, 'film', { afterJobId: null, limit: 1 })).items[0].id, job.id);
  await assert.rejects(submit(f.store, a.assetId, 'viewer', viewer), { code: 'forbidden' });
  await assert.rejects(f.store.cancelVerificationJob(editor, 'film', job.id, action(1, 'cancel')), { code: 'asset-policy-forbidden' });
  const own = await submit(f.store, a.assetId, 'editor', editor);
  assert.equal((await f.store.cancelVerificationJob(owner, 'film', own.id, action(1, 'owner-cancel'))).status, 'cancelled');
  assert.deepEqual((await f.store.listVerificationJobs(viewer, 'other-film', { afterJobId: null, limit: 100 })).items, []);
  await assert.rejects(f.store.getVerificationJob(viewer, 'other-film', job.id), { code: 'asset-job-not-found' });
});
test('cancel and explicit retry are run-fenced and exact old action receipts never cancel a later retry', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId);
  await f.store.cancelVerificationJob(owner, 'film', job.id, action(1, 'cancel'));
  const retried = await f.store.retryVerificationJob(owner, 'film', job.id, action(1, 'retry'));
  assert.equal(retried.run, 2); assert.equal(retried.status, 'queued');
  assert.equal((await f.store.cancelVerificationJob(owner, 'film', job.id, action(1, 'cancel'))).status, 'queued');
  assert.equal((await f.store.retryVerificationJob(owner, 'film', job.id, action(1, 'retry'))).run, 2);
  await assert.rejects(f.store.cancelVerificationJob(owner, 'film', job.id, action(1, 'late-cancel')), { code: 'asset-job-run-stale' });
  assert.equal((await submit(f.store, a.assetId, 'first-job')).id, job.id);
});
test('worker rehashes complete stored content, persists progress/results and reports logical verification metrics', async t => {
  const f = await fixture(t), a = await f.upload('complete stored media'), job = await submit(f.store, a.assetId);
  const worker = createAssetVerificationWorker({ worker: f.store.worker }); await worker.tick(); await worker.stop();
  const done = await f.store.getVerificationJob(owner, 'film', job.id); validateAssetJob(done);
  assert.equal(done.status, 'succeeded'); assert.equal(done.progressBytes, a.bytes.length); assert.equal(done.result.sha256, a.assetId.slice(7));
  assert.equal(done.result.verified, true); await f.reopen(); assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'succeeded');
  const metrics = await f.store.getVerificationMetrics(viewer, 'film'); assert.equal(metrics.succeeded, 1); assert.equal(metrics.verifiedBytes, a.bytes.length); assert.equal(metrics.attempts, 1);
  assert.equal((await submit(f.store, a.assetId, 'fresh-check')).id === job.id, false);
  assert.deepEqual((await f.store.readChunk(viewer, 'film', a.assetId, 0)).bytes, a.bytes.subarray(0, 4));
});
test('lease expiry survives restart, fences old workers and exhausts a bounded attempt budget', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId);
  const first = await f.store.worker.claim(1000); f.advance(1001); await f.reopen();
  const second = await f.store.worker.claim(1000); assert.notEqual(first.token, second.token);
  await assert.rejects(f.store.worker.progress(first, 1), { code: 'asset-job-lease-stale' });
  f.advance(1001); const third = await f.store.worker.claim(1000); assert(third);
  f.advance(1001); assert.equal(await f.store.worker.claim(1000), null);
  const stopped = await f.store.getVerificationJob(owner, 'film', job.id); assert.equal(stopped.status, 'failed'); assert.equal(stopped.error, 'asset-job-attempts-exhausted');
  assert.equal((await f.store.getVerificationMetrics(owner, 'film')).processingMs, 3000);
  await assert.rejects(f.store.retryVerificationJob(owner, 'film', job.id, action(1, 'exhausted-retry')), { code: 'asset-job-attempts-exhausted' });
});
test('heartbeat progress is monotonic, extends the lease and cannot renew an expired or cancelled token', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId), claim = await f.store.worker.claim(1000);
  f.advance(500); let value = await f.store.worker.progress(claim, 4); assert.equal(value.leaseExpiresAt, 2500);
  await assert.rejects(f.store.worker.progress(claim, 3), { code: 'asset-job-invalid' });
  await assert.rejects(f.store.worker.progress(claim, a.bytes.length + 1), { code: 'asset-job-invalid' });
  await f.store.cancelVerificationJob(owner, 'film', job.id, action(1, 'cancel-running'));
  await assert.rejects(f.store.worker.complete(claim, { size: a.bytes.length, sha256: a.assetId.slice(7) }), { code: 'asset-job-lease-stale' });
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'cancelled');
});
test('expired lease cannot complete before reclaim, and another store never claims the same live job', async t => {
  const f = await fixture(t), a = await f.upload(); await submit(f.store, a.assetId);
  const other = await f.open({ workerActorContext: () => owner });
  const claims = await Promise.all([f.store.worker.claim(1000), other.worker.claim(1000)]); assert.equal(claims.filter(Boolean).length, 1);
  f.advance(1001); await assert.rejects(f.store.worker.progress(claims.find(Boolean), 1), { code: 'asset-job-lease-expired' });
});
test('cancelling a streamed worker fences late completion while unrelated queued jobs stay usable', async t => {
  const f = await fixture(t), a = await f.upload(), b = await f.upload('unrelated media');
  const first = await submit(f.store, a.assetId), second = await submit(f.store, b.assetId, 'second');
  const entered = gate(), release = gate();
  const worker = createAssetVerificationWorker({ worker: { ...f.store.worker, async readChunk(...args) { entered.resolve(); await release.promise; return f.store.worker.readChunk(...args); } } });
  const pending = worker.tick(); await entered.promise;
  await f.store.cancelVerificationJob(owner, 'film', first.id, action(1, 'cancel-stream'));
  release.resolve(); await pending; await worker.stop();
  assert.equal((await f.store.getVerificationJob(owner, 'film', first.id)).status, 'cancelled');
  assert.equal((await f.store.getVerificationJob(owner, 'film', second.id)).status, 'queued');
});
test('membership and media policy are rechecked on worker reads; safe failures preserve asset bytes', async t => {
  for (const kind of ['revoked', 'archived', 'excluded', 'corrupt']) await t.test(kind, async t => {
    const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId);
    if (kind === 'revoked') f.revoked.add(owner.accessToken);
    else if (kind === 'archived') await f.store.setArchived(owner, 'film', a.assetId, { expectedArchived: false, archived: true });
    else if (kind === 'excluded') await f.store.setPolicy(owner, 'film', { expectedVersion: 1, syncClasses: [] });
    else { const file = path.join(f.directory, 'uploads', a.uploadId, '0.enc.json'); await fs.writeFile(file, '{}'); }
    const worker = createAssetVerificationWorker({ worker: f.store.worker }); await worker.tick(); await worker.stop();
    f.revoked.clear(); const failed = await f.store.getVerificationJob(owner, 'film', job.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, { revoked: 'asset-job-access-denied', archived: 'asset-archived', excluded: 'asset-policy-excluded', corrupt: 'asset-chunk-corrupt' }[kind]);
    assert.doesNotMatch(JSON.stringify(failed), /\/private\/|bearer-credential/);
    assert.equal((await f.store.getAvailability(owner, 'film', a.assetId)).cloudPresent, true);
  });
});
test('worker shutdown requeues an interrupted lease and a fresh worker restarts hashing from zero', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId), entered = gate(), release = gate();
  const worker = createAssetVerificationWorker({ worker: { ...f.store.worker, async readChunk(...args) { entered.resolve(); await release.promise; return f.store.worker.readChunk(...args); } } });
  const pending = worker.tick(); await entered.promise; const stopping = worker.stop(); release.resolve(); await Promise.all([pending, stopping]);
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'queued');
  await f.reopen(); const fresh = createAssetVerificationWorker({ worker: f.store.worker }); await fresh.tick(); await fresh.stop();
  const value = await f.store.getVerificationJob(owner, 'film', job.id); assert.equal(value.status, 'succeeded'); assert.equal(value.attempts, 2);
});
test('full-file hash mismatch cannot produce a successful job even from valid-length worker reads', async t => {
  const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId);
  const worker = createAssetVerificationWorker({ worker: { ...f.store.worker, async readChunk(...args) {
    const bytes = await f.store.worker.readChunk(...args); return Buffer.alloc(bytes.length, 42);
  } } }); await worker.tick(); await worker.stop();
  const result = await f.store.getVerificationJob(owner, 'film', job.id); assert.equal(result.status, 'failed'); assert.equal(result.error, 'asset-content-mismatch');
});
test('schema3 migration preserves lifecycle history and bytes; corrupted job receipts fail closed', async t => {
  const f = await fixture(t), a = await f.upload();
  await f.store.setHold(owner, 'film', a.assetId, { expectedVersion: 0, held: true, reason: 'manual', until: null, idempotencyKey: 'held' });
  await f.store.close(); const state = await f.state(), prior = structuredClone(state.lifecycle); state.schemaVersion = 3; delete state.jobs; await f.saveState(state);
  await f.reopen(); assert.equal((await f.state()).schemaVersion, 4); assert.deepEqual((await f.state()).lifecycle, prior);
  await submit(f.store, a.assetId); await f.store.close(); const corrupt = await f.state(); corrupt.jobs.receipts[0].jobId = 'wrong-job'; await f.saveState(corrupt);
  const before = await fs.readFile(path.join(f.directory, 'assets.enc.json'));
  await assert.rejects(f.open(), { code: 'asset-state-invalid' }); assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), before);
});
test('uncertain submission publication recovers the same job on exact retry after reopening', async t => {
  const f = await fixture(t), a = await f.upload();
  await f.reopen({ storage: { ...fs, async rename(from, to) { await fs.rename(from, to); throw fail('EIO'); } } });
  await assert.rejects(submit(f.store, a.assetId), { code: 'asset-storage-uncertain' }); await f.reopen();
  const retried = await submit(f.store, a.assetId); assert.equal(retried.status, 'queued'); assert.equal((await f.store.getVerificationMetrics(owner, 'film')).totalJobs, 1);
});

test('a lease expiring during final asynchronous authorization cannot acknowledge bytes, progress, or success', async t => {
  for (const kind of ['read', 'progress', 'complete']) await t.test(kind, async t => {
    const f = await fixture(t), a = await f.upload(), job = await submit(f.store, a.assetId), claim = await f.store.worker.claim(1000);
    let checks = 0;
    await f.reopen({ authorize: async (...args) => { const result = await f.authorize(...args); if (++checks === 3) f.advance(1001); return result; } });
    const work = kind === 'read' ? f.store.worker.readChunk(claim, 0) : kind === 'progress' ? f.store.worker.progress(claim, 4)
      : f.store.worker.complete(claim, { size: a.bytes.length, sha256: a.assetId.slice(7) });
    await assert.rejects(work, { code: 'asset-job-lease-expired' });
    const current = await f.store.getVerificationJob(owner, 'film', job.id);
    assert.equal(current.status, 'running'); assert.equal(current.progressBytes, 0); assert.equal(current.result, null);
  });
});
