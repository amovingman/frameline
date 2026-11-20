'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { inspectApi, reference } = require('./inspect-resolve-api');
const { readInput } = require('./integration-input');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const projectName = 'Frameline Large Scan Proof 20261119 corpus01';
const utility = path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const basename = probeId => `Frameline Read Only Inventory ${probeId.slice(0, 12)}.lua`;

function renderInventory(template, baseSource, { probeId, resultPath, completePath }) {
  if (!/^[a-f0-9]{32}$/.test(probeId) || ![resultPath, completePath].every(filename => path.isAbsolute(filename)
    && !/[\x00-\x1f\x7f"\\]/.test(filename)) || resultPath === completePath) throw new Error('invalid-menu-inventory-binding');
  const sentinel = 'return { capture_request = capture_request }';
  if (baseSource.split(sentinel).length !== 2) throw new Error('invalid-menu-inventory-base');
  let source = template;
  for (const [token, value] of Object.entries({ __EXPECTED_PROJECT_NAME__: JSON.stringify(projectName), __PROBE_ID__: JSON.stringify(probeId),
    __RESULT_PATH__: JSON.stringify(resultPath), __COMPLETE_PATH__: JSON.stringify(completePath),
    __BASE_CAPTURE_SOURCE__: baseSource.replace(sentinel, 'return {capture=capture, encode=encode}') })) {
    if (source.split(token).length !== 2) throw new Error('invalid-menu-inventory-template');
    source = source.replace(token, () => value);
  }
  return source;
}

async function prepareInventory({ install = false } = {}) {
  if (typeof install !== 'boolean') throw new Error('invalid-menu-inventory-options');
  const api = inspectApi(await fs.readFile(reference));
  const template = await fs.readFile(path.join(__dirname, 'resolve-menu-inventory.lua'), 'utf8');
  const baseSource = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-menu-inventory-'));
  await fs.chmod(directory, 0o700);
  const probeId = randomBytes(16).toString('hex');
  const resultPath = path.join(directory, `inventory-${probeId}.json`), completePath = path.join(directory, `complete-${probeId}.txt`);
  const source = renderInventory(template, baseSource, { probeId, resultPath, completePath });
  const preparedPath = path.join(directory, basename(probeId));
  await fs.writeFile(preparedPath, source, { flag: 'wx', mode: 0o600 });
  const record = { schemaVersion: 1, operation: 'prepare-resolve-menu-inventory', probeId, readOnly: true, safeToApply: false,
    expectedProjectName: projectName, directory, preparedPath, resultPath, completePath,
    installedPath: install ? path.join(utility, basename(probeId)) : null, sourceSha256: sha(source), templateSha256: sha(template),
    baseSourceSha256: sha(baseSource), apiReferenceSha256: api.referenceSha256, newLiveEditorRun: false };
  if (install) {
    const info = await fs.lstat(utility);
    if (!info.isDirectory() || await fs.realpath(utility) !== utility) throw new Error('unsafe-menu-inventory-directory');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 });
    if (!(await fs.readFile(record.installedPath)).equals(Buffer.from(source))) throw new Error('menu-inventory-install-mismatch');
  }
  await fs.writeFile(path.join(directory, 'preparation.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return record;
}

async function readInventoryResult(preparationFile) {
  const bounded = (filename, limit) => { const bytes = readInput(filename); if (bytes.length > limit) throw new Error('menu-inventory-input-too-large'); return bytes; };
  const record = JSON.parse(bounded(preparationFile, 8192));
  const directory = path.dirname(preparationFile);
  if (record.schemaVersion !== 1 || record.operation !== 'prepare-resolve-menu-inventory' || !/^[a-f0-9]{32}$/.test(record.probeId)
    || record.expectedProjectName !== projectName || path.resolve(record.directory) !== path.resolve(directory)
    || record.preparedPath !== path.join(record.directory, basename(record.probeId))
    || record.resultPath !== path.join(record.directory, `inventory-${record.probeId}.json`)
    || record.completePath !== path.join(record.directory, `complete-${record.probeId}.txt`)) throw new Error('invalid-menu-inventory-preparation');
  const directoryInfo = await fs.lstat(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077 || uid !== null && directoryInfo.uid !== uid) throw new Error('unsafe-menu-inventory-directory');
  for (const filename of [record.resultPath, record.completePath]) {
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || uid !== null && info.uid !== uid) throw new Error('invalid-menu-inventory-file');
      await handle.chmod(0o600);
    }
    finally { await handle.close(); }
  }
  const source = bounded(record.preparedPath, 64 * 1024);
  if (sha(source) !== record.sourceSha256) throw new Error('menu-inventory-source-changed');
  const template = await fs.readFile(path.join(__dirname, 'resolve-menu-inventory.lua'), 'utf8');
  const baseSource = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  if (record.templateSha256 !== sha(template) || record.baseSourceSha256 !== sha(baseSource)
    || !source.equals(Buffer.from(renderInventory(template, baseSource, record)))) throw new Error('menu-inventory-source-changed');
  const bytes = bounded(record.resultPath, 20 * 1024 * 1024), result = JSON.parse(bytes);
  const keys = ['schemaVersion', 'operation', 'probeId', 'readOnly', 'safeToApply', 'snapshot', 'capturePasses', 'representedStateUnchangedAcrossReads', 'cpuTimeStatus'];
  if (Object.hasOwn(result, 'cpuMicros')) keys.push('cpuMicros');
  if (Object.keys(result).sort().join(',') !== keys.sort().join(',') || result.schemaVersion !== 1
    || result.operation !== 'resolve-menu-inventory' || result.probeId !== record.probeId || result.readOnly !== true
    || result.safeToApply !== false || result.capturePasses !== 2 || result.representedStateUnchangedAcrossReads !== true
    || !['captured', 'unavailable'].includes(result.cpuTimeStatus)
    || (result.cpuTimeStatus === 'captured' ? !Number.isSafeInteger(result.cpuMicros) || result.cpuMicros < 0 : Object.hasOwn(result, 'cpuMicros'))) throw new Error('invalid-menu-inventory-result');
  validateResolveSnapshot(result.snapshot);
  if (result.snapshot.project_name !== projectName || result.snapshot.resolve_version !== '21.1.2.10') throw new Error('menu-inventory-target-mismatch');
  const marker = bounded(record.completePath, 256);
  if (marker.toString('utf8') !== `FRAMELINE_MENU_INVENTORY_COMPLETE_V1:${record.probeId}\n`) throw new Error('menu-inventory-incomplete');
  const timelines = result.snapshot.timelines.map(timeline => ({ id: timeline.id, name: timeline.name, startFrame: timeline.start_frame,
    tracks: timeline.tracks, itemCount: timeline.items.length,
    itemTypes: Object.fromEntries([...new Set(timeline.items.map(item => item.type))].sort().map(type => [type, timeline.items.filter(item => item.type === type).length])),
    mediaPoolItemCount: new Set(timeline.items.map(item => item.media_pool_id).filter(Boolean)).size,
    linkedDirectedEdges: timeline.items.reduce((n, item) => n + item.linked_item_ids.length, 0),
    effectCounts: Object.fromEntries(['fusion', 'ofx', 'audio'].map(category => [category, timeline.items.reduce((n, item) => n + item.effect_counts[category], 0)])) }));
  return { snapshot: result.snapshot, summary: { schemaVersion: 1, operation: result.operation, probeId: result.probeId,
    readOnly: true, safeToApply: false, resolveVersion: result.snapshot.resolve_version, projectId: result.snapshot.project_id,
    projectName: result.snapshot.project_name, timelineCount: timelines.length,
    itemCount: timelines.reduce((n, timeline) => n + timeline.itemCount, 0), timelines,
    capturePasses: 2, representedStateUnchangedAcrossReads: true, cpuTimeStatus: result.cpuTimeStatus,
    cpuMicros: result.cpuMicros ?? null, cpuTimeScope: 'Process CPU sampled across two API captures and snapshot encodings; may include other editor threads. Not wall time or editor write/reopen latency.',
    resultBytes: bytes.length, resultSha256: sha(bytes), snapshotCanonicalSha256: sha(JSON.stringify(canonical(result.snapshot))),
    completionMarkerSha256: sha(marker), completionMarkerVerified: true, sourceSha256: record.sourceSha256,
    templateSha256: record.templateSha256, baseSourceSha256: record.baseSourceSha256, apiReferenceSha256: record.apiReferenceSha256,
    stableTrackIdentityProven: false, completeEnumerationProven: false, editorStateMutated: false,
    limitations: ['Schema-3 fields include effect counts, not parameters or full native properties.',
      'Two matching represented reads do not prove atomic capture or unrepresented state preservation.',
      'Track type/index/name are observed locations; no persistent track identity is inferred.',
      'Copied local files are not authenticated editor provenance; ordinary apply remains unavailable.'] } };
}
if (require.main === module) {
  const [operation, ...args] = process.argv.slice(2);
  const action = operation === 'prepare' && (args.length === 0 || args.length === 1 && args[0] === '--install')
    ? prepareInventory({ install: args[0] === '--install' })
    : ['read', 'snapshot'].includes(operation) && args.length === 1 ? readInventoryResult(args[0]).then(value => operation === 'snapshot' ? value.snapshot : value.summary)
      : Promise.reject(new Error('invalid-menu-inventory-command'));
  action.then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(() => { process.stderr.write('resolve-menu-inventory-failed\n'); process.exitCode = 1; });
}
module.exports = { renderInventory, prepareInventory, readInventoryResult };
