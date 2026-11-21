'use strict';
// Admit a new stored baseline after an incomplete native transaction. This does
// not turn that transaction into a successful Save or Close.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {readInput}=require('./integration-input'),{owned,json,sha}=require('./prepare-preservation-session');
const {readPreservationMinimalNameV2}=require('./prepare-preservation-minimal-name-v2'),{readPreservationAbsence,validatePreservationAbsence}=require('./prepare-preservation-absence');
const {readHandshake}=require('./preservation-native-handshake'),{readNativeSqliteSnapshot}=require('./native-sqlite-preservation');
const {bindStoredNameTarget,verifyClosedLiveSource}=require('./prepare-preservation-minimal-name'),{requireNativeSqlitePhysicalProfile}=require('./native-sqlite-physical-profile');
const ROOT=path.resolve(__dirname,'..'),PY=path.join(__dirname,'resolve-native-sqlite-snapshot.py');
const SOURCES=['phase-0/prepare-preservation-crash-recovery.js','phase-0/prepare-preservation-minimal-name-v2.js','phase-0/prepare-preservation-minimal-name.js','phase-0/prepare-preservation-absence.js','phase-0/preservation-native-handshake.js','phase-0/native-sqlite-preservation.js','phase-0/resolve-native-sqlite-snapshot.py','phase-0/native-sqlite-physical-profile.js'];
const hashes=()=>Object.fromEntries(SOURCES.map(p=>[p,sha(readInput(path.join(ROOT,p)))])),need=(v,c)=>{if(!v)throw new Error('preservation-crash-recovery-'+c);};
async function absent(file){try{await fs.lstat(file);throw new Error('preservation-crash-recovery-interrupted-output-now-exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function collect(interruptedPreparation,freshAbsencePreparation,snapshotRecordPath,depth=0){
 need(Number.isSafeInteger(depth)&&depth>=0&&depth<=12,'source-chain-depth');
 const interruptedBytes=await owned(interruptedPreparation),r=JSON.parse(interruptedBytes),interrupted=await readPreservationMinimalNameV2(interruptedPreparation,depth+1);
 need(interrupted.status==='recovery-required'&&interrupted.executionMayStillBeRunning===true&&interrupted.doNotReplay===true,'incomplete-native-source-required');
 need((await owned(r.paths.started,true)).toString()===`FRAMELINE_PRESERVATION_MINIMAL_STARTED:${r.probeId}\n`,'actual-start-required');
 for(const key of['marker','result','error'])await absent(r.paths[key]);
 const admission=await readHandshake(interruptedPreparation),freshBytes=await owned(freshAbsencePreparation),freshRecord=JSON.parse(freshBytes),fresh=await readPreservationAbsence(freshAbsencePreparation);
 need(fresh.status==='closed-verified'&&fresh.sourceAndResultVerified===true&&fresh.projectId===r.projectId&&fresh.projectName===r.projectName,'fresh-native-absence-required');
 const startedStat=await fs.stat(r.paths.started),freshPreparationStat=await fs.stat(freshAbsencePreparation),freshResultStat=await fs.stat(freshRecord.paths.result);
 need(freshAbsencePreparation!==r.closedPreparation&&freshRecord.probeId!==r.probeId&&freshPreparationStat.mtimeMs>startedStat.mtimeMs&&freshResultStat.mtimeMs>=freshPreparationStat.mtimeMs,'absence-must-follow-interrupted-start');
 const placeholder=validatePreservationAbsence(fresh.observations,r.projectId),snapshot=await readNativeSqliteSnapshot(snapshotRecordPath),snapshotBytes=await owned(snapshotRecordPath),rawRecord=JSON.parse(snapshotBytes);
 need(snapshot.closedCheckpoint===null&&snapshot.projectId===r.projectId&&snapshot.projectName===r.projectName&&snapshot.rawSnapshotAndCensusVerified===true&&snapshot.allApplicationCellsCovered===true&&snapshot.singleProjectDirectoryValidated===true&&snapshot.snapshot.size<=8*1024*1024,'forensic-stored-baseline-required');
 const physicalProfile=requireNativeSqlitePhysicalProfile(await owned(snapshot.snapshotPath)),census=JSON.parse(await owned(snapshot.censusPath));
 const plan={projectId:r.projectId,projectName:r.projectName,target:r.plan.target,oldName:r.plan.newName},sqlTargetBinding=bindStoredNameTarget(census,plan);
 need(Array.isArray(r.plan.after)&&r.plan.after.length===2,'derived-contexts-required');
 const facts={schemaVersion:1,operation:'preservation-interrupted-source-recovery-checkpoint',status:'closed-verified',projectId:r.projectId,projectName:r.projectName,interruptedPreparationSha256:sha(interruptedBytes),interruptedNativeSourceSha256:r.sourceSha256,interruptedActualStartedSha256:sha(await owned(r.paths.started,true)),interruptedHostAdmissionSha256:admission.admissionSha256,interruptedCompletionRecordAbsent:true,interruptedErrorRecordAbsent:true,interruptedNativeExecutionRemainsIncomplete:true,crashCauseProvenByThisReader:false,freshAbsencePreparationSha256:sha(freshBytes),freshAbsenceSourceSha256:fresh.sourceSha256,freshAbsenceResultSha256:fresh.resultSha256,privateFileOrdering:{interruptedStartedMtimeMs:startedStat.mtimeMs,freshPreparationMtimeMs:freshPreparationStat.mtimeMs,freshResultMtimeMs:freshResultStat.mtimeMs,freshAbsencePreparationAndResultFollowInterruptedStart:true,clockTamperResistanceProven:false},snapshotRecordSha256:sha(snapshotBytes),snapshot:snapshot.snapshot,census:snapshot.census,physicalProfile,sqlTargetBinding,freshNativeAbsenceVerified:true,sourcePersistedDatabaseCheckpointVerified:true,sourceAndResultVerified:true,savePerformed:false,saveVerified:false,closePerformed:false,closeVerified:false,nativeSourceSaveCompletionProven:false,nativeSourceCloseCompletionProven:false,sourcePreviouslySavedCheckpointVerified:false,contextsAreDerivedExpectedNameProjection:true,derivedContextsAreNotActualPostCrashApiCaptures:true,sourceBaselineMayContainUnexplainedNativeChanges:true,losslessValidated:false,ordinaryApplySupported:false,safeToApply:false};
 return{facts,r,fresh,placeholder,snapshot,census,liveSourcePath:rawRecord.sourcePath};
}
async function preparePreservationCrashRecovery(interruptedPreparation,freshAbsencePreparation,snapshotRecordPath){
 const data=await collect(interruptedPreparation,freshAbsencePreparation,snapshotRecordPath);await verifyClosedLiveSource({closed:data.fresh,snapshot:data.snapshot,liveSourcePath:data.liveSourcePath});
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-preservation-crash-recovery-')));await fs.chmod(directory,0o700);
 const record={schemaVersion:1,operation:'prepare-preservation-crash-recovery',directory,interruptedPreparation,freshAbsencePreparation,snapshotRecordPath,facts:data.facts,sourceHashes:hashes()},preparation=path.join(directory,'preparation.json');
 execFileSync('python3',['-B',PY,'publish-record',preparation,JSON.stringify(record)],{timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});return{preparation,...await readPreservationCrashRecovery(preparation)};
}
async function readPreservationCrashRecovery(preparation,depth=0){
 const bytes=await owned(preparation),r=JSON.parse(bytes);need(r.schemaVersion===1&&r.operation==='prepare-preservation-crash-recovery'&&r.directory===path.dirname(preparation)&&path.basename(preparation)==='preparation.json'&&json(r.sourceHashes)===json(hashes()),'invalid-record');
 const data=await collect(r.interruptedPreparation,r.freshAbsencePreparation,r.snapshotRecordPath,depth);need(json(data.facts)===json(r.facts),'evidence-differs');
 return{...data.facts,closedCheckpointKind:'crash-recovery',sourceSha256:sha(readInput(__filename)),resultSha256:sha(bytes),preparationSha256:sha(bytes),sourceHashes:r.sourceHashes,placeholder:data.placeholder,observations:data.fresh.observations,postCloseObservations:data.fresh.observations,contexts:data.r.plan.after,mainTimelineId:data.r.plan.target.timelineId,protectionArchive:data.fresh.protectionArchive,protectionArchivePath:data.fresh.protectionArchivePath,protectionArchiveRepresents:'pre-interruption-source',currentLiveAbsenceProvenByThisReader:false,recoveryCheckpointOnlyNotLosslessEvidence:true};
}
module.exports={preparePreservationCrashRecovery,readPreservationCrashRecovery};
