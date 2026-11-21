'use strict';
// A backed-up unsupported-content control in the owned synthetic project.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const{randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const{readInput}=require('./integration-input'),{resultWriter}=require('./gate-lab-session');
const{readEnumerationCaptureAny:readEnumerationCapture,json}=require('./prepare-enumeration-capture-v2');
const{assembleActiveTimelineEnumeration}=require('./timeline-enumeration-acceptance');
const{parseTimelineEnumeration}=require('../src/resolve-timeline-enumeration');
const{propertyCaptureConfig}=require('../src/resolve-property-observation'),{NAME}=require('./prepare-enumeration-fixture');
const{inspectResolveProjectExport}=require('../src/resolve-project-export');
const ROOT=path.resolve(__dirname,'..'),sha=v=>createHash('sha256').update(v).digest('hex'),q=JSON.stringify;
const SOURCES=['phase-0/prepare-enumeration-compound-probe.js','phase-0/prepare-enumeration-capture.js','phase-0/prepare-enumeration-capture-v2.js','phase-0/timeline-enumeration-acceptance.js','phase-0/gate-lab-session.js',
 'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-timeline-enumeration.lua','src/resolve-timeline-enumeration.js','src/resolve-property-contract.json','src/resolve-project-export.js'];
const hashes=()=>Object.fromEntries(SOURCES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
function ownerRich(doc,id){return{timeline:doc.snapshot.timelines.find(t=>t.id===id),items:doc.items.filter(t=>t.timelineId===id),tracks:doc.tracks.filter(t=>t.timelineId===id),activeTimelineId:doc.activeTimelineId};}
function expectedOwners(capture){return capture.observations.map(({before:doc})=>{const id=doc.activeTimelineId.value;if(doc.richContext.status!=='captured')throw new Error('owner-rich-source-required');return{id,strict:doc.timelines.value.find(t=>t.id===id),rich:ownerRich(doc.richContext.value,id)};});}
function renderEnumerationCompoundProbe(record){
 const raw=readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString(),anchor='return { capture_request = capture_request }';if(raw.split(anchor).length!==2)throw new Error('incompatible-compound-base');
 const base=raw.replace(anchor,'return {capture=capture,encode=encode,array=array}'),effects=readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString(),enumeration=readInput(path.join(ROOT,'src/companion/resolve-timeline-enumeration.lua')).toString();
 return `local fusion=assert(resolve:Fusion(),'No Fusion')
${resultWriter()}
local encode=(function()${effects}\nend)().encode
local stage,mutated,publish_error='initial',false,false
local ok,err=pcall(function()
assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local pm=assert(resolve:GetProjectManager(),'No manager')
local function current()local p=assert(pm:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)}and p:GetUniqueId()==${q(record.projectId)},'Wrong owned fixture');return p end
local p=current()
for _,filename in ipairs({${[record.resultPath,record.markerPath,record.startedPath,record.errorPath,record.savedArchivePath,...record.observationPaths].map(q).join(',')}})do absent(filename)end
publish_error=true
local backup=assert(fusion:OpenFile(${q(record.backupPath)},1),'Backup absent');assert(backup:GetFileSize()==${record.backupBytes},'Backup differs');backup:Close()
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)();local enumeration=(function()${enumeration}\nend)();local config=${propertyCaptureConfig()}
local function timeline(id)local found=nil;for index=1,p:GetTimelineCount()do local value=p:GetTimelineByIndex(index);if value:GetUniqueId()==id then assert(found==nil,'Duplicate timeline');found=value end end;return assert(found,'Timeline absent')end
local function find_item(t,id)local found=nil;for _,kind in ipairs({'video','audio'})do for index=1,t:GetTrackCount(kind)do for _,value in ipairs(t:GetItemListInTrack(kind,index)or{})do if value:GetUniqueId()==id then assert(found==nil,'Duplicate item');found=value end end end end;return assert(found,'Item absent')end
local function owner_rich(value,id)local items,tracks=base.array(),base.array();local t=nil;for _,row in ipairs(value.snapshot.timelines)do if row.id==id then assert(t==nil,'Duplicate rich timeline');t=row end end
 for _,row in ipairs(value.items)do if row.timelineId==id then items[#items+1]=row end end;for _,row in ipairs(value.tracks)do if row.timelineId==id then tracks[#tracks+1]=row end end
 return{timeline=assert(t,'Rich owner absent'),items=items,tracks=tracks,activeTimelineId=value.activeTimelineId}end
local owners={${record.owners.map(row=>`{id=${q(row.id)},index=${q(row.strict.index??0)},strict=${q(json(row.strict))},rich=${q(json(row.rich))}}`).join(',')}}
local original_rich_verified=true
local function guard_owners(expected_count,allow_unavailable_rich)
 current();local count=p:GetTimelineCount();assert((expected_count>0 and count==expected_count)or(expected_count==0 and count>=3 and count<=20),'Timeline count changed')
 for _,owner in ipairs(owners)do current();assert(p:SetCurrentTimeline(timeline(owner.id))==true,'Owner selection failed');local observed=enumeration.capture(resolve,base,effects,config,200)
  assert(observed.activeTimelineId.status=='captured'and observed.activeTimelineId.value==owner.id,'Owner source unavailable')
  local selected=nil;for _,row in ipairs(observed.timelines.value)do if row.id==owner.id then assert(selected==nil,'Duplicate owner');selected=row end end
  assert(selected,'Owner absent');if allow_unavailable_rich then selected.index=owner.index end
  assert(encode(selected)==owner.strict,'Owner structure changed')
  if observed.richContext.status=='captured'then assert(encode(owner_rich(observed.richContext.value,owner.id))==owner.rich,'Owner properties changed')else assert(allow_unavailable_rich,'Owner rich source unavailable');original_rich_verified=false end
 end
 assert(p:SetCurrentTimeline(timeline(${q(record.roles.mainTimelineId)}))==true,'Restore main failed')
end
stage='source-owner-guard';guard_owners(2)
write_exact(${q(record.startedPath)},${q('FRAMELINE_ENUMERATION_COMPOUND_STARTED:'+record.probeId)})
stage='source-after-barrier';guard_owners(2);p=current();mutated=true
stage='negative-timeline-create';local pool=p:GetMediaPool();local negative=assert(pool:CreateEmptyTimeline(${q(record.negativeName)},'00:00:00:00'),'Negative timeline failed')
assert(p:SetCurrentTimeline(negative)==true,'Negative select failed');assert(negative:GetTrackCount('video')==1 and negative:GetTrackCount('audio')==1,'Unexpected negative layout')
local media=assert(find_item(timeline(${q(record.roles.mainTimelineId)}),${q(record.roles.mainVideo1)}):GetMediaPoolItem(),'Movie absent');assert(media:GetUniqueId()==${q(record.roles.movieMediaPoolId)},'Movie changed')
local function append(kind)local rows=assert(pool:AppendToTimeline({{mediaPoolItem=media,startFrame=12,endFrame=35,mediaType=kind,trackIndex=1,recordFrame=negative:GetStartFrame()}}),'Negative append failed');assert(#rows==1,'Negative append count');return rows[1]end
local video,audio=append(1),append(2);assert(negative:SetClipsLinked({video,audio},true)==true,'Negative link failed')
stage='create-compound';local compound=assert(negative:CreateCompoundClip({video,audio},{name=${q(record.compoundName)},startTimecode='00:00:00:00'}),'Compound create failed')
local compound_id=compound:GetUniqueId();local negative_id=negative:GetUniqueId()
stage='save-reopen';assert(p:SetCurrentTimeline(timeline(${q(record.roles.mainTimelineId)}))==true,'Main restore failed');current();assert(pm:SaveProject()==true,'Negative save failed');assert(pm:CloseProject(p)==true,'Negative close failed');assert(pm:LoadProject(${q(NAME)})~=nil,'Negative reopen failed');p=current()
stage='original-owner-postcondition';guard_owners(0,true)
local ids=base.array();for index=1,p:GetTimelineCount()do ids[#ids+1]=p:GetTimelineByIndex(index):GetUniqueId()end;local paths={${record.observationPaths.map(q).join(',')}};assert(#ids<=#paths,'Negative context bound')
for index,id in ipairs(ids)do stage='negative-capture-'..index;current();assert(p:SetCurrentTimeline(timeline(id))==true,'Negative owner select failed');write_exact(paths[index],encode(enumeration.capture(resolve,base,effects,config,200)))end
assert(p:SetCurrentTimeline(timeline(${q(record.roles.mainTimelineId)}))==true,'Final main restore failed');current()
stage='saved-export';assert(pm:ExportProject(${q(NAME)},${q(record.savedArchivePath)},true)==true,'Negative export failed')
stage='complete';write_exact(${q(record.resultPath)},encode({schemaVersion=1,operation='resolve-enumeration-compound-control',probeId=${q(record.probeId)},projectId=${q(record.projectId)},
 status='saved-reopened',stage=stage,negativeTimelineId=negative_id,compoundItemId=compound_id,timelineIds=ids,orientationCount=#ids,saveReopenVerified=true,originalOwnersStructurallyUnchanged=true,originalOwnerRichProjectionVerified=original_rich_verified,activeTimelineRestored=true,expectedProfileDisposition='refuse-nested-content',sourceCaptureResultSha256=${q(record.sourceCaptureResultSha256)},safeToApply=false,ordinaryApplySupported=false}))
write_exact(${q(record.markerPath)},${q('FRAMELINE_ENUMERATION_COMPOUND_COMPLETE:'+record.probeId)})
end)
if not ok and publish_error then write_exact(${q(record.errorPath)},encode({schemaVersion=1,operation='resolve-enumeration-compound-error',probeId=${q(record.probeId)},stage=stage,mutated=mutated,
 error=tostring(err):gsub('[%z\\1-\\31\\127]',' '):sub(1,2048),safeToApply=false}))elseif not ok then print('FRAMELINE_ENUMERATION_COMPOUND_REFUSED')end`;
}
async function prepareEnumerationCompoundProbe(sourcePreparation,{install=false}={}){
 const capture=await readEnumerationCapture(sourcePreparation);if(capture.status!=='captured'||capture.baseline.snapshot.timelines.length!==2||capture.baseline.items.length!==60)throw new Error('restored-two-timeline-source-required');
 const assembled=assembleActiveTimelineEnumeration({observations:capture.observations.map(row=>row.before),nativeInventories:capture.nativeInventories});if(assembled.completeForProfile!==true)throw new Error('complete-owner-source-required');
 const backup=readInput(capture.savedArchivePath);if(sha(backup)!==capture.archives.saved.sha256)throw new Error('compound-backup-changed');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-enumeration-compound-')));await fs.chmod(directory,0o700);const probeId=randomBytes(16).toString('hex');
 const record={schemaVersion:1,operation:'prepare-enumeration-compound-probe',directory,probeId,sourcePreparation,sourceCaptureResultSha256:capture.resultSha256,projectId:capture.projectId,roles:capture.roles,owners:expectedOwners(capture),
  negativeName:`Enumeration Nested Negative ${probeId.slice(0,12)}`,compoundName:`Enumeration Compound ${probeId.slice(0,12)}`,backupPath:path.join(directory,'verified-source.drp'),backupSha256:sha(backup),backupBytes:backup.length,
  resultPath:path.join(directory,'result.json'),markerPath:path.join(directory,'complete.txt'),startedPath:path.join(directory,'started.txt'),errorPath:path.join(directory,'error.json'),savedArchivePath:path.join(directory,'saved.drp'),
  observationPaths:Array.from({length:20},(_,index)=>path.join(directory,`orientation-${index+1}.json`)),sourceHashes:hashes()};
 await fs.writeFile(record.backupPath,backup,{flag:'wx',mode:0o600});record.sourcePath=path.join(directory,`Frameline Enumeration Compound ${probeId.slice(0,12)}.lua`);const source=renderEnumerationCompoundProbe(record);record.sourceSha256=sha(source);
 await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
 if(install){const folder=path.dirname(record.installedPath),s=await fs.lstat(folder);if(!s.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-compound-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
 const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});return{preparation,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua')};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-compound-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readEnumerationCompoundProbe(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.schemaVersion!==1||record.operation!=='prepare-enumeration-compound-probe'||record.directory!==directory||!/^[a-f0-9]{32}$/.test(record.probeId)||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory
  ||record.sourcePath!==path.join(directory,`Frameline Enumeration Compound ${record.probeId.slice(0,12)}.lua`)||record.backupPath!==path.join(directory,'verified-source.drp')||record.savedArchivePath!==path.join(directory,'saved.drp')
  ||record.resultPath!==path.join(directory,'result.json')||record.markerPath!==path.join(directory,'complete.txt')||record.startedPath!==path.join(directory,'started.txt')||record.errorPath!==path.join(directory,'error.json')
  ||json(record.observationPaths)!==json(Array.from({length:20},(_,index)=>path.join(directory,`orientation-${index+1}.json`))))throw new Error('invalid-compound-record');
 const prior=await readEnumerationCapture(record.sourcePreparation),source=await owned(record.sourcePath);
 if(prior.status!=='captured'||prior.resultSha256!==record.sourceCaptureResultSha256||prior.projectId!==record.projectId||json(prior.roles)!==json(record.roles)||json(expectedOwners(prior))!==json(record.owners)
  ||sha(source)!==record.sourceSha256||source.toString()!==renderEnumerationCompoundProbe(record)||json(record.sourceHashes)!==json(hashes())||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==prior.archives.saved.sha256)throw new Error('compound-source-changed');
 try{return{status:'native-error',error:JSON.parse(await owned(record.errorPath)),safeToApply:false};}catch(error){if(error.code!=='ENOENT')throw error;}
 if((await owned(record.startedPath)).toString()!==`FRAMELINE_ENUMERATION_COMPOUND_STARTED:${record.probeId}\n`||(await owned(record.markerPath)).toString()!==`FRAMELINE_ENUMERATION_COMPOUND_COMPLETE:${record.probeId}\n`)throw new Error('compound-probe-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);if(result.operation!=='resolve-enumeration-compound-control'||result.probeId!==record.probeId||result.projectId!==record.projectId||result.status!=='saved-reopened'||result.stage!=='complete'
  ||result.saveReopenVerified!==true||result.originalOwnersStructurallyUnchanged!==true||typeof result.originalOwnerRichProjectionVerified!=='boolean'||result.activeTimelineRestored!==true||result.expectedProfileDisposition!=='refuse-nested-content'||result.sourceCaptureResultSha256!==record.sourceCaptureResultSha256||result.safeToApply!==false||result.ordinaryApplySupported!==false
  ||!Array.isArray(result.timelineIds)||result.timelineIds.length<3||result.timelineIds.length>20||new Set(result.timelineIds).size!==result.timelineIds.length||result.orientationCount!==result.timelineIds.length||record.owners.some(row=>!result.timelineIds.includes(row.id))||record.owners.some(row=>row.id===result.negativeTimelineId)||!result.timelineIds.includes(result.negativeTimelineId))throw new Error('compound-result-differs');
 const observations=[],observationSources=[];for(const filename of record.observationPaths.slice(0,result.orientationCount)){const bytes=await owned(filename);observations.push(parseTimelineEnumeration(bytes));observationSources.push({sha256:sha(bytes),bytes:bytes.length});}
 if(observations.some((doc,index)=>doc.projectId!==record.projectId||doc.activeTimelineId.status!=='captured'||doc.activeTimelineId.value!==result.timelineIds[index]||doc.timelineCount.status!=='captured'||doc.timelineCount.value!==result.orientationCount))throw new Error('compound-context-differs');
 const archive=await owned(record.savedArchivePath);await inspectResolveProjectExport(record.savedArchivePath,sha(archive));let nativeInventory=null,nativeRefusal=null;try{nativeInventory=JSON.parse(execFileSync('python3',[path.join(__dirname,'resolve-native-timeline-inventory.py'),record.savedArchivePath],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));}catch(error){if(error.status!==1)throw new Error('native-inventory-execution-failed');nativeRefusal=String(error.stderr||'native-inventory-refused').trim();if(!/^[a-z0-9-]+$/.test(nativeRefusal))throw new Error('unsafe-native-refusal');}
 if(nativeInventory&&(nativeInventory.archive.sha256!==sha(archive)||nativeInventory.archive.size!==archive.length||nativeInventory.projectId!==record.projectId))throw new Error('compound-native-source-differs');
 const owner=observations.find(doc=>doc.activeTimelineId.value===result.negativeTimelineId).timelines.value.find(t=>t.id===result.negativeTimelineId);
 if(owner.name.status!=='captured'||owner.name.value!==record.negativeName)throw new Error('negative-timeline-name-differs');
 const compound=owner?.trackGroups.flatMap(g=>g.tracks.status==='captured'?g.tracks.value:[]).flatMap(t=>t.items.status==='captured'?t.items.value:[]).find(item=>item.id===result.compoundItemId);
 if(!compound)throw new Error('saved-compound-role-absent');
 const nestedReferenceObserved=compound.mediaPool.nestedTimeline.status==='timeline'||!!nativeInventory?.nestedTimelineEdges?.length;
 let accepted=null,rejection=null;if(nativeInventory){try{accepted=assembleActiveTimelineEnumeration({observations,nativeInventories:[nativeInventory]});}catch(error){rejection=error.message;}}
 return{...result,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,resultSha256:sha(raw),resultBytes:raw.length,observations,observationSources,nativeInventory,nativeRefusal,
  archive:{sha256:sha(archive),size:archive.length},nativeArchiveVerified:true,nativeParserRefused:nativeRefusal!==null,compoundRoleObserved:true,nestedReferenceIndependentlyObserved:nestedReferenceObserved,
  profileAccepted:accepted?.completeForProfile===true,profileRejection:rejection,profileRefusalVerified:nestedReferenceObserved&&accepted?.completeForProfile!==true,
  nativeReaderSha256:sha(readInput(path.join(__dirname,'resolve-native-timeline-inventory.py'))),sourceAndResultVerified:true};
}
module.exports={ownerRich,expectedOwners,renderEnumerationCompoundProbe,prepareEnumerationCompoundProbe,readEnumerationCompoundProbe};
if(require.main===module){const[op,a,flag]=process.argv.slice(2);(op==='prepare'?prepareEnumerationCompoundProbe(a,{install:flag==='--install'}):op==='read'?readEnumerationCompoundProbe(a):Promise.reject(new Error('usage')))
 .then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(error=>{process.stderr.write('enumeration-compound-failed:'+error.message+'\n');process.exitCode=1;});}
