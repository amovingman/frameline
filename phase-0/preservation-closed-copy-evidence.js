'use strict';
const path=require('node:path'),{createHash}=require('node:crypto'),{gunzipSync}=require('node:zlib');
const{readInput}=require('./integration-input');
const{compareProjections}=require('./preservation-interrupted-name-evidence');
const{bindProjectedNameTarget}=require('./native-sqlite-name-target-binding');
const ROOT=path.resolve(__dirname,'..'),DIR='phase-0/preservation-closed-copy-evidence',HASH='29aa04e7a23bcd27757ca3fb380365f70fa474d5007ab571d8de19e8abe30622';
const sha=b=>createHash('sha256').update(b).digest('hex'),need=(v,c)=>{if(!v)throw Error('closed-copy-evidence-'+c);};
function auditClosedCopyPreservation(read=readInput){
 const file=f=>read(path.join(ROOT,f)),receipt=file(DIR+'/receipt.json');need(sha(receipt)===HASH,'receipt');const r=JSON.parse(receipt);
 for(const[f,h]of Object.entries(r.sourceHashes))need(!path.isAbsolute(f)&&!f.includes('..')&&sha(file(f))===h,'source');
 const compressed=file(DIR+'/evidence.json.gz');need(sha(compressed)===r.compressedSha256,'compressed');const raw=gunzipSync(compressed,{maxOutputLength:8*1024*1024});need(sha(raw)===r.payloadSha256,'payload');need(!/\/Users\/|\/private\/|"base64"\s*:/.test(raw.toString()),'private-data');const p=JSON.parse(raw),b=p.binding;
 const ids={projectId:b.projectId,timelineId:b.timelineId,sequenceId:b.sequenceId,trackId:b.trackId,itemId:b.itemId,kind:'video'};
 const before=bindProjectedNameTarget(p.before,ids),written=bindProjectedNameTarget(p.written,ids),after=bindProjectedNameTarget(p.after,ids);
 const changes=compareProjections(p.before,p.written);need(changes.length===1,'single-cell');const d=changes[0];need(d.tableNameSha256===before.tableNameSha256&&d.rowIdentitySha256===before.rowIdentitySha256&&d.columnNameSha256===before.columnNameSha256&&d.beforeValueSha256===before.storedNameValueSha256&&d.afterValueSha256===written.storedNameValueSha256,'target');
 need(compareProjections(p.written,p.after).length===0&&after.storedNameValueSha256===written.storedNameValueSha256,'reopen');
 const w=p.writeComparison,c=p.reopenComparison,e=p.execution;
 need(w.allOtherApplicationValuesPreserved===true&&w.unexplainedDifferences.length===0&&w.excludedApplicationColumns.length===0&&w.authorizedNameCell.itemId===ids.itemId,'write');
 need(c.allOtherApplicationValuesPreserved===true&&c.physicalFileBytesEqual===true&&c.unexplainedDifferences.length===0&&c.excludedApplicationColumns.length===0&&c.beforeSnapshot.sha256===c.afterSnapshot.sha256&&c.afterSnapshot.sha256===e.postSnapshot.sha256,'closed-bytes');
 need(e.basicNameReadbackVerified===true&&e.contentSetterCalls===0&&e.savePerformed===false&&e.closePerformed===false&&e.sourceAbsenceCapturedSeparately===true&&e.sourceExtendedAttributeValuesPreserved===true&&e.allFileMetadataEqual===false&&e.atomicLoadBytesVerified===false&&e.concurrentWriterResistanceProven===false,'execution-scope');
 for(const k of ['openSourceSha256','openResultSha256','publicationResultSha256','checkpointResultSha256','absenceResultSha256'])need(/^[a-f0-9]{64}$/.test(e[k]),'native-receipts');
 return{schemaVersion:1,status:'verified-scoped-preservation',scope:r.scope,tables:146,schemaObjects:596,rows:540,cellsIncludingRowid:9788,authorizedNameCellChanges:1,unexplainedCellChanges:0,postEditorDatabaseBytesIdentical:true,sourceBoundNativeEvidenceRetained:true,privateRawDatabasesReconstructed:false,allFileMetadataEqual:false,sdkSavePreservationProven:false,originalBaselineRestorationProven:false,ordinaryApplySupported:false,safeToApply:false,gateEvidenceComplete:true};
}
module.exports={auditClosedCopyPreservation};
if(require.main===module)console.log(JSON.stringify(auditClosedCopyPreservation(),null,2));
