'use strict';
// Construct a bounded, backed-up synthetic fixture. This is not ordinary Apply.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { resultWriter, fileReader } = require('./gate-lab-session');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { scanXml } = require('../src/fcpxml-adapter');
const ROOT = path.resolve(__dirname,'..');
const NAME = 'Frameline Enumeration Fixture 20261120';
const sha = value => createHash('sha256').update(value).digest('hex');
const q = JSON.stringify;
const SOURCE_FILES = ['phase-0/prepare-enumeration-fixture.js','phase-0/gate-lab-session.js',
  'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
const hashes = () => Object.fromEntries(SOURCE_FILES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));

function renderEnumerationFixture(record) {
  const raw = readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString();
  const anchor = 'return { capture_request = capture_request }';
  if (raw.split(anchor).length !== 2) throw new Error('incompatible-fixture-base');
  const base = raw.replace(anchor,'return {capture=capture,encode=encode,array=array}');
  const effects = readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString();
  const xml = readInput(record.inputPath).toString();
  return `local fusion=assert(resolve:Fusion(),'No Fusion')
${resultWriter()}
local encode=(function()${effects}\nend)().encode
local stage,mutated,publish_error='initial',false,false
local ok,err=pcall(function()
assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local pm=assert(resolve:GetProjectManager(),'No manager')
local project_id=nil
local function current()local p=assert(pm:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)}and(project_id==nil or p:GetUniqueId()==project_id),'Wrong owned fixture');return p end
local p=current();project_id=p:GetUniqueId()
for _,filename in ipairs({${Object.values(record.paths).map(q).join(',')}})do absent(filename)end
publish_error=true;assert(p:GetTimelineCount()==0,'Fixture not empty')
${fileReader(record.inputPath,xml)}
local movie=assert(fusion:OpenFile(${q(record.moviePath)},1),'Movie unavailable');assert(movie:GetFileSize()==${record.movieBytes},'Movie changed');movie:Close()
stage='empty-backup';current();assert(pm:SaveProject()==true,'Empty save failed');current();assert(pm:ExportProject(${q(NAME)},${q(record.paths.empty)},true)==true,'Empty backup failed')
write_exact(${q(record.paths.started)},${q('FRAMELINE_ENUMERATION_FIXTURE_STARTED:'+record.probeId)})
p=current();assert(p:GetUniqueId()==project_id and p:GetTimelineCount()==0,'Source changed after barrier');mutated=true
stage='settings';assert(p:SetSettings({timelineFrameRate='24',timelinePlaybackFrameRate='24'})==true,'Settings failed')
stage='import-picture';local pool=p:GetMediaPool();local main=assert(pool:ImportTimelineFromFile(${q(record.inputPath)},{timelineName='Enumeration Main'}),'Import failed')
assert(p:SetCurrentTimeline(main)==true and p:GetTimelineCount()==1,'Main selection failed')
local pictures=assert(main:GetItemListInTrack('video',1),'Picture list absent');assert(#pictures==50,'Picture count differs')
local function tracks(t)
 assert(t:GetTrackCount('video')==1 and t:GetTrackCount('audio')==1 and t:GetTrackCount('subtitle')==0,'Unexpected initial tracks')
 for index=1,2 do assert(t:AddTrack('video')==true,'Video track failed');assert(t:AddTrack('audio','mono')==true,'Audio track failed')end
 for _,kind in ipairs({'video','audio'})do for index=1,3 do assert(t:SetTrackName(kind,index,'Enumeration duplicate track')==true,'Track name failed')end end
end
tracks(main)
stage='import-movie';local imported=assert(pool:ImportMedia({${q(record.moviePath)}}),'Movie import failed');assert(#imported==1,'Movie import count differs');local media=imported[1]
local function append(t,track,kind,source,frame)
 assert(p:SetCurrentTimeline(t)==true,'Append selection failed')
 local list=assert(pool:AppendToTimeline({{mediaPoolItem=media,startFrame=source,endFrame=source+23,mediaType=kind,trackIndex=track,recordFrame=t:GetStartFrame()+frame}}),'Append failed')
 assert(#list==1,'Append count differs');return list[1]
end
local function effect(item,category,id)
 local value=assert(item:AddEffect(category,id),'Effect add failed');local info=assert(value:GetInfo(),'Effect info absent');assert(info.category==category and info.id==id and value:GetIsEnabled()==true,'Effect differs');return value
end
stage='main-occurrences';local mv1=append(main,2,1,12,0);local ma1=append(main,2,2,12,0);local main_next=mv1:GetEnd()-main:GetStartFrame();assert(main_next>0,'Main duration absent');local mv2=append(main,2,1,36,main_next);local ma2=append(main,2,2,36,main_next)
assert(main:SetClipsLinked({mv1,ma1},true)==true,'Main linking failed')
stage='main-transition';local mt=assert(mv1:AddTransition({type='Cross Dissolve',category='simple',position='end',alignment='center',duration=4}),'Main transition failed')
stage='main-effects';effect(pictures[1],'ofx','Resolve FX/Resolve FX Blur/Gaussian Blur');effect(pictures[1],'ofx','Resolve FX/Resolve FX Blur/Gaussian Blur')
effect(pictures[2],'fusion','Fusion/Fusion Effects/Colored Border');effect(ma1,'audio','Audio FX/Fairlight FX/Chorus')
stage='secondary-create';local secondary=assert(pool:CreateEmptyTimeline('Enumeration Secondary','00:00:00:00'),'Secondary create failed');tracks(secondary)
stage='secondary-occurrences';local sv1=append(secondary,1,1,12,0);local sa1=append(secondary,1,2,12,0);local secondary_next=sv1:GetEnd()-secondary:GetStartFrame();assert(secondary_next>0,'Secondary duration absent');local sv2=append(secondary,1,1,36,secondary_next);local sa2=append(secondary,1,2,36,secondary_next)
assert(secondary:SetClipsLinked({sv1,sa1},true)==true,'Secondary linking failed')
stage='secondary-transition';local st=assert(sv1:AddTransition({type='Cross Dissolve',category='simple',position='end',alignment='center',duration=4}),'Secondary transition failed')
stage='secondary-effects';effect(sv1,'ofx','Resolve FX/Resolve FX Blur/Gaussian Blur');effect(sv2,'fusion','Fusion/Fusion Effects/Colored Border');effect(sa1,'audio','Audio FX/Fairlight FX/Chorus')
local roles={mainTimelineId=main:GetUniqueId(),secondaryTimelineId=secondary:GetUniqueId(),pictureOfxId=pictures[1]:GetUniqueId(),pictureFusionId=pictures[2]:GetUniqueId(),
 mainVideo1=mv1:GetUniqueId(),mainVideo2=mv2:GetUniqueId(),mainAudio1=ma1:GetUniqueId(),mainAudio2=ma2:GetUniqueId(),mainTransitionId=mt:GetUniqueId(),
 secondaryVideo1=sv1:GetUniqueId(),secondaryVideo2=sv2:GetUniqueId(),secondaryAudio1=sa1:GetUniqueId(),secondaryAudio2=sa2:GetUniqueId(),secondaryTransitionId=st:GetUniqueId(),movieMediaPoolId=media:GetUniqueId()}
stage='save-reopen';current();assert(p:SetCurrentTimeline(main)==true,'Restore main selection failed');current();assert(pm:SaveProject()==true,'Fixture save failed');current();assert(pm:CloseProject(p)==true,'Fixture close failed');assert(pm:LoadProject(${q(NAME)})~=nil,'Fixture reopen failed')
p=current();assert(p:GetUniqueId()==project_id and p:GetTimelineCount()==2,'Reopened source differs')
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)()
stage='legacy-source-guard';local baseline=effects.capture(resolve,base,${propertyCaptureConfig()});assert(#baseline.items==60 and #baseline.tracks==12,'Source fixture size differs')
assert(pm:ExportProject(${q(NAME)},${q(record.paths.saved)},true)==true,'Saved backup failed')
assert(effects.encode(effects.capture(resolve,base,${propertyCaptureConfig()}))==effects.encode(baseline),'Source changed around saved export')
write_exact(${q(record.paths.baseline)},effects.encode(baseline))
stage='complete';write_exact(${q(record.paths.result)},encode({schemaVersion=1,operation='resolve-enumeration-fixture',probeId=${q(record.probeId)},projectId=project_id,roles=roles,
 status='saved-reopened',stage=stage,saveReopenVerified=true,itemCount=#baseline.items,trackCount=#baseline.tracks,ordinaryApplySupported=false,safeToApply=false,legacyGuardDoesNotProveEnumeration=true}))
write_exact(${q(record.paths.marker)},${q('FRAMELINE_ENUMERATION_FIXTURE_COMPLETE:'+record.probeId)})
end)
if not ok and publish_error then write_exact(${q(record.paths.error)},encode({schemaVersion=1,operation='resolve-enumeration-fixture-error',probeId=${q(record.probeId)},stage=stage,mutated=mutated,
 error=tostring(err):gsub('[%z\\1-\\31\\127]',' '):sub(1,2048),safeToApply=false}))elseif not ok then print('FRAMELINE_ENUMERATION_FIXTURE_REFUSED')end`;
}

