'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readInput } = require('./integration-input');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { planObservation, renderChallenge, readResult: readNameProof, verifyNativeRetention } = require('./prepare-native-track-challenge');
const NAME = 'Frameline Integration Gate Fixture 20261120';
const OPS = ['append-empty-video', 'delete-empty-video-2', 'recreate-empty-video-3'];
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const lua = value => typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? `{${value.map(lua).join(',')}}` : String(value);
const graphRows = value => value.timelines.flatMap(timeline => timeline.tracks.map(track => ({ timelineId: timeline.timelineId, ...track })))
  .sort((a, b) => a.nativeTrackId < b.nativeTrackId ? -1 : a.nativeTrackId > b.nativeTrackId ? 1 : 0);
const identityRows = value => graphRows(value).map(({ timelineId, nativeTrackId, kind, nativeOrdinal, nameSha256, itemIds }) => ({ timelineId, nativeTrackId, kind, nativeOrdinal, nameSha256, itemIds }));

function planStage(observation, operation) {
  if (!OPS.includes(operation)) throw new Error('invalid-topology-operation');
  planObservation(Buffer.from(JSON.stringify(observation)), 'a'.repeat(32));
  const before = structuredClone(observation), after = structuredClone(observation), timeline = after.snapshot.timelines[0];
  const video = timeline.tracks.filter(track => track.type === 'video'), audio = timeline.tracks.filter(track => track.type === 'audio');
  if (video.length !== (operation === 'delete-empty-video-2' ? 4 : 3) || audio.length !== 2 || timeline.tracks.length !== video.length + 2
    || new Set(timeline.tracks.map(track => track.name)).size !== 1) throw new Error('unsupported-topology-source');
  const originalName = video[0].name;
  if (operation === 'append-empty-video') {
    timeline.tracks.splice(video.length, 0, { type: 'video', index: 4, name: originalName });
    after.tracks.splice(video.length, 0, { timelineId: timeline.id, type: 'video', index: 4, enabled: true, locked: false });
  } else if (operation === 'delete-empty-video-2') {
    timeline.tracks = timeline.tracks.filter(track => !(track.type === 'video' && track.index === 2));
    after.tracks = after.tracks.filter(track => !(track.type === 'video' && track.index === 2));
    for (const track of [...timeline.tracks, ...after.tracks]) if (track.type === 'video' && track.index > 2) track.index--;
  }
  const recreated = before.tracks.find(track => track.type === 'video' && track.index === 3);
  return { before, after, originalName, recreatedState: recreated, operation };
}

