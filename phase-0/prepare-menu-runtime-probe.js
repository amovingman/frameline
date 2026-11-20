'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { inspectApi, reference } = require('./inspect-resolve-api');
const { readInput } = require('./integration-input');
const projectName = 'Frameline Large Scan Proof 20261119 corpus01';
const utility = path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function renderProbe(template, { probeId, resultPath, completePath }) {
  if (!/^[a-f0-9]{32}$/.test(probeId) || ![resultPath, completePath].every(filename => path.isAbsolute(filename)
    && !/[\x00-\x1f\x7f"\\]/.test(filename)) || resultPath === completePath) throw new Error('invalid-probe-binding');
  const bindings = { __EXPECTED_PROJECT_NAME__: projectName, __PROBE_ID__: probeId,
    __RESULT_PATH__: resultPath, __COMPLETE_PATH__: completePath };
  let source = template;
  for (const [token, value] of Object.entries(bindings)) {
    if (source.split(token).length !== 2) throw new Error('invalid-probe-template');
    source = source.replace(token, () => JSON.stringify(value));
  }
  return source;
}

async function prepare({ install = false } = {}) {
  if (typeof install !== 'boolean') throw new Error('invalid-probe-options');
  const api = inspectApi(await fs.readFile(reference));
  const templateFile = path.join(__dirname, 'resolve-menu-runtime-probe.lua');
  const template = await fs.readFile(templateFile, 'utf8');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-menu-runtime-'));
  await fs.chmod(directory, 0o700);
  const probeId = randomBytes(16).toString('hex');
  const resultPath = path.join(directory, `result-${probeId}.json`);
  const completePath = path.join(directory, `complete-${probeId}.txt`);
  const source = renderProbe(template, { probeId, resultPath, completePath });
  const filename = `Frameline Runtime Probe ${probeId.slice(0, 12)}.lua`;
  const preparedPath = path.join(directory, filename);
  await fs.writeFile(preparedPath, source, { flag: 'wx', mode: 0o600 });
  const writerSource = await fs.readFile(path.join(__dirname, '../src/resolve-rename-trial.js'));
  const record = { schemaVersion: 1, probeId, readOnly: true, safeToApply: false, expectedProjectName: projectName,
    directory, preparedPath, resultPath, completePath,
    installedPath: install ? path.join(utility, filename) : null,
    sourceSha256: sha(source), templateSha256: sha(template), apiReferenceSha256: api.referenceSha256,
    knownWriterSourceSha256: sha(writerSource), newLiveEditorRun: false,
    limitation: 'Preflight refuses existing outputs; Fusion IOClass does not provide proven atomic exclusive creation.' };
  if (install) {
    const info = await fs.lstat(utility);
    if (!info.isDirectory() || await fs.realpath(utility) !== utility) throw new Error('unsafe-probe-install-directory');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 });
    if (!(await fs.readFile(record.installedPath)).equals(Buffer.from(source))) throw new Error('probe-install-mismatch');
  }
  await fs.writeFile(path.join(directory, 'preparation.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return record;
}

async function readResult(preparationFile) {
  function bounded(filename, limit) {
    const data = readInput(filename);
    if (data.length > limit) throw new Error('invalid-probe-file');
    return data;
  }
  const record = JSON.parse(await bounded(preparationFile, 8192));
  if (record.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(record.probeId) || record.expectedProjectName !== projectName) throw new Error('invalid-probe-preparation');
  const directory = path.dirname(preparationFile);
  if (path.resolve(record.directory) !== path.resolve(directory)
    || record.preparedPath !== path.join(record.directory, `Frameline Runtime Probe ${record.probeId.slice(0, 12)}.lua`)
    || record.resultPath !== path.join(record.directory, `result-${record.probeId}.json`)
    || record.completePath !== path.join(record.directory, `complete-${record.probeId}.txt`)) throw new Error('invalid-probe-preparation');
  const directoryInfo = await fs.lstat(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077 || uid !== null && directoryInfo.uid !== uid) throw new Error('unsafe-probe-result-directory');
  // Fusion inherits its own file-creation mode. The containing directory must
  // already be private; tighten the two owned output files through no-follow,
  // nonblocking descriptors before reading or returning their validated data.
  for (const filename of [record.resultPath, record.completePath]) {
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || uid !== null && info.uid !== uid) throw new Error('invalid-probe-output-file');
      await handle.chmod(0o600);
    } finally { await handle.close(); }
  }
  const source = await bounded(record.preparedPath, 16384);
  if (sha(source) !== record.sourceSha256) throw new Error('probe-source-changed');
  const template = await fs.readFile(path.join(__dirname, 'resolve-menu-runtime-probe.lua'), 'utf8');
  if (record.templateSha256 !== sha(template) || !source.equals(Buffer.from(renderProbe(template, record)))) throw new Error('probe-source-changed');
  const bytes = await bounded(record.resultPath, 4096);
  const result = JSON.parse(bytes);
  const marker = (await bounded(record.completePath, 256)).toString('utf8');
  const keys = ['schemaVersion', 'operation', 'probeId', 'readOnly', 'safeToApply', 'resolveVersion', 'projectName',
    'projectId', 'timelineCount', 'standardLuaIoAvailable', 'fusionOpenFileAvailable'];
  if (Object.keys(result).sort().join(',') !== keys.sort().join(',')) throw new Error('invalid-probe-result');
  if (marker !== `FRAMELINE_MENU_PROBE_COMPLETE_V1:${record.probeId}\n` || result.schemaVersion !== 1
    || result.probeId !== record.probeId || result.operation !== 'resolve-menu-runtime-probe'
    || result.readOnly !== true || result.safeToApply !== false || result.projectName !== projectName
    || result.resolveVersion !== '21.1.2.10' || typeof result.projectId !== 'string'
    || !/^[A-Za-z0-9_.-]{1,160}$/.test(result.projectId) || !Number.isSafeInteger(result.timelineCount)
    || result.timelineCount < 0 || result.timelineCount > 100000 || typeof result.standardLuaIoAvailable !== 'boolean'
    || result.fusionOpenFileAvailable !== true) throw new Error('invalid-probe-result');
  return { ...result, resultSha256: sha(bytes), completionMarkerVerified: true, editorStateMutated: false,
    limitation: 'Copied local runtime evidence is not authenticated editor provenance or an ordinary project write capability.' };
}
if (require.main === module) {
  const [operation, ...args] = process.argv.slice(2);
  const action = operation === 'prepare' && (args.length === 0 || args.length === 1 && args[0] === '--install')
    ? prepare({ install: args[0] === '--install' })
    : operation === 'read' && args.length === 1 ? readResult(args[0]) : Promise.reject(new Error('invalid-probe-command'));
  action.then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(() => { process.stderr.write('resolve-menu-runtime-probe-failed\n'); process.exitCode = 1; });
}
module.exports = { renderProbe, prepare, readResult };
