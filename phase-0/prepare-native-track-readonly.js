'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readInput } = require('./integration-input');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { planObservation } = require('./prepare-native-track-challenge');
const { loadCalibration, joinCalibratedTracks, json, sha } = require('./native-track-readonly-join');
const NAME = 'Frameline Integration Gate Fixture 20261120';
const SOURCES = ['phase-0/prepare-native-track-readonly.js', 'phase-0/resolve-native-track-readonly.lua',
  'phase-0/native-track-readonly-join.js', 'phase-0/resolve-native-track-identity.py', 'phase-0/compare-native-resolve-exports.py',
  'src/companion/resolve-internal.lua', 'src/companion/resolve-effects.lua', 'src/resolve-property-contract.json'];
const ROOT = path.resolve(__dirname, '..');
const graph = (archive, observation) => JSON.parse(execFileSync('python3', [path.join(__dirname, 'resolve-native-track-identity.py'),
  observation ? 'bind-api' : 'graph', archive, ...(observation ? [observation] : [])], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
async function sourceHashes() { return Object.fromEntries(await Promise.all(SOURCES.map(async file => [file, sha(await fs.readFile(path.join(ROOT, file)))]))); }
async function renderReadOnly(record) {
  let source = await fs.readFile(path.join(__dirname, 'resolve-native-track-readonly.lua'), 'utf8');
  const rawBase = await fs.readFile(path.join(ROOT, 'src/companion/resolve-internal.lua'), 'utf8');
  const sentinel = 'return { capture_request = capture_request }';
  if (rawBase.split(sentinel).length !== 2) throw new Error('incompatible-readonly-capture');
  const replacements = { __EXPECTED_NAME__: JSON.stringify(NAME), __EXPECTED_PROJECT_ID__: JSON.stringify(record.projectId),
    __EXPECTED_OBSERVATION__: JSON.stringify(json(record.observation)), __PROBE_ID__: JSON.stringify(record.probeId),
    __RESULT_PATH__: JSON.stringify(record.resultPath), __MARKER_PATH__: JSON.stringify(record.markerPath),
    __FIRST_EXPORT__: JSON.stringify(record.exports.first), __SECOND_EXPORT__: JSON.stringify(record.exports.second),
    __BASE_SOURCE__: rawBase.replace(sentinel, 'return {capture=capture, encode=encode, array=array}'),
    __EFFECT_SOURCE__: await fs.readFile(path.join(ROOT, 'src/companion/resolve-effects.lua'), 'utf8'), __PROPERTY_CONFIG__: propertyCaptureConfig() };
  for (const [token, value] of Object.entries(replacements)) {
    if (source.split(token).length !== 2) throw new Error('invalid-readonly-template');
    source = source.replace(token, () => value);
  }
  return source;
}

async function prepare(archivePath, observationPath, { install = false } = {}) {
  if (!path.isAbsolute(archivePath || '') || !path.isAbsolute(observationPath || '') || typeof install !== 'boolean') throw new Error('invalid-readonly-options');
  const calibration = loadCalibration(), observationBytes = readInput(observationPath);
  const observation = planObservation(observationBytes, 'a'.repeat(32)).observation;
  const native = graph(archivePath, observationPath), archive = readInput(archivePath);
  if (native.archive.sha256 !== sha(archive)) throw new Error('readonly-source-archive-changed');
  joinCalibratedTracks(calibration, [observation, observation, observation], [native, native]);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-track-readonly-')));await fs.chmod(directory,0o700);
  const probeId = randomBytes(16).toString('hex');
  const record = { schemaVersion: 1, operation: 'prepare-native-track-readonly', directory, probeId,
    projectId: observation.snapshot.project_id, projectName: NAME, observation, observationSourceSha256: sha(observationBytes),
    calibrationGraphSha256: sha(json(calibration.graph)), sourceArchiveSha256: sha(archive),
    sourceArchivePath: path.join(directory, 'source.drp'), sourceObservationPath: path.join(directory, 'source-observation.json'),
    preparedPath: path.join(directory, `Frameline Track Readonly ${probeId.slice(0,12)}.lua`),
    resultPath: path.join(directory, `result-${probeId}.json`), markerPath: path.join(directory, `complete-${probeId}.txt`),
    exports: { first: path.join(directory, 'first.drp'), second: path.join(directory, 'second.drp') },
    sourceHashes: await sourceHashes(), ordinaryApplySupported: false };
  const source = await renderReadOnly(record); record.sourceSha256 = sha(source);
  record.installedPath = install ? path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.preparedPath)) : null;
  await fs.writeFile(record.sourceArchivePath,archive,{flag:'wx',mode:0o600});
  await fs.writeFile(record.sourceObservationPath,observationBytes,{flag:'wx',mode:0o600});
  await fs.writeFile(record.preparedPath,source,{flag:'wx',mode:0o600});
  if (install) {
    const target = path.dirname(record.installedPath), info = await fs.lstat(target);
    if (!info.isDirectory() || await fs.realpath(target) !== target) throw new Error('unsafe-readonly-install');
    await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});
  }
  const preparation = path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return { preparation, menuName: path.basename(record.preparedPath,'.lua'), preparedPath: record.preparedPath,
    sourceSha256: record.sourceSha256, projectId: record.projectId, readOnly: true, ordinaryApplySupported: false };
}
async function ownedFile(filename) {
  const handle = await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const info=await handle.stat();if(!info.isFile()||info.nlink!==1||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error('unsafe-readonly-output');await handle.chmod(0o600); }
  finally { await handle.close(); }
  return readInput(filename);
}
async function readResult(preparation) {
  if (!path.isAbsolute(preparation||'')) throw new Error('invalid-readonly-preparation');
  const record=JSON.parse(readInput(preparation)), directory=path.dirname(preparation), info=await fs.lstat(directory);
  if(!info.isDirectory()||info.mode&0o077||await fs.realpath(directory)!==directory||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error('unsafe-readonly-directory');
  if(record.schemaVersion!==1||record.operation!=='prepare-native-track-readonly'||record.directory!==directory||record.projectName!==NAME||!/^[a-f0-9]{32}$/.test(record.probeId)
    ||record.preparedPath!==path.join(directory,`Frameline Track Readonly ${record.probeId.slice(0,12)}.lua`)
    ||record.sourceArchivePath!==path.join(directory,'source.drp')||record.sourceObservationPath!==path.join(directory,'source-observation.json')
    ||record.resultPath!==path.join(directory,`result-${record.probeId}.json`)||record.markerPath!==path.join(directory,`complete-${record.probeId}.txt`)
    ||json(record.exports)!==json({first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp')}))throw new Error('invalid-readonly-record');
  const calibration=loadCalibration(), source=await ownedFile(record.preparedPath);
  const observation=planObservation(await ownedFile(record.sourceObservationPath),'a'.repeat(32)).observation;
  if(record.projectId!==observation.snapshot.project_id||json(record.observation)!==json(observation)||sha(source)!==record.sourceSha256||source.toString()!==await renderReadOnly(record)
    ||json(await sourceHashes())!==json(record.sourceHashes)||record.calibrationGraphSha256!==sha(json(calibration.graph))
    ||sha(await ownedFile(record.sourceArchivePath))!==record.sourceArchiveSha256||sha(await ownedFile(record.sourceObservationPath))!==record.observationSourceSha256)throw new Error('readonly-source-changed');
  const baseline=graph(record.sourceArchivePath,record.sourceObservationPath);
  joinCalibratedTracks(calibration,[observation,observation,observation],[baseline,baseline]);
  const raw=await ownedFile(record.resultPath), result=JSON.parse(raw);
  if(Object.keys(result).sort().join(',')!==['schemaVersion','operation','probeId','status','stage','readOnly','safeToApply','ordinaryApplySupported','events','before','between','after','pageBefore','pageAfter'].sort().join(',')
    ||result.schemaVersion!==1||result.operation!=='resolve-native-track-readonly-capture'||result.probeId!==record.probeId||result.readOnly!==true||result.safeToApply!==false||result.ordinaryApplySupported!==false
    ||!['captured','refused'].includes(result.status)||readInput(record.markerPath).toString()!==`FRAMELINE_TRACK_READONLY_COMPLETE_V1:${record.probeId}\n`)throw new Error('invalid-readonly-result');
  if(result.status!=='captured')return {status:result.status,stage:result.stage,readOnly:true,ordinaryApplySupported:false};
  if(result.stage!=='complete'||typeof result.pageBefore!=='string'||result.pageBefore!==result.pageAfter
    ||json(result.events)!==json(['capture-before','export-first','capture-between','export-second','capture-after'])
    ||[result.before,result.between,result.after].some(value=>json(value)!==json(observation)))throw new Error('readonly-capture-source-differs');
  const graphs=[];
  for(const filename of Object.values(record.exports)) {
    const bytes=await ownedFile(filename), native=graph(filename,record.sourceObservationPath);
    if(native.archive.sha256!==sha(bytes))throw new Error('readonly-export-changed');graphs.push(native);
  }
  return {...joinCalibratedTracks(calibration,[result.before,result.between,result.after],graphs),status:'captured',probeId:record.probeId,
    sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,resultSha256:sha(raw),resultBytes:raw.length,
    sourceArchiveSha256:record.sourceArchiveSha256,sourceObservationSha256:record.observationSourceSha256,
    sourceAndResultVerified:true,events:result.events,pageUnchanged:true,graphs:{first:graphs[0],second:graphs[1]}};
}
if(require.main===module){const[operation,target,observation,flag]=process.argv.slice(2);
  const action=operation==='prepare'&&target&&observation&&(!flag||flag==='--install')?prepare(target,observation,{install:flag==='--install'}):operation==='read'&&target&&!observation?readResult(target):Promise.reject(new Error('usage'));
  action.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(()=>{process.stderr.write('native-track-readonly-failed\n');process.exitCode=1;});}
module.exports={prepare,readResult,renderReadOnly};
