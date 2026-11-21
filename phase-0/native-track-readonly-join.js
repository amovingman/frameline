'use strict';
// Empirical location calibration for this exact fixture. A vector ordinal is
// never an identity: it only locates a UUID in an unchanged, calibrated graph.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { auditNativeTrackTopologyEvidence } = require('./native-track-topology-evidence-audit');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const ROOT = path.resolve(__dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const rows = graph => graph.timelines.flatMap(timeline => timeline.tracks.map(track => ({ timelineId: timeline.timelineId,
  nativeSequenceId: timeline.nativeSequenceId, ...track })));
const graphFacts = graph => ({ projectId: graph.projectId, tracks: rows(graph).map(({ timelineId, nativeSequenceId,
  nativeContainerId, nativeTrackId, kind, nativeOrdinal, nameSha256, itemIds }) => ({ timelineId, nativeSequenceId,
  nativeContainerId, nativeTrackId, kind, nativeOrdinal, nameSha256, itemIds })).sort((a, b) => a.nativeTrackId.localeCompare(b.nativeTrackId)) });

function verifyLocationCalibration(reports) {
  if (!Array.isArray(reports) || reports.length !== 4) throw new Error('incomplete-location-calibration');
  let count = 0;
  for (const [index, report] of reports.entries()) {
    const challenged = report.graphs.challenged, native = rows(challenged), bindings = challenged.apiBindings;
    if (native.length !== [5, 6, 5, 5][index] || bindings.length !== native.length
      || new Set(native.map(row => row.nativeTrackId)).size !== native.length
      || new Set(bindings.map(row => row.nativeTrackId)).size !== native.length) throw new Error('incomplete-location-calibration');
    const locations = new Set();
    for (const binding of bindings) {
      const track = native.find(row => row.nativeTrackId === binding.nativeTrackId);
      const location = `${binding.timelineId}:${binding.type}:${binding.index}`;
      if (!track || locations.has(location) || binding.status !== 'controlled-name-challenge'
        || track.timelineId !== binding.timelineId || track.kind !== binding.type || track.nativeOrdinal !== binding.index
        || track.itemIds.length !== binding.itemCount) throw new Error('location-calibration-disagrees');
      locations.add(location); count++;
    }
  }
  return { independentlyChallengedAssociations: count, graph: reports[3].graphs.restored,
    bindings: reports[3].graphs.challenged.apiBindings,
    rule: 'observed-native-vector-kind-and-current-ordinal-equals-api-kind-and-current-index',
    vendorDocumentedContract: false };
}

function loadCalibration(read = readInput) {
  // These audits pin raw challenge responses, graph facts, source hashes, and
  // the index-shift/delete-recreate chain before any location rule is evaluated.
  auditNativeTrackTopologyEvidence(read);
  return verifyLocationCalibration(['phase-0/native-track-challenge-live-observation.json',
    ...['append', 'delete', 'recreate'].map(label => `phase-0/native-track-topology-${label}-live-observation.json`)]
    .map(file => JSON.parse(read(path.join(ROOT, file)))));
}

function joinCalibratedTracks(calibration, observations, graphs) {
  if (calibration.independentlyChallengedAssociations !== 21 || calibration.vendorDocumentedContract !== false
    || observations.length !== 3 || graphs.length !== 2) throw new Error('invalid-readonly-join');
  const states = observations.map(value => parseEffectObservation(JSON.stringify(value)));
  if (json(states[0]) !== json(states[1]) || json(states[0]) !== json(states[2])) throw new Error('read-export-read-state-drift');
  const observation = states[0], snapshot = observation.snapshot;
  if (snapshot.resolve_version !== '21.1.2.10' || snapshot.project_name !== 'Frameline Integration Gate Fixture 20261120'
    || snapshot.project_id !== calibration.graph.projectId || snapshot.timelines.length !== 1
    || snapshot.timelines[0].items.length !== 50 || snapshot.timelines[0].tracks.length !== 5
    || new Set(snapshot.timelines[0].tracks.map(track => track.name)).size !== 1) throw new Error('outside-calibrated-fixture');
  const expected = graphFacts(calibration.graph);
  for (const graph of graphs) if (json(graphFacts(graph)) !== json(expected)) throw new Error('calibrated-native-graph-drift');
  const native = rows(graphs[0]), timeline = snapshot.timelines[0], bindings = [];
  if (native.length !== timeline.tracks.length || new Set(native.map(row => row.nativeTrackId)).size !== native.length
    || calibration.bindings.length !== native.length) throw new Error('incomplete-native-location-join');
  for (const api of timeline.tracks) {
    const candidates = native.filter(row => row.timelineId === timeline.id && row.kind === api.type && row.nativeOrdinal === api.index);
    const track = candidates[0], prior = calibration.bindings.find(row => row.timelineId === timeline.id && row.type === api.type && row.index === api.index);
    const itemIds = timeline.items.filter(item => item.track_type === api.type && item.track_index === api.index).map(item => item.id).sort();
    if (candidates.length !== 1 || !prior || prior.nativeTrackId !== track.nativeTrackId || track.nameSha256 !== sha(api.name)
      || json([...track.itemIds].sort()) !== json(itemIds)) throw new Error('calibrated-api-location-differs');
    bindings.push({ timelineId: timeline.id, type: api.type, index: api.index, nativeTrackId: track.nativeTrackId,
      itemCount: itemIds.length, status: 'unchanged-graph-calibrated-location', independentItemParentageWitness: itemIds.length > 0 });
  }
  if (new Set(bindings.map(row => row.nativeTrackId)).size !== native.length
    || json(native.flatMap(row => row.itemIds).sort()) !== json(timeline.items.map(item => item.id).sort())) throw new Error('incomplete-native-item-join');
  return { schemaVersion: 1, operation: 'resolve-native-track-readonly-join', readOnly: true,
    projectId: snapshot.project_id, resolveVersion: snapshot.resolve_version, bindings,
    independentlyChallengedCalibrationAssociations: 21, challengeFreeReadOnlyRebindingVerified: true,
    emptyDuplicateNameTracksBound: bindings.filter(row => row.itemCount === 0).length,
    readExportReadStateUnchanged: true, nativeGraphUnchangedSinceCalibration: true,
    nativeIdentityGraphSha256: sha(json(expected)), currentLocationRuleCalibrated: true, vendorDocumentedMappingContract: false,
    stableTrackIdentityProven: false, fullNativePreservationProven: false, safeToApply: false, ordinaryApplySupported: false,
    limitations: ['Empirical calibration is limited to this exact version, project, timeline and unchanged native identity graph.',
      'Current vector locations locate UUIDs; they never replace native UUID identity or independently distinguish identical empty API tracks.',
      'Unobserved concurrent edit-and-revert activity and undocumented future serialization changes are not excluded.',
      'No native byte rewrite, unknown-field preservation or general track mapping contract is established.'] };
}
module.exports = { loadCalibration, verifyLocationCalibration, joinCalibratedTracks, graphFacts, json, sha };
