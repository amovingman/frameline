'use strict';
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { readInput } = require('./integration-input');
const { loadCalibration, joinCalibratedTracks, json, sha } = require('./native-track-readonly-join');
const ROOT = path.resolve(__dirname, '..');
const RAW_SHA = '97bac67a48fee81d0f76c540cc9832d0cd2c1655ff606706dd69f9c7059ddb98';
const GRAPHS_SHA = '533564bd63a00788ce7912f633518c875fd2a50f44f30fe8ef874c8bd08897fc';
const ISSUED_SOURCE_SHA = '5f925e0a65e204ffebe2e1acdf439d6cc41a497d7973f6cf0c8170a20466fb16';
const SOURCES = ['phase-0/prepare-native-track-readonly.js', 'phase-0/resolve-native-track-readonly.lua',
  'phase-0/native-track-readonly-join.js', 'phase-0/resolve-native-track-identity.py', 'phase-0/compare-native-resolve-exports.py',
  'src/companion/resolve-internal.lua', 'src/companion/resolve-effects.lua', 'src/resolve-property-contract.json'];

function auditNativeTrackReadOnlyEvidence(read = readInput) {
  const file = name => read(path.join(ROOT, name));
  const report = JSON.parse(file('phase-0/native-track-readonly-live-observation.json'));
  if (report.status !== 'captured' || report.resultFile !== 'phase-0/native-track-readonly-live-result.json.gz'
    || report.sourceSha256 !== ISSUED_SOURCE_SHA || report.resultSha256 !== RAW_SHA || report.nativeGraphFactsSha256 !== GRAPHS_SHA
    || Object.keys(report.sourceHashes).sort().join(',') !== [...SOURCES].sort().join(',')) throw new Error('invalid-readonly-track-evidence');
  for (const source of SOURCES) if (sha(file(source)) !== report.sourceHashes[source]) throw new Error('readonly-track-source-changed');
  const compressed = file(report.resultFile), raw = gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
  if (sha(compressed) !== report.compressedSha256 || compressed.length !== report.compressedBytes
    || sha(raw) !== RAW_SHA || raw.length !== report.resultBytes || sha(json(report.graphs)) !== GRAPHS_SHA) throw new Error('readonly-track-evidence-changed');
  const result = JSON.parse(raw);
  if (result.schemaVersion !== 1 || result.operation !== 'resolve-native-track-readonly-capture' || result.status !== 'captured'
    || result.stage !== 'complete' || result.probeId !== report.probeId || result.readOnly !== true || result.safeToApply !== false
    || result.ordinaryApplySupported !== false || typeof result.pageBefore !== 'string' || result.pageBefore !== result.pageAfter
    || json(result.events) !== json(['capture-before', 'export-first', 'capture-between', 'export-second', 'capture-after'])) throw new Error('invalid-readonly-track-result');
  const joined = joinCalibratedTracks(loadCalibration(read), [result.before, result.between, result.after], [report.graphs.first, report.graphs.second]);
  for (const [key, value] of Object.entries(joined)) if (json(report[key]) !== json(value)) throw new Error('readonly-track-recomputation-differs');
  return { ...joined, operation: 'audit-native-track-readonly-evidence', resultSha256: RAW_SHA,
    nativeGraphFactsSha256: GRAPHS_SHA, issuedSourceSha256: ISSUED_SOURCE_SHA, rawObservationProofRecomputed: true,
    calibratedLocationRuleRecomputed: true, publicNativeGraphConsistencyVerified: true, nativeGraphsReconstructedFromArchives: false,
    nativeArchiveSourcesPrivate: true, sourceHashes: report.sourceHashes, installedTestScriptRemoved: report.installedTestScriptRemoved === true,
    limitations: [...joined.limitations,
      'The fresh read-only interval does not independently prove the serialization-order rule for indistinguishable empty API tracks.',
      'Public tests recompute pinned native graph facts and raw API observations; private native archive bytes and issued source are retained separately.'] };
}
module.exports = { auditNativeTrackReadOnlyEvidence };
