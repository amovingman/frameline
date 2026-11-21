'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const sha = value => createHash('sha256').update(value).digest('hex');
const utility = path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const projectName = 'Frameline Integration Gate Fixture 20261120';
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('invalid-clock-result');
}
function integer(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) throw new Error('invalid-clock-result'); }
function validateClockDescription(wall) {
  if (!wall || !['captured', 'captured-coarse', 'unavailable'].includes(wall.status)) throw new Error('invalid-clock-result');
  if (wall.status === 'captured') {
    exact(wall, ['status', 'id', 'clockId', 'binding', 'monotonic', 'reportedResolutionNs'], ['observedMinimumStepNs']);
    if (wall.id !== 'posix-clock-monotonic' || wall.clockId !== 6 || wall.binding !== 'LuaJIT-FFI-clock_gettime' || wall.monotonic !== true) throw new Error('invalid-clock-result');
  } else if (wall.status === 'captured-coarse') {
    exact(wall, ['status', 'id', 'monotonic', 'reportedResolutionNs'], ['observedMinimumStepNs']);
    if (wall.id !== 'lua-os-time' || wall.monotonic !== false || wall.reportedResolutionNs !== 1000000000) throw new Error('invalid-clock-result');
  } else {
    exact(wall, ['status', 'id', 'monotonic']);
    if (wall.id !== 'unavailable' || wall.monotonic !== false) throw new Error('invalid-clock-result');
  }
  if (Object.hasOwn(wall, 'reportedResolutionNs')) integer(wall.reportedResolutionNs, 1);
  if (Object.hasOwn(wall, 'observedMinimumStepNs')) integer(wall.observedMinimumStepNs, 1);
  return wall;
}
function validateClockResult(result) {
  exact(result, ['schemaVersion', 'operation', 'probeId', 'readOnly', 'safeToApply', 'resolveVersion', 'projectName', 'projectId', 'wallClock', 'emptyCallSample']);
  validateClockDescription(result.wallClock);
  const sample = result.emptyCallSample;
  exact(sample, ['wallStatus', 'cpuStatus', 'returnedNormally'], ['wallNs', 'cpuMicros']);
  if (!['captured', 'unavailable-or-regressed'].includes(sample.wallStatus) || !['captured', 'unavailable'].includes(sample.cpuStatus) || sample.returnedNormally !== true) throw new Error('invalid-clock-result');
  if (sample.wallStatus === 'captured') integer(sample.wallNs);
  else if (Object.hasOwn(sample, 'wallNs')) throw new Error('invalid-clock-result');
  if (sample.cpuStatus === 'captured') integer(sample.cpuMicros);
  else if (Object.hasOwn(sample, 'cpuMicros')) throw new Error('invalid-clock-result');
  return result;
}

