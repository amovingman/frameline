'use strict';
// Save/reopen the exactly inspected partial-stage state, without repeating its
// append/delete/move/rename operations. The original failed source is retained.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const{randomBytes}=require('node:crypto');
const{readInput}=require('./integration-input'),{resultWriter}=require('./gate-lab-session');
const{readDiagnostic}=require('./prepare-native-blind-diagnostic');
const{renderBlindCapture,readCapture,NAME}=require('./prepare-native-blind-capture');
const{propertyCaptureConfig}=require('../src/resolve-property-observation');
const{readNativeLocationGraph,identityFacts,json,sha}=require('./native-track-location-binding');
const ROOT=path.resolve(__dirname,'..');
const SOURCES=['phase-0/prepare-native-blind-continuation.js','phase-0/prepare-native-blind-diagnostic.js','phase-0/prepare-native-blind-perturb.js',
 'phase-0/prepare-native-blind-capture.js','phase-0/native-track-location-binding.js','phase-0/resolve-native-location-graph.py','phase-0/resolve-native-track-identity.py',
 'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
const hashes=()=>Object.fromEntries(SOURCES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
const q=JSON.stringify;
function semanticState(input){const value=structuredClone(input);for(const t of value.snapshot.timelines)t.items.sort((a,b)=>a.id.localeCompare(b.id));value.items.sort((a,b)=>a.timelineId.localeCompare(b.timelineId)||a.itemId.localeCompare(b.itemId));return value;}
async function renderContinuation(record){
 const raw=readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString(),anchor='return { capture_request = capture_request }';
 if(raw.split(anchor).length!==2)throw new Error('incompatible-continuation-capture');
 const base=raw.replace(anchor,'return {capture=capture,encode=encode,array=array}'),effects=readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString();
 const captureSource=await renderBlindCapture(record.captureRecord);if(sha(captureSource)!==record.captureRecord.sourceSha256)throw new Error('continuation-capture-source-changed');
 return `local ok,err=pcall(function()
assert(resolve and resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local manager=assert(resolve:GetProjectManager(),'No manager');local fusion=assert(resolve:Fusion(),'No Fusion')
local function current()local p=assert(manager:GetCurrentProject(),'No project');assert(p:GetName()==${q(NAME)}and p:GetUniqueId()==${q(record.projectId)},'Wrong owned fixture');return p end
${resultWriter()}
for _,filename in ipairs({${[record.resultPath,record.markerPath,record.startedPath,...Object.values(record.exports),...Object.values(record.captureRecord.paths)].map(q).join(',')}})do absent(filename)end
local backup=assert(fusion:OpenFile(${q(record.backupPath)},1),'Verified backup unavailable');assert(backup:GetFileSize()==${record.backupBytes},'Backup differs');backup:Close()
local base=(function()${base}\nend)();local effects=(function()${effects}\nend)();local config=${propertyCaptureConfig()}
local function capture()current();return effects.capture(resolve,base,config)end
local function export(filename)absent(filename);assert(manager:ExportProject(${q(NAME)},filename,true)==true,'Export failed');local f=assert(fusion:OpenFile(filename,1),'Export unavailable');assert(f:GetFileSize()>0,'Export empty');f:Close()end
local before=capture();assert(effects.encode(before)==${q(json(record.observation))},'Inspected source changed');export(${q(record.exports.before)})
write_exact(${q(record.startedPath)},${q('FRAMELINE_BLIND_CONTINUATION_STARTED:'+record.probeId)})
assert(effects.encode(capture())==${q(json(record.observation))},'Source changed after barrier')
local p=current();assert(p:GetTimelineCount()==1 and p:GetTimelineByIndex(1):GetUniqueId()==${q(record.observation.snapshot.timelines[0].id)},'Timeline changed')
assert(manager:SaveProject()==true,'Save failed');assert(manager:CloseProject(p)==true,'Close failed');assert(manager:LoadProject(${q(NAME)})~=nil,'Load failed')
local after=capture();assert(effects.encode(after)==${q(json(record.observation))},'Reopened source differs');export(${q(record.exports.after)})
local value={schemaVersion=1,operation='resolve-native-blind-save-reopen-continuation',probeId=${q(record.probeId)},status='checkpoint-complete',saveReopenVerified=true,repeatedPriorMutators=false,
 before=before,after=after,diagnosticResultSha256=${q(record.diagnosticResultSha256)},originalFailedSourceSha256=${q(record.originalFailedSourceSha256)},captureSourceSha256=${q(record.captureRecord.sourceSha256)},safeToApply=false,ordinaryApplySupported=false}
write_exact(${q(record.resultPath)},effects.encode(value));write_exact(${q(record.markerPath)},${q('FRAMELINE_BLIND_CONTINUATION_COMPLETE:'+record.probeId)})
end);if ok then do\n${captureSource}\nend else print('FRAMELINE_BLIND_CONTINUATION_FAILED:'..tostring(err))end`;
}
async function prepareContinuation(diagnosticPreparation){
 const diagnosticRecord=JSON.parse(readInput(diagnosticPreparation)),diagnostic=await readDiagnostic(diagnosticPreparation);
 if(diagnostic.status!=='captured'||diagnostic.prediction.itemCount!==52||!diagnostic.apiWitnessAssessment.requiredPopulatedKindsCapturedAndAgree)throw new Error('diagnostic-source-incomplete');
 const failed=JSON.parse(readInput(diagnosticRecord.executedStagePreparation)),observation=diagnostic.observations[2];
 if(json(semanticState(failed.plan.after))!==json(semanticState(observation))||json(failed.plan.after)===json(observation))throw new Error('diagnostic-is-not-only-enumeration-order');
 const backup=readInput(diagnosticRecord.captureRecord.paths.second);if(sha(backup)!==diagnostic.graphs[1].archive.sha256)throw new Error('diagnostic-backup-changed');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-native-blind-continuation-')));await fs.chmod(directory,0o700);const probeId=randomBytes(16).toString('hex');
 const captureRecord={...failed.captureRecord,stage:'capture',directory,probeId,expectedObservation:observation,emptyBackupPath:path.join(directory,'empty-project-backup.drp'),paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')},
  predictionPath:path.join(directory,'prediction.json'),sourcePath:path.join(directory,`Frameline Blind Init ${probeId.slice(0,12)}.lua`),installedPath:null};
 captureRecord.sourceSha256=sha(await renderBlindCapture(captureRecord));
 const record={schemaVersion:1,operation:'prepare-native-blind-continuation',directory,probeId,projectId:diagnostic.projectId,diagnosticPreparation,diagnosticResultSha256:diagnostic.resultSha256,
  originalFailedSourceSha256:diagnostic.executedSourceSha256,observation,captureRecord,sourceHashes:hashes(),backupPath:path.join(directory,'verified-diagnostic-backup.drp'),backupBytes:backup.length,backupSha256:sha(backup),
  resultPath:path.join(directory,'checkpoint-result.json'),markerPath:path.join(directory,'checkpoint-complete.txt'),startedPath:path.join(directory,'checkpoint-started.txt'),exports:{before:path.join(directory,'checkpoint-before.drp'),after:path.join(directory,'checkpoint-after.drp')}};
 await fs.writeFile(record.backupPath,backup,{flag:'wx',mode:0o600});await fs.writeFile(captureRecord.sourcePath,await renderBlindCapture(captureRecord),{flag:'wx',mode:0o600});await fs.writeFile(path.join(directory,'preparation.json'),JSON.stringify(captureRecord,null,2)+'\n',{flag:'wx',mode:0o600});
 record.sourcePath=path.join(directory,`Frameline Blind Continue ${probeId.slice(0,12)}.lua`);const source=await renderContinuation(record);record.sourceSha256=sha(source);await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
 const preparation=path.join(directory,'continuation-preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,capturePreparation:path.join(directory,'preparation.json'),sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),sourceOrderOnlyDifferenceVerified:true,repeatedPriorMutators:false};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-continuation-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readContinuation(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.operation!=='prepare-native-blind-continuation'||record.directory!==directory||!/^[a-f0-9]{32}$/.test(record.probeId)||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory
  ||record.sourcePath!==path.join(directory,`Frameline Blind Continue ${record.probeId.slice(0,12)}.lua`)||record.backupPath!==path.join(directory,'verified-diagnostic-backup.drp')
  ||record.resultPath!==path.join(directory,'checkpoint-result.json')||record.markerPath!==path.join(directory,'checkpoint-complete.txt')||record.startedPath!==path.join(directory,'checkpoint-started.txt')
  ||json(record.exports)!==json({before:path.join(directory,'checkpoint-before.drp'),after:path.join(directory,'checkpoint-after.drp')}))throw new Error('invalid-continuation-record');
 const diagnostic=await readDiagnostic(record.diagnosticPreparation),source=await owned(record.sourcePath);
 if(diagnostic.status!=='captured'||diagnostic.resultSha256!==record.diagnosticResultSha256||diagnostic.executedSourceSha256!==record.originalFailedSourceSha256||diagnostic.projectId!==record.projectId
  ||json(diagnostic.observations[2])!==json(record.observation)||sha(source)!==record.sourceSha256||source.toString()!==await renderContinuation(record)||json(record.sourceHashes)!==json(hashes())
  ||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==diagnostic.graphs[1].archive.sha256
  ||json(JSON.parse(await owned(path.join(directory,'preparation.json'))))!==json(record.captureRecord))throw new Error('continuation-source-changed');
 if((await owned(record.markerPath)).toString()!==`FRAMELINE_BLIND_CONTINUATION_COMPLETE:${record.probeId}\n`||(await owned(record.startedPath)).toString()!==`FRAMELINE_BLIND_CONTINUATION_STARTED:${record.probeId}\n`)throw new Error('continuation-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);
 if(result.operation!=='resolve-native-blind-save-reopen-continuation'||result.probeId!==record.probeId||result.status!=='checkpoint-complete'||result.saveReopenVerified!==true||result.repeatedPriorMutators!==false
  ||result.diagnosticResultSha256!==record.diagnosticResultSha256||result.originalFailedSourceSha256!==record.originalFailedSourceSha256||result.captureSourceSha256!==record.captureRecord.sourceSha256
  ||result.safeToApply!==false||result.ordinaryApplySupported!==false||json(result.before)!==json(record.observation)||json(result.after)!==json(record.observation))throw new Error('invalid-continuation-result');
 const graphs={};for(const[key,filename]of Object.entries(record.exports)){await owned(filename);graphs[key]=readNativeLocationGraph(filename);if(json(identityFacts(graphs[key]))!==json(identityFacts(diagnostic.graphs[1])))throw new Error('continuation-native-identity-drift');}
 const capture=await readCapture(path.join(directory,'preparation.json'));if(json(capture.observations[0])!==json(record.observation)||json(identityFacts(capture.graphs[0]))!==json(identityFacts(graphs.after)))throw new Error('continuation-capture-differs');
 return{schemaVersion:1,operation:'native-blind-save-reopen-continuation-receipt',status:'captured',projectId:record.projectId,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,resultSha256:sha(raw),resultBytes:raw.length,
  originalFailedSourceSha256:record.originalFailedSourceSha256,diagnosticResultSha256:record.diagnosticResultSha256,sourceOrderOnlyDifferenceVerified:true,repeatedPriorMutators:false,saveReopenVerified:true,graphs,capture,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module){const[op,a]=process.argv.slice(2);const action=op==='prepare'?prepareContinuation(a):op==='read'?readContinuation(a):Promise.reject(new Error('usage'));action.then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{process.stderr.write('native-blind-continuation-failed:'+e.message+'\n');process.exitCode=1;});}
module.exports={semanticState,prepareContinuation,renderContinuation,readContinuation};
