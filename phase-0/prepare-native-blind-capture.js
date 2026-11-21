'use strict';
// Disposable fixture construction and untouched captures only. Native UUID
// predictions are persisted before a separate independent name challenge.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { readInput } = require('./integration-input');
const { resultWriter, fileReader } = require('./gate-lab-session');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { parseApiLocationObservation, assessApiLocationWitnesses } = require('../src/resolve-api-location-observation');
const { readNativeLocationGraph, joinSynchronizedNativeTracks, json, sha } = require('./native-track-location-binding');
const ROOT = path.resolve(__dirname, '..');
const NAME = 'Frameline Identity Blind Fixture 20261120';
const PRIOR_PROJECT = 'dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff';
const q = JSON.stringify;
const SOURCES = ['phase-0/prepare-native-blind-capture.js', 'phase-0/native-track-location-binding.js', 'phase-0/resolve-native-location-graph.py',
  'phase-0/resolve-native-track-identity.py', 'phase-0/compare-native-resolve-exports.py', 'phase-0/gate-lab-session.js',
  'src/companion/resolve-internal.lua', 'src/companion/resolve-effects.lua', 'src/companion/resolve-api-locations.lua',
  'src/resolve-api-location-observation.js', 'src/resolve-property-contract.json'];
const sourceHashes = () => Object.fromEntries(SOURCES.map(file => [file, sha(readInput(path.join(ROOT, file)))]));

async function renderBlindCapture(record) {
  const rawBase = readInput(path.join(ROOT, 'src/companion/resolve-internal.lua')).toString();
  const sentinel = 'return { capture_request = capture_request }';
  if (rawBase.split(sentinel).length !== 2) throw new Error('incompatible-blind-capture');
  const base = rawBase.replace(sentinel, 'return {capture=capture,encode=encode,array=array}');
  const effects = readInput(path.join(ROOT, 'src/companion/resolve-effects.lua')).toString();
  const locations = readInput(path.join(ROOT, 'src/companion/resolve-api-locations.lua')).toString();
  let setup = '';
  if (record.stage === 'initialize') {
    const xml = readInput(record.inputPath).toString();
    setup = `assert(p:GetTimelineCount()==0,'Project is not empty');assert(p:GetUniqueId()~=${q(PRIOR_PROJECT)},'Prior project refused')
${fileReader(record.inputPath, xml)}
export(${q(record.emptyBackupPath)})
local timeline=assert(p:GetMediaPool():ImportTimelineFromFile(${q(record.inputPath)}),'Import failed')
assert(p:GetTimelineCount()==1 and p:SetCurrentTimeline(timeline)==true,'Timeline setup failed')
assert(timeline:GetTrackCount('video')==1 and timeline:GetTrackCount('audio')==1 and timeline:GetTrackCount('subtitle')==0,'Unexpected import layout')
assert(#(timeline:GetItemListInTrack('video',1)or{})==50,'Picture import differs')
for n=1,3 do assert(timeline:AddTrack('video')==true,'Video track failed')end
for n=1,3 do assert(timeline:AddTrack('audio','mono')==true,'Audio track failed')end
assert(timeline:GetTrackCount('video')==4 and timeline:GetTrackCount('audio')==4,'Fixture counts differ')
local wav=assert(fusion:OpenFile(${q(record.wavPath)},1),'Audio source unavailable');assert(wav:GetFileSize()==${record.wavBytes},'Audio source differs');wav:Close()
local pool=p:GetMediaPool();local imported=assert(pool:ImportMedia({${q(record.wavPath)}}),'Audio import failed');assert(#imported==1,'Audio count differs')
local start=timeline:GetStartFrame()
local added=assert(pool:AppendToTimeline({{mediaPoolItem=imported[1],startFrame=0,endFrame=47,mediaType=2,trackIndex=2,recordFrame=start},
 {mediaPoolItem=imported[1],startFrame=0,endFrame=47,mediaType=2,trackIndex=3,recordFrame=start+48}}),'Audio append failed')
assert(#added==2 and #(timeline:GetItemListInTrack('audio',2)or{})==1 and #(timeline:GetItemListInTrack('audio',3)or{})==1,'Audio placement differs')
for _,kind in ipairs({'video','audio'})do for index=1,timeline:GetTrackCount(kind)do assert(timeline:SetTrackName(kind,index,'Blind duplicate track')==true,'Track name failed')end end
assert(manager:SaveProject()==true,'Save failed');assert(manager:CloseProject(p)==true,'Close failed');assert(manager:LoadProject(${q(NAME)})~=nil,'Reload failed');p=current()
`;
  } else if (record.stage !== 'capture') throw new Error('unsupported-blind-stage');
  return `local ok,err=pcall(function()
assert(resolve and resolve:GetVersionString()=='21.1.2.10' and resolve:GetProductName()=='DaVinci Resolve' and resolve:IsStudio()==false,'Unexpected Resolve')
local manager=assert(resolve:GetProjectManager(),'No manager');local fusion=assert(resolve:Fusion(),'No Fusion')
local function current()local p=assert(manager:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)} and p:GetUniqueId()~=${q(PRIOR_PROJECT)},'Wrong blind fixture');return p end
local p=current()
${resultWriter()}
for _,name in ipairs({${Object.values(record.paths).map(q).join(',')},${q(record.emptyBackupPath)}})do absent(name)end
local function export(filename)absent(filename);assert(manager:ExportProject(${q(NAME)},filename,true)==true,'Export failed');local f=assert(fusion:OpenFile(filename,1),'Export missing');assert(f:GetFileSize()>0,'Export empty');f:Close();current()end
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)();local locations=(function()${locations}\nend)();local config=${propertyCaptureConfig()}
${setup}
local before=effects.capture(resolve,base,config)
${record.expectedObservation ? `assert(effects.encode(before)==${q(json(record.expectedObservation))},'Expected source differs')` : ''}
assert(before.snapshot.project_id==p:GetUniqueId() and #before.snapshot.timelines==1 and #before.items==52,'Fixture source differs')
local page=resolve:GetCurrentPage();assert(type(page)=='string','Page unavailable')
export(${q(record.paths.first)});local between=effects.capture(resolve,base,config)
export(${q(record.paths.second)});local after=effects.capture(resolve,base,config)
assert(effects.encode(before)==effects.encode(between) and effects.encode(before)==effects.encode(after),'State changed during export')
local witnessed=locations.capture(resolve,base,effects,config,52)
assert(effects.encode(witnessed.richContext)==effects.encode(after),'Witness source differs')
assert(resolve:GetCurrentPage()==page,'Page changed')
local value={schemaVersion=1,operation='resolve-native-blind-capture',stage=${q(record.stage)},probeId=${q(record.probeId)},readOnly=${record.stage === 'capture'},safeToApply=false,ordinaryApplySupported=false,
 before=before,between=between,after=after,apiLocationWitnesses=witnessed,pageBefore=page,pageAfter=resolve:GetCurrentPage()}
write_exact(${q(record.paths.result)},effects.encode(value));write_exact(${q(record.paths.marker)},${q('FRAMELINE_NATIVE_BLIND_CAPTURE_V1:' + record.probeId)})
end);if not ok then print('FRAMELINE_NATIVE_BLIND_CAPTURE_FAILED:'..tostring(err))end`;
}

