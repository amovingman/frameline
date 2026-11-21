'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readInput } = require('./integration-input');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const projectName = 'Frameline Integration Gate Fixture 20261120';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const lua = value => typeof value === 'string' ? JSON.stringify(value) : typeof value === 'number' || typeof value === 'boolean' ? String(value)
  : Array.isArray(value) ? `{${value.map(lua).join(',')}}` : `{${Object.entries(value).map(([key, field]) => `[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}`;

function planObservation(bytes, probeId) {
  const observation = parseEffectObservation(bytes);
  if (!/^[a-f0-9]{32}$/.test(probeId) || observation.schemaVersion !== 2 || observation.snapshot.project_name !== projectName
    || observation.snapshot.timelines.length !== 1 || observation.snapshot.timelines[0].items.length !== 50
    || observation.items.some(item => item.propertyReadStatus !== 'captured' || !Object.keys(item.properties).length)
    || observation.tracks.some(track => track.enabled === null || track.locked === null)) throw new Error('invalid-track-challenge-source');
  const challenged = structuredClone(observation), bindings = [];
  for (const timeline of challenged.snapshot.timelines) {
    for (const type of ['video', 'audio', 'subtitle']) {
      const tracks = timeline.tracks.filter(track => track.type === type).sort((a, b) => a.index - b.index);
      if (tracks.some((track, index) => track.index !== index + 1)) throw new Error('invalid-track-layout');
      for (const track of tracks) {
        const challengeName = `Frameline-TrackProof-${probeId}-${type}-${track.index}`;
        bindings.push({ timelineId: timeline.id, type, index: track.index, originalName: track.name, challengeName });
        track.name = challengeName;
      }
    }
  }
  const timeline = observation.snapshot.timelines[0];
  if (bindings.length < 5 || bindings.length > 8 || timeline.tracks.filter(track => track.type === 'video').length < 3
    || timeline.tracks.filter(track => track.type === 'audio').length < 2
    || timeline.items.some(item => item.track_type !== 'video' || item.track_index !== 1)) throw new Error('invalid-track-challenge-layout');
  return { observation, challenged, bindings };
}

async function renderChallenge(record) {
  const template = await fs.readFile(path.join(__dirname, 'resolve-native-track-challenge.lua'), 'utf8');
  const rawBase = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  const sentinel = 'return { capture_request = capture_request }';
  if (rawBase.split(sentinel).length !== 2) throw new Error('incompatible-track-capture');
  const base = rawBase.replace(sentinel, 'return {capture=capture, encode=encode, array=array}');
  const effect = await fs.readFile(path.join(__dirname, '../src/companion/resolve-effects.lua'), 'utf8');
  const replacements = { __EXPECTED_NAME__: JSON.stringify(projectName), __EXPECTED_PROJECT_ID__: JSON.stringify(record.projectId),
    __EXPECTED_BEFORE__: JSON.stringify(json(record.observation)), __EXPECTED_CHALLENGED__: JSON.stringify(json(record.challenged)),
    __BINDINGS__: lua(record.bindings), __RESULT_PATH__: JSON.stringify(record.resultPath), __MARKER_PATH__: JSON.stringify(record.markerPath),
    __BACKUP_PATH__: JSON.stringify(record.backupPath), __BACKUP_BYTES__: String(record.backupBytes),
    __EXPORT_BEFORE__: JSON.stringify(record.exports.before), __EXPORT_CHALLENGED__: JSON.stringify(record.exports.challenged),
    __EXPORT_RESTORED__: JSON.stringify(record.exports.restored), __PROBE_ID__: JSON.stringify(record.probeId),
    __BASE_SOURCE__: base, __EFFECT_SOURCE__: effect, __PROPERTY_CONFIG__: propertyCaptureConfig() };
  let source = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (source.split(token).length !== 2) throw new Error('invalid-track-challenge-template');
    source = source.replace(token, () => value);
  }
  return source;
}

async function prepare(baselineDirectory, { install = false } = {}) {
  if (!path.isAbsolute(baselineDirectory || '') || typeof install !== 'boolean') throw new Error('invalid-track-challenge-options');
  const observationBytes = readInput(path.join(baselineDirectory, 'observation.json'));
  const probeId = randomBytes(16).toString('hex'), plan = planObservation(observationBytes, probeId);
  const backup = readInput(path.join(baselineDirectory, 'baseline.drp'));
  const native = JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-track-identity.py'), 'bind-api',
    path.join(baselineDirectory, 'baseline.drp'), path.join(baselineDirectory, 'observation.json')], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
  if (native.projectId !== plan.observation.snapshot.project_id || native.archive.sha256 !== sha(backup)
    || native.unboundEmptyApiTracks.length !== plan.bindings.length - 1 || native.apiBindings.length !== 1) throw new Error('native-backup-source-mismatch');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-track-challenge-'));
  const directory = await fs.realpath(temporary); await fs.chmod(directory, 0o700);
  const record = { schemaVersion: 1, operation: 'prepare-native-track-challenge', probeId, directory,
    projectId: plan.observation.snapshot.project_id, projectName, ...plan, observationSourceSha256: sha(observationBytes),
    backupPath: path.join(directory, 'verified-baseline.drp'), backupBytes: backup.length, backupSha256: sha(backup),
    resultPath: path.join(directory, `result-${probeId}.json`), markerPath: path.join(directory, `complete-${probeId}.txt`),
    exports: { before: path.join(directory, 'before.drp'), challenged: path.join(directory, 'challenged.drp'), restored: path.join(directory, 'restored.drp') },
    ordinaryApplySupported: false };
  await fs.writeFile(record.backupPath, backup, { flag: 'wx', mode: 0o600 });
  const source = await renderChallenge(record);
  record.sourceSha256 = sha(source); record.preparedPath = path.join(directory, `Frameline Track Proof ${probeId.slice(0, 12)}.lua`);
  record.installedPath = install ? path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility', path.basename(record.preparedPath)) : null;
  await fs.writeFile(record.preparedPath, source, { flag: 'wx', mode: 0o600 });
  if (install) {
    const target = path.dirname(record.installedPath), info = await fs.lstat(target);
    if (!info.isDirectory() || await fs.realpath(target) !== target) throw new Error('unsafe-track-proof-install');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 });
  }
  await fs.writeFile(path.join(directory, 'preparation.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, preparation: path.join(directory, 'preparation.json'), menuName: path.basename(record.preparedPath, '.lua'),
    sourceSha256: record.sourceSha256, backupSha256: record.backupSha256, projectId: record.projectId, ordinaryApplySupported: false };
}

function verifyNativeRetention(baseline, graphs) {
  const rows = (graph, names) => graph.timelines.flatMap(timeline => timeline.tracks.map(track => ({
    timelineId: timeline.timelineId, nativeTrackId: track.nativeTrackId, kind: track.kind,
    nativeOrdinal: track.nativeOrdinal, itemIds: track.itemIds, ...(names ? { nameSha256: track.nameSha256 } : {}) })))
    .sort((a, b) => a.nativeTrackId < b.nativeTrackId ? -1 : a.nativeTrackId > b.nativeTrackId ? 1 : 0);
  if (json(rows(baseline, true)) !== json(rows(graphs.before, true))
    || json(rows(graphs.before, false)) !== json(rows(graphs.challenged, false))
    || json(rows(graphs.before, true)) !== json(rows(graphs.restored, true))) throw new Error('native-track-id-retention-failed');
  return { nativeTrackIdsRetainedAcrossNameChallenge: true,
    emptyTrackChallengeBindings: graphs.challenged.apiBindings.filter(row => row.itemCount === 0).length,
    stableTrackIdentityProven: false, indexShiftPersistenceProven: false, deleteRecreateNegativeControlProven: false };
}

async function readResult(preparation) {
  const record = JSON.parse(readInput(preparation)), directory = path.dirname(preparation);
  if (record.schemaVersion !== 1 || record.operation !== 'prepare-native-track-challenge' || !/^[a-f0-9]{32}$/.test(record.probeId)
    || path.resolve(record.directory) !== path.resolve(directory) || record.projectName !== projectName
    || record.preparedPath !== path.join(directory, `Frameline Track Proof ${record.probeId.slice(0, 12)}.lua`)
    || record.resultPath !== path.join(directory, `result-${record.probeId}.json`) || record.markerPath !== path.join(directory, `complete-${record.probeId}.txt`)) throw new Error('invalid-track-proof-record');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('unsafe-track-proof-directory');
  const planned = planObservation(Buffer.from(JSON.stringify(record.observation)), record.probeId);
  if (json(planned.bindings) !== json(record.bindings) || json(planned.challenged) !== json(record.challenged)
    || record.projectId !== planned.observation.snapshot.project_id || record.backupPath !== path.join(directory, 'verified-baseline.drp')
    || Object.entries(record.exports).some(([name, filename]) => !['before', 'challenged', 'restored'].includes(name) || filename !== path.join(directory, `${name}.drp`))
    || Object.keys(record.exports).length !== 3) throw new Error('invalid-track-proof-plan');
  const source = readInput(record.preparedPath);
  if (sha(source) !== record.sourceSha256 || source.toString() !== await renderChallenge(record)
    || sha(readInput(record.backupPath)) !== record.backupSha256) throw new Error('track-proof-source-changed');
  for (const filename of [record.resultPath, record.markerPath]) {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('unsafe-track-proof-output'); await handle.chmod(0o600); }
    finally { await handle.close(); }
  }
  const bytes = readInput(record.resultPath), result = JSON.parse(bytes);
  const keys = ['schemaVersion', 'operation', 'probeId', 'safeToApply', 'status', 'stage', 'ordinaryApplySupported',
    'representedStateRestored', 'before', 'challenged', 'reopened', 'restored'];
  if (result.schemaVersion !== 1 || result.operation !== 'resolve-native-track-challenge' || result.probeId !== record.probeId
    || result.safeToApply !== false || result.ordinaryApplySupported !== false
    || Object.keys(result).sort().join(',') !== keys.sort().join(',')
    || !['restored', 'rolled-back', 'refused', 'recovery-required'].includes(result.status)
    || !['initial', 'source-check', 'baseline-export', 'challenge', 'challenge-reopen', 'restore', 'restore-reopen', 'complete'].includes(result.stage)
    || typeof result.representedStateRestored !== 'boolean'
    || readInput(record.markerPath).toString() !== `FRAMELINE_NATIVE_TRACK_CHALLENGE_COMPLETE_V1:${record.probeId}\n`) throw new Error('invalid-track-proof-result');
  if (result.status !== 'restored' || result.representedStateRestored !== true) return { status: result.status, stage: result.stage, ordinaryApplySupported: false, recoveryRequired: true };
  for (const [name, expected] of [['before', record.observation], ['challenged', record.challenged], ['reopened', record.challenged], ['restored', record.observation]]) {
    if (json(parseEffectObservation(JSON.stringify(result[name]))) !== json(expected)) throw new Error('track-proof-observation-mismatch');
  }
  const graphs = {};
  for (const [name, filename] of Object.entries(record.exports)) {
    if (filename !== path.join(directory, `${name}.drp`)) throw new Error('invalid-track-proof-export');
    const data = readInput(filename);
    const observationPath = path.join(directory, `${name}-observation.json`);
    const observation = name === 'challenged' ? result.reopened : name === 'before' ? result.before : result.restored;
    try { await fs.writeFile(observationPath, JSON.stringify(observation), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || !readInput(observationPath).equals(Buffer.from(JSON.stringify(observation)))) throw error; }
    graphs[name] = JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-track-identity.py'), name === 'challenged' ? 'bind-challenge' : 'bind-api', filename, observationPath], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
    if (graphs[name].archive.sha256 !== sha(data)) throw new Error('track-proof-export-changed');
  }
  const baseline = JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-track-identity.py'), 'graph', record.backupPath],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
  const identity = verifyNativeRetention(baseline, graphs);
  return { schemaVersion: 1, operation: result.operation, probeId: record.probeId, status: result.status,
    representedStateRestored: true, resultSha256: sha(bytes), sourceSha256: record.sourceSha256,
    backupSha256: record.backupSha256, projectId: record.projectId, trackCount: record.bindings.length,
    graphs, ...identity, safeToApply: false, ordinaryApplySupported: false, fullNativePreservationProven: false };
}
if (require.main === module) {
  const [operation, target, flag] = process.argv.slice(2);
  const action = operation === 'prepare' && target && (!flag || flag === '--install') ? prepare(target, { install: flag === '--install' })
    : operation === 'read' && target && !flag ? readResult(target) : Promise.reject(new Error('usage'));
  action.then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(() => { process.stderr.write('native-track-challenge-failed\n'); process.exitCode = 1; });
}
module.exports = { planObservation, renderChallenge, prepare, readResult, verifyNativeRetention };
