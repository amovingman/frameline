'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { readInput } = require('./integration-input');
const PROFILE = 'resolve-free-21.1.2.10-video-audio-v1';
const VERSION = '21.1.2.10';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const sorted = values => [...values].sort();

function bindNativeTrackLocations(graph, input) {
  const observation = parseEffectObservation(JSON.stringify(input)), snapshot = observation.snapshot;
  if (observation.schemaVersion !== 2 || snapshot.resolve_version !== VERSION || graph.schemaVersion !== 1 || graph.readOnly !== true
    || graph.safeToApply !== false || !UUID.test(snapshot.project_id) || graph.nativeStructuralProfile !== PROFILE
    || graph.identitySource !== 'Sm2TiTrack.DbId' || graph.identityEqualsOrdinal !== false || graph.projectId !== snapshot.project_id
    || graph.timelines.length !== snapshot.timelines.length || !snapshot.timelines.length) throw new Error('unsupported-native-binding-source');
  const seenTracks = new Set(), seenTimelines = new Set(), seenSequences = new Set(), seenContainers = new Set(), timelines = [];
  let itemCount = 0, trackCount = 0, emptyTrackCount = 0;
  for (const api of snapshot.timelines) {
    const matches = graph.timelines.filter(row => row.timelineId === api.id), native = matches[0];
    if (matches.length !== 1 || !UUID.test(api.id) || seenTimelines.has(api.id) || !UUID.test(native.nativeSequenceId)
      || seenSequences.has(native.nativeSequenceId) || !UUID.test(native.nativeContainerId) || seenContainers.has(native.nativeContainerId)
      || native.tracks.length !== api.tracks.length || !api.tracks.length) throw new Error('native-api-timeline-differs');
    seenTimelines.add(api.id); seenSequences.add(native.nativeSequenceId); seenContainers.add(native.nativeContainerId);
    const bindings = [], locations = new Set();
    for (const type of ['video', 'audio']) {
      const apiTracks = api.tracks.filter(track => track.type === type).sort((a, b) => a.index - b.index);
      if (apiTracks.length > 64 || native.tracks.filter(track => track.kind === type).length !== apiTracks.length
        || apiTracks.some((track, index) => track.index !== index + 1)) throw new Error('unsupported-track-count-or-location');
      for (const track of apiTracks) {
        const candidates = native.tracks.filter(row => row.kind === type && row.currentVectorIndex === track.index);
        const row = candidates[0], location = `${type}:${track.index}`;
        const itemIds = sorted(api.items.filter(item => item.track_type === type && item.track_index === track.index).map(item => item.id));
        if (candidates.length !== 1 || seenTracks.has(row.nativeTrackId) || locations.has(location) || !UUID.test(row.nativeTrackId)
          || row.nativeContainerId !== native.nativeContainerId || row.nativeOrdinal !== row.currentVectorIndex
          || row.nativeVector !== (type === 'video' ? 'VideoTrackVec' : 'AudioTrackVec') || row.nativeType !== (type === 'video' ? 0 : 1)
          || !Number.isSafeInteger(row.nativeSubType) || row.nativeSubType < 0 || row.nativeSubType > 2147483647
          || !Number.isSafeInteger(row.nativeFlags) || row.nativeFlags < 0 || row.nativeFlags > 2147483647
          || row.itemIds.some(id => !UUID.test(id)) || row.nameSha256 !== sha(track.name) || json(row.itemIds) !== json(itemIds)
          || new Set(row.itemIds).size !== row.itemIds.length) throw new Error('native-api-current-location-disagrees');
        seenTracks.add(row.nativeTrackId); locations.add(location);
        bindings.push({ type, index: track.index, nativeTrackId: row.nativeTrackId, itemCount: itemIds.length, itemIds,
          bindingMethod: 'validated-native-vector-current-location', independentItemParentageWitness: itemIds.length > 0 });
        trackCount++; itemCount += itemIds.length; if (!itemIds.length) emptyTrackCount++;
      }
    }
    if (bindings.length !== api.tracks.length || native.tracks.some(track => !['video', 'audio'].includes(track.kind))
      || json(sorted(native.tracks.flatMap(track => track.itemIds))) !== json(sorted(api.items.map(item => item.id)))) throw new Error('unsupported-or-incomplete-native-binding');
    timelines.push({ timelineId: api.id, nativeSequenceId: native.nativeSequenceId, nativeContainerId: native.nativeContainerId, bindings });
  }
  if (seenTimelines.size !== graph.timelines.length) throw new Error('unassigned-native-timeline');
  return { schemaVersion: 1, operation: 'native-track-current-location-binding', readOnly: true, projectId: snapshot.project_id,
    resolveVersion: VERSION, timelines, trackCount, itemCount, emptyTrackCount, currentLocationRuleVersion: PROFILE,
    nativeIdentitySource: 'Sm2TiTrack.DbId', identityEqualsOrdinal: false, priorUuidLedgerRequired: false,
    oldWholeGraphEqualityRequired: false, vendorDocumentedLocationRule: false,
    safeToApply: false, ordinaryApplySupported: false };
}

