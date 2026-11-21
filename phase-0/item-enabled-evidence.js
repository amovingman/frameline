'use strict';
const path=require('node:path');
const{gunzipSync}=require('node:zlib');
const{createHash}=require('node:crypto');
const{readInput}=require('./integration-input');
const{parseItemStateObservation,compareItemStateObservations}=require('../src/resolve-item-state-observation');
const{parseEffectObservation}=require('../src/resolve-effect-observation');
const root=path.resolve(__dirname,'..'),sha=value=>createHash('sha256').update(value).digest('hex');
function auditItemEnabledEvidence(read=readInput){
  const record=JSON.parse(read(path.join(root,'phase-0/item-state-evidence/receipt.json'))),proof=record.enabledProof;
  if(!proof||proof.schemaVersion!==1||proof.readOnly!==false||proof.experimental!==true||proof.safeToApply!==false||proof.ordinaryApplyEnabled!==false||proof.phases.length!==2||proof.sourceGenerator!=='phase-0/prepare-item-enabled-proof.js'||sha(read(path.join(root,proof.sourceGenerator)))!==proof.sourceGeneratorSha256)throw new Error('invalid-enabled-proof-evidence');
  function decode(entry,name,expected){if(entry.file!==`phase-0/item-state-evidence/${name}`)throw new Error('invalid-enabled-evidence-file');const compressed=read(path.join(root,entry.file));if(sha(compressed)!==entry.compressedSha256)throw new Error('enabled-compressed-evidence-changed');const raw=gunzipSync(compressed,{maxOutputLength:2*1024*1024});if(raw.length!==entry.bytes||sha(raw)!==entry.sha256||entry.sha256!==expected)throw new Error('enabled-evidence-changed');return raw;}
  const initial=decode(record.orderedBaseline,'ordered-baseline.json.gz','1d051df28bb9b2260e24c48847710ea07958ef5c74a9b54b28736d7554f0772f'),raws={};
  const richBaseline=decode(record.richBaseline,'baseline-rich.json.gz','e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af');
  const sourceKeys=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-item-state.lua','phase-0/resolve-item-state-menu.lua'].sort().join(',');
  for(const phase of proof.phases){
    if(!['disable','restore'].includes(phase.mode)||raws[phase.mode]||phase.targetItemId!=='ccb4c9a5-2189-4b81-82c9-bf099c49eec1')throw new Error('invalid-enabled-phase');
    raws[phase.mode]=decode(phase,`enabled-${phase.mode}.json.gz`,phase.mode==='disable'?'90262c4db61c967c26cedfefeedd9bdc6b6b2008f4855910488d0f8b213a44e8':record.orderedBaseline.sha256);parseItemStateObservation(raws[phase.mode]);
    const resultFile=`phase-0/item-state-evidence/enabled-${phase.mode}-result.json`;if(phase.resultFile!==resultFile)throw new Error('invalid-enabled-result-file');const bytes=read(path.join(root,resultFile)),result=JSON.parse(bytes);
    const expectedResultHash=phase.mode==='disable'?'8d99f67a5c5e1e6d4b7a0b0ecba6020d7a3b322c36e0e72fb74471488471b451':'6631a514f68d9a3df806b49f08798881de90b8c662ebe7a2527b516ba9bf6645';
    if(sha(bytes)!==phase.resultSha256||phase.resultSha256!==expectedResultHash||result.operation!=='resolve-item-enabled-proof'||result.experimental!==true||result.readOnly!==false||result.safeToApply!==false||result.requestId!==phase.requestId||result.mode!==phase.mode||result.targetItemId!==phase.targetItemId||result.projectId!==record.projectId||result.itemCount!==50||result.observationBytes!==raws[phase.mode].length-1||result.enabled!==(phase.mode==='restore')||phase.richObservationSha256!==record.richBaseline.sha256)throw new Error('enabled-result-evidence-mismatch');
    const richOutcome=decode(phase.richResult,`enabled-${phase.mode}-rich.json.gz`,record.richBaseline.sha256);parseEffectObservation(richOutcome);if(!richOutcome.equals(richBaseline))throw new Error('enabled-rich-evidence-mismatch');
    if(Object.keys(phase.sourceHashes).sort().join(',')!==sourceKeys)throw new Error('enabled-source-evidence-changed');
    for(const[file,digest]of Object.entries(phase.sourceHashes))if(!Object.hasOwn(record.orderedBaseline.sourceHashes,file)||sha(read(path.join(root,file)))!==digest)throw new Error('enabled-source-evidence-changed');
    for(const backup of[phase.beforeBackup,phase.postStateBackup])if(backup.archiveVerified!==true||backup.timelineCount!==1||backup.mode!==0o600||!Number.isSafeInteger(backup.size)||backup.size<1||!/^[a-f0-9]{64}$/.test(backup.sha256))throw new Error('invalid-enabled-backup-receipt');
  }
  const disabled=proof.phases.find(phase=>phase.mode==='disable'),restored=proof.phases.find(phase=>phase.mode==='restore'),delta=compareItemStateObservations(initial,raws.disable);
  if(delta.snapshotChanges.length||delta.itemStateChanges.length!==1||delta.itemStateChanges[0].itemId!==disabled.targetItemId||delta.itemStateChanges[0].field!=='clipEnabled'||delta.itemStateChanges[0].before.value!==true||delta.itemStateChanges[0].after.value!==false||!initial.equals(raws.restore)||restored.beforeBackup.sha256!==disabled.postStateBackup.sha256||disabled.sourceExtraSha256!==record.orderedBaseline.sha256||restored.sourceExtraSha256!==disabled.sha256)throw new Error('enabled-restoration-evidence-mismatch');
  return{schemaVersion:1,readOnly:false,experimental:true,safeToApply:false,targetItemId:disabled.targetItemId,disabledDifferenceCount:1,disabledField:'clipEnabled',snapshotDifferenceCount:0,richOutcomesMatchBaseline:true,exactRepresentedBytesRestored:true,freshRestoreBackupMatchesDisabledExport:true,privateNativeArchiveReceiptsRetained:true,generalLosslessPreservationProven:false,ordinaryApplyEnabled:false};
}
module.exports={auditItemEnabledEvidence};