function verifyTopologyDelta(source, before, after, afterBindings, operation) {
  if (json(identityRows(source.graph)) !== json(identityRows(before))) throw new Error('native-topology-before-differs');
  const old = new Map(graphRows(before).map(row => [row.nativeTrackId, row])), current = new Map(graphRows(after).map(row => [row.nativeTrackId, row]));
  const oldBindings = new Map(source.bindings.map(row => [row.nativeTrackId, row]));
  const newBindings = new Map(afterBindings.map(row => [row.nativeTrackId, row]));
  if (oldBindings.size !== old.size || newBindings.size !== current.size) throw new Error('incomplete-topology-binding');
  const removed = [...old.keys()].filter(id => !current.has(id)).sort(), added = [...current.keys()].filter(id => !old.has(id)).sort();
  const targetIndex = operation === 'delete-empty-video-2' ? 2 : operation === 'recreate-empty-video-3' ? 3 : null;
  const target = targetIndex === null ? null : source.bindings.find(row => row.type === 'video' && row.index === targetIndex);
  if (target && (target.itemCount !== 0 || old.get(target.nativeTrackId)?.itemIds.length !== 0)) throw new Error('nonempty-topology-target');
  if (operation === 'append-empty-video' ? removed.length || added.length !== 1 : operation === 'delete-empty-video-2'
    ? added.length || removed.length !== 1 || removed[0] !== target?.nativeTrackId
    : added.length !== 1 || removed.length !== 1 || removed[0] !== target?.nativeTrackId) throw new Error('unexpected-native-topology-delta');
  const observed = new Set(source.observedNativeTrackIds);
  for (const id of added) {
    const binding = newBindings.get(id), row = current.get(id);
    if (observed.has(id) || row.kind !== 'video' || row.itemIds.length || binding.type !== 'video'
      || binding.index !== (operation === 'append-empty-video' ? 4 : 3) || binding.itemCount !== 0) throw new Error('native-track-id-reused-or-misbound');
  }
  const retained = [];
  for (const [id, row] of old) {
    if (!current.has(id)) continue;
    const next = current.get(id), a = oldBindings.get(id), b = newBindings.get(id);
    const expectedIndex = operation === 'delete-empty-video-2' && a.type === 'video' && a.index > 2 ? a.index - 1 : a.index;
    if (row.timelineId !== next.timelineId || row.kind !== next.kind || json(row.itemIds) !== json(next.itemIds)
      || a.type !== b.type || b.index !== expectedIndex || a.itemCount !== b.itemCount) throw new Error('retained-native-track-misbound');
    retained.push({ nativeTrackId: id, type: a.type, apiIndexBefore: a.index, apiIndexAfter: b.index, itemCount: a.itemCount });
  }
  if (retained.filter(row => row.itemCount === 50 && row.type === 'video' && row.apiIndexBefore === 1 && row.apiIndexAfter === 1).length !== 1) throw new Error('picture-track-not-preserved');
  return { operation, addedNativeTrackIds: added, removedNativeTrackIds: removed, retainedTracks: retained,
    observedNativeTrackIds: [...new Set([...observed, ...added])].sort(),
    retiredNativeTrackIds: [...new Set([...(source.retiredNativeTrackIds || []), ...removed])].sort(),
    indexShiftObservedByControlledBindings: retained.some(row => row.apiIndexBefore !== row.apiIndexAfter),
    deleteRecreateNegativeControlVerified: operation === 'recreate-empty-video-3', allFiftyPictureItemsPreserved: true,
    stableTrackIdentityProven: false, ordinaryApplySupported: false };
}

async function verifiedSource(preparation, depth = 0) {
  if (depth > 4) throw new Error('topology-chain-limit');
  const record = JSON.parse(readInput(preparation));
  if (record.operation === 'prepare-native-track-challenge') {
    const summary = await readNameProof(preparation), result = JSON.parse(readInput(record.resultPath));
    if (summary.status !== 'restored') throw new Error('source-proof-not-restored');
    return { observation: result.restored, archivePath: record.exports.restored, graph: summary.graphs.restored,
      bindings: summary.graphs.challenged.apiBindings, observedNativeTrackIds: graphRows(summary.graphs.restored).map(row => row.nativeTrackId), retiredNativeTrackIds: [] };
  }
  if (record.operation === 'prepare-native-track-topology') {
    const summary = await readResult(preparation, depth), result = JSON.parse(readInput(record.challengeResultPath));
    if (summary.status !== 'restored') throw new Error('source-topology-not-restored');
    return { observation: result.restored, archivePath: record.exports.restored, graph: summary.graphs.restored,
      bindings: summary.graphs.challenged.apiBindings, observedNativeTrackIds: summary.topology.observedNativeTrackIds,
      retiredNativeTrackIds: summary.topology.retiredNativeTrackIds };
  }
  throw new Error('unsupported-topology-proof');
}

