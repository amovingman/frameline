'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { describeResolveHistoryChanges } = require('../src/resolve-history-detail');
const { describeResolveHistoryAudit } = require('../src/resolve-history-detail');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const { createHash } = require('node:crypto');
const { portableTrialAuditHash } = require('../src/resolve-portable-trial-audit');

const fixture = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'live-mapping-before-schema3.json');

test('observation details filter the entire verified diff before the display limit', async () => {
  const original = JSON.parse(await fs.readFile(fixture, 'utf8'));
  const changed = structuredClone(original);
  const template = changed.timelines[0].items[0];
  for (let index = 0; index < 101; index++) changed.timelines[0].items.push({
    ...structuredClone(template), id: `synthetic-video-${String(index).padStart(3, '0')}`,
    name: `Synthetic ${index}`, linked_item_ids: []
  });
  changed.timelines[0].items.push({ ...structuredClone(template), id: 'zz-synthetic-audio',
    name: 'Synthetic audio', type: 'audio', track_type: 'audio', track_index: 1, linked_item_ids: [] });
  const before = createResolveRevisionManifest(original);
  const after = createResolveRevisionManifest(changed);
  const all = describeResolveHistoryChanges(before, after);
  assert.equal(all.changeCount, 102);
  assert.equal(all.changes.length, 100);
  assert.deepEqual(all.options.tracks, ['A1', 'V1']);
  const audio = describeResolveHistoryChanges(before, after, { track: 'A1', status: 'added' });
  assert.equal(audio.filteredCount, 1);
  assert.equal(audio.changes[0].itemName, 'Synthetic audio');
  assert.equal(audio.changes[0].timelineName, original.timelines[0].name);
  assert.equal(describeResolveHistoryChanges(before, after, { kind: 'item-deleted' }).filteredCount, 0);
  assert.throws(() => describeResolveHistoryChanges(before, after, { unknown: 'x' }),
    { code: 'resolve-history-filter-invalid' });
});

async function audited({ count = 25, effects = false, recovered = false } = {}) {
  const directory = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'live-rename-before-schema3.json')));
  const base = structuredClone(snapshot), incoming = structuredClone(snapshot);
  for (let index = 0; index < Math.max(count, 1); index++) {
    if (count) base.timelines[0].items[index].name = `Earlier clip ${index}`;
    incoming.timelines[0].items[index].name = `Incoming clip ${index}`;
  }
  const sources = { base: JSON.stringify(base), local: JSON.stringify(snapshot), incoming: JSON.stringify(incoming) };
  const plan = createResolvePreviewPlan(sources);
  const conflicts = createResolveConflictReview(plan, sources).conflicts;
  // Only the first item is selected incoming; the remaining choices preserve local work.
  const review = createResolveDecisionAudit(plan, sources, conflicts.map(conflict => ({ conflictId: conflict.id,
    choice: conflict.itemId === snapshot.timelines[0].items[0].id ? 'take-incoming' : 'keep-local' })));
  const derived = resolveReviewedRename({ sources, plan, audit: review });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const transactionId = 'a'.repeat(32), stamp = '2026-11-17T20:00:00.000Z';
  const issuedRecord = JSON.stringify({ transactionId, forceFailure: true, issuedAt: stamp, recoveryVersion: 1,
    backup: { schemaVersion: 1, sha256: 'b'.repeat(64), size: 300, mode: 0o600, timelineCount: 1, archiveVerified: true } });
  const resultSnapshot = `${JSON.stringify(snapshot)}\n`;
  const effectBytes = effects ? await fs.readFile(path.join(directory, 'live-effects-enabled.json'), 'utf8') : null;
  const audit = { schemaVersion: 1, kind: 'resolve-rename-trial-audit', readOnly: true, safeToApply: false,
    nativeBackupIncluded: false, provenance: 'copied-console-observation', transactionId, sources, review, issuedRecord,
    outcome: { status: recovered ? 'source-verified' : 'rolled-back', recordedAt: stamp,
      sourceSha256: hash(derived.beforeBytes), incomingSha256: hash(derived.afterBytes), resultingSnapshotSha256: hash(resultSnapshot),
      validation: 'observed-fields-only', effectObservation: effects ? { sourceSha256: hash(effectBytes), resultingSha256: hash(effectBytes),
        validation: 'observed-effect-metadata-only' } : null }, resultSnapshot,
    effects: effects ? { before: effectBytes, after: effectBytes } : null, recovery: null };
  if (recovered) {
    const revocation = JSON.stringify({ schemaVersion: 1, transactionId, issuedSha256: hash(issuedRecord), backupSha256: 'b'.repeat(64) });
    audit.recovery = { binding: { attemptId: 'c'.repeat(32), revocationSha256: hash(revocation), inspectionSha256: hash(effectBytes), operation: 'verify-source' },
      inspection: effectBytes, revocation };
  }
  return createResolveRevisionManifest(snapshot, audit);
}

