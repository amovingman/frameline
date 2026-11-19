'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fingerprint } = require('../src/project-api-contracts');
const { DAY, validatePlan, validateHoldInput } = require('../src/asset-lifecycle-protocol');
const { lifecycleFixture, owner, editor, viewer, holdInput, page } = require('./fixtures/asset-lifecycle-service');
const release = (expectedVersion = 1, idempotencyKey = 'release-1') => holdInput(expectedVersion, { held: false, reason: null, until: null, idempotencyKey });

test('default retention is thirty days; lifecycle reports are bounded, owner-only and never authorize deletion', async t => {
  const f = await lifecycleFixture(t);
  assert.deepEqual(await f.store.getRetentionPolicy(owner, 'film'), { projectId: 'film', version: 0, minimumArchiveAgeMs: 30 * DAY, updatedAt: null });
  assert.deepEqual((await f.store.getLifecycleReport(owner, 'film', page)).items, []);
  const a = await f.upload(), report = await f.store.getLifecycleReport(owner, 'film', page);
  assert.deepEqual(report.items[0].blockers, ['not-archived', 'revision-references-unverified']); assert.equal(report.items[0].cleanupCandidate, false);
  for (const actor of [editor, viewer]) for (const call of [() => f.store.getHold(actor, 'film', a.assetId),
    () => f.store.setHold(actor, 'film', a.assetId, holdInput()), () => f.store.getRetentionPolicy(actor, 'film'),
    () => f.store.setRetentionPolicy(actor, 'film', { expectedVersion: 0, minimumArchiveAgeMs: 0, idempotencyKey: 'policy-1' }),
    () => f.store.getLifecycleReport(actor, 'film', page), () => f.store.planCleanup(actor, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash })]) {
    await assert.rejects(call(), error => ['forbidden', 'asset-policy-forbidden'].includes(error.code));
  }
});
test('holds persist with exact lost-ack replay, CAS updates and tombstones preventing stale resurrection', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  const first = await f.store.setHold(owner, 'film', a.assetId, holdInput()); assert.equal(first.version, 1);
  await f.reopen(); assert.deepEqual(await f.store.getHold(owner, 'film', a.assetId), first);
  const released = await f.store.setHold(owner, 'film', a.assetId, release()); assert.equal(released.held, false); assert.equal(released.version, 2);
  assert.deepEqual(await f.store.setHold(owner, 'film', a.assetId, holdInput()), first);
  assert.deepEqual(await f.store.getHold(owner, 'film', a.assetId), released);
  assert.deepEqual(await f.store.setHold(owner, 'film', a.assetId, release()), released);
  await assert.rejects(f.store.setHold(owner, 'film', a.assetId, holdInput(0, { idempotencyKey: 'stale' })), { code: 'asset-lifecycle-version-conflict' });
  await assert.rejects(f.store.setHold(owner, 'film', a.assetId, holdInput(0, { reason: 'contractual' })), { code: 'asset-lifecycle-idempotency-conflict' });
  await f.reopen(); assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 2);
});
test('hold writes require published project-scoped media, a valid reason and an unexpired deadline', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  await assert.rejects(f.store.setHold(owner, 'other-film', a.assetId, holdInput()), { code: 'asset-not-found' });
  await assert.rejects(f.store.setHold(owner, 'film', a.assetId, holdInput(0, { until: f.at })), { code: 'asset-lifecycle-invalid' });
  for (const patch of [{ reason: '/private/camera' }, { until: -1 }, { expectedVersion: -1 }, { extra: true }]) {
    assert.throws(() => validateHoldInput(holdInput(0, patch)), { code: 'asset-lifecycle-invalid' });
  }
  const hold = await f.store.setHold(owner, 'film', a.assetId, holdInput(0, { until: 2000 }));
  assert.equal(hold.until, 2000); f.advance(1001);
  assert.equal((await f.store.getLifecycleReport(owner, 'film', page)).items[0].blockers.includes('active-hold'), false);
  assert.equal((await f.store.getHold(owner, 'film', a.assetId)).held, true); // History retained after expiry.
});
test('retention persists, replays historically and versions independently of transfer-class policy', async t => {
  const f = await lifecycleFixture(t), input = { expectedVersion: 0, minimumArchiveAgeMs: DAY, idempotencyKey: 'retention-1' };
  const saved = await f.store.setRetentionPolicy(owner, 'film', input); await f.reopen();
  assert.deepEqual(await f.store.getRetentionPolicy(owner, 'film'), saved);
  await f.store.setRetentionPolicy(owner, 'film', { expectedVersion: 1, minimumArchiveAgeMs: 0, idempotencyKey: 'retention-2' });
  assert.deepEqual(await f.store.setRetentionPolicy(owner, 'film', input), saved);
  assert.equal((await f.store.getRetentionPolicy(owner, 'film')).version, 2);
  assert.equal((await f.store.getPolicy(owner, 'film')).version, 1);
  await assert.rejects(f.store.setRetentionPolicy(owner, 'film', { ...input, idempotencyKey: 'wrong-version' }), { code: 'asset-lifecycle-version-conflict' });
  await assert.rejects(f.store.setRetentionPolicy(owner, 'film', { ...input, minimumArchiveAgeMs: 3651 * DAY }), { code: 'asset-lifecycle-invalid' });
});
test('archive age, expiring holds and cross-project copies produce conservative path-free reports', async t => {
  const f = await lifecycleFixture(t), a = await f.upload('first media'), b = await f.upload('second media');
  await f.upload('second media', 'other-film');
  await f.store.setHold(owner, 'film', a.assetId, holdInput(0, { until: f.at + DAY + 10 }));
  await f.store.setRetentionPolicy(owner, 'film', { expectedVersion: 0, minimumArchiveAgeMs: DAY, idempotencyKey: 'retention-1' });
  for (const item of [a, b]) await f.store.setArchived(owner, 'film', item.assetId, { expectedArchived: false, archived: true });
  let report = await f.store.getLifecycleReport(owner, 'film', page), rows = new Map(report.items.map(item => [item.assetId, item]));
  assert.deepEqual(rows.get(a.assetId).blockers, ['retention-period', 'active-hold', 'revision-references-unverified']);
  assert.equal(rows.get(b.assetId).sharedProjects, true);
  f.advance(DAY + 11); report = await f.store.getLifecycleReport(owner, 'film', page); rows = new Map(report.items.map(item => [item.assetId, item]));
  assert.equal(rows.get(a.assetId).cleanupCandidate, true); assert.deepEqual(rows.get(a.assetId).blockers, ['revision-references-unverified']);
  assert.equal(rows.get(b.assetId).cleanupCandidate, false); assert.deepEqual(rows.get(b.assetId).blockers, ['shared-project', 'revision-references-unverified']);
  assert.doesNotMatch(JSON.stringify(report), /other-film|frameline-lifecycle-|\.mov|\/private\//);
});
test('restoring/rearchiving restarts the retention clock; duplicate archive state preserves its timestamp', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  const archive = (expectedArchived, archived) => f.store.setArchived(owner, 'film', a.assetId, { expectedArchived, archived });
  await archive(false, true); f.advance(DAY); await archive(true, true);
  assert.equal((await f.store.getLifecycleReport(owner, 'film', page)).items[0].archivedAt, 1000);
  await archive(true, false); f.advance(DAY); await archive(false, true);
  assert.equal((await f.store.getLifecycleReport(owner, 'film', page)).items[0].archivedAt, f.at);
  await f.reopen(); assert.equal((await f.store.getLifecycleReport(owner, 'film', page)).items[0].archivedAt, f.at);
});
test('cleanup plans bind reviewed state, reject mutation and keep every encrypted media byte intact', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  await f.store.setArchived(owner, 'film', a.assetId, { expectedArchived: false, archived: true });
  await f.store.setRetentionPolicy(owner, 'film', { expectedVersion: 0, minimumArchiveAgeMs: 0, idempotencyKey: 'retention-1' });
  const report = await f.store.getLifecycleReport(owner, 'film', page), before = await fs.readFile(path.join(f.directory, 'assets.enc.json'));
  const chunk = path.join(f.directory, 'uploads', a.uploadId, '0.enc.json'), chunkBefore = await fs.readFile(chunk);
  const plan = await f.store.planCleanup(owner, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash });
  assert.equal(plan.ready, false); assert.equal(plan.deletionPerformed, false); assert.equal(plan.candidateBytes, a.bytes.length);
  assert.deepEqual(plan.items[0].blockers, ['revision-references-unverified']);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), before); assert.deepEqual(await fs.readFile(chunk), chunkBefore);
  assert.throws(() => validatePlan({ ...plan, ready: true }), { code: 'asset-response-invalid' });
  await f.store.setHold(owner, 'film', a.assetId, holdInput());
  await assert.rejects(f.store.planCleanup(owner, 'film', { assetIds: [a.assetId], expectedStateHash: report.stateHash }), { code: 'asset-lifecycle-plan-stale' });
});
test('lifecycle report paging is deterministic and state hashes detect policy, archive and shared-copy changes', async t => {
  const f = await lifecycleFixture(t); const a = await f.upload('a'), b = await f.upload('b'), c = await f.upload('c');
  const first = await f.store.getLifecycleReport(owner, 'film', { afterAssetId: null, limit: 2 });
  const second = await f.store.getLifecycleReport(owner, 'film', { afterAssetId: first.nextAssetId, limit: 2 });
  assert.equal(first.stateHash, second.stateHash); assert.equal(first.items.length, 2); assert.equal(second.items.length, 1); assert.equal(second.nextAssetId, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.assetId)).size, 3);
  await f.upload('a', 'other-film'); const shared = await f.store.getLifecycleReport(owner, 'film', page); assert.notEqual(shared.stateHash, first.stateHash);
  await f.store.setArchived(owner, 'film', b.assetId, { expectedArchived: false, archived: true });
  assert.notEqual((await f.store.getLifecycleReport(owner, 'film', page)).stateHash, shared.stateHash);
  await assert.rejects(f.store.getLifecycleReport(owner, 'film', { afterAssetId: null, limit: 101 }), { code: 'asset-lifecycle-invalid' });
});
test('schema2 migration preserves archived bytes and starts unknown archive age at migration time', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  await f.store.setArchived(owner, 'film', a.assetId, { expectedArchived: false, archived: true }); await f.store.close();
  const legacy = await f.state(); legacy.schemaVersion = 2; delete legacy.lifecycle; await f.saveState(legacy);
  const bytes = await fs.readFile(path.join(f.directory, 'uploads', a.uploadId, '0.enc.json'));
  f.advance(90 * DAY); await f.reopen(); const report = await f.store.getLifecycleReport(owner, 'film', page);
  assert.equal((await f.state()).schemaVersion, 3); assert.equal(report.items[0].archivedAt, f.at);
  assert.equal(report.items[0].eligibleAt, f.at + 30 * DAY); assert.equal(report.items[0].cleanupCandidate, false);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'uploads', a.uploadId, '0.enc.json')), bytes);
});
test('fresh transactions enforce simultaneous hold CAS and recheck actor identity before acknowledging a mutation', async t => {
  const f = await lifecycleFixture(t), a = await f.upload(), other = await f.open();
  const results = await Promise.allSettled([f.store.setHold(owner, 'film', a.assetId, holdInput()), other.setHold(owner, 'film', a.assetId, holdInput(0, { idempotencyKey: 'concurrent' }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'asset-lifecycle-version-conflict');
  let count = 0; await f.reopen({ authorizePolicy: async () => ({ allowed: true, actorId: ++count > 1 ? 'other-owner' : 'owner-id' }) });
  await assert.rejects(f.store.setHold(owner, 'film', a.assetId, release()), { code: 'asset-policy-forbidden' });
  await f.reopen(); assert.equal((await f.store.getHold(owner, 'film', a.assetId)).version, 1);
});
test('uncertain hold publication blocks the writer and an exact retry recovers the one acknowledged-intent result', async t => {
  const f = await lifecycleFixture(t), a = await f.upload();
  const storage = { ...fs, async rename(from, to) { await fs.rename(from, to); throw new Error('uncertain private disk'); } };
  await f.reopen({ storage }); await assert.rejects(f.store.setHold(owner, 'film', a.assetId, holdInput()), { code: 'asset-storage-uncertain' });
  await assert.rejects(f.store.getHold(owner, 'film', a.assetId), { code: 'asset-storage-uncertain' });
  await f.reopen(); const result = await f.store.setHold(owner, 'film', a.assetId, holdInput()); assert.equal(result.version, 1);
  assert.equal((await f.state()).lifecycle.receipts.length, 1);
});
test('lifecycle records stay encrypted and inconsistent holds, archive clocks or receipts fail closed', async t => {
  for (const kind of ['hold', 'archive', 'receipt']) await t.test(kind, async t => {
    const f = await lifecycleFixture(t), a = await f.upload(); await f.store.setHold(owner, 'film', a.assetId, holdInput());
    await f.store.setArchived(owner, 'film', a.assetId, { expectedArchived: false, archived: true });
    const text = await fs.readFile(path.join(f.directory, 'assets.enc.json'), 'utf8'); assert.equal(text.includes(a.assetId), false); assert.equal(text.includes('manual'), false);
    await f.store.close(); const state = await f.state();
    if (kind === 'hold') state.lifecycle.holds[0].held = false;
    else if (kind === 'archive') state.lifecycle.archives = [];
    else state.lifecycle.receipts[0].requestHash = 'f'.repeat(64);
    await f.saveState(state); const before = await fs.readFile(path.join(f.directory, 'assets.enc.json'));
    await assert.rejects(f.open(), { code: 'asset-state-invalid' }); assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), before);
  });
});
