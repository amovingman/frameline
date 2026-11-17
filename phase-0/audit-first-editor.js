'use strict';

// Recompute current proof from checked-in, named disposable Resolve captures.
// This report inventories evidence; it never upgrades a diagnostic to support.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectFreeExport } = require('./inspect-free-export');
const { reconcileCoverage } = require('./reconcile-free-coverage');
const { coverageFiles } = require('./coverage-free-snapshot');
const { createCandidateLedger } = require('../src/resolve-candidate-ledger');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { compareResolveManifests } = require('../src/resolve-id-diff');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { compareResolveRecovery } = require('../src/resolve-recovery-comparison');
const { parseEffectObservation, compareEffectObservations } = require('../src/resolve-effect-observation');

const root = path.join(__dirname, 'resolve-xml-proof');
const structure = path.join(__dirname, 'compatibility-corpus');
const pair = phase => ({ snapshot: fs.readFileSync(path.join(root, `live-mapping-${phase}-schema3.json`)),
  xml: fs.readFileSync(path.join(root, `live-mapping-${phase}.fcpxmld/Info.fcpxml`)) });
const gate = (id, status, evidence) => ({ id, status, evidence });
const mixedFiles = [
  ['live-mixed-audio-video-transition-schema3.json', '4f2b6420e03d0123cfeeff93ce8ed299ff27d0b9518be5ea22498c529f372b12'],
  ['live-mixed-linked-effect-schema3.json', '21b11d8ffe6ec71635936e6b8fbffbbee2cc31486ceb42d026900a25da81a2b2']
];

function readMixedEvidence() {
  const snapshots = mixedFiles.map(([name, expectedHash]) => {
    const bytes = fs.readFileSync(path.join(root, name));
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('mixed-evidence-changed');
    const snapshot = JSON.parse(bytes);
    validateResolveSnapshot(snapshot);
    return snapshot;
  });
  const [before, after] = snapshots;
  if (before.project_id !== after.project_id || before.timelines.length !== 1
    || after.timelines.length !== 1 || before.timelines[0].id !== after.timelines[0].id) {
    throw new Error('mixed-evidence-project-mismatch');
  }
  const beforeItems = new Map(before.timelines[0].items.map(item => [item.id, item]));
  const items = after.timelines[0].items;
  const byId = new Map(items.map(item => [item.id, item]));
  const linked = items.filter(item => item.linked_item_ids.length);
  const reciprocalPairs = linked.filter(item => item.linked_item_ids.length === 1
    && byId.get(item.linked_item_ids[0])?.linked_item_ids.includes(item.id)).length / 2;
  const ofxCountChanges = items.filter(item => beforeItems.has(item.id)
    && item.effect_counts.ofx !== beforeItems.get(item.id).effect_counts.ofx).length;
  return { hashes: { mixedBefore: mixedFiles[0][1], mixedAfter: mixedFiles[1][1] },
    itemCounts: { video: items.filter(item => item.type === 'video').length,
      audio: items.filter(item => item.type === 'audio').length,
      transition: items.filter(item => item.type === 'transition').length },
    reciprocalLinkedPairs: reciprocalPairs, ofxCountChanges };
}

