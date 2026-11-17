'use strict';

// Recompute current proof from checked-in, named disposable Resolve captures.
// This report inventories evidence; it never upgrades a diagnostic to support.
const fs = require('node:fs');
const path = require('node:path');
const { inspectFreeExport } = require('./inspect-free-export');
const { reconcileCoverage } = require('./reconcile-free-coverage');
const { coverageFiles } = require('./coverage-free-snapshot');
const { createCandidateLedger } = require('../src/resolve-candidate-ledger');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { compareResolveManifests } = require('../src/resolve-id-diff');

const root = path.join(__dirname, 'resolve-xml-proof');
const structure = path.join(__dirname, 'compatibility-corpus');
const pair = phase => ({ snapshot: fs.readFileSync(path.join(root, `live-mapping-${phase}-schema3.json`)),
  xml: fs.readFileSync(path.join(root, `live-mapping-${phase}.fcpxmld/Info.fcpxml`)) });
const gate = (id, status, evidence) => ({ id, status, evidence });

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
  const gates = [
    gate('first-user-cohort', 'open', 'No intended-user editor/version distribution is recorded.'),
    gate('complete-timeline-enumeration', 'blocked', `Structure capture: ${structureCoverage.api.audioItems} API audio items, ${structureCoverage.xml.explicitAudioEntries} XML audio entries; linked/effect semantics unresolved.`),
    gate('release-version-corpus', 'open', 'Only the named Free 21.1.2 build is editor-backed; no release support range is declared.'),
    gate('stable-clip-and-track-identity', 'blocked', `${ledger.retained.length} retained API item IDs in paired captures; XML association is candidate-only and track identity is index-only.`),
    gate('representative-scan-write-reopen', 'open', 'Scanner observations exist; representative-project and app write/reopen measurements do not.'),
    gate('editor-choice-stop-or-revisit', 'blocked', `External Free connection was unavailable in the ${external.observedOn} local probe; evaluate an internal-script bridge or a different release target.`),
    gate('lossless-editor-fields', 'blocked', `Paired coverage leaves ${pairedCoverage.timelines[0].unobservable.length} construct/identity categories unobservable.`),
    gate('durable-sidecar-identity', 'blocked', 'No generated ID mapping survives a changed export; candidate ledger is exact-source-bound.'),
    gate('stable-id-object-matching', 'partial', `${ledger.retained.length} API IDs are retained in one project; API-to-export identity remains unproven.`),
    gate('smallest-safe-change-detection', 'partial', `${diff.changes.length} observed API-field differences; unrepresented editor fields cannot be compared.`)
  ];
  return { schemaVersion: 1, readOnly: true, safeToApply: false, releaseSupported: false,
    target: 'DaVinci Resolve Free 21.1.2 / build 21.1.20010 / macOS / FCPXML 1.10',
    sources: { ...ledger.sourceHashes, structureExport: structureCoverage.sourceHash,
      pairedCoverage: pairedCoverage.sources },
    observations: { externalFreeConnection: external.connected, apiAudioItems: structureCoverage.api.audioItems,
      xmlExplicitAudioEntries: structureCoverage.xml.explicitAudioEntries,
      retainedApiItems: ledger.retained.length, candidateStatus: ledger.status,
      observedDifferenceKinds: diffKinds }, gates };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(auditFirstEditor(), null, 2)}\n`); }
  catch { process.stderr.write('first-editor-audit-failed\n'); process.exitCode = 1; }
}

module.exports = { auditFirstEditor };
