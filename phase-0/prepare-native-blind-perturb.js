'use strict';
// Finite backed-up operations in the owned blind fixture. No ordinary Apply.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto');
const {readInput}=require('./integration-input'),{resultWriter}=require('./gate-lab-session');
const {readChallenge}=require('./prepare-native-blind-challenge');
const {readCapture,renderBlindCapture,NAME}=require('./prepare-native-blind-capture');
const {propertyCaptureConfig}=require('../src/resolve-property-observation');
const {readNativeLocationGraph,bindNativeTrackLocations,identityFacts,json,sha}=require('./native-track-location-binding');
const ROOT=path.resolve(__dirname,'..'),OPS=['append-delete-move-rename','recreate-empty-video-4'];
const SOURCES=['phase-0/prepare-native-blind-perturb.js','phase-0/prepare-native-blind-capture.js','phase-0/prepare-native-blind-challenge.js',
 'phase-0/native-track-location-binding.js','phase-0/resolve-native-location-graph.py','phase-0/resolve-native-track-identity.py','phase-0/compare-native-resolve-exports.py',
 'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
const hashes=()=>Object.fromEntries(SOURCES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
const q=JSON.stringify;
function planPerturb(input,operation,probeId){
 if(!OPS.includes(operation)||!/^[a-f0-9]{32}$/.test(probeId))throw new Error('invalid-blind-perturb');
 const before=structuredClone(input),after=structuredClone(input),timeline=after.snapshot.timelines[0];
 if(after.schemaVersion!==2||after.snapshot.project_name!==NAME||after.snapshot.timelines.length!==1||after.items.length!==52
  ||timeline.tracks.filter(t=>t.type==='video').length!==4||timeline.tracks.filter(t=>t.type==='audio').length!==4||timeline.tracks.length!==8
  ||new Set(timeline.tracks.map(t=>t.name)).size!==1)throw new Error('unsupported-blind-perturb-source');
 const targetIndex=operation==='append-delete-move-rename'?2:4;
 if(timeline.items.some(item=>item.track_type==='video'&&item.track_index===targetIndex))throw new Error('nonempty-blind-topology-target');
 let movedItemId=null,renamedItemId=null,newName=null,startFrame=null;
 if(operation==='append-delete-move-rename'){
  // Append5 then delete2 leaves four video locations. Track UUID correspondence
  // is checked independently from native exports after execution.
  timeline.tracks=timeline.tracks.filter(t=>!(t.type==='video'&&t.index===2));
  after.tracks=after.tracks.filter(t=>!(t.type==='video'&&t.index===2));
  for(const t of[...timeline.tracks,...after.tracks])if(t.type==='video'&&t.index>2)t.index--;
  const name=timeline.tracks[0].name;
  timeline.tracks.splice(3,0,{type:'video',index:4,name});
  after.tracks.splice(3,0,{timelineId:timeline.id,type:'video',index:4,enabled:true,locked:false});
  const candidates=timeline.items.filter(item=>item.track_type==='video'&&item.track_index===1).sort((a,b)=>a.start_frame-b.start_frame||a.id.localeCompare(b.id));
  if(candidates.length!==50)throw new Error('unexpected-blind-picture-layout');
  const item=candidates[0];movedItemId=item.id;renamedItemId=item.id;startFrame=item.start_frame;newName=`Frameline identity moved occurrence ${probeId.slice(0,12)}`;
  item.track_index=2;item.name=newName;
 }
 return{before,after,operation,targetIndex,movedItemId,renamedItemId,newName,startFrame};
}
function intermediateStates(input,operation){
 const before=structuredClone(input),appended=structuredClone(input),deleted=structuredClone(input);
 const timeline=before.snapshot.timelines[0],name=timeline.tracks[0].name,id=timeline.id;
 if(operation==='append-delete-move-rename'){
  appended.snapshot.timelines[0].tracks.splice(4,0,{type:'video',index:5,name});appended.tracks.splice(4,0,{timelineId:id,type:'video',index:5,enabled:true,locked:false});
  Object.assign(deleted,structuredClone(appended));
  deleted.snapshot.timelines[0].tracks=deleted.snapshot.timelines[0].tracks.filter(t=>!(t.type==='video'&&t.index===2));deleted.tracks=deleted.tracks.filter(t=>!(t.type==='video'&&t.index===2));
  for(const t of[...deleted.snapshot.timelines[0].tracks,...deleted.tracks])if(t.type==='video'&&t.index>2)t.index--;
 }else if(operation==='recreate-empty-video-4'){
  deleted.snapshot.timelines[0].tracks=deleted.snapshot.timelines[0].tracks.filter(t=>!(t.type==='video'&&t.index===4));deleted.tracks=deleted.tracks.filter(t=>!(t.type==='video'&&t.index===4));
 }else throw new Error('invalid-intermediate-stage');
 return{before,appended,deleted};
}
async function renderPerturb(record){
 const raw=readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString(),anchor='return { capture_request = capture_request }';
 if(raw.split(anchor).length!==2)throw new Error('incompatible-perturb-capture');
 const base=raw.replace(anchor,'return {capture=capture,encode=encode,array=array}'),effects=readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString();
 const plan=planPerturb(record.before,record.stageOperation,record.probeId);
 if(json(plan)!==json(record.plan))throw new Error('perturb-plan-changed');
 const captureSource=await renderBlindCapture(record.captureRecord);
 if(sha(captureSource)!==record.captureRecord.sourceSha256)throw new Error('perturb-capture-source-differs');
 const name=plan.before.snapshot.timelines[0].tracks[0].name,timelineId=plan.before.snapshot.timelines[0].id;
 let mutation;
 if(plan.operation==='append-delete-move-rename')mutation=`
assert(timeline:GetTrackCount('video')==4,'Source count differs');assert(timeline:AddTrack('video')==true,'Append failed');assert(timeline:GetTrackCount('video')==5,'Append count differs');empty(timeline,5)
assert(timeline:SetTrackName('video',5,${q(name)})==true,'Append name failed');assert(timeline:SetTrackEnable('video',5,true)==true and timeline:SetTrackLock('video',5,false)==true,'Append state failed')
export(${q(record.exports.appended)});empty(timeline,2);assert(timeline:DeleteTrack('video',2)==true,'Delete failed');assert(timeline:GetTrackCount('video')==4,'Delete count differs');export(${q(record.exports.deleted)})
local target=find_item(timeline,${q(plan.movedItemId)});assert(timeline:MoveItems({target},{trackType='video',trackIndex=2,startFrame=${plan.startFrame}},false,false)==true,'Move failed')
target=find_item(timeline,${q(plan.renamedItemId)});assert(target:SetName(${q(plan.newName)})==true,'Rename failed')
`;
 else mutation=`empty(timeline,4);assert(timeline:DeleteTrack('video',4)==true,'Recreate delete failed');assert(timeline:GetTrackCount('video')==3,'Recreate deletion count differs');export(${q(record.exports.deleted)})
assert(timeline:AddTrack('video')==true,'Recreate append failed');assert(timeline:GetTrackCount('video')==4,'Recreate count differs');empty(timeline,4)
assert(timeline:SetTrackName('video',4,${q(name)})==true,'Recreate name failed');assert(timeline:SetTrackEnable('video',4,true)==true and timeline:SetTrackLock('video',4,false)==true,'Recreate state failed');export(${q(record.exports.appended)})`;
 return `local manager,fusion,mutated,stage=nil,nil,false,'initial';local before,after=nil,nil
local ok,err=pcall(function()
assert(resolve and resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
manager=assert(resolve:GetProjectManager(),'No manager');fusion=assert(resolve:Fusion(),'No Fusion')
local function current()local p=assert(manager:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)}and p:GetUniqueId()==${q(record.projectId)},'Wrong owned fixture');return p end
${resultWriter()}
for _,filename in ipairs({${[record.resultPath,record.markerPath,record.startedPath,...Object.values(record.exports),...Object.values(record.captureRecord.paths)].map(q).join(',')}})do absent(filename)end
local backup=assert(fusion:OpenFile(${q(record.backupPath)},1),'Verified backup unavailable');assert(backup:GetFileSize()==${record.backupBytes},'Backup differs');backup:Close()
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)();local config=${propertyCaptureConfig()}
local function capture()current();return effects.capture(resolve,base,config)end
local function export(filename)absent(filename);assert(manager:ExportProject(${q(NAME)},filename,true)==true,'Export failed');local f=assert(fusion:OpenFile(filename,1),'Export missing');assert(f:GetFileSize()>0,'Export empty');f:Close()end
local function empty(timeline,index)local list=timeline:GetItemListInTrack('video',index)or{};for key in pairs(list)do assert(key=='__flags','Track not empty')end end
local function find_item(timeline,id)local found=nil;for _,kind in ipairs({'video','audio'})do for index=1,timeline:GetTrackCount(kind)do for _,item in ipairs(timeline:GetItemListInTrack(kind,index)or{})do if item:GetUniqueId()==id then assert(found==nil,'Duplicate item');found=item end end end end;return assert(found,'Item absent')end
stage='source-check';before=capture();assert(effects.encode(before)==${q(json(plan.before))},'Source differs')
export(${q(record.exports.before)});assert(effects.encode(capture())==${q(json(plan.before))},'Source changed around export')
local p=current();assert(p:GetTimelineCount()==1,'Timeline count differs');local timeline=p:GetTimelineByIndex(1);assert(timeline:GetUniqueId()==${q(timelineId)},'Timeline differs')
stage='started-barrier';write_exact(${q(record.startedPath)},${q('FRAMELINE_BLIND_PERTURB_STARTED:'+record.probeId)})
stage='pre-write-recheck';assert(effects.encode(capture())==${q(json(plan.before))},'Source changed after started barrier')
p=current();assert(p:GetTimelineCount()==1,'Timeline count changed');timeline=p:GetTimelineByIndex(1);assert(timeline:GetUniqueId()==${q(timelineId)},'Timeline changed after started barrier')
stage='mutating';mutated=true
${mutation}
stage='save-reopen';assert(manager:SaveProject()==true,'Save failed');assert(manager:CloseProject(current())==true,'Close failed');assert(manager:LoadProject(${q(NAME)})~=nil,'Reopen failed')
after=capture();assert(effects.encode(after)==${q(json(plan.after))},'Post-operation source differs');export(${q(record.exports.after)});stage='ready-for-capture'
local value={schemaVersion=1,operation='resolve-native-blind-perturb',stageOperation=${q(record.stageOperation)},probeId=${q(record.probeId)},status='ready-for-capture',stage=stage,before=before,after=after,
 captureSourceSha256=${q(record.captureRecord.sourceSha256)},safeToApply=false,ordinaryApplySupported=false}
write_exact(${q(record.resultPath)},effects.encode(value));write_exact(${q(record.markerPath)},${q('FRAMELINE_BLIND_PERTURB_COMPLETE:'+record.probeId)})
end)
if ok then do\n${captureSource}\nend else print('FRAMELINE_BLIND_PERTURB_FAILED:'..stage..':'..tostring(mutated)..':'..tostring(err))end`;
}
async function preparePerturb(previousChallenge,stageOperation,{install=false}={}){
 if(!path.isAbsolute(previousChallenge||'')||!OPS.includes(stageOperation)||typeof install!=='boolean')throw new Error('invalid-perturb-options');
 const previous=JSON.parse(readInput(previousChallenge)),prior=await readChallenge(previousChallenge);
 if(prior.status!=='restored')throw new Error('prior-challenge-not-restored');
 const priorCapture=JSON.parse(readInput(previous.previousPreparation));
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-native-blind-perturb-')));await fs.chmod(directory,0o700);
 const probeId=randomBytes(16).toString('hex'),plan=planPerturb(prior.observations.restored,stageOperation,probeId),backup=readInput(previous.exports.restored);
 if(sha(backup)!==prior.graphs.restored.archive.sha256)throw new Error('perturb-backup-changed');
 const captureRecord={...priorCapture,stage:'capture',directory,probeId,expectedObservation:plan.after,sourceHashes:priorCapture.sourceHashes,
  emptyBackupPath:path.join(directory,'empty-project-backup.drp'),paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')},
  predictionPath:path.join(directory,'prediction.json'),sourcePath:path.join(directory,`Frameline Blind Init ${probeId.slice(0,12)}.lua`),installedPath:null};
 captureRecord.sourceSha256=sha(await renderBlindCapture(captureRecord));
 const record={schemaVersion:1,operation:'prepare-native-blind-perturb',directory,probeId,projectId:prior.projectId,previousChallenge,stageOperation,before:plan.before,plan,captureRecord,
  backupPath:path.join(directory,'verified-baseline.drp'),backupBytes:backup.length,backupSha256:sha(backup),resultPath:path.join(directory,'perturb-result.json'),markerPath:path.join(directory,'perturb-complete.txt'),startedPath:path.join(directory,'perturb-started.txt'),
  exports:Object.fromEntries(['before','appended','deleted','after'].map(key=>[key,path.join(directory,'stage-'+key+'.drp')])),sourceHashes:hashes()};
 await fs.writeFile(record.backupPath,backup,{flag:'wx',mode:0o600});await fs.writeFile(captureRecord.sourcePath,await renderBlindCapture(captureRecord),{flag:'wx',mode:0o600});
 await fs.writeFile(path.join(directory,'preparation.json'),JSON.stringify(captureRecord,null,2)+'\n',{flag:'wx',mode:0o600});
 record.sourcePath=path.join(directory,`Frameline Blind Perturb ${probeId.slice(0,12)}.lua`);const source=await renderPerturb(record);record.sourceSha256=sha(source);
 await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
 if(install){const folder=path.dirname(record.installedPath),info=await fs.lstat(folder);if(!info.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-perturb-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
 const preparation=path.join(directory,'stage-preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,capturePreparation:path.join(directory,'preparation.json'),sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),operation:stageOperation,movedItemId:plan.movedItemId,renamedItemId:plan.renamedItemId};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-perturb-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readPerturb(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.schemaVersion!==1||record.operation!=='prepare-native-blind-perturb'||record.directory!==directory||!OPS.includes(record.stageOperation)||!/^[a-f0-9]{32}$/.test(record.probeId)
  ||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory||record.sourcePath!==path.join(directory,`Frameline Blind Perturb ${record.probeId.slice(0,12)}.lua`)
  ||record.backupPath!==path.join(directory,'verified-baseline.drp')||record.resultPath!==path.join(directory,'perturb-result.json')||record.markerPath!==path.join(directory,'perturb-complete.txt')||record.startedPath!==path.join(directory,'perturb-started.txt')
  ||json(record.exports)!==json(Object.fromEntries(['before','appended','deleted','after'].map(key=>[key,path.join(directory,'stage-'+key+'.drp')]))))throw new Error('invalid-perturb-record');
 const prior=await readChallenge(record.previousChallenge),plan=planPerturb(prior.observations.restored,record.stageOperation,record.probeId),source=await owned(record.sourcePath);
 if(json(plan)!==json(record.plan)||json(record.before)!==json(plan.before)||record.projectId!==prior.projectId||sha(source)!==record.sourceSha256||source.toString()!==await renderPerturb(record)
  ||json(record.sourceHashes)!==json(hashes())||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==prior.graphs.restored.archive.sha256
  ||json(JSON.parse(await owned(path.join(directory,'preparation.json'))))!==json(record.captureRecord))throw new Error('perturb-source-changed');
 if((await owned(record.markerPath)).toString()!==`FRAMELINE_BLIND_PERTURB_COMPLETE:${record.probeId}\n`||(await owned(record.startedPath)).toString()!==`FRAMELINE_BLIND_PERTURB_STARTED:${record.probeId}\n`)throw new Error('perturb-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);
 if(result.schemaVersion!==1||result.operation!=='resolve-native-blind-perturb'||result.status!=='ready-for-capture'||result.stage!=='ready-for-capture'||result.stageOperation!==record.stageOperation
  ||result.probeId!==record.probeId||result.safeToApply!==false||result.ordinaryApplySupported!==false||result.captureSourceSha256!==record.captureRecord.sourceSha256||json(result.before)!==json(plan.before)||json(result.after)!==json(plan.after))throw new Error('perturb-result-differs');
 const graphs={};for(const[key,filename]of Object.entries(record.exports)){await owned(filename);graphs[key]=readNativeLocationGraph(filename);}
 const intermediates=intermediateStates(plan.before,record.stageOperation);
 bindNativeTrackLocations(graphs.appended,intermediates.appended);bindNativeTrackLocations(graphs.deleted,intermediates.deleted);
 if(json(identityFacts(graphs.before))!==json(identityFacts(prior.graphs.restored)))throw new Error('perturb-native-source-differs');
 const beforeBinding=bindNativeTrackLocations(graphs.before,plan.before),afterBinding=bindNativeTrackLocations(graphs.after,plan.after);
 const old=new Map(beforeBinding.timelines[0].bindings.map(row=>[row.nativeTrackId,row])),next=new Map(afterBinding.timelines[0].bindings.map(row=>[row.nativeTrackId,row]));
 const removed=[...old.keys()].filter(id=>!next.has(id)),added=[...next.keys()].filter(id=>!old.has(id));
 const target=beforeBinding.timelines[0].bindings.find(row=>row.type==='video'&&row.index===plan.targetIndex);
 if(removed.length!==1||added.length!==1||removed[0]!==target.nativeTrackId||old.get(removed[0]).itemCount!==0||next.get(added[0]).itemCount!==0||next.get(added[0]).type!=='video'||next.get(added[0]).index!==4)throw new Error('perturb-native-delta-differs');
 for(const[id,row]of old){if(!next.has(id))continue;const now=next.get(id),index=plan.operation==='append-delete-move-rename'&&row.type==='video'&&row.index>2?row.index-1:row.index;if(row.type!==now.type||now.index!==index)throw new Error('perturb-retained-index-differs');}
 const capture=await readCapture(path.join(directory,'preparation.json'));
 if(json(capture.observations[0])!==json(plan.after)||json(identityFacts(capture.graphs[0]))!==json(identityFacts(graphs.after)))throw new Error('perturb-capture-state-differs');
 return{schemaVersion:1,operation:'native-blind-perturb-receipt',stageOperation:record.stageOperation,status:'captured',projectId:record.projectId,resultSha256:sha(raw),resultBytes:raw.length,
  sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,removedTrackId:removed[0],addedTrackId:added[0],movedItemId:plan.movedItemId,renamedItemId:plan.renamedItemId,graphs,intermediateObservations:intermediates,beforeObservation:plan.before,afterObservation:plan.after,capture,
  sourceAndResultVerified:true,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module){const[op,a,b,flag]=process.argv.slice(2);const action=op==='prepare'&&a&&OPS.includes(b)&&(!flag||flag==='--install')?preparePerturb(a,b,{install:flag==='--install'}):op==='read'&&a&&!b?readPerturb(a):Promise.reject(new Error('usage'));
 action.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(e=>{process.stderr.write('native-blind-perturb-failed:'+e.message+'\n');process.exitCode=1;});}
module.exports={planPerturb,intermediateStates,renderPerturb,preparePerturb,readPerturb};
