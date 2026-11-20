'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fingerprint } = require('../src/project-api-contracts');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { createHash } = require('node:crypto');
const { createAssetVerificationWorker } = require('../src/asset-verification-worker');
const { lifecycleFixture, owner, editor, viewer, page, holdInput } = require('./fixtures/asset-lifecycle-service');
const references = (projectId, revisions = [], complete = true) => {
  const body = { projectId, complete, revisions }; return { ...body, stateHash: fingerprint(body) };
};
async function fixture(t, overrides = {}) {
  const snapshots = new Map(); let inLease = false;
  const f = await lifecycleFixture(t, { ownerBoundaryDeduplication: true,
    withRevisionReferences: async (context, projectId, operation) => {
      if (context.accessToken !== owner.accessToken) throw Object.assign(new Error('private'), { code: 'asset-policy-forbidden' });
      inLease = true;
      try { return await operation(snapshots.get(projectId) || references(projectId), {
        authorize: () => ({ allowed: true, actorId: 'owner-id' }), authorizePolicy: () => ({ allowed: true, actorId: 'owner-id' }),
        getInitialPolicy: () => ({ projectId, version: 0, syncClasses: [] })
      }); } finally { inLease = false; }
    }, ...overrides });
  return { ...f, get store() { return f.store; }, snapshots, inLease: () => inLease,
    reopen: changes => f.reopen(changes), upload: (...args) => f.upload(...args) };
}
async function ready(f, assetId, projectId = 'film') {
  const policy = await f.store.getRetentionPolicy(owner, projectId);
  if (policy.minimumArchiveAgeMs !== 0) await f.store.setRetentionPolicy(owner, projectId, { expectedVersion: policy.version, minimumArchiveAgeMs: 0, idempotencyKey: `retention-${projectId}` });
  await f.store.setArchived(owner, projectId, assetId, { expectedArchived: false, archived: true });
  const report = await f.store.getOwnerAssetReport(owner, projectId, page);
  const plan = await f.store.planGarbageCollection(owner, projectId, { assetIds: [assetId], expectedStateHash: report.stateHash });
  return { report, plan, input: { assetIds: [assetId], expectedStateHash: report.stateHash, planId: plan.planId, idempotencyKey: `delete-${assetId.slice(7, 20)}` } };
}
test('owner-boundary dedup stores one ciphertext copy, rehashes before publication and survives restart', async t => {
  const f = await fixture(t); const a = await f.upload('shared original bytes'); const b = await f.upload('shared original bytes', 'other-film');
  const state = await f.state(); assert.equal(state.schemaVersion, 5); assert.equal(state.blobs.length, 1); assert.equal(state.uploads.length, 2);
  assert.equal(new Set(state.uploads.map(row => row.blobId)).size, 1);
  assert.equal((await fs.readdir(path.join(f.directory, 'uploads'))).length, 1);
  await f.reopen(); const chunk = await f.store.readChunk(owner, 'other-film', b.assetId, 0); assert.equal(chunk.bytes.toString(), 'shar');
  assert.notEqual(a.uploadId, b.uploadId);
});
test('dedup requires both owner access and exact class/media type; colliding identities never share storage', async t => {
  const f = await fixture(t); await f.upload('same bytes', 'film', 'original'); await f.upload('same bytes', 'other-film', 'proxy');
  assert.equal((await f.state()).blobs.length, 2);
  await f.reopen({ authorizePolicy: async (context, projectId) => {
    if (projectId === 'film') throw Object.assign(new Error('private'), { code: 'asset-policy-forbidden' });
    return { allowed: true, actorId: 'owner-id' };
  } });
  // Existing other-film identity remains immutable rather than a silent role change.
  const identity = (await f.state()).uploads.find(row => row.projectId === 'film').identity;
  await assert.rejects(f.store.beginUpload(owner, 'other-film', identity), { code: 'asset-identity-collision' });
});
test('authoritative retained revisions and incomplete coverage block deletion with path-free owner reports', async t => {
  const f = await fixture(t); const a = await f.upload(); const identity = (await f.state()).uploads[0].identity;
  f.snapshots.set('film', references('film', [{ revisionId: 'revision-1', manifestId: `sha256:${'b'.repeat(64)}`, sourceHash: 'a'.repeat(64), assets: [identity] }]));
  const prepared = await ready(f, a.assetId); assert.equal(prepared.plan.ready, false);
  assert.deepEqual(prepared.plan.items[0].retainedBy, ['revision-1']); assert.deepEqual(prepared.plan.items[0].blockers, ['retained-revision']);
  await assert.rejects(f.store.garbageCollect(owner, 'film', prepared.input), { code: 'asset-gc-blocked' });
  f.snapshots.set('film', references('film', [], false)); const report = await f.store.getOwnerAssetReport(owner, 'film', page);
  assert.deepEqual(report.items[0].blockers, ['revision-references-unverified']);
  assert.doesNotMatch(JSON.stringify(report), /uploads|\.enc\.json|frameline-lifecycle|accessToken|other-film/);
  for (const actor of [editor, viewer]) await assert.rejects(f.store.getOwnerAssetReport(actor, 'film', page));
});
test('GC releases only unreferenced project membership, keeps shared bytes, and exact retries survive restart', async t => {
  const f = await fixture(t); const a = await f.upload('shared bytes'); await f.upload('shared bytes', 'other-film');
  const prepared = await ready(f, a.assetId); assert.equal(prepared.plan.ready, true); assert.equal(prepared.plan.physicalBytesReclaimable, 0);
  const result = await f.store.garbageCollect(owner, 'film', prepared.input); assert.equal(result.logicalBytesReleased, a.bytes.length); assert.equal(result.physicalBytesScheduled, 0);
  await assert.rejects(f.store.getAsset(owner, 'film', a.assetId), { code: 'asset-not-found' });
  assert.equal((await f.store.readChunk(owner, 'other-film', a.assetId, 0)).bytes.toString(), 'shar');
  await f.reopen(); assert.deepEqual(await f.store.garbageCollect(owner, 'film', prepared.input), result);
  const second = await ready(f, a.assetId, 'other-film'); assert.equal(second.plan.physicalBytesReclaimable, a.bytes.length);
  await f.store.garbageCollect(owner, 'other-film', second.input);
  assert.equal((await f.state()).blobs.length, 0); assert.deepEqual(await fs.readdir(path.join(f.directory, 'uploads')), []);
});
test('holds, active verification and changed canonical references invalidate an old reviewed plan', async t => {
  const f = await fixture(t); const a = await f.upload(); const prepared = await ready(f, a.assetId);
  await f.store.setHold(owner, 'film', a.assetId, holdInput());
  await assert.rejects(f.store.garbageCollect(owner, 'film', prepared.input), { code: 'asset-lifecycle-plan-stale' });
  const report = await f.store.getOwnerAssetReport(owner, 'film', page); assert.deepEqual(report.items[0].blockers, ['active-hold']);
  f.snapshots.set('film', references('film', [], false));
  await assert.rejects(f.store.planGarbageCollection(owner, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash }), { code: 'asset-lifecycle-plan-stale' });
});
test('logical deletion is durable before physical cleanup; interrupted cleanup resumes after restart and preserves unknown files', async t => {
  const f = await fixture(t); const a = await f.upload(); const blob = (await f.state()).blobs[0]; const folder = path.join(f.directory, 'uploads', blob.id);
  const prepared = await ready(f, a.assetId); await fs.writeFile(path.join(folder, 'keep-private.txt'), 'unknown');
  const result = await f.store.garbageCollect(owner, 'film', prepared.input); assert.equal(result.physicalBytesScheduled, a.bytes.length);
  assert.equal((await f.state()).garbageCollection.pending.length, 1); assert.equal(await fs.readFile(path.join(folder, 'keep-private.txt'), 'utf8'), 'unknown');
  await f.reopen(); assert.equal((await f.state()).garbageCollection.pending.length, 1);
  await fs.unlink(path.join(folder, 'keep-private.txt')); await f.reopen();
  assert.equal((await f.state()).garbageCollection.pending.length, 0); await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
  assert.deepEqual(await f.store.garbageCollect(owner, 'film', prepared.input), result);
});
test('post-commit uncertainty retains referenced bytes and a fresh writer recovers exact GC receipt before cleanup', async t => {
  const f = await fixture(t); const a = await f.upload(); const prepared = await ready(f, a.assetId); const blob = (await f.state()).blobs[0];
  const storage = { ...fs, async rename(from, to) { await fs.rename(from, to); throw new Error('uncertain private disk'); } };
  await f.reopen({ storage }); await assert.rejects(f.store.garbageCollect(owner, 'film', prepared.input), { code: 'asset-storage-uncertain' });
  assert.ok((await fs.stat(path.join(f.directory, 'uploads', blob.id, '0.enc.json'))).isFile());
  await f.reopen(); const result = await f.store.garbageCollect(owner, 'film', prepared.input); assert.equal(result.logicalBytesReleased, a.bytes.length);
});
test('publication guard is source-record-bound and strict only when media is explicitly required', async t => {
  const f = await fixture(t); const a = await f.upload(); const identity = (await f.state()).uploads[0].identity;
  const manifest = { mediaDependencies: { coverage: 'complete', assets: [{ identity, required: true }] } };
  assert.equal(await f.store.withPublicationGuard(owner, 'film', check => { check(manifest, { requireMedia: true }); return 'saved'; }), 'saved');
  await assert.rejects(f.store.withPublicationGuard(owner, 'other-film', check => check(manifest, { requireMedia: true })), { code: 'asset-revision-media-missing' });
  await f.store.withPublicationGuard(owner, 'other-film', check => check(manifest));
  const wrong = { mediaDependencies: { assets: [{ identity: { ...identity, assetClass: 'proxy' }, required: true }] } };
  await assert.rejects(f.store.withPublicationGuard(owner, 'film', check => check(wrong)), { code: 'asset-revision-identity-mismatch' });
  await f.store.setArchived(owner, 'film', a.assetId, { expectedArchived: false, archived: true });
  await f.store.withPublicationGuard(owner, 'film', check => check(manifest));
  await assert.rejects(f.store.withPublicationGuard(owner, 'film', check => check(manifest, { requireMedia: true })), { code: 'asset-revision-media-missing' });
  await assert.rejects(f.store.withPublicationGuard(owner, 'film', check => check({ mediaDependencies: { coverage: 'incomplete', assets: [] } }, { requireMedia: true })), { code: 'asset-revision-media-missing' });
});
test('a fresh destination cannot deduplicate from a source project without the same current owner', async t => {
  const f = await fixture(t); await f.upload('private original bytes'); const identity = (await f.state()).uploads[0].identity;
  let sourceOwnerChecks = 0;
  await f.reopen({ authorizePolicy: async (context, projectId) => {
    if (projectId === 'film') { sourceOwnerChecks++; throw Object.assign(new Error('private'), { code: 'asset-policy-forbidden' }); }
    return { allowed: true, actorId: 'owner-id' };
  } });
  const begun = await f.store.beginUpload(owner, 'other-film', identity);
  assert.ok(sourceOwnerChecks > 0); assert.equal(begun.received.every(value => value === false), true); assert.equal(begun.complete, false);
  assert.equal((await f.state()).blobs.length, 2); await assert.rejects(f.store.completeUpload(owner, 'other-film', begun.uploadId), { code: 'upload-incomplete' });
  await assert.rejects(f.store.beginUpload(viewer, 'other-film', identity));
});
test('metadata-first canonical identities prevent a later proxy or media-type upload from poisoning originals', async t => {
  const f = await fixture(t); const bytes = Buffer.from('not uploaded yet');
  const identity = createMediaAssetIdentity({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, { assetClass: 'original' });
  f.snapshots.set('film', references('film', [{ revisionId: 'revision-1', manifestId: `sha256:${'b'.repeat(64)}`, sourceHash: 'c'.repeat(64), assets: [identity] }]));
  for (const patch of [{ assetClass: 'proxy' }, { mediaType: 'video/quicktime' }]) await assert.rejects(f.store.beginUpload(owner, 'film', { ...identity, ...patch }), { code: 'asset-identity-collision' });
  assert.equal((await f.state()).blobs.length, 0);
  assert.equal((await f.store.beginUpload(owner, 'film', identity)).received.every(value => value === false), true);
});
test('completed verification and hold receipts survive GC and same-identity reupload; retired identity changes remain refused', async t => {
  const f = await fixture(t, { workerActorContext: () => owner }); const a = await f.upload('completed verification');
  await f.store.setHold(owner, 'film', a.assetId, holdInput());
  await f.store.setHold(owner, 'film', a.assetId, { expectedVersion: 1, held: false, reason: null, until: null, idempotencyKey: 'release' });
  const job = await f.store.submitVerificationJob(owner, 'film', { assetId: a.assetId, idempotencyKey: 'verify-first' });
  const worker = createAssetVerificationWorker({ worker: f.store.worker }); await worker.tick(); await worker.stop();
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'succeeded');
  const identity = (await f.state()).uploads[0].identity; const prepared = await ready(f, a.assetId);
  await f.store.garbageCollect(owner, 'film', prepared.input); await f.reopen();
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'succeeded');
  await assert.rejects(f.store.beginUpload(owner, 'film', { ...identity, assetClass: 'proxy' }), { code: 'asset-identity-collision' });
  await f.upload('completed verification'); await f.reopen();
  assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 2);
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'succeeded');
});
test('reference leases avoid normal authorization reentrancy and inconsistent pending geometry fails closed', async t => {
  const f = await fixture(t); const a = await f.upload();
  await f.reopen({ authorize: async (...args) => { assert.equal(f.inLease(), false); return f.authorize(...args); },
    authorizePolicy: async (...args) => { assert.equal(f.inLease(), false); return f.authorizePolicy(...args); } });
  const prepared = await ready(f, a.assetId); const blob = (await f.state()).blobs[0]; const folder = path.join(f.directory, 'uploads', blob.id);
  await fs.writeFile(path.join(folder, 'keep.txt'), 'unknown'); await f.store.garbageCollect(owner, 'film', prepared.input); await f.store.close();
  const corrupted = await f.state(); corrupted.garbageCollection.pending[0].blob.hashes = []; await f.saveState(corrupted);
  await assert.rejects(f.open(), { code: 'asset-state-invalid' }); assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), 'unknown');
});
test('active verification blocks cleanup until an explicit cancellation retires its lease and queue entry', async t => {
  const f = await fixture(t); const a = await f.upload();
  const job = await f.store.submitVerificationJob(owner, 'film', { assetId: a.assetId, idempotencyKey: 'verify-pending' });
  const prepared = await ready(f, a.assetId); assert.equal(prepared.plan.ready, false); assert.deepEqual(prepared.plan.items[0].blockers, ['verification-active']);
  await assert.rejects(f.store.garbageCollect(owner, 'film', prepared.input), { code: 'asset-gc-blocked' });
  await f.store.cancelVerificationJob(owner, 'film', job.id, { expectedRun: 1, idempotencyKey: 'cancel-before-cleanup' });
  const report = await f.store.getOwnerAssetReport(owner, 'film', page);
  const plan = await f.store.planGarbageCollection(owner, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash });
  await f.store.garbageCollect(owner, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash, planId: plan.planId, idempotencyKey: 'after-cancel' });
  assert.equal((await f.store.getVerificationJob(owner, 'film', job.id)).status, 'cancelled');
});
