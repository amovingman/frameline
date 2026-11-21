'use strict';
// Read-only project observations with explicit, restored active-timeline changes.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const{randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const{readInput}=require('./integration-input'),{resultWriter}=require('./gate-lab-session');
const{propertyCaptureConfig}=require('../src/resolve-property-observation');
const{parseTimelineEnumeration,assessTimelineEnumeration}=require('../src/resolve-timeline-enumeration');
const{NAME}=require('./prepare-enumeration-fixture');
const ROOT=path.resolve(__dirname,'..'),sha=v=>createHash('sha256').update(v).digest('hex'),q=JSON.stringify;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(canonical(v));
const SOURCES=['phase-0/prepare-enumeration-capture.js','phase-0/gate-lab-session.js','src/companion/resolve-internal.lua',
 'src/companion/resolve-effects.lua','src/companion/resolve-timeline-enumeration.lua','src/resolve-timeline-enumeration.js','src/resolve-property-contract.json'];
const hashes=()=>Object.fromEntries(SOURCES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
async function readCheckpoint(kind,preparation){
 const result=kind==='fixture-retry'?await require('./prepare-enumeration-fixture-retry').readEnumerationRetry(preparation)
  :kind==='challenge'?await require('./prepare-enumeration-challenge').readEnumerationChallenge(preparation):null;
 if(!result||result.status!=='saved-reopened'||result.saveReopenVerified!==true||result.baseline?.snapshot?.project_name!==NAME
  ||!path.isAbsolute(result.savedArchivePath||'')||!result.archives?.saved||result.baseline.snapshot.project_id!==result.projectId)throw new Error('verified-enumeration-checkpoint-required');
 return result;
}
function checkpointFacts(value){return{projectId:value.projectId,sourceSha256:value.sourceSha256,resultSha256:value.resultSha256,saveReopenVerified:value.saveReopenVerified,savedArchive:value.archives.saved};}
function tree(doc){return{runtime:doc.runtime,projectId:doc.projectId,timelineCount:doc.timelineCount,timelines:doc.timelines};}

function renderEnumerationCapture(record){
 const raw=readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString(),anchor='return { capture_request = capture_request }';
 if(raw.split(anchor).length!==2)throw new Error('incompatible-enumeration-base');
 const base=raw.replace(anchor,'return {capture=capture,encode=encode,array=array}'),effects=readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString(),enumeration=readInput(path.join(ROOT,'src/companion/resolve-timeline-enumeration.lua')).toString();
 return `local fusion=assert(resolve:Fusion(),'No Fusion')
${resultWriter()}
local encode=(function()${effects}\nend)().encode
local stage,publish_error='initial',false
local ok,err=pcall(function()
assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local pm=assert(resolve:GetProjectManager(),'No manager')
local function current()local p=assert(pm:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)}and p:GetUniqueId()==${q(record.projectId)},'Wrong owned fixture');return p end
local p=current()
for _,filename in ipairs({${[record.resultPath,record.markerPath,record.errorPath,...record.orientations.flatMap(row=>Object.values(row))].map(q).join(',')}})do absent(filename)end
publish_error=true
local backup=assert(fusion:OpenFile(${q(record.backupPath)},1),'Checkpoint backup absent');assert(backup:GetFileSize()==${record.backupBytes},'Checkpoint backup differs');backup:Close()
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)();local enumeration=(function()${enumeration}\nend)();local config=${propertyCaptureConfig()}
local function rich()current();return effects.capture(resolve,base,config)end
stage='source-check';assert(encode(rich())==${q(json(record.baseline))},'Saved source differs')
local original=assert(p:GetCurrentTimeline(),'No active timeline');assert(original:GetUniqueId()==${q(record.baseline.activeTimelineId)},'Active source differs')
local function timeline(id)local found=nil;for index=1,p:GetTimelineCount()do local t=p:GetTimelineByIndex(index);if t:GetUniqueId()==id then assert(found==nil,'Timeline duplicate');found=t end end;return assert(found,'Timeline absent')end
local orientation_ids={${record.timelineIds.map(q).join(',')}}
local orientations={${record.orientations.map(row=>`{before=${q(row.before)},after=${q(row.after)},archive=${q(row.archive)}}`).join(',')}}
local raw_tree=nil;local invariant=true
for index,id in ipairs(orientation_ids)do
 stage='select-'..index;current();assert(p:SetCurrentTimeline(timeline(id))==true,'Timeline select failed')
 stage='read-before-'..index;local before=enumeration.capture(resolve,base,effects,config,200);write_exact(orientations[index].before,encode(before))
 stage='export-'..index;current();assert(pm:ExportProject(${q(NAME)},orientations[index].archive,true)==true,'Native export failed')
 stage='read-after-'..index;local after=enumeration.capture(resolve,base,effects,config,200);write_exact(orientations[index].after,encode(after))
 assert(encode(before)==encode(after),'Enumeration changed around export')
 local current_tree=encode({runtime=before.runtime,projectId=before.projectId,timelineCount=before.timelineCount,timelines=before.timelines})
 if raw_tree==nil then raw_tree=current_tree elseif raw_tree~=current_tree then invariant=false end
end
stage='restore-active';current();assert(p:SetCurrentTimeline(timeline(${q(record.baseline.activeTimelineId)}))==true,'Active restoration failed')
assert(encode(rich())==${q(json(record.baseline))},'Source differs after active restoration')
stage='complete';write_exact(${q(record.resultPath)},encode({schemaVersion=1,operation='resolve-enumeration-capture-interval',probeId=${q(record.probeId)},projectId=${q(record.projectId)},
 status='captured',stage=stage,orientationCount=#orientation_ids,wholeProjectTreeInvariantAcrossActiveContexts=invariant,activeTimelineRestored=true,savedCheckpointResultSha256=${q(record.checkpoint.resultSha256)},
 readOnly=true,changesActiveTimeline=true,ordinaryApplySupported=false,safeToApply=false}))
write_exact(${q(record.markerPath)},${q('FRAMELINE_ENUMERATION_CAPTURE_COMPLETE:'+record.probeId)})
end)
if not ok and publish_error then write_exact(${q(record.errorPath)},encode({schemaVersion=1,operation='resolve-enumeration-capture-error',probeId=${q(record.probeId)},stage=stage,
 error=tostring(err):gsub('[%z\\1-\\31\\127]',' '):sub(1,2048),safeToApply=false}))elseif not ok then print('FRAMELINE_ENUMERATION_CAPTURE_REFUSED')end`;
}
async function prepareEnumerationCapture(checkpointKind,checkpointPreparation,{install=false}={}){
 const checkpoint=await readCheckpoint(checkpointKind,checkpointPreparation),baseline=checkpoint.baseline,timelineIds=baseline.snapshot.timelines.map(t=>t.id);
 if(timelineIds.length<2||timelineIds.length>20||baseline.items.length>200)throw new Error('unsupported-enumeration-capture-source');
 const backup=readInput(checkpoint.savedArchivePath);if(sha(backup)!==checkpoint.archives.saved.sha256||backup.length!==checkpoint.archives.saved.size)throw new Error('enumeration-checkpoint-archive-changed');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-enumeration-capture-')));await fs.chmod(directory,0o700);const probeId=randomBytes(16).toString('hex');
 const record={schemaVersion:1,operation:'prepare-enumeration-capture',directory,probeId,projectId:checkpoint.projectId,checkpointKind,checkpointPreparation,checkpoint:checkpointFacts(checkpoint),baseline,roles:checkpoint.roles,timelineIds,
  orientations:timelineIds.map((_,index)=>({before:path.join(directory,`orientation-${index+1}-before.json`),after:path.join(directory,`orientation-${index+1}-after.json`),archive:path.join(directory,`orientation-${index+1}.drp`)})),
  backupPath:path.join(directory,'verified-saved-backup.drp'),backupSha256:sha(backup),backupBytes:backup.length,resultPath:path.join(directory,'result.json'),markerPath:path.join(directory,'complete.txt'),errorPath:path.join(directory,'error.json'),sourceHashes:hashes()};
 await fs.writeFile(record.backupPath,backup,{flag:'wx',mode:0o600});record.sourcePath=path.join(directory,`Frameline Enumeration Capture ${probeId.slice(0,12)}.lua`);
 const source=renderEnumerationCapture(record);record.sourceSha256=sha(source);await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
 record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
 if(install){const folder=path.dirname(record.installedPath),stat=await fs.lstat(folder);if(!stat.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-enumeration-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
 const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),orientationCount:timelineIds.length};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-enumeration-capture-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readEnumerationCapture(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),stat=await fs.lstat(directory);
 if(record.schemaVersion!==1||record.operation!=='prepare-enumeration-capture'||record.directory!==directory||!/^[a-f0-9]{32}$/.test(record.probeId)||!stat.isDirectory()||stat.mode&0o077||stat.uid!==process.getuid()||await fs.realpath(directory)!==directory
  ||record.sourcePath!==path.join(directory,`Frameline Enumeration Capture ${record.probeId.slice(0,12)}.lua`)||record.resultPath!==path.join(directory,'result.json')||record.markerPath!==path.join(directory,'complete.txt')||record.errorPath!==path.join(directory,'error.json')||record.backupPath!==path.join(directory,'verified-saved-backup.drp')
  ||json(record.orientations)!==json(record.timelineIds.map((_,index)=>({before:path.join(directory,`orientation-${index+1}-before.json`),after:path.join(directory,`orientation-${index+1}-after.json`),archive:path.join(directory,`orientation-${index+1}.drp`)}))))throw new Error('invalid-enumeration-capture-record');
 const checkpoint=await readCheckpoint(record.checkpointKind,record.checkpointPreparation),source=await owned(record.sourcePath);
 if(json(checkpointFacts(checkpoint))!==json(record.checkpoint)||json(checkpoint.baseline)!==json(record.baseline)||json(checkpoint.roles)!==json(record.roles)||json(record.timelineIds)!==json(record.baseline.snapshot.timelines.map(t=>t.id))
  ||sha(source)!==record.sourceSha256||source.toString()!==renderEnumerationCapture(record)||json(record.sourceHashes)!==json(hashes())||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==checkpoint.archives.saved.sha256)throw new Error('enumeration-capture-source-changed');
 try{return{status:'native-error',error:JSON.parse(await owned(record.errorPath)),safeToApply:false};}catch(error){if(error.code!=='ENOENT')throw error;}
 if((await owned(record.markerPath)).toString()!==`FRAMELINE_ENUMERATION_CAPTURE_COMPLETE:${record.probeId}\n`)throw new Error('enumeration-capture-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);
 if(result.operation!=='resolve-enumeration-capture-interval'||result.probeId!==record.probeId||result.projectId!==record.projectId||result.status!=='captured'||result.stage!=='complete'||result.orientationCount!==record.timelineIds.length||result.activeTimelineRestored!==true
  ||result.savedCheckpointResultSha256!==record.checkpoint.resultSha256||result.readOnly!==true||result.changesActiveTimeline!==true||result.safeToApply!==false||result.ordinaryApplySupported!==false)throw new Error('enumeration-capture-result-differs');
 const observations=[],nativeInventories=[],rawReceipts=[];
 for(let index=0;index<record.orientations.length;index++){
  const row=record.orientations[index],beforeBytes=await owned(row.before),afterBytes=await owned(row.after),before=parseTimelineEnumeration(beforeBytes),after=parseTimelineEnumeration(afterBytes);
  if(json(before)!==json(after)||before.projectId!==record.projectId||before.activeTimelineId.status!=='captured'||before.activeTimelineId.value!==record.timelineIds[index])throw new Error('enumeration-capture-state-differs');
  const archive=await owned(row.archive),inventory=JSON.parse(execFileSync('python3',[path.join(__dirname,'resolve-native-timeline-inventory.py'),row.archive],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024}));
  if(inventory.archive.sha256!==sha(archive)||inventory.archive.size!==archive.length||inventory.projectId!==record.projectId)throw new Error('enumeration-capture-native-source-differs');
  observations.push({before,after});nativeInventories.push(inventory);rawReceipts.push({beforeSha256:sha(beforeBytes),afterSha256:sha(afterBytes),archive:inventory.archive});
 }
 const invariant=observations.every(row=>json(tree(row.before))===json(tree(observations[0].before)));
 if(result.wholeProjectTreeInvariantAcrossActiveContexts!==invariant)throw new Error('enumeration-capture-invariance-result-differs');
 return{...result,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,resultSha256:sha(raw),resultBytes:raw.length,roles:record.roles,checkpoint:record.checkpoint,baseline:record.baseline,
  observations,nativeInventories,rawReceipts,assessments:observations.map(row=>assessTimelineEnumeration(row.before)),sourceAndResultVerified:true,
  nativeReaderSha256:sha(readInput(path.join(__dirname,'resolve-native-timeline-inventory.py'))),savedCheckpointScopeOnly:true,currentUnsavedStateBindingProven:false,
  savedArchivePath:record.orientations[0].archive,archives:{saved:nativeInventories[0].archive},saveReopenVerified:true,saveReopenPerformedByCapture:false};
}
module.exports={renderEnumerationCapture,prepareEnumerationCapture,readEnumerationCapture,tree,json,sha};
if(require.main===module){const[operation,a,b,flag]=process.argv.slice(2);(operation==='prepare'?prepareEnumerationCapture(a,b,{install:flag==='--install'}):operation==='read'?readEnumerationCapture(a):Promise.reject(new Error('usage')))
 .then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(error=>{process.stderr.write('enumeration-capture-failed:'+error.message+'\n');process.exitCode=1;});}
