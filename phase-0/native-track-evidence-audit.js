'use strict';
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { parseEffectObservation, compareEffectObservations } = require('../src/resolve-effect-observation');
const { verifyNativeRetention } = require('./prepare-native-track-challenge');
const ROOT = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const FILES = ['phase-0/resolve-native-track-identity.py', 'phase-0/resolve-native-track-challenge.lua',
  'phase-0/prepare-native-track-challenge.js', 'src/companion/resolve-internal.lua',
  'src/companion/resolve-effects.lua', 'src/resolve-property-contract.json'];
const RAW_SHA = '15bcde8f20413bccfa0782c4e72300ed37f913313ec76568134cd06e439f3571';
const GRAPHS_SHA = 'f75eb9fde263dcbe70870f07e9db155a51d9d224eaadc30e62ee8be55cd49bcd';

function auditNativeTrackEvidence(read = readInput) {
  const observationFile = 'phase-0/native-track-challenge-live-observation.json';
  const report = JSON.parse(read(path.join(ROOT, observationFile)));
  if (report.resultFile !== 'phase-0/native-track-challenge-live-result.json.gz' || report.status !== 'restored'
    || report.safeToApply !== false || report.ordinaryApplySupported !== false
    || Object.keys(report.sourceHashes).sort().join(',') !== [...FILES].sort().join(',')) throw new Error('invalid-native-track-evidence');
  for (const filename of FILES) if (sha(read(path.join(ROOT, filename))) !== report.sourceHashes[filename]) throw new Error('native-track-evidence-source-changed');
  const compressed = read(path.join(ROOT, report.resultFile));
  if (sha(compressed) !== report.compressedSha256) throw new Error('native-track-evidence-compression-changed');
  const raw = gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
  if (sha(raw) !== RAW_SHA || report.resultSha256 !== RAW_SHA || raw.length !== report.resultBytes
    || sha(json(report.graphs)) !== GRAPHS_SHA) throw new Error('native-track-evidence-changed');
  const result = JSON.parse(raw);
  if (result.status !== 'restored' || result.stage !== 'complete' || result.representedStateRestored !== true
    || result.safeToApply !== false || result.ordinaryApplySupported !== false) throw new Error('invalid-native-track-outcome');
  const states = Object.fromEntries(['before', 'challenged', 'reopened', 'restored'].map(name => [name, parseEffectObservation(JSON.stringify(result[name]))]));
  if (json(states.before) !== json(states.restored) || json(states.challenged) !== json(states.reopened)
    || states.before.snapshot.timelines.length !== 1 || states.before.snapshot.timelines[0].items.length !== 50
    || new Set(states.before.snapshot.timelines[0].tracks.map(track => track.name)).size !== 1) throw new Error('native-track-restoration-differs');
  const diff = compareEffectObservations(JSON.stringify(states.before), JSON.stringify(states.challenged));
  if (diff.snapshotChanges.length !== 5 || !diff.snapshotChanges.every(row => row.kind === 'track-changed' && row.field === 'name')
    || diff.propertyChanges.length || diff.effectChanges.length || diff.trackStateChanges.length || diff.activeTimelineChange !== null) throw new Error('native-track-unrelated-change');
  const retention = verifyNativeRetention(report.graphs.before, report.graphs);
  if (retention.emptyTrackChallengeBindings !== 4 || report.graphs.challenged.apiBindings.length !== 5) throw new Error('native-track-binding-differs');
  return { schemaVersion: 1, readOnly: true, safeToApply: false, operation: 'audit-native-track-name-proof',
    resultSha256: RAW_SHA, nativeGraphFactsSha256: GRAPHS_SHA, projectId: report.projectId,
    itemCount: 50, nativeTrackCount: 5, controlledEmptyTrackBindings: 4,
    representedStateRestored: true, nativeTrackIdsRetainedAcrossNameSaveReopen: true,
    rawObservationProofRecomputed: true, publicNativeGraphConsistencyVerified: true,
    nativeGraphsRecomputedFromArchives: false, nativeArchiveSourcesPrivate: true,
    sourceHashes: report.sourceHashes, stableTrackIdentityProven: false,
    indexShiftPersistenceProven: false, deleteRecreateNegativeControlProven: false,
    fullNativePreservationProven: false, ordinaryApplySupported: false,
    limitations: ['Private native archive hashes and observed graph facts are pinned; their original archive bytes are not committed.',
      'Public graph consistency is recomputed, not independently reconstructed from private native archives.',
      'This proves only the named disposable name/save/reopen challenge; broader identity and write gates stay open.'] };
}
module.exports = { auditNativeTrackEvidence };