function renderClockProbe({ base, clock, probeId, resultPath, completePath }) {
  if (!/^[a-f0-9]{32}$/.test(probeId) || ![resultPath, completePath].every(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f"\\]/.test(value))) throw new Error('invalid-clock-probe-binding');
  const sentinel = 'return { capture_request = capture_request }';
  if (base.split(sentinel).length !== 2) throw new Error('invalid-clock-probe-base');
  return `local expected=${JSON.stringify(projectName)};local probe_id=${JSON.stringify(probeId)};local result_path=${JSON.stringify(resultPath)};local complete_path=${JSON.stringify(completePath)};
local ok=pcall(function()
assert(resolve and resolve:GetVersionString()=='21.1.2.10','Unexpected version');local p=resolve:GetProjectManager():GetCurrentProject();assert(p and p:GetName()==expected,'Unexpected project');
local project_id=p:GetUniqueId();assert(type(project_id)=='string' and project_id:match('^[A-Za-z0-9_.%-]+$'),'Invalid project ID');
local base=(function() ${base.replace(sentinel, 'return {encode=encode}')} end)();local clocks=(function() ${clock} end)();local timer=clocks.open();
local success,values,err,sample=timer.measure(function() return true end);assert(success,'Clock sample failed');
local result={schemaVersion=1,operation='resolve-operation-clock-probe',probeId=probe_id,readOnly=true,safeToApply=false,resolveVersion='21.1.2.10',projectName=expected,projectId=project_id,wallClock=timer.description,emptyCallSample=sample};
local fusion=assert(resolve:Fusion());local function absent(name)local f=fusion:OpenFile(name,1);if f then f:Close();error('Output exists')end end;
absent(result_path);absent(complete_path);
local function write(name,value)absent(name);local f=assert(fusion:OpenFile(name,2));local written=pcall(function()assert(f:WriteLine(value)==#value+1);assert(f:Flush()==true)end);local closed=pcall(function()f:Close()end);assert(written and closed);local r=assert(fusion:OpenFile(name,1));local expected=value..'\\n';local good,actual=pcall(function()assert(r:GetFileSize()==#expected);local parts,n={},0;while n<#expected do local s=r:ReadLine();assert(type(s)=='string' and #s>0 and #s<=#expected-n);n=n+#s;parts[#parts+1]=s end;assert(r:ReadLine()==nil);return table.concat(parts)end);local shut=pcall(function()r:Close()end);assert(good and shut and actual==expected)end;
write(result_path,base.encode(result));write(complete_path,'FRAMELINE_OPERATION_CLOCK_COMPLETE_V1:'..probe_id);print('FRAMELINE_OPERATION_CLOCK_OK_V1:'..probe_id)
end);if not ok then print('FRAMELINE_OPERATION_CLOCK_FAILED_V1:'..probe_id)end`;
}

async function prepareClockProbe({ install = false } = {}) {
  if (typeof install !== 'boolean') throw new Error('invalid-clock-probe-options');
  const base = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  const clock = await fs.readFile(path.join(__dirname, 'resolve-operation-clock.lua'), 'utf8');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-operation-clock-')); await fs.chmod(directory, 0o700);
  const probeId = randomBytes(16).toString('hex');
  const resultPath = path.join(directory, `result-${probeId}.json`), completePath = path.join(directory, `complete-${probeId}.txt`);
  const preparedPath = path.join(directory, `Frameline Operation Clock ${probeId.slice(0, 12)}.lua`);
  const source = renderClockProbe({ base, clock, probeId, resultPath, completePath });
  await fs.writeFile(preparedPath, source, { flag: 'wx', mode: 0o600 });
  const record = { schemaVersion: 1, operation: 'prepare-resolve-operation-clock-probe', probeId, expectedProjectName: projectName,
    directory, preparedPath, resultPath, completePath, sourceSha256: sha(source), baseSourceSha256: sha(base), clockSourceSha256: sha(clock),
    installedPath: install ? path.join(utility, path.basename(preparedPath)) : null };
  if (install) { const info = await fs.lstat(utility); if (!info.isDirectory() || await fs.realpath(utility) !== utility) throw new Error('invalid-clock-install-directory');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 }); }
  await fs.writeFile(path.join(directory, 'preparation.json'), JSON.stringify(record, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  return record;
}

// Accept the historical macOS /var alias only through the known system-temp root.
// Every chmod rechecks this binding and the opened file's named identity.
async function verifiedOutputDirectory(directory) {
  const absolute=path.resolve(directory), canonicalTemp=await fs.realpath(os.tmpdir()), name=path.basename(absolute);
  const canonicalDirectory=path.join(canonicalTemp,name), actual=await fs.realpath(absolute);
  const allowed=[path.join(path.resolve(os.tmpdir()),name),canonicalDirectory];
  const info=await fs.lstat(absolute),uid=typeof process.getuid==='function'?process.getuid():null;
  if(!name.startsWith('frameline-operation-clock-')||!allowed.includes(absolute)||actual!==canonicalDirectory
    ||!info.isDirectory()||info.mode&0o077||uid!==null&&info.uid!==uid)throw new Error('invalid-clock-directory');
}

async function readClockProbe(preparationFile) {
  const record = JSON.parse(readInput(preparationFile));
  const directory = path.dirname(preparationFile), uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (record.schemaVersion !== 1 || record.operation !== 'prepare-resolve-operation-clock-probe' || !/^[a-f0-9]{32}$/.test(record.probeId)
    || path.resolve(record.directory) !== path.resolve(directory) || record.expectedProjectName !== projectName
    || record.preparedPath !== path.join(record.directory, `Frameline Operation Clock ${record.probeId.slice(0, 12)}.lua`)
    || record.resultPath !== path.join(record.directory, `result-${record.probeId}.json`) || record.completePath !== path.join(record.directory, `complete-${record.probeId}.txt`)) throw new Error('invalid-clock-preparation');
  await verifiedOutputDirectory(directory);
  const base = await fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
  const clock = await fs.readFile(path.join(__dirname, 'resolve-operation-clock.lua'), 'utf8');
  const source = readInput(record.preparedPath);
  if (sha(source) !== record.sourceSha256 || sha(base) !== record.baseSourceSha256 || sha(clock) !== record.clockSourceSha256
    || !source.equals(Buffer.from(renderClockProbe({ base, clock, ...record })))) throw new Error('clock-source-changed');
  for (const filename of [record.resultPath, record.completePath]) {
    await verifiedOutputDirectory(directory);
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try { const file = await handle.stat(); if (!file.isFile() || file.nlink !== 1 || file.size > 8192 || uid !== null && file.uid !== uid) throw new Error('invalid-clock-output'); await verifiedOutputDirectory(directory); const named=await fs.lstat(filename); if(!named.isFile()||named.dev!==file.dev||named.ino!==file.ino||named.nlink!==1)throw new Error('invalid-clock-output'); await handle.chmod(0o600); }
    finally { await handle.close(); }
  }
  const bytes = readInput(record.resultPath), result = validateClockResult(JSON.parse(bytes));
  if (readInput(record.completePath).toString('utf8') !== `FRAMELINE_OPERATION_CLOCK_COMPLETE_V1:${record.probeId}\n`
    || result.schemaVersion !== 1 || result.operation !== 'resolve-operation-clock-probe' || result.probeId !== record.probeId
    || result.projectName !== projectName || result.resolveVersion !== '21.1.2.10' || result.readOnly !== true || result.safeToApply !== false
    || typeof result.projectId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(result.projectId)) throw new Error('invalid-clock-result');
  return { ...result, resultSha256: sha(bytes), sourceSha256: record.sourceSha256, clockSourceSha256: record.clockSourceSha256, completionMarkerVerified: true,
    limitations: ['POSIX clock access is an OS runtime capability, not an editor write permission.', 'Reported resolution and observed minimum steps are not an accuracy guarantee.', 'CPU samples can include other active editor threads.'] };
}
if (require.main === module) {
  const [operation, arg] = process.argv.slice(2);
  const action = operation === 'prepare' && (arg === undefined || arg === '--install') ? prepareClockProbe({ install: arg === '--install' })
    : operation === 'read' && arg ? readClockProbe(arg) : Promise.reject(new Error('usage'));
  action.then(value => process.stdout.write(JSON.stringify(value, null, 2)+'\n')).catch(() => { process.stderr.write('resolve-operation-clock-probe-failed\n'); process.exitCode = 1; });
}
module.exports = { renderClockProbe, prepareClockProbe, readClockProbe, validateClockResult, validateClockDescription };
