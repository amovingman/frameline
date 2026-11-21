'use strict';
// Python type facts remain Python facts. This adapter performs no editor calls.
const path=require('node:path'),{createHash}=require('node:crypto');
const {readInput}=require('./integration-input');
const ROOT=path.resolve(__dirname,'..'),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw new Error('preservation-absence-v3-'+c);};
const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v,json=v=>JSON.stringify(canon(v));
function typeFact(value){return value&&Object.keys(value).sort().join(',')==='module,typeName'&&typeof value.module==='string'&&/^[A-Za-z_][\w.]{0,199}$/.test(value.module)&&typeof value.typeName==='string'&&/^[A-Za-z_][\w.]{0,199}$/.test(value.typeName);}
const captured=(r,value)=>r&&r.status==='captured'&&r.value===value;
function validatePythonPreservationAbsence(observations,projectId){
 const a=observations?.first,b=observations?.second;
 need(UUID.test(projectId||'')&&a&&b&&json(a)===json(b),'stable-two-pass-placeholder-required');
 need(a.language==='python'&&a.currentObjectStatus==='captured'&&a.currentObjectPresent===true&&typeFact(a.currentObjectType)&&a.currentObjectType.module!=='builtins','actual-python-proxy-type-required');
 need(a.projectName?.status==='captured'&&['New Project','Untitled Project'].includes(a.projectName.value)&&a.projectId?.status==='captured'&&UUID.test(a.projectId.value||'')&&a.projectId.value!==projectId,'source-identity-must-be-absent');
 need(captured(a.timelineCount,0)&&captured(a.rootClipCount,0)&&captured(a.rootSubfolderCount,0),'empty-placeholder-required');
 need(typeFact(a.currentTimelineType)&&a.currentTimelineType.module==='builtins'&&((a.currentTimelineType.typeName==='NoneType'&&a.currentTimelineValue===null)||(a.currentTimelineType.typeName==='bool'&&a.currentTimelineValue===false))&&a.currentTimelineAbsent===true,'actual-python-no-current-timeline-required');
 const settings=a.settings?.value;
 need(a.settings?.status==='captured'&&settings&&typeof settings==='object'&&!Array.isArray(settings)&&Object.keys(settings).length>0&&Object.keys(settings).length<=2000&&Object.entries(settings).every(([k,v])=>k.length>0&&k.length<=512&&['string','boolean','number'].includes(typeof v)&&(typeof v!=='number'||Number.isFinite(v))),'captured-settings-required');
 need(a.savedProjectNamesStatus==='captured'&&a.currentNameExistsInSavedProjectList===false&&a.sourceNameExistsInSavedProjectList===true,'saved-source-and-unsaved-placeholder-required');
 return{projectId:a.projectId.value,projectName:a.projectName.value,timelineCount:0,rootClipCount:0,rootSubfolderCount:0,settings,currentNameExistsInSavedProjectList:false,originalCurrentIdentityAbsent:true,language:'python',currentObjectType:a.currentObjectType,currentTimelineType:a.currentTimelineType,currentTimelineValue:a.currentTimelineValue};
}
async function readPreservationAbsenceV3(preparation,depth=0){
 need(Number.isSafeInteger(depth)&&depth>=0&&depth<=12,'source-chain-depth');
 const r=await require(path.join(ROOT,'phase-0/prepare-preservation-minimal-name-v2.js')).readPreservationMinimalNameV2(preparation,depth+1);
 need(r&&r.schemaVersion===1&&r.operation==='resolve-preservation-minimal-name-close-v2'&&r.status==='closed-verified'&&r.stage==='complete'&&UUID.test(r.projectId||'')&&typeof r.projectName==='string'&&r.projectName.length>0&&HASH.test(r.sourceSha256||'')&&HASH.test(r.resultSha256||'')&&r.sourceAndResultVerified===true&&r.saveVerified===true&&r.closeVerified===true,'verified-native-v2-result-required');
 need(r.binaryTransportSentinelVerified===true&&r.closedDatabaseByteEqualityVerifiedBeforeLoad===true&&r.contentSetterCalls===1&&r.basicNameReadbackVerified===true&&r.sourceEffectsPropertiesGraphsAndExportsRead===false&&r.sourceContentGettersAfterSavePerformed===false&&r.postEditDatabaseSnapshotStillRequired===true&&r.persistedNameCellVerified===false&&r.fullNativePreservationProven===false&&r.safeToApply===false&&r.ordinaryApplySupported===false,'native-v2-scope');
 need(r.contextsAreDerivedExpectedNameProjection===true&&Array.isArray(r.contexts)&&r.contexts.length===2&&UUID.test(r.mainTimelineId||'')&&r.protectionArchiveRepresents==='pre-edit-source'&&r.nativePostEditExportPerformed===false&&r.saveReopenVerified===false,'derived-context-scope');
 const placeholder=validatePythonPreservationAbsence(r.postCloseObservations,r.projectId);
 return{...r,placeholder,nativeOperation:r.operation,closedCheckpointKind:'source-absence-v3',closedSourceAdmission:'verified-native-python-v2-post-close-observations',absenceWrapperSourceSha256:createHash('sha256').update(readInput(__filename)).digest('hex'),nativeOperationAndResultPreserved:true,backendOnlyNoNewEditorCalls:true,closedCheckpointScopeOnly:true,currentLiveAbsenceProvenByThisReader:false,losslessValidated:false};
}
module.exports={validatePythonPreservationAbsence,readPreservationAbsenceV3};