async function renderStage(record) {
  const template = await fs.readFile(path.join(__dirname, 'resolve-native-track-topology.lua'), 'utf8');
  const rawBase = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  const sentinel = 'return { capture_request = capture_request }';
  if (rawBase.split(sentinel).length !== 2) throw new Error('incompatible-topology-capture');
  const base = rawBase.replace(sentinel, 'return {capture=capture, encode=encode, array=array}');
  const effect = await fs.readFile(path.join(__dirname, '../src/companion/resolve-effects.lua'), 'utf8');
  const plan = planStage(record.before, record.stageOperation);
  if (json(plan.after) !== json(record.after)) throw new Error('topology-plan-differs');
  const inner = { ...planObservation(Buffer.from(JSON.stringify(plan.after)), record.probeId), projectId: record.projectId,
    probeId: record.probeId, resultPath: record.challengeResultPath, markerPath: record.challengeMarkerPath,
    backupPath: record.exports.after, backupBytes: 0,
    exports: { before: record.exports.challengeBefore, challenged: record.exports.challenged, restored: record.exports.restored } };
  let challenge = await renderChallenge(inner);
  if (challenge.split('local backup_bytes = 0').length !== 2) throw new Error('incompatible-topology-challenge');
  challenge = challenge.replace('local backup_bytes = 0', 'local backup_bytes = topology_backup_bytes');
  const mutation = record.stageOperation === 'append-empty-video'
    ? `assert(timeline:GetTrackCount('video')==3,'Source count differs');assert(timeline:AddTrack('video')==true,'Append failed');assert(timeline:GetTrackCount('video')==4,'Append count differs');empty(timeline,4);assert(timeline:SetTrackName('video',4,${JSON.stringify(plan.originalName)})==true,'Name failed');assert(timeline:SetTrackEnable('video',4,true)==true,'Enable failed');assert(timeline:SetTrackLock('video',4,false)==true,'Lock failed')`
    : record.stageOperation === 'delete-empty-video-2'
      ? `assert(timeline:GetTrackCount('video')==4,'Source count differs');empty(timeline,2);assert(timeline:DeleteTrack('video',2)==true,'Delete failed');assert(timeline:GetTrackCount('video')==3,'Delete count differs')`
      : `assert(timeline:GetTrackCount('video')==3,'Source count differs');empty(timeline,3);assert(timeline:DeleteTrack('video',3)==true,'Delete failed');assert(timeline:GetTrackCount('video')==2,'Delete count differs');assert(timeline:AddTrack('video')==true,'Recreate failed');assert(timeline:GetTrackCount('video')==3,'Recreate count differs');empty(timeline,3);assert(timeline:SetTrackName('video',3,${JSON.stringify(plan.originalName)})==true,'Name failed');assert(timeline:SetTrackEnable('video',3,${plan.recreatedState.enabled})==true,'Enable failed');assert(timeline:SetTrackLock('video',3,${plan.recreatedState.locked})==true,'Lock failed')`;
  const bindings = { __EXPECTED_NAME__: JSON.stringify(NAME), __EXPECTED_PROJECT_ID__: JSON.stringify(record.projectId),
    __EXPECTED_BEFORE__: JSON.stringify(json(plan.before)), __EXPECTED_AFTER__: JSON.stringify(json(plan.after)),
    __BACKUP_PATH__: JSON.stringify(record.backupPath), __BACKUP_SIZE__: String(record.backupBytes),
    __EXPORT_BEFORE__: JSON.stringify(record.exports.before), __EXPORT_AFTER__: JSON.stringify(record.exports.after),
    __RESULT_PATH__: JSON.stringify(record.resultPath), __MARKER_PATH__: JSON.stringify(record.markerPath), __PROBE_ID__: JSON.stringify(record.probeId),
    __BASE_SOURCE__: base, __EFFECT_SOURCE__: effect, __PROPERTY_CONFIG__: propertyCaptureConfig(),
    __ALL_OUTPUTS__: lua([record.resultPath, record.markerPath, record.challengeResultPath, record.challengeMarkerPath, ...Object.values(record.exports)]),
    __TIMELINE_ID__: JSON.stringify(plan.before.snapshot.timelines[0].id), __MUTATION_SOURCE__: mutation, __CHALLENGE_SOURCE__: challenge };
  let source = template;
  for (const [token, value] of Object.entries(bindings)) {
    if (source.split(token).length !== 2) throw new Error('invalid-topology-template');
    source = source.replace(token, () => value);
  }
  return source;
}

