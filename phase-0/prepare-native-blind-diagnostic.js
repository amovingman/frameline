'use strict';
// Read-only inspection of the partially completed owned fixture. No repair.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const{randomBytes}=require('node:crypto');
const{readInput}=require('./integration-input'),{resultWriter}=require('./gate-lab-session');
const{renderBlindCapture,NAME}=require('./prepare-native-blind-capture');
const{readNativeLocationGraph,joinSynchronizedNativeTracks,json,sha}=require('./native-track-location-binding');
const{parseApiLocationObservation,assessApiLocationWitnesses}=require('../src/resolve-api-location-observation');
const ROOT=path.resolve(__dirname,'..');
async function renderDiagnostic(record){
 let source=await renderBlindCapture(record.captureRecord);
 const prior='p:GetUniqueId()~="dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff"';
 if(source.split(prior).length!==2||source.split('#before.items==52').length!==2)throw new Error('incompatible-diagnostic-capture');
 source=source.replace(prior,`p:GetUniqueId()==${JSON.stringify(record.projectId)}`).replace('#before.items==52','#before.items<=52');
 const failure="end);if not ok then print('FRAMELINE_NATIVE_BLIND_CAPTURE_FAILED:'..tostring(err))end";
 if(source.split(failure).length!==2)throw new Error('incompatible-diagnostic-error');
 source=source.replace(failure,"end);if not ok then diagnostic_error(err)end");
 return `local diagnostic_fusion=assert(resolve:Fusion(),'No Fusion')
assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local diagnostic_project=assert(resolve:GetProjectManager():GetCurrentProject(),'No project');assert(diagnostic_project:GetName()==${JSON.stringify(NAME)}and diagnostic_project:GetUniqueId()==${JSON.stringify(record.projectId)},'Wrong diagnostic project')
local fusion=diagnostic_fusion
${resultWriter()}
absent(${JSON.stringify(record.errorPath)})
local diagnostic_encode=(function()${readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString()}\nend)().encode
local function diagnostic_error(err)local message=tostring(err):gsub('[%z\\1-\\31\\127]',' '):sub(1,2000);write_exact(${JSON.stringify(record.errorPath)},diagnostic_encode({schemaVersion=1,operation='native-blind-readonly-diagnostic-error',probeId=${JSON.stringify(record.probeId)},error=message,readOnly=true,safeToApply=false}))end
${source}`;
}
async function prepareDiagnostic(executedStagePreparation){
 const stage=JSON.parse(readInput(executedStagePreparation));
 if(stage.operation!=='prepare-native-blind-perturb'||sha(readInput(stage.sourcePath))!==stage.sourceSha256)throw new Error('unverified-executed-stage');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-native-blind-diagnostic-')));await fs.chmod(directory,0o700);const probeId=randomBytes(16).toString('hex');
 const captureRecord={stage:'capture',probeId,emptyBackupPath:path.join(directory,'unused.drp'),paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')}};
 const record={schemaVersion:1,operation:'prepare-native-blind-diagnostic',directory,probeId,projectId:stage.projectId,executedStagePreparation,executedSourceSha256:stage.sourceSha256,captureRecord,errorPath:path.join(directory,'error.json')};
 record.sourcePath=path.join(directory,`Frameline Blind Diagnostic ${probeId.slice(0,12)}.lua`);const source=await renderDiagnostic(record);record.sourceSha256=sha(source);
 await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});const preparation=path.join(directory,'diagnostic-preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),readOnly:true};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-diagnostic-file');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readDiagnostic(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.operation!=='prepare-native-blind-diagnostic'||record.directory!==directory||!/^[a-f0-9]{32}$/.test(record.probeId)||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory
  ||record.sourcePath!==path.join(directory,`Frameline Blind Diagnostic ${record.probeId.slice(0,12)}.lua`)||record.errorPath!==path.join(directory,'error.json')
  ||json(record.captureRecord)!==json({stage:'capture',probeId:record.probeId,emptyBackupPath:path.join(directory,'unused.drp'),paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')}}))throw new Error('invalid-diagnostic-record');
 const source=await owned(record.sourcePath),stage=JSON.parse(readInput(record.executedStagePreparation));
 if(sha(source)!==record.sourceSha256||source.toString()!==await renderDiagnostic(record)||stage.sourceSha256!==record.executedSourceSha256||stage.projectId!==record.projectId||sha(readInput(stage.sourcePath))!==stage.sourceSha256)throw new Error('diagnostic-source-changed');
 try{const failure=JSON.parse(await owned(record.errorPath));return{status:'diagnostic-error',error:failure,ordinaryApplySupported:false};}catch(error){if(error.code!=='ENOENT')throw error;}
 const raw=await owned(record.captureRecord.paths.result),result=JSON.parse(raw);
 if(result.operation!=='resolve-native-blind-capture'||result.probeId!==record.probeId||result.readOnly!==true||result.safeToApply!==false||result.before.snapshot.project_id!==record.projectId
  ||result.pageBefore!==result.pageAfter||(await owned(record.captureRecord.paths.marker)).toString()!==`FRAMELINE_NATIVE_BLIND_CAPTURE_V1:${record.probeId}\n`)throw new Error('invalid-diagnostic-result');
 const graphs=[];for(const name of['first','second']){await owned(record.captureRecord.paths[name]);graphs.push(readNativeLocationGraph(record.captureRecord.paths[name]));}
 const prediction=joinSynchronizedNativeTracks([result.before,result.between,result.after],graphs),witness=parseApiLocationObservation(JSON.stringify(result.apiLocationWitnesses));
 if(json(witness.richContext)!==json(result.after))throw new Error('diagnostic-witness-source-differs');
 return{schemaVersion:1,operation:'native-blind-readonly-diagnostic-receipt',status:'captured',projectId:record.projectId,sourceSha256:record.sourceSha256,executedSourceSha256:record.executedSourceSha256,
  resultSha256:sha(raw),resultBytes:raw.length,observations:[result.before,result.between,result.after],graphs,prediction,apiLocationWitnesses:witness,apiWitnessAssessment:assessApiLocationWitnesses(witness),readOnly:true,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module){const[op,a]=process.argv.slice(2);const action=op==='prepare'?prepareDiagnostic(a):op==='read'?readDiagnostic(a):Promise.reject(new Error('usage'));action.then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{process.stderr.write('native-blind-diagnostic-failed:'+e.message+'\n');process.exitCode=1;});}
module.exports={prepareDiagnostic,renderDiagnostic,readDiagnostic};
