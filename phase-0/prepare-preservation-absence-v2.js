'use strict';
// Backend-only adapter for a verified V2 transaction's actual post-close
// observations. No native script is installed and no editor call is issued.
const path=require('node:path'),{createHash}=require('node:crypto');
const {readInput}=require('./integration-input');
const {validatePreservationAbsence}=require('./prepare-preservation-absence');
const ROOT=path.resolve(__dirname,'..'),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw new Error('preservation-absence-v2-'+c);};
async function readPreservationAbsenceV2(preparation,depth=0){
 need(Number.isSafeInteger(depth)&&depth>=0&&depth<=12,'source-chain-depth');
 const result=await require(path.join(ROOT,'phase-0/prepare-preservation-minimal-name-v2.js')).readPreservationMinimalNameV2(preparation,depth+1);
 need(result&&result.schemaVersion===1&&result.operation==='resolve-preservation-minimal-name-close-v2'&&result.status==='closed-verified'&&result.stage==='complete'&&UUID.test(result.projectId||'')&&typeof result.projectName==='string'&&result.projectName.length>0&&HASH.test(result.sourceSha256||'')&&HASH.test(result.resultSha256||'')&&result.sourceAndResultVerified===true&&result.saveVerified===true&&result.closeVerified===true,'verified-native-v2-result-required');
 need(result.binaryTransportSentinelVerified===true&&result.closedDatabaseByteEqualityVerifiedBeforeLoad===true&&result.contentSetterCalls===1&&result.basicNameReadbackVerified===true&&result.sourceEffectsPropertiesGraphsAndExportsRead===false&&result.sourceContentGettersAfterSavePerformed===false&&result.postEditDatabaseSnapshotStillRequired===true&&result.persistedNameCellVerified===false&&result.fullNativePreservationProven===false&&result.safeToApply===false&&result.ordinaryApplySupported===false,'native-v2-scope');
 need(result.contextsAreDerivedExpectedNameProjection===true&&Array.isArray(result.contexts)&&result.contexts.length===2&&UUID.test(result.mainTimelineId||'')&&result.protectionArchiveRepresents==='pre-edit-source'&&result.nativePostEditExportPerformed===false&&result.saveReopenVerified===false,'derived-context-scope');
 const placeholder=validatePreservationAbsence(result.postCloseObservations,result.projectId);
 return{...result,placeholder,nativeOperation:result.operation,closedCheckpointKind:'source-absence-v2',closedSourceAdmission:'verified-native-v2-post-close-observations',absenceWrapperSourceSha256:createHash('sha256').update(readInput(__filename)).digest('hex'),nativeOperationAndResultPreserved:true,backendOnlyNoNewEditorCalls:true,closedCheckpointScopeOnly:true,currentLiveAbsenceProvenByThisReader:false,losslessValidated:false};
}
module.exports={readPreservationAbsenceV2};