function readRecoveryEvidence() {
  const read = (filename, expectedHash) => {
    const bytes = fs.readFileSync(path.join(root, filename));
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('recovery-evidence-changed');
    validateResolveSnapshot(JSON.parse(bytes));
    return bytes;
  };
  const originalHash = '654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850';
  const appliedHash = '7655ea985e1033860f194f3e94b3e4f4c32147d71af4a98552d1cebf2021c9a9';
  const original = read('live-rename-before-schema3.json', originalHash);
  const reopenedApplied = read('live-rename-reopened-applied-schema3.json', appliedHash);
  const reopenedRollback = read('live-rename-reopened-rolled-back-schema3.json', originalHash);
  const changes = compareResolveRecovery(original, reopenedApplied).changes;
  if (changes.length !== 1 || changes[0].kind !== 'item-changed' || changes[0].field !== 'name'
    || !original.equals(reopenedRollback)) throw new Error('recovery-evidence-mismatch');
  const desktopBytes = fs.readFileSync(path.join(__dirname, 'desktop-rename-drill-live-observation.json'));
  if (createHash('sha256').update(desktopBytes).digest('hex') !== 'b5d41651bee1efb3e46a157e96b4deca6160b2be4bc96cf634bd34d31206f612') throw new Error('desktop-drill-evidence-changed');
  const desktop = JSON.parse(desktopBytes);
  if (desktop.desktopIntegrated !== true || desktop.forcedFailure !== true || desktop.status !== 'rolled-back'
    || desktop.sourceSha256 !== originalHash || desktop.resultingSnapshotSha256 !== originalHash || !desktop.revisionId) throw new Error('desktop-drill-evidence-mismatch');
  return { sourceHash: originalHash, reopenedAppliedHash: appliedHash, reopenedRollbackHash: originalHash,
    observedAppliedChanges: changes.length, changedField: changes[0].field,
    rollbackObservedBytesMatch: true, desktopRollbackDrillVerified: true, fullProjectApplyVerified: false };
}

function readNativeControlEvidence() {
  const files = [
    ['native-no-edit-control-live-observation.json', 'a37bc5a77cc0897a000d315b98d63e0721efcfdb40cff7561654020fb1e00f97'],
    ['native-rename-control-comparison-live-observation.json', 'e00ff1771f4911e2a2be13940e82b2066f236544ca8e3f7757b584a3f0b6d5ce']
  ];
  const [control, comparison] = files.map(([name, hash]) => {
    const bytes = fs.readFileSync(path.join(__dirname, name));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('native-control-evidence-changed');
    const report = JSON.parse(bytes);
    if (report.readOnly !== true || report.safeToApply !== false || report.losslessValidated !== false) throw new Error('invalid-native-evidence');
    return report;
  });
  const count = report => report.members.filter(member => member.status !== 'unchanged').length;
  if (count(control) !== control.changedMembers || count(comparison.edit) !== comparison.edit.changedMembers
    || control.before.sha256 !== comparison.control.before.sha256 || control.after.sha256 !== comparison.control.after.sha256) {
    throw new Error('native-control-evidence-mismatch');
  }
  const commonOpaqueKinds = [];
  const editOnlyNameKinds = [];
  for (const member of comparison.tagEvidence) {
    const edit = comparison.edit.members.find(value => value.memberNameSha256 === member.memberNameSha256);
    const noEdit = comparison.control.members.find(value => value.memberNameSha256 === member.memberNameSha256);
    const editTags = Object.keys(edit?.changedLineTags || {});
    const controlTags = Object.keys(noEdit?.changedLineTags || {});
    const common = editTags.filter(tag => controlTags.includes(tag)).sort();
    if (JSON.stringify(common) !== JSON.stringify(member.commonTags)) throw new Error('native-control-tags-mismatch');
    if (common.includes('FieldsBlob') || common.includes('Body')) commonOpaqueKinds.push(member.kind);
    if (editTags.includes('Name') && !controlTags.includes('Name')) editOnlyNameKinds.push(member.kind);
  }
  return { hashes: { nativeControlReport: files[0][1], nativeComparisonReport: files[1][1] },
    changedDuringEdit: count(comparison.edit), changedDuringNoEditControl: count(control),
    commonOpaqueKinds: commonOpaqueKinds.sort(), editOnlyNameKinds: editOnlyNameKinds.sort(),
    observedControlSnapshotSha256: control.observedSnapshotSha256, semanticEquivalenceProven: false };
}