async function prepareEnumerationFixture(inputPath,moviePath,{install=false}={}) {
  const xml=readInput(inputPath),movie=readInput(moviePath),scan=scanXml(xml.toString());
  if(!path.isAbsolute(inputPath)||!path.isAbsolute(moviePath)||scan.clips.length!==50||scan.warnings.length||scan.sequence.durationFrames!==2400||movie.length>2*1024*1024)throw new Error('unsupported-enumeration-input');
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-enumeration-fixture-')));await fs.chmod(directory,0o700);
  const record={schemaVersion:1,operation:'prepare-enumeration-fixture',probeId:randomBytes(16).toString('hex'),directory,projectName:NAME,
    inputPath:path.join(directory,'input.fcpxml'),inputSha256:sha(xml),moviePath:path.join(directory,'enumeration-movie.mov'),movieSha256:sha(movie),movieBytes:movie.length,sourceHashes:hashes(),
    paths:Object.fromEntries(['empty','saved','started','baseline','result','marker','error'].map(key=>[key,path.join(directory,{empty:'empty.drp',saved:'saved.drp',started:'started.txt',baseline:'baseline.json',result:'result.json',marker:'complete.txt',error:'error.json'}[key])]))};
  await fs.writeFile(record.inputPath,xml,{flag:'wx',mode:0o600});await fs.writeFile(record.moviePath,movie,{flag:'wx',mode:0o600});
  record.sourcePath=path.join(directory,`Frameline Enumeration Fixture ${record.probeId.slice(0,12)}.lua`);const source=renderEnumerationFixture(record);record.sourceSha256=sha(source);
  await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
  if(install){const folder=path.dirname(record.installedPath),stat=await fs.lstat(folder);if(!stat.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-enumeration-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
  const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return{preparation,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua')};
}

async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-enumeration-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readEnumerationFixture(preparation){
  const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),stat=await fs.lstat(directory);
  if(record.schemaVersion!==1||record.operation!=='prepare-enumeration-fixture'||record.directory!==directory||record.projectName!==NAME||!/^[a-f0-9]{32}$/.test(record.probeId)
    ||!stat.isDirectory()||stat.mode&0o077||stat.uid!==process.getuid()||await fs.realpath(directory)!==directory||record.sourcePath!==path.join(directory,`Frameline Enumeration Fixture ${record.probeId.slice(0,12)}.lua`)
    ||record.inputPath!==path.join(directory,'input.fcpxml')||record.moviePath!==path.join(directory,'enumeration-movie.mov'))throw new Error('invalid-enumeration-fixture-record');
  const source=await owned(record.sourcePath);
  if(sha(source)!==record.sourceSha256||source.toString()!==renderEnumerationFixture(record)||sha(await owned(record.inputPath))!==record.inputSha256||sha(await owned(record.moviePath))!==record.movieSha256
    ||JSON.stringify(record.sourceHashes)!==JSON.stringify(hashes()))throw new Error('enumeration-fixture-source-changed');
  for(const[key,name]of Object.entries({empty:'empty.drp',saved:'saved.drp',started:'started.txt',baseline:'baseline.json',result:'result.json',marker:'complete.txt',error:'error.json'}))if(record.paths[key]!==path.join(directory,name))throw new Error('invalid-enumeration-fixture-path');
  try{return{status:'native-error',error:JSON.parse(await owned(record.paths.error)),sourceSha256:record.sourceSha256,safeToApply:false};}catch(error){if(error.code!=='ENOENT')throw error;}
  if((await owned(record.paths.started)).toString()!==`FRAMELINE_ENUMERATION_FIXTURE_STARTED:${record.probeId}\n`||(await owned(record.paths.marker)).toString()!==`FRAMELINE_ENUMERATION_FIXTURE_COMPLETE:${record.probeId}\n`)throw new Error('enumeration-fixture-incomplete');
  const raw=await owned(record.paths.result),result=JSON.parse(raw),baseline=parseEffectObservation(await owned(record.paths.baseline));
  if(result.operation!=='resolve-enumeration-fixture'||result.probeId!==record.probeId||result.status!=='saved-reopened'||result.stage!=='complete'||result.saveReopenVerified!==true||result.legacyGuardDoesNotProveEnumeration!==true
    ||result.safeToApply!==false||result.ordinaryApplySupported!==false||baseline.snapshot.project_id!==result.projectId||baseline.snapshot.project_name!==NAME||baseline.snapshot.timelines.length!==2||baseline.items.length!==60||baseline.tracks.length!==12)throw new Error('enumeration-fixture-result-differs');
  const archives={};for(const key of['empty','saved']){const bytes=await owned(record.paths[key]);archives[key]={sha256:sha(bytes),size:bytes.length};}
  return{...result,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,resultSha256:sha(raw),baseline,archives};
}
module.exports={NAME,renderEnumerationFixture,prepareEnumerationFixture,readEnumerationFixture};
if(require.main===module){const[operation,a,b,flag]=process.argv.slice(2);(operation==='prepare'?prepareEnumerationFixture(a,b,{install:flag==='--install'}):operation==='read'?readEnumerationFixture(a):Promise.reject(new Error('usage')))
  .then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(error=>{process.stderr.write('enumeration-fixture-failed:'+error.message+'\n');process.exitCode=1;});}