test('saved audit details expose paged decisions with exact source values and clip context', async () => {
  const manifest = await audited(), before = JSON.stringify(manifest);
  const first = describeResolveHistoryAudit(manifest), second = describeResolveHistoryAudit(manifest, first.nextOffset);
  assert.equal(first.choiceCount, 25); assert.equal(first.choices.length, 20); assert.equal(second.choices.length, 5);
  assert.equal(first.previousOffset, null); assert.equal(first.nextOffset, 20);
  assert.equal(second.previousOffset, 0); assert.equal(second.nextOffset, null);
  const choices = [...first.choices, ...second.choices];
  assert.equal(new Set(choices.map(choice => choice.conflictId)).size, 25);
  const incoming = choices.find(choice => choice.choice === 'take-incoming');
  assert.equal(incoming.selected.text, incoming.incoming.text);
  assert.equal(incoming.base.text, '"Earlier clip 0"');
  assert.equal(incoming.itemName, manifest.snapshot.timelines[0].items[0].name);
  assert.equal(incoming.timelineName, manifest.snapshot.timelines[0].name); assert.equal(incoming.track, 'V1');
  const local = choices.find(choice => choice.choice === 'keep-local'); assert.equal(local.selected.text, local.local.text);
  assert.equal(first.status, 'rolled-back'); assert.equal(first.readOnly, true); assert.equal(first.safeToApply, false);
  assert.equal(first.effects, null); assert.equal(first.backup.availability, 'not-checked'); assert.equal(first.backup.included, false);
  assert.equal(first.sourceHashes.local, manifest.transactionAudit.review.binding.hashes.local);
  assert(!JSON.stringify(first).includes('issuedRecord')); assert(!JSON.stringify(first).includes('resultSnapshot"'));
  first.sourceHashes.local = 'changed view'; assert.equal(JSON.stringify(manifest), before);
});

test('recovered audit details distinguish zero choices, effect evidence and source verification', async () => {
  const manifest = await audited({ count: 0, effects: true, recovered: true });
  const detail = describeResolveHistoryAudit(manifest);
  assert.equal(detail.choiceCount, 0); assert.deepEqual(detail.choices, []); assert.equal(detail.nextOffset, null);
  assert.equal(detail.status, 'source-verified'); assert.equal(detail.recovery.operation, 'verify-source');
  assert.equal(detail.effects.effectCount, 1); assert.equal(detail.effects.itemCount, 53);
  assert.equal(detail.effects.sourceHash, detail.effects.resultHash);
  assert.equal(detail.auditHash, manifest.transactionAuditHash);
});

test('audit inspection rejects semantic tampering even with a new outer hash and preserves legacy uncertainty', async () => {
  const manifest = await audited({ count: 1 });
  for (const offset of [-1, 1, 1.5, '0', Infinity]) assert.throws(() => describeResolveHistoryAudit(manifest, offset));
  const legacy = createResolveRevisionManifest(manifest.snapshot);
  assert.deepEqual(describeResolveHistoryAudit(legacy), { available: false, readOnly: true, safeToApply: false });
  const corrupt = structuredClone(manifest); corrupt.transactionAudit.review.choices[0].selectedValue = 'Forged choice';
  corrupt.transactionAuditHash = portableTrialAuditHash(corrupt.transactionAudit);
  assert.throws(() => describeResolveHistoryAudit(corrupt), { code: 'resolve-revision-invalid' });
});
