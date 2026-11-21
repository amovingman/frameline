'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { inspectApi, reference } = require('./inspect-resolve-api');
const { readInput } = require('./integration-input');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { parseItemStateObservation, describeItemStateCoverage } = require('../src/resolve-item-state-observation');
const projectName = 'Frameline Integration Gate Fixture 20261120';
const projectId = 'dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff';
const sourceFiles = ['src/companion/resolve-internal.lua', 'src/companion/resolve-effects.lua', 'src/companion/resolve-item-state.lua', 'phase-0/resolve-item-state-menu.lua'];
const root = path.resolve(__dirname, '..');
const utility = path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const basename = id => `Frameline Item State ${id.slice(0, 12)}.lua`;
function lua(value) {
  if (value === null) return 'base.null';
  if (Array.isArray(value)) return `setmetatable({${value.map(lua).join(',')}},base.arrayMeta)`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([name, value]) => `[${JSON.stringify(name)}]=${lua(value)}`).join(',')}}`;
  return JSON.stringify(value);
}
function checkBaseline(bytes) {
  const observed = parseEffectObservation(bytes);
  if (observed.schemaVersion !== 2 || observed.snapshot.project_name !== projectName || observed.snapshot.project_id !== projectId
    || observed.snapshot.timelines.length !== 1 || observed.items.length !== 50 || observed.tracks.length !== 5) throw new Error('unexpected-item-state-baseline');
  return observed.snapshot;
}
function renderItemStateMenu(sources, record, baseline = null) {
  if (!/^[a-f0-9]{32}$/.test(record.id || '') || Object.values(record.paths || {}).some(name => typeof name !== 'string'
    || !path.isAbsolute(name) || /[\x00-\x1f\x7f"\\]/.test(name))) throw new Error('invalid-item-state-menu-binding');
  const sentinel = 'return { capture_request = capture_request }';
  if (sources['src/companion/resolve-internal.lua'].split(sentinel).length !== 2) throw new Error('incompatible-item-state-menu-base');
  const bindings = {
    __PROJECT_NAME__: JSON.stringify(projectName), __PROJECT_ID__: JSON.stringify(projectId), __REQUEST_ID__: JSON.stringify(record.id),
    __RESULT_PATH__: JSON.stringify(record.paths.result), __OBSERVATION_PATH__: JSON.stringify(record.paths.observation),
    __MARKER_PATH__: JSON.stringify(record.paths.marker), __FAILURE_PATH__: JSON.stringify(record.paths.failure),
    __EXPECTED_SNAPSHOT__: baseline ? lua(baseline) : 'nil',
    __BASE_SOURCE__: sources['src/companion/resolve-internal.lua'].replace(sentinel, 'return {capture=capture,encode=encode,array=array,null=NULL,arrayMeta=ARRAY}'),
    __EFFECT_SOURCE__: sources['src/companion/resolve-effects.lua'], __STATE_SOURCE__: sources['src/companion/resolve-item-state.lua']
  };
  let source = sources['phase-0/resolve-item-state-menu.lua'];
  for (const [token, value] of Object.entries(bindings)) {
    if (source.split(token).length !== 2) throw new Error('invalid-item-state-menu-template');
    source = source.replace(token, () => value);
  }
  return source;
}
async function getSources() { return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')]))); }
async function prepareItemStateMenu({ baselineFile = null, install = false } = {}) {
  if (typeof install !== 'boolean' || baselineFile !== null && !path.isAbsolute(baselineFile)) throw new Error('invalid-item-state-menu-options');
  inspectApi(readInput(reference));
  const sources = await getSources(), directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-item-state-menu-')));
  await fs.chmod(directory, 0o700);
  const id = randomBytes(16).toString('hex');
  const paths = Object.fromEntries(Object.entries({ result: 'result.json', observation: 'observation.json', marker: 'complete.txt', failure: 'failure.json', baseline: 'baseline-observation.json' })
    .map(([name, filename]) => [name, path.join(directory, filename)]));
  const baselineBytes = baselineFile ? readInput(baselineFile) : null, baseline = baselineBytes ? checkBaseline(baselineBytes) : null;
  const record = { schemaVersion: 1, operation: 'prepare-item-state-menu', id, directory, paths,
    projectName, projectId, baselineSha256: baselineBytes ? sha(baselineBytes) : null,
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, sha(sources[file])])),
    sourcePath: path.join(directory, basename(id)), installedPath: install ? path.join(utility, basename(id)) : null };
  const source = renderItemStateMenu(sources, record, baseline); record.sourceSha256 = sha(source);
  if (baselineBytes) await fs.writeFile(paths.baseline, baselineBytes, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(record.sourcePath, source, { flag: 'wx', mode: 0o600 });
  if (install) {
    const info = await fs.lstat(utility);
    if (!info.isDirectory() || await fs.realpath(utility) !== utility || info.uid !== process.getuid()) throw new Error('unsafe-item-state-menu-install');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 });
    if (!(await fs.readFile(record.installedPath)).equals(Buffer.from(source))) throw new Error('item-state-menu-install-mismatch');
  }
  await fs.writeFile(path.join(directory, 'preparation.json'), JSON.stringify(record, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  return record;
}
async function ownedBytes(filename, maxBytes, tighten = false) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > maxBytes) throw new Error('invalid-item-state-menu-file');
    if (tighten) await handle.chmod(0o600);
    const before = await handle.stat();
    const bytes = Buffer.alloc(before.size + 1); let count = 0, read;
    while (count < bytes.length && (read = (await handle.read(bytes, count, bytes.length-count, count)).bytesRead)) count += read;
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('item-state-menu-file-changed');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
async function readItemStateMenu(preparationFile) {
  const directory = path.dirname(path.resolve(preparationFile)), record = JSON.parse(await ownedBytes(preparationFile, 8192));
  if (record.schemaVersion !== 1 || record.operation !== 'prepare-item-state-menu' || !/^[a-f0-9]{32}$/.test(record.id || '')
    || record.directory !== directory || record.projectName !== projectName || record.projectId !== projectId
    || record.sourcePath !== path.join(directory, basename(record.id))) throw new Error('invalid-item-state-menu-record');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid() || await fs.realpath(directory) !== directory) throw new Error('unsafe-item-state-menu-directory');
  for (const [name, filename] of Object.entries({ result: 'result.json', observation: 'observation.json', marker: 'complete.txt', failure: 'failure.json', baseline: 'baseline-observation.json' })) {
    if (record.paths[name] !== path.join(directory, filename)) throw new Error('invalid-item-state-menu-path');
  }
  const sources = await getSources();
  if (JSON.stringify(record.sourceHashes) !== JSON.stringify(Object.fromEntries(sourceFiles.map(file => [file, sha(sources[file])])))) throw new Error('item-state-menu-source-changed');
  const baselineBytes = record.baselineSha256 ? await ownedBytes(record.paths.baseline, 2 * 1024 * 1024) : null;
  if (baselineBytes && sha(baselineBytes) !== record.baselineSha256) throw new Error('item-state-menu-baseline-changed');
  const baseline = baselineBytes ? checkBaseline(baselineBytes) : null;
  const source = await ownedBytes(record.sourcePath, 128 * 1024);
  if (sha(source) !== record.sourceSha256 || !source.equals(Buffer.from(renderItemStateMenu(sources, record, baseline)))) throw new Error('item-state-menu-source-changed');
  try {
    const failure = JSON.parse(await ownedBytes(record.paths.failure, 4096, true));
    if (Object.keys(failure).sort().join(',') !== 'errorCode,operation,readOnly,requestId,safeToApply,schemaVersion,stage'
      || failure.schemaVersion !== 1 || failure.operation !== 'resolve-item-state-menu-failure' || failure.requestId !== record.id
      || failure.readOnly !== true || failure.safeToApply !== false || !['guard', 'capture', 'observation-write', 'result-write', 'marker-write'].includes(failure.stage)
      || !['capture-failed', 'output-failed', 'unsupported-field', 'invalid-value', 'oversize', 'state-changed',
        'expected-snapshot-diverged','item-state-diverged','page-context-diverged','snapshot-context-diverged','timeline-context-diverged','membership-diverged'].includes(failure.errorCode)) throw new Error('invalid-item-state-menu-failure');
    return { status: 'failed', readOnly: true, safeToApply: false, stage: failure.stage, errorCode: failure.errorCode, requestId: record.id };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const raw = await ownedBytes(record.paths.observation, 2 * 1024 * 1024, true), observation = parseItemStateObservation(raw);
  const result = JSON.parse(await ownedBytes(record.paths.result, 4096, true)), marker = await ownedBytes(record.paths.marker, 256, true);
  if (Object.keys(result).sort().join(',') !== 'itemCount,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion'
    || result.schemaVersion !== 1 || result.operation !== 'resolve-item-state-menu' || result.readOnly !== true || result.safeToApply !== false
    || result.requestId !== record.id || result.projectId !== projectId || result.itemCount !== 50 || result.observationBytes !== raw.length-1
    || marker.toString('utf8') !== `FRAMELINE_ITEM_STATE_MENU_COMPLETE_V1:${record.id}\n`
    || observation.snapshot.project_id !== projectId || observation.snapshot.project_name !== projectName || observation.items.length !== 50
    || observation.snapshot.timelines.length !== 1 || observation.snapshot.timelines[0].tracks.length !== 5
    || baseline && JSON.stringify(canonical(baseline)) !== JSON.stringify(canonical(observation.snapshot))) throw new Error('item-state-menu-result-mismatch');
  return { status: 'complete', readOnly: true, safeToApply: false, requestId: record.id, observation,
    observationSha256: sha(raw), snapshotCanonicalSha256: sha(JSON.stringify(canonical(observation.snapshot))),
    completionMarkerSha256: sha(marker), sourceSha256: record.sourceSha256, sourceHashes: record.sourceHashes,
    coverage: describeItemStateCoverage(observation), projectMutationCalls: 0 };
}
if (require.main === module) {
  const [operation, ...args] = process.argv.slice(2);
  const action = operation === 'prepare' ? prepareItemStateMenu({ baselineFile: args.find(arg => arg !== '--install') || null, install: args.includes('--install') })
    : ['read', 'observation'].includes(operation) && args.length === 1 ? readItemStateMenu(args[0]).then(result => {
      if (operation === 'observation') { if (result.status !== 'complete') throw new Error('item-state-menu-incomplete'); return result.observation; }
      const { observation, ...summary } = result; return summary;
    }) : Promise.reject(new Error('invalid-item-state-menu-command'));
  action.then(result => process.stdout.write(JSON.stringify(result, null, 2)+'\n')).catch(() => { process.stderr.write('item-state-menu-failed\n'); process.exitCode = 1; });
}
module.exports = { prepareItemStateMenu, readItemStateMenu, renderItemStateMenu, getSources, projectName, projectId, ownedBytes, lua };