async function prepare(previousPreparation, operation, { install = false } = {}) {
  if (!path.isAbsolute(previousPreparation || '') || !OPS.includes(operation) || typeof install !== 'boolean') throw new Error('invalid-topology-options');
  const source = await verifiedSource(previousPreparation), plan = planStage(source.observation, operation);
  const backup = readInput(source.archivePath);
  if (sha(backup) !== source.graph.archive.sha256) throw new Error('topology-backup-changed');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-track-topology-'))); await fs.chmod(directory, 0o700);
  const probeId = randomBytes(16).toString('hex');
  const record = { schemaVersion: 1, operation: 'prepare-native-track-topology', previousPreparation,
    directory, probeId, stageOperation: operation, before: plan.before, after: plan.after,
    projectId: plan.before.snapshot.project_id, projectName: NAME, backupPath: path.join(directory, 'verified-baseline.drp'), backupBytes: backup.length, backupSha256: sha(backup),
    resultPath: path.join(directory, `topology-result-${probeId}.json`), markerPath: path.join(directory, `topology-complete-${probeId}.txt`),
    challengeResultPath: path.join(directory, `challenge-result-${probeId}.json`), challengeMarkerPath: path.join(directory, `challenge-complete-${probeId}.txt`),
    exports: Object.fromEntries(['before', 'after', 'challengeBefore', 'challenged', 'restored'].map(name => [name, path.join(directory, `${name}.drp`)])),
    ordinaryApplySupported: false };
  await fs.writeFile(record.backupPath, backup, { flag: 'wx', mode: 0o600 });
  const text = await renderStage(record); record.sourceSha256 = sha(text);
  record.preparedPath = path.join(directory, `Frameline Track Topology ${probeId.slice(0, 12)}.lua`);
  record.installedPath = install ? path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility', path.basename(record.preparedPath)) : null;
  await fs.writeFile(record.preparedPath, text, { flag: 'wx', mode: 0o600 });
  if (install) {
    const target = path.dirname(record.installedPath), info = await fs.lstat(target);
    if (!info.isDirectory() || await fs.realpath(target) !== target) throw new Error('unsafe-topology-install');
    await fs.writeFile(record.installedPath, text, { flag: 'wx', mode: 0o600 });
  }
  await fs.writeFile(path.join(directory, 'preparation.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, preparation: path.join(directory, 'preparation.json'), menuName: path.basename(record.preparedPath, '.lua'),
    sourceSha256: record.sourceSha256, backupSha256: record.backupSha256, operation, ordinaryApplySupported: false };
}

async function output(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('unsafe-topology-output'); await handle.chmod(0o600); }
  finally { await handle.close(); }
  return readInput(filename);
}
async function nativeGraph(filename, observation, operation, directory, label) {
  const target = path.join(directory, `${label}-observation.json`), data = Buffer.from(JSON.stringify(observation));
  try { await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || !readInput(target).equals(data)) throw error; }
  return JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-track-identity.py'), operation, filename, target], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
}