async function prepareInitialize(inputPath, wavPath, { install = false } = {}) {
  if (!path.isAbsolute(inputPath || '') || !path.isAbsolute(wavPath || '') || typeof install !== 'boolean') throw new Error('invalid-blind-input');
  const xml = readInput(inputPath), wav = readInput(wavPath);
  const { scanXml } = require('../src/fcpxml-adapter');
  const scan = scanXml(xml.toString());
  if (scan.clips.length !== 50 || scan.warnings.length || scan.sequence.durationFrames !== 2400
    || sha(wav) !== '5a3a95eeabfea55414cb8f4159518c197bc81410bb2f628166f245458521093d') throw new Error('unexpected-blind-input');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-native-blind-')));await fs.chmod(directory,0o700);
  const probeId = randomBytes(16).toString('hex');
  const record = { schemaVersion:1, operation:'prepare-native-blind-capture',stage:'initialize',projectName:NAME,directory,probeId,
    inputPath,wavPath,inputSha256:sha(xml),wavSha256:sha(wav),wavBytes:wav.length,sourceHashes:sourceHashes(),
    emptyBackupPath:path.join(directory,'empty-project-backup.drp'),paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),
      result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')},predictionPath:path.join(directory,'prediction.json') };
  record.sourcePath=path.join(directory,`Frameline Blind Init ${probeId.slice(0,12)}.lua`);
  const source=await renderBlindCapture(record);record.sourceSha256=sha(source);
  await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
  record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
  if(install){const folder=path.dirname(record.installedPath),info=await fs.lstat(folder);if(!info.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-blind-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
  const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return {preparation,sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),projectName:NAME};
}

async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-blind-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function persist(filename,bytes){try{await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST'||!(await owned(filename)).equals(Buffer.from(bytes)))throw error;}}
async function readCapture(preparation){
  const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),info=await fs.lstat(directory);
  if(record.schemaVersion!==1||record.operation!=='prepare-native-blind-capture'||!['initialize','capture'].includes(record.stage)||record.directory!==directory||record.projectName!==NAME
    ||!/^[a-f0-9]{32}$/.test(record.probeId)||!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await fs.realpath(directory)!==directory
    ||record.sourcePath!==path.join(directory,`Frameline Blind Init ${record.probeId.slice(0,12)}.lua`)
    ||record.predictionPath!==path.join(directory,'prediction.json')||record.emptyBackupPath!==path.join(directory,'empty-project-backup.drp')
    ||json(record.paths)!==json({first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')}))throw new Error('invalid-blind-record');
  const source=await owned(record.sourcePath);
  if(sha(source)!==record.sourceSha256||source.toString()!==await renderBlindCapture(record)||json(sourceHashes())!==json(record.sourceHashes)
    ||sha(readInput(record.inputPath))!==record.inputSha256||sha(readInput(record.wavPath))!==record.wavSha256)throw new Error('blind-source-changed');
  if((await owned(record.paths.marker)).toString()!==`FRAMELINE_NATIVE_BLIND_CAPTURE_V1:${record.probeId}\n`)throw new Error('blind-capture-incomplete');
  const raw=await owned(record.paths.result),result=JSON.parse(raw);
  if(result.schemaVersion!==1||result.operation!=='resolve-native-blind-capture'||result.stage!==record.stage||result.probeId!==record.probeId||result.safeToApply!==false||result.ordinaryApplySupported!==false
    ||typeof result.pageBefore!=='string'||result.pageBefore!==result.pageAfter)throw new Error('invalid-blind-capture');
  const observations=['before','between','after'].map(key=>parseEffectObservation(JSON.stringify(result[key])));
  if(observations[0].snapshot.project_name!==NAME||observations[0].snapshot.project_id===PRIOR_PROJECT||observations[0].snapshot.timelines.length!==1||observations[0].items.length!==52)throw new Error('wrong-blind-fixture');
  const apiWitnesses=parseApiLocationObservation(JSON.stringify(result.apiLocationWitnesses));
  if(json(apiWitnesses.richContext)!==json(observations[0]))throw new Error('blind-witness-source-differs');
  const apiWitnessAssessment=assessApiLocationWitnesses(apiWitnesses,{requireKinds:['video','audio']});
  const observationPath=path.join(directory,'observation.json');await persist(observationPath,Buffer.from(JSON.stringify(result.after)+'\n'));
  const graphs=[];for(const filename of [record.paths.first,record.paths.second]){await owned(filename);graphs.push(readNativeLocationGraph(filename,observationPath));}
  const prediction=joinSynchronizedNativeTracks(observations,graphs);
  if(record.stage==='initialize'&&(prediction.trackCount!==8||prediction.emptyTrackCount!==5||prediction.timelines[0].bindings.filter(row=>row.type==='video').length!==4
    ||prediction.timelines[0].bindings.filter(row=>row.type==='audio').length!==4))throw new Error('unexpected-blind-layout');
  const predictionBytes=Buffer.from(json(prediction)+'\n');await persist(record.predictionPath,predictionBytes);
  return {schemaVersion:1,operation:'native-blind-capture-receipt',stage:record.stage,status:'captured',projectId:prediction.projectId,
    resultSha256:sha(raw),resultBytes:raw.length,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,
    prediction,predictionSha256:sha(predictionBytes),predictionCanonicalSha256:sha(json(prediction)),predictionFrozenBeforeChallenge:true,
    observations,graphs,apiLocationWitnesses:apiWitnesses,apiWitnessAssessment,sourceAndResultVerified:true,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module){const[op,a,b,flag]=process.argv.slice(2);const action=op==='initialize'&&a&&b&&(!flag||flag==='--install')?prepareInitialize(a,b,{install:flag==='--install'}):op==='read'&&a&&!b?readCapture(a):Promise.reject(new Error('usage'));
  action.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(error=>{process.stderr.write('native-blind-capture-failed:'+error.message+'\n');process.exitCode=1;});}
module.exports={prepareInitialize,renderBlindCapture,readCapture,NAME};