function readEffectEvidence() {
  const hashes = { enabled: '696ee1b32e09ff410f54ed4905c2423cc228437654511117f86d31ad4070f585',
    disabled: '7b5cbe4ebe91f915e58b060f86a6f4eacf3daeb7750f3e9a78ce3a0e50b4728d',
    restored: '696ee1b32e09ff410f54ed4905c2423cc228437654511117f86d31ad4070f585' };
  const bytes = Object.fromEntries(Object.entries(hashes).map(([phase, hash]) => {
    const source = fs.readFileSync(path.join(root, `live-effects-${phase}.json`));
    if (createHash('sha256').update(source).digest('hex') !== hash) throw new Error('effect-evidence-changed');
    parseEffectObservation(source);
    return [phase, source];
  }));
  const observation = parseEffectObservation(bytes.enabled);
  const diff = compareEffectObservations(bytes.enabled, bytes.disabled);
  if (diff.snapshotChanges.length !== 0 || diff.effectChanges.length !== 1
    || diff.effectChanges[0].field !== 'enabled' || diff.effectChanges[0].before !== true
    || diff.effectChanges[0].after !== false || !bytes.enabled.equals(bytes.restored)) throw new Error('effect-evidence-mismatch');
  return { hashes, observedItems: observation.items.length,
    observedEffects: observation.items.reduce((sum, item) => sum + item.effects.length, 0),
    enabledStateChanges: diff.effectChanges.length, schema3Changes: diff.snapshotChanges.length,
    restoredBytesMatch: true, effectParametersObserved: false, persistentEffectIdentityProven: false };
}

