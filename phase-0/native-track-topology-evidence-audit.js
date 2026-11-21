'use strict';
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { auditNativeTrackEvidence } = require('./native-track-evidence-audit');
const { parseEffectObservation, compareEffectObservations } = require('../src/resolve-effect-observation');
const { planObservation, verifyNativeRetention } = require('./prepare-native-track-challenge');
const { planStage, verifyTopologyDelta } = require('./prepare-native-track-topology');
const ROOT = path.resolve(__dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const FILES = ['phase-0/prepare-native-track-topology.js', 'phase-0/resolve-native-track-topology.lua',
  'phase-0/prepare-native-track-challenge.js', 'phase-0/resolve-native-track-challenge.lua', 'phase-0/resolve-native-track-identity.py',
  'src/companion/resolve-internal.lua', 'src/companion/resolve-effects.lua', 'src/resolve-property-contract.json'];
const STAGES = [
  { label: 'append', operation: 'append-empty-video', facts: '74b11f2539ea8ceaf92c3b6a6c43217c04013ae8d46f78127c34591938db7422',
    topology: 'ae19b3d8081f10449a1f5b026056dbd93fb268b3450fe5f6a063a67270940c4d', challenge: 'f43b16262c6a295239bc2a8d50ba8f8848677594cbd1cac8fcd8e460f74e314b' },
  { label: 'delete', operation: 'delete-empty-video-2', facts: '9a15118857eb4c19791430a9a4f0271167bee0b435fec9a3080265cf7a229252',
    topology: '2d01b514837a016638f0c949e9618f109fe6b2da9e8d5dc768dc0a348f9d3ae9', challenge: 'abbd5ea82ea1803856399103d003c0a26091123e0589deb9c56c24057edddccb' },
  { label: 'recreate', operation: 'recreate-empty-video-3', facts: '32041663b216f260f5685984c0af7f504093e614711eb59a73adb125154a9c8e',
    topology: '1ee8bc446f7d430636f7a63c96873076015242563276f3be0c7ade4164ecddc1', challenge: 'd022b9d494a8b3129821a5fff7510af8079dca4a3884b1893809a9d2b83423db' }
];
const rows = graph => graph.timelines.flatMap(timeline => timeline.tracks.map(track => ({ timelineId: timeline.timelineId, ...track })));
const ids = values => [...values].sort();

function verifyPublicGraph(graph, observation, challenged = false) {
  const snapshot = observation.snapshot;
  if (graph.projectId !== snapshot.project_id || json(ids(graph.timelines.map(t => t.timelineId))) !== json(ids(snapshot.timelines.map(t => t.id)))) throw new Error('public-native-project-differs');
  for (const timeline of snapshot.timelines) {
    const native = graph.timelines.find(value => value.timelineId === timeline.id), tracks = native.tracks;
    if (tracks.length !== timeline.tracks.length || new Set(tracks.map(track => track.nativeTrackId)).size !== tracks.length
      || json(ids(tracks.flatMap(track => track.itemIds))) !== json(ids(timeline.items.map(item => item.id)))) throw new Error('public-native-track-items-differ');
    for (const type of ['video', 'audio', 'subtitle']) if (tracks.filter(track => track.kind === type).length !== timeline.tracks.filter(track => track.type === type).length) throw new Error('public-native-counts-differ');
    if (challenged) {
      const bindings = graph.apiBindings;
      if (bindings.length !== timeline.tracks.length || new Set(bindings.map(binding => binding.nativeTrackId)).size !== bindings.length) throw new Error('public-challenge-bindings-differ');
      let nonce = null;
      for (const api of timeline.tracks) {
        const binding = bindings.find(value => value.timelineId === timeline.id && value.type === api.type && value.index === api.index);
        const nativeTrack = binding && tracks.find(track => track.nativeTrackId === binding.nativeTrackId);
        const match = /^Frameline-TrackProof-([0-9a-f]{32})-(video|audio|subtitle)-([1-9][0-9]*)$/.exec(api.name);
        const itemIds = timeline.items.filter(item => item.track_type === api.type && item.track_index === api.index).map(item => item.id);
        if (!match || match[2] !== api.type || Number(match[3]) !== api.index || nonce && nonce !== match[1]
          || !nativeTrack || nativeTrack.kind !== api.type || nativeTrack.nameSha256 !== sha(api.name)
          || binding.status !== 'controlled-name-challenge' || binding.itemCount !== itemIds.length
          || json(ids(nativeTrack.itemIds)) !== json(ids(itemIds))) throw new Error('public-challenge-response-differs');
        nonce = match[1];
      }
    }
  }
}

function auditNativeTrackTopologyEvidence(read = readInput) {
  const readFile = file => read(path.join(ROOT, file));
  const initialAudit = auditNativeTrackEvidence(read);
  const initial = JSON.parse(readFile('phase-0/native-track-challenge-live-observation.json'));
  const firstRaw = JSON.parse(gunzipSync(readFile(initial.resultFile), { maxOutputLength: 20 * 1024 * 1024 }));
  let observation = parseEffectObservation(JSON.stringify(firstRaw.restored));
  const initialObservation = observation;
  let source = { graph: initial.graphs.restored, bindings: initial.graphs.challenged.apiBindings,
    observedNativeTrackIds: rows(initial.graphs.restored).map(row => row.nativeTrackId), retiredNativeTrackIds: [] };
  const originalIds = new Set(source.observedNativeTrackIds), stages = [];
  verifyPublicGraph(initial.graphs.challenged, firstRaw.reopened, true);
  for (const stage of STAGES) {
    const report = JSON.parse(readFile(`phase-0/native-track-topology-${stage.label}-live-observation.json`));
    if (report.status !== 'restored' || report.operation !== stage.operation || report.safeToApply !== false || report.ordinaryApplySupported !== false
      || report.projectId && report.projectId !== initialAudit.projectId || Object.keys(report.sourceHashes).sort().join(',') !== [...FILES].sort().join(',')) throw new Error('invalid-native-topology-evidence');
    for (const filename of FILES) if (sha(readFile(filename)) !== report.sourceHashes[filename]) throw new Error('native-topology-source-changed');
    if (sha(json({ graphs: report.graphs, topology: report.topology, beforeArchive: report.beforeArchive, afterArchive: report.afterArchive })) !== stage.facts) throw new Error('native-topology-facts-changed');
    const payload = {};
    for (const kind of ['topology', 'challenge']) {
      const binding = report.payloads[kind], filename = `phase-0/native-track-topology-${stage.label}-${kind}-result.json.gz`;
      if (binding.file !== filename || binding.sha256 !== stage[kind]) throw new Error('native-topology-result-binding-differs');
      const compressed = readFile(filename); if (sha(compressed) !== binding.compressedSha256) throw new Error('native-topology-compression-changed');
      const raw = gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
      if (sha(raw) !== stage[kind] || raw.length !== binding.bytes) throw new Error('native-topology-result-changed');
      payload[kind] = JSON.parse(raw);
    }
    const top = payload.topology, challenge = payload.challenge;
    if (top.schemaVersion !== 1 || top.operation !== 'resolve-native-track-topology' || top.status !== 'ready-for-challenge' || top.stage !== 'topology-complete'
      || challenge.schemaVersion !== 1 || challenge.operation !== 'resolve-native-track-challenge' || challenge.status !== 'restored' || challenge.stage !== 'complete'
      || top.probeId !== challenge.probeId || !/^[a-f0-9]{32}$/.test(top.probeId)
      || top.safeToApply !== false || challenge.safeToApply !== false || top.ordinaryApplySupported !== false || challenge.ordinaryApplySupported !== false) throw new Error('native-topology-outcome-differs');
    const planned = planStage(observation, stage.operation);
    if (json(parseEffectObservation(JSON.stringify(top.before))) !== json(observation)
      || json(parseEffectObservation(JSON.stringify(top.after))) !== json(planned.after)) throw new Error('native-topology-state-differs');
    const named = planObservation(Buffer.from(JSON.stringify(planned.after)), top.probeId);
    for (const [name, expected] of [['before', planned.after], ['challenged', named.challenged], ['reopened', named.challenged], ['restored', planned.after]]) {
      if (json(parseEffectObservation(JSON.stringify(challenge[name]))) !== json(expected)) throw new Error('native-topology-challenge-state-differs');
    }
    const diff = compareEffectObservations(JSON.stringify(challenge.before), JSON.stringify(challenge.challenged));
    if (diff.snapshotChanges.length !== planned.after.snapshot.timelines[0].tracks.length
      || !diff.snapshotChanges.every(row => row.kind === 'track-changed' && row.field === 'name')
      || diff.propertyChanges.length || diff.effectChanges.length || diff.trackStateChanges.length || diff.activeTimelineChange !== null) throw new Error('native-topology-unrelated-change');
    verifyPublicGraph(report.graphs.before, challenge.before);
    verifyPublicGraph(report.graphs.challenged, challenge.reopened, true);
    verifyPublicGraph(report.graphs.restored, challenge.restored);
    verifyNativeRetention(report.graphs.before, report.graphs);
    const delta = verifyTopologyDelta(source, source.graph, report.graphs.before, report.graphs.challenged.apiBindings, stage.operation);
    if (json(delta) !== json(report.topology)) throw new Error('native-topology-delta-differs');
    stages.push({ operation: stage.operation, trackCount: planned.after.snapshot.timelines[0].tracks.length,
      rawResultHashes: { topology: stage.topology, challenge: stage.challenge }, nativeGraphFactsSha256: stage.facts, ...delta });
    source = { graph: report.graphs.restored, bindings: report.graphs.challenged.apiBindings,
      observedNativeTrackIds: delta.observedNativeTrackIds, retiredNativeTrackIds: delta.retiredNativeTrackIds };
    observation = parseEffectObservation(JSON.stringify(challenge.restored));
  }
  if (json(observation) !== json(initialObservation)) throw new Error('native-topology-final-observation-differs');
  const finalIds = rows(source.graph).map(row => row.nativeTrackId);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, operation: 'audit-native-track-topology-proof',
    projectId: initialAudit.projectId, itemCount: 50, finalTrackCount: 5, stages,
    retainedOriginalNativeTrackIds: finalIds.filter(id => originalIds.has(id)).sort(),
    newFinalNativeTrackIds: finalIds.filter(id => !originalIds.has(id)).sort(), retiredNativeTrackIds: source.retiredNativeTrackIds,
    controlledNameSaveReopenProofVerified: true, controlledApiUuidIndexShiftVerified: true,
    deleteRecreateNegativeControlVerified: true, noObservedUuidReuse: true,
    representedFinalObservationMatchesInitial: true, finalDuplicateNameLayoutRestored: true,
    allFiftyPictureItemsPreserved: true, publicNativeGraphDeltaConsistencyVerified: true,
    nativeGraphsReconstructedFromArchives: false, nativeArchiveSourcesPrivate: true,
    stableTrackIdentityProven: false, fullNativePreservationProven: false, ordinaryApplySupported: false,
    limitations: ['These are controlled proofs on one backed-up synthetic project and the exact installed build.',
      'Raw API observations and pinned public native graph facts are recomputed; private native archives are retained separately.',
      'UUIDs, not duplicate labels or native ordinals, identify retained and retired tracks.',
      'Broader editor/native semantics, cross-device identity and ordinary apply remain unproven.'] };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(auditNativeTrackTopologyEvidence(), null, 2) + '\n'); }
  catch { process.stderr.write('native-track-topology-audit-failed\n'); process.exitCode = 1; }
}
module.exports = { auditNativeTrackTopologyEvidence };
