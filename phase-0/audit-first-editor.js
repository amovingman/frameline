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
  return { sourceHash: originalHash, reopenedAppliedHash: appliedHash, reopenedRollbackHash: originalHash,
    observedAppliedChanges: changes.length, changedField: changes[0].field,
    rollbackObservedBytesMatch: true, liveAppTransactionVerified: false };
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
  const gates = [
    gate('first-user-cohort', 'open', 'No intended-user editor/version distribution is recorded.'),
    gate('complete-timeline-enumeration', 'blocked', `Mixed API capture: ${mixed.itemCounts.video} video, ${mixed.itemCounts.audio} audio, ${mixed.itemCounts.transition} transition items, ${mixed.reciprocalLinkedPairs} reciprocal linked pair, ${mixed.ofxCountChanges} OFX count change; effect settings, nested content, and complete XML coverage remain unresolved.`),
    gate('release-version-corpus', 'open', 'Only the named Free 21.1.2 build is editor-backed; no release support range is declared.'),
    gate('stable-clip-and-track-identity', 'blocked', `${ledger.retained.length} retained API item IDs in paired captures; XML association is candidate-only and track identity is index-only.`),
    gate('representative-scan-write-reopen', 'partial', 'One disposable rename and its rollback retain exact observed bytes after separate project close/reopens; representative-project and desktop transaction measurements remain open.'),
    gate('editor-choice-stop-or-revisit', 'blocked', `External Free connection was unavailable in the ${external.observedOn} local probe; the internal Lua Console bridge now captures read-only fixtures, but safe apply and full coverage remain unproven.`),
    gate('lossless-editor-fields', 'blocked', `Paired coverage leaves ${pairedCoverage.timelines[0].unobservable.length} construct/identity categories unobservable.`),
    gate('durable-sidecar-identity', 'blocked', 'No generated ID mapping survives a changed export; candidate ledger is exact-source-bound.'),
    gate('stable-id-object-matching', 'partial', `${ledger.retained.length} API IDs are retained in one project; API-to-export identity remains unproven.`),
    gate('smallest-safe-change-detection', 'partial', `${diff.changes.length} observed API-field differences; unrepresented editor fields cannot be compared.`)
  ];
  return { schemaVersion: 1, readOnly: true, safeToApply: false, releaseSupported: false,
    target: 'DaVinci Resolve Free 21.1.2 / build 21.1.20010 / macOS / FCPXML 1.10',
    sources: { ...ledger.sourceHashes, ...mixed.hashes, structureExport: structureCoverage.sourceHash,
      pairedCoverage: pairedCoverage.sources },
    observations: { externalFreeConnection: external.connected, apiAudioItems: structureCoverage.api.audioItems,
      xmlExplicitAudioEntries: structureCoverage.xml.explicitAudioEntries,
      mixedConstructs: { ...mixed.itemCounts, reciprocalLinkedPairs: mixed.reciprocalLinkedPairs,
        ofxCountChanges: mixed.ofxCountChanges },
      retainedApiItems: ledger.retained.length, candidateStatus: ledger.status,
      recovery, observedDifferenceKinds: diffKinds }, gates };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(auditFirstEditor(), null, 2)}\n`); }
  catch { process.stderr.write('first-editor-audit-failed\n'); process.exitCode = 1; }
}

module.exports = { auditFirstEditor };