async function readResult(preparation, depth = 0) {
  if (depth > 4) throw new Error('topology-chain-limit');
  const record = JSON.parse(readInput(preparation)), directory = path.dirname(preparation);
  if (record.schemaVersion !== 1 || record.operation !== 'prepare-native-track-topology' || !OPS.includes(record.stageOperation)
    || !/^[a-f0-9]{32}$/.test(record.probeId) || path.resolve(record.directory) !== path.resolve(directory)
    || record.preparedPath !== path.join(directory, `Frameline Track Topology ${record.probeId.slice(0, 12)}.lua`)
    || record.backupPath !== path.join(directory, 'verified-baseline.drp') || record.projectName !== NAME
    || record.resultPath !== path.join(directory, `topology-result-${record.probeId}.json`) || record.markerPath !== path.join(directory, `topology-complete-${record.probeId}.txt`)
    || record.challengeResultPath !== path.join(directory, `challenge-result-${record.probeId}.json`) || record.challengeMarkerPath !== path.join(directory, `challenge-complete-${record.probeId}.txt`)
    || Object.keys(record.exports).sort().join(',') !== 'after,before,challengeBefore,challenged,restored'
    || Object.entries(record.exports).some(([name, filename]) => filename !== path.join(directory, `${name}.drp`))) throw new Error('invalid-topology-record');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('unsafe-topology-directory');
  const prior = await verifiedSource(record.previousPreparation, depth + 1);
  if (record.projectId !== prior.observation.snapshot.project_id || json(record.before) !== json(prior.observation)
    || sha(readInput(record.backupPath)) !== record.backupSha256 || record.backupSha256 !== prior.graph.archive.sha256
    || sha(readInput(record.preparedPath)) !== record.sourceSha256 || readInput(record.preparedPath).toString() !== await renderStage(record)) throw new Error('topology-source-differs');
  const raw = await output(record.resultPath), result = JSON.parse(raw);
  const fields = ['schemaVersion', 'operation', 'probeId', 'status', 'stage', 'safeToApply', 'ordinaryApplySupported', 'before', 'after'];
  if (Object.keys(result).sort().join(',') !== fields.sort().join(',') || result.schemaVersion !== 1 || result.operation !== 'resolve-native-track-topology'
    || result.probeId !== record.probeId || result.safeToApply !== false || result.ordinaryApplySupported !== false
    || !['ready-for-challenge', 'refused', 'recovery-required'].includes(result.status)
    || !['initial', 'source-check', 'before-export', 'empty-track-mutation', 'save-reopen', 'after-export', 'topology-complete'].includes(result.stage)
    || (await output(record.markerPath)).toString() !== `FRAMELINE_TRACK_TOPOLOGY_COMPLETE_V1:${record.probeId}\n`) throw new Error('invalid-topology-result');
  if (result.status !== 'ready-for-challenge') return { status: result.status, stage: result.stage, recoveryRequired: true, ordinaryApplySupported: false };
  for (const name of ['before', 'after']) if (json(parseEffectObservation(JSON.stringify(result[name]))) !== json(record[name])) throw new Error('topology-observation-differs');
  const challengeRaw = await output(record.challengeResultPath), challenge = JSON.parse(challengeRaw);
  const expected = planObservation(Buffer.from(JSON.stringify(record.after)), record.probeId);
  const challengeFields = ['schemaVersion', 'operation', 'probeId', 'safeToApply', 'status', 'stage', 'ordinaryApplySupported', 'representedStateRestored', 'before', 'challenged', 'reopened', 'restored'];
  if (Object.keys(challenge).sort().join(',') !== challengeFields.sort().join(',') || challenge.schemaVersion !== 1 || challenge.operation !== 'resolve-native-track-challenge'
    || challenge.probeId !== record.probeId || challenge.safeToApply !== false || challenge.ordinaryApplySupported !== false
    || challenge.status !== 'restored' || challenge.stage !== 'complete' || challenge.representedStateRestored !== true
    || (await output(record.challengeMarkerPath)).toString() !== `FRAMELINE_NATIVE_TRACK_CHALLENGE_COMPLETE_V1:${record.probeId}\n`) throw new Error('topology-challenge-incomplete');
  for (const [name, value] of [['before', record.after], ['challenged', expected.challenged], ['reopened', expected.challenged], ['restored', record.after]]) {
    if (json(parseEffectObservation(JSON.stringify(challenge[name]))) !== json(value)) throw new Error('topology-challenge-observation-differs');
  }
  const beforeGraph = await nativeGraph(record.exports.before, result.before, 'bind-api', directory, 'before');
  const afterGraph = await nativeGraph(record.exports.after, result.after, 'bind-api', directory, 'after');
  const graphs = {
    before: await nativeGraph(record.exports.challengeBefore, challenge.before, 'bind-api', directory, 'challenge-before'),
    challenged: await nativeGraph(record.exports.challenged, challenge.reopened, 'bind-challenge', directory, 'challenged'),
    restored: await nativeGraph(record.exports.restored, challenge.restored, 'bind-api', directory, 'restored') };
  verifyNativeRetention(afterGraph, graphs);
  const topology = verifyTopologyDelta(prior, beforeGraph, afterGraph, graphs.challenged.apiBindings, record.stageOperation);
  return { schemaVersion: 1, operation: record.stageOperation, status: 'restored', representedAfterMatchesPlanned: true,
    allOriginalNamesRestored: true, itemCount: 50, trackCount: record.after.snapshot.timelines[0].tracks.length,
    beforeArchive: beforeGraph.archive, afterArchive: afterGraph.archive, graphs, topology,
    sourceSha256: record.sourceSha256, topologyResultSha256: sha(raw), challengeResultSha256: sha(challengeRaw),
    safeToApply: false, ordinaryApplySupported: false, fullNativePreservationProven: false };
}

if (require.main === module) {
  const [operation, target, action, flag] = process.argv.slice(2);
  const work = operation === 'prepare' && target && OPS.includes(action) && (!flag || flag === '--install') ? prepare(target, action, { install: flag === '--install' })
    : operation === 'read' && target && !action ? readResult(target) : Promise.reject(new Error('usage'));
  work.then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(() => { process.stderr.write('native-track-topology-failed\n'); process.exitCode = 1; });
}
module.exports = { planStage, verifyTopologyDelta, renderStage, prepare, readResult };