function readEffectGuardEvidence(effects, recovery) {
  const bytes = fs.readFileSync(path.join(__dirname, 'effect-guard-rename-live-observation.json'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== 'dae8e1491cf1f4fb116249a5e2b4b34f8cfd1fb1c4a412bea9e2f08619ca7b2a') throw new Error('effect-guard-evidence-changed');
  const report = JSON.parse(bytes);
  const before = fs.readFileSync(path.join(root, 'live-effects-enabled.json'));
  const disabled = fs.readFileSync(path.join(root, 'live-effects-disabled.json'));
  const diff = compareEffectObservations(before, disabled);
  if (report.schemaVersion !== 1 || report.safeToApply !== false || report.losslessValidated !== false
    || report.sourceSha256 !== recovery.sourceHash || report.resultingSnapshotSha256 !== recovery.sourceHash
    || report.effectObservation.sourceSha256 !== effects.hashes.enabled
    || report.effectObservation.resultingSha256 !== effects.hashes.restored
    || report.rejectedEffectObservationSha256 !== effects.hashes.disabled
    || report.staleCommandRejected !== true || report.staleCommandConsumed !== false || report.staleClipNameUnchanged !== true
    || report.staleSchema3Changes !== diff.snapshotChanges.length
    || JSON.stringify(report.staleEffectChanges) !== JSON.stringify(diff.effectChanges)
    || report.forcedFailure !== true || report.status !== 'rolled-back' || report.savedAndReopened !== true
    || report.backup.archiveVerified !== true || report.backup.mode !== 0o600 || report.desktopIntegrated !== false) {
    throw new Error('effect-guard-evidence-mismatch');
  }
  return { hash, staleCommandRejected: true, staleSchema3Changes: 0, staleEffectChanges: diff.effectChanges.length,
    rollbackEffectBytesMatch: true, desktopIntegrated: false, fullProjectApplyVerified: false };
}

function readDesktopEffectEvidence(effects, recovery) {
  const bytes = fs.readFileSync(path.join(__dirname, 'desktop-effect-guard-live-observation.json'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== '7239b53ade532f4ab646033164292cb9ab5959813e951da216fa74dc73cb6a69') throw new Error('desktop-effect-evidence-changed');
  const report = JSON.parse(bytes);
  if (report.schemaVersion !== 1 || report.desktopIntegrated !== true || report.forcedFailure !== true
    || report.safeToApply !== false || report.losslessValidated !== false || report.status !== 'rolled-back'
    || report.sourceSha256 !== recovery.sourceHash || report.resultingSnapshotSha256 !== recovery.sourceHash
    || report.effectObservation.sourceSha256 !== effects.hashes.enabled
    || report.effectObservation.resultingSha256 !== effects.hashes.restored
    || report.effectObservation.validation !== 'observed-effect-metadata-only'
    || report.invalidResultRejected !== true || report.backup.archiveVerified !== true || report.backup.mode !== 0o600
    || !/^[a-f0-9-]{36}$/.test(report.revisionId) || !/^[a-f0-9]{64}$/.test(report.revisionRecordHash)) {
    throw new Error('desktop-effect-evidence-mismatch');
  }
  return { hash, desktopIntegrated: true, rollbackEffectBytesMatch: true, invalidResultRejected: true,
    outcomeRevisionRecorded: true, fullProjectApplyVerified: false };
}

function auditFirstEditor() {
  const external = JSON.parse(fs.readFileSync(path.join(__dirname, 'external-api-observation.json'), 'utf8'));
  if (external.schemaVersion !== 1 || external.readOnly !== true || external.edition !== 'Free'
    || external.editorVersion !== '21.1.2' || external.editorBuild !== '21.1.20010'
    || external.platform !== 'macOS' || external.connected !== false
    || external.reason !== 'external-connection-unavailable') throw new Error('invalid-external-observation');
  const structureCoverage = reconcileCoverage(
    JSON.parse(fs.readFileSync(path.join(structure, 'live-structure-api.json'), 'utf8')),
    inspectFreeExport(path.join(structure, 'resolve-structure-live.fcpxmld')));
  const before = pair('before'), after = pair('after');
  const beforeSnapshot = JSON.parse(before.snapshot), afterSnapshot = JSON.parse(after.snapshot);
  const timelineId = beforeSnapshot.timelines[0]?.id;
  const ledger = createCandidateLedger({ beforeSnapshotBytes: before.snapshot,
    beforeExportBytes: before.xml, afterSnapshotBytes: after.snapshot,
    afterExportBytes: after.xml, timelineId });
  const pairedCoverage = coverageFiles(path.join(root, 'live-mapping-before-schema3.json'),
    path.join(root, 'live-mapping-before.fcpxmld'));
  const diff = compareResolveManifests(normalizeResolveSnapshot(beforeSnapshot), normalizeResolveSnapshot(afterSnapshot));
  const diffKinds = Object.fromEntries([...new Set(diff.changes.map(change => change.kind))].sort()
    .map(kind => [kind, diff.changes.filter(change => change.kind === kind).length]));
  const mixed = readMixedEvidence();
  const recovery = readRecoveryEvidence();
  const native = readNativeControlEvidence();
  const effects = readEffectEvidence();
  const effectGuard = readEffectGuardEvidence(effects, recovery);
  const desktopEffects = readDesktopEffectEvidence(effects, recovery);
  if (native.observedControlSnapshotSha256 !== recovery.sourceHash) throw new Error('native-control-snapshot-mismatch');
  const gates = [
    gate('first-user-cohort', 'open', 'No intended-user editor/version distribution is recorded.'),
    gate('complete-timeline-enumeration', 'blocked', `Mixed API capture: ${mixed.itemCounts.video} video, ${mixed.itemCounts.audio} audio, ${mixed.itemCounts.transition} transition items, ${mixed.reciprocalLinkedPairs} reciprocal linked pair. A supplement observes ${effects.observedEffects} effect type ID, enabled state, and index; effect parameters, persistent effect identity, nested content, and complete XML coverage remain unresolved.`),
    gate('release-version-corpus', 'open', 'Only the named Free 21.1.2 build is editor-backed; no release support range is declared.'),
    gate('stable-clip-and-track-identity', 'blocked', `${ledger.retained.length} retained API item IDs in paired captures; XML association is candidate-only and track identity is index-only.`),
    gate('representative-scan-write-reopen', 'partial', 'One disposable rename and its rollback retain exact observed bytes after separate project close/reopens; representative-project and desktop transaction measurements remain open.'),
    gate('editor-choice-stop-or-revisit', 'blocked', `External Free connection was unavailable in the ${external.observedOn} local probe; the internal Lua Console bridge now captures read-only fixtures, but safe apply and full coverage remain unproven.`),
    gate('lossless-editor-fields', 'blocked', `Paired coverage leaves ${pairedCoverage.timelines[0].unobservable.length} construct/identity categories unobservable. Native edit and no-edit control each change ${native.changedDuringNoEditControl} members; common opaque line tags do not prove semantic equivalence.`),
    gate('durable-sidecar-identity', 'blocked', 'No generated ID mapping survives a changed export; candidate ledger is exact-source-bound.'),
    gate('stable-id-object-matching', 'partial', `${ledger.retained.length} API IDs are retained in one project; API-to-export identity remains unproven.`),
    gate('smallest-safe-change-detection', 'partial', `${diff.changes.length} observed API-field differences; unrepresented editor fields cannot be compared.`)
  ];
  return { schemaVersion: 1, readOnly: true, safeToApply: false, releaseSupported: false,
    target: 'DaVinci Resolve Free 21.1.2 / build 21.1.20010 / macOS / FCPXML 1.10',
    sources: { ...ledger.sourceHashes, ...mixed.hashes, ...native.hashes, effectReports: effects.hashes,
      effectGuardReport: effectGuard.hash, desktopEffectGuardReport: desktopEffects.hash, structureExport: structureCoverage.sourceHash,
      pairedCoverage: pairedCoverage.sources },
    observations: { externalFreeConnection: external.connected, apiAudioItems: structureCoverage.api.audioItems,
      xmlExplicitAudioEntries: structureCoverage.xml.explicitAudioEntries,
      mixedConstructs: { ...mixed.itemCounts, reciprocalLinkedPairs: mixed.reciprocalLinkedPairs,
        ofxCountChanges: mixed.ofxCountChanges },
      retainedApiItems: ledger.retained.length, candidateStatus: ledger.status,
      recovery, effectMetadata: { observedItems: effects.observedItems, observedEffects: effects.observedEffects,
        enabledStateChanges: effects.enabledStateChanges, schema3Changes: effects.schema3Changes,
        restoredBytesMatch: effects.restoredBytesMatch, effectParametersObserved: false, persistentEffectIdentityProven: false },
      effectGuard: { staleCommandRejected: effectGuard.staleCommandRejected, staleSchema3Changes: effectGuard.staleSchema3Changes,
        staleEffectChanges: effectGuard.staleEffectChanges, rollbackEffectBytesMatch: effectGuard.rollbackEffectBytesMatch,
        desktopIntegrated: false, fullProjectApplyVerified: false },
      desktopEffectGuard: { desktopIntegrated: desktopEffects.desktopIntegrated, rollbackEffectBytesMatch: desktopEffects.rollbackEffectBytesMatch,
        invalidResultRejected: desktopEffects.invalidResultRejected, outcomeRevisionRecorded: desktopEffects.outcomeRevisionRecorded,
        fullProjectApplyVerified: false },
      nativeContent: { changedDuringEdit: native.changedDuringEdit,
        changedDuringNoEditControl: native.changedDuringNoEditControl, commonOpaqueKinds: native.commonOpaqueKinds,
        editOnlyNameKinds: native.editOnlyNameKinds, semanticEquivalenceProven: false }, observedDifferenceKinds: diffKinds }, gates };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(auditFirstEditor(), null, 2)}\n`); }
  catch { process.stderr.write('first-editor-audit-failed\n'); process.exitCode = 1; }
}

module.exports = { auditFirstEditor };