function identityFacts(graph) {
  return { projectId: graph.projectId, timelines: graph.timelines.map(timeline => ({ timelineId: timeline.timelineId,
    nativeSequenceId: timeline.nativeSequenceId, nativeContainerId: timeline.nativeContainerId,
    tracks: timeline.tracks.map(({ nativeTrackId, nativeContainerId, kind, nativeOrdinal, nameSha256, itemIds,
      nativeType, nativeSubType, nativeFlags, nativeVector, currentVectorIndex }) => ({ nativeTrackId, nativeContainerId, kind,
      nativeOrdinal, nameSha256, itemIds, nativeType, nativeSubType, nativeFlags, nativeVector, currentVectorIndex }))
      .sort((a, b) => a.nativeTrackId.localeCompare(b.nativeTrackId)) })).sort((a, b) => a.timelineId.localeCompare(b.timelineId)) };
}

function joinSynchronizedNativeTracks(observations, graphs) {
  if (!Array.isArray(observations) || observations.length !== 3 || !Array.isArray(graphs) || graphs.length !== 2) throw new Error('incomplete-synchronized-native-source');
  const states = observations.map(value => parseEffectObservation(JSON.stringify(value)));
  if (json(states[0]) !== json(states[1]) || json(states[0]) !== json(states[2])) throw new Error('api-state-drift-during-native-export');
  const first = bindNativeTrackLocations(graphs[0], states[0]), second = bindNativeTrackLocations(graphs[1], states[1]);
  if (json(first) !== json(second) || json(identityFacts(graphs[0])) !== json(identityFacts(graphs[1]))) throw new Error('native-identity-drift-during-export');
  return { ...first, synchronizedReadExportReadVerified: true, apiRepresentedStateUnchanged: true,
    nativeIdentityGraphUnchangedDuringCapture: true, nativeIdentityFactsSha256: sha(json(identityFacts(graphs[0]))),
    archiveSources: graphs.map(graph => graph.archive),
    limitations: ['Fresh current locations use an empirically validated exact-build vector rule; native UUIDs remain identities.',
      'Only simple video/audio track structures are supported; unknown or inconsistent structures refuse.',
      'Equal captures are not atomic and cannot exclude concurrent edits that are reverted between observations.',
      'Object location does not prove native field preservation or authorize an editor mutation.'] };
}

function readNativeLocationGraph(archive, observationPath) {
  const bytes = readInput(archive);
  const graph = JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-location-graph.py'), archive],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000 }));
  if (graph.archive.sha256 !== sha(bytes)) throw new Error('native-archive-source-changed');
  if (observationPath) bindNativeTrackLocations(graph, parseEffectObservation(readInput(observationPath)));
  return graph;
}
module.exports = { PROFILE, bindNativeTrackLocations, joinSynchronizedNativeTracks, readNativeLocationGraph, identityFacts, json, sha };
