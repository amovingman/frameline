'use strict';
// Pure host audit of public bytes. Native archives remain private; no editor calls.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{gunzipSync}=require('node:zlib');
const{parseItemStateObservation,compareItemStateObservations,describeItemStateCoverage}=require('../src/resolve-item-state-observation');
const{parseEffectObservation}=require('../src/resolve-effect-observation');
const{states,targetItemId}=require('./prepare-item-state-rename-proof');
const folder='phase-0/item-state-rename-evidence',generator='phase-0/prepare-item-state-rename-proof.js';
const generatorSha='b441563e9aa60f27f40bf3f85b66d2bfcbf7f69ef109fd4c8ec7b17988b893bc';
const sourceFiles=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-item-state.lua','phase-0/resolve-item-state-menu.lua'];
const pins={
 'baseline-extra.json.gz':'1d051df28bb9b2260e24c48847710ea07958ef5c74a9b54b28736d7554f0772f',
 'baseline-rich.json.gz':'e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af',
 'fresh-capture-result.json':'c599957ba2d00928976303b96c214a5708a92c19646b587cccbeabd5810647a6',
 'fresh-capture-marker.txt':'56e4ebed75b9bf980a47085299827444e2226e8c88db93c815863b7f20b27536',
 'rename-extra.json.gz':'275194815708c0c476a9a956345e0af81291c5e9d9d919ce359c381733e82fcb',
 'rename-rich.json.gz':'bc05352619feb745546d53a2107a55841ab7546940d370b887b6b410e1214a3a',
 'rename-result.json':'dc5886c57b9b47989bf2f4a08c870168c4c74d932c82bb041fa89e84b7ae0dda',
 'rename-started.json':'c7713f3b74fe646df3da1187f4d393e668c7bdd37057f5884072fdd93780b4eb',
 'rename-complete.txt':'2c98071a2b15a960841b37eb54f5a28d48a96a247ff4212eb8f796603fa267fe',
 'rollback-extra.json.gz':'1d051df28bb9b2260e24c48847710ea07958ef5c74a9b54b28736d7554f0772f',
 'rollback-rich.json.gz':'e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af',
 'rollback-result.json':'0bcd31306e0ead4768307717a36b2b041462ed0d3e8b15edb389b77f3acd3ac5',
 'rollback-started.json':'ca01d0d66d2088e3519f9caf078222ec8e89acf48b456a81efc6d7e19790a938',
 'rollback-complete.txt':'a0813cd86b286103a6456e4c27ef76697cbdf7a3b02e74fb2c18f56c2363283e'
};
const phasePins=[{mode:'rename',id:'0a334ce48e2b3d222824468f7bcbd3e0',source:'223b9e5750a9c01607f3b06e2ec2f2ca12d4bc49b5675f424bc9ba71ab61e87b',before:'db1439fce5693878a7a28394237053dd55a8790ea7fd420ff42c9b3d86f7fbd0',beforeSize:53487,after:'f3c5b7583aae64a95e3ac312637a40926054c844d1728233b703cdf3315c15ed',afterSize:53495},
 {mode:'rollback',id:'25f232860f26e96b52b7104d7a720d1d',source:'c691796e163005fc0ca9e5b59fc5926f0b7ee6d9ed877c443de5210ea24033f6',before:'f3c5b7583aae64a95e3ac312637a40926054c844d1728233b703cdf3315c15ed',beforeSize:53495,after:'df3b9d8690574d806deb96f01880e8946735b0a573ae8212303d5f873a49a337',afterSize:53465}];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const json=value=>JSON.stringify(canonical(value));
function auditItemStateRenameEvidence({root=path.resolve(__dirname,'..')}={}){
 const requireProof=(condition,message)=>{if(!condition)throw new Error('item-state-rename-evidence-'+message);};
 const bytes=file=>fs.readFileSync(path.join(root,file)),receipt=JSON.parse(bytes(folder+'/receipt.json'));
 requireProof(receipt.schemaVersion===1&&receipt.operation==='item-state-guarded-rename-live-proof'&&receipt.experimental===true&&receipt.readOnly===false&&receipt.safeToApply===false&&receipt.ordinaryApplyEnabled===false&&receipt.completeEditorStateObserved===false&&receipt.generalLosslessPreservationProven===false,'scope');
 requireProof(receipt.version==='21.1.2.10'&&receipt.projectId==='dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff'&&receipt.projectName==='Frameline Integration Gate Fixture 20261120','context');
 requireProof(json(receipt.writeAuthority)===json({project:'API-project-UUID',timeline:'API-timeline-UUID',item:'API-timeline-item-UUID',namesAndPositions:'source-assertions-only'}),'authority');
 requireProof(receipt.sourceGenerator.file===generator&&receipt.sourceGenerator.sha256===generatorSha&&sha(bytes(generator))===generatorSha,'generator-source');
 requireProof(json(receipt.sourceHashes)===json(Object.fromEntries(sourceFiles.map(file=>[file,sha(bytes(file))]))),'source-hashes');
 function raw(file,descriptor){const relative=folder+'/'+file,packed=bytes(relative),value=file.endsWith('.gz')?gunzipSync(packed,{maxOutputLength:2*1024*1024}):packed;
  requireProof(descriptor.file===relative&&descriptor.sha256===pins[file]&&sha(value)===pins[file]&&descriptor.bytes===value.length,'raw-hash');
  if(file.endsWith('.gz'))requireProof(descriptor.compressedSha256===sha(packed),'compressed-hash');return value;}
 const extraRaw=raw('baseline-extra.json.gz',receipt.baseline.extra),richRaw=raw('baseline-rich.json.gz',receipt.baseline.rich),baselineExtra=parseItemStateObservation(extraRaw),baselineRich=parseEffectObservation(richRaw);
 const fresh=JSON.parse(raw('fresh-capture-result.json',receipt.baseline.result));
 requireProof(receipt.baseline.requestId==='46a233b090af80381a2c200ccef9ce24'&&receipt.baseline.renderedSourceSha256==='915d488810434c8b80dce7b6825d43d540306b14a67b9fdc02a6f6e01736ed53'&&fresh.operation==='resolve-item-state-menu'&&fresh.requestId===receipt.baseline.requestId&&fresh.readOnly===true&&fresh.safeToApply===false&&fresh.itemCount===50,'fresh-capture');
 requireProof(raw('fresh-capture-marker.txt',receipt.baseline.marker).toString()===`FRAMELINE_ITEM_STATE_MENU_COMPLETE_V1:${fresh.requestId}\n`,'fresh-marker');
 requireProof(Array.isArray(receipt.phases)&&receipt.phases.length===2,'phase-count');
 const observations=[];
 for(let i=0;i<2;i++){const p=receipt.phases[i],pin=phasePins[i],expected=states(baselineExtra,baselineRich,pin.mode),mode=pin.mode;
  requireProof(p.mode===mode&&p.status===(i?'restored':'renamed')&&p.requestId===pin.id&&p.renderedSourceSha256===pin.source&&p.targetItemId===targetItemId&&p.name===expected.resultName,'phase-binding');
  const observedRaw=raw(mode+'-extra.json.gz',p.extra),afterRichRaw=raw(mode+'-rich.json.gz',p.rich),observed=parseItemStateObservation(observedRaw),afterRich=parseEffectObservation(afterRichRaw);
  requireProof(json(observed)===json(expected.after)&&json(afterRich)===json(expected.richAfter),'represented-result');
  const result=JSON.parse(raw(mode+'-result.json',p.result)),started=JSON.parse(raw(mode+'-started.json',p.started));
  requireProof(Object.keys(result).sort().join(',')==='experimental,itemCount,mode,name,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion,targetItemId'&&result.schemaVersion===1&&result.operation==='resolve-item-state-rename-proof'&&result.mode===mode&&result.name===p.name&&result.requestId===pin.id&&result.projectId===receipt.projectId&&result.targetItemId===targetItemId&&result.experimental===true&&result.readOnly===false&&result.safeToApply===false&&result.itemCount===50&&result.observationBytes===observedRaw.length-1,'result-envelope');
  requireProof(json(started)===json({schemaVersion:1,operation:'item-state-rename-started',id:pin.id,mode})&&raw(mode+'-complete.txt',p.marker).toString()===`FRAMELINE_ITEM_STATE_RENAME_PROOF_COMPLETE_V1:${pin.id}\n`,'markers');
  for(const[key,hash,size]of[['beforeBackup',pin.before,pin.beforeSize],['postStateBackup',pin.after,pin.afterSize]])requireProof(json(p[key])===json({schemaVersion:1,sha256:hash,size,mode:384,timelineCount:1,archiveVerified:true}),'native-backup-receipt');
  const beforeExtra=i?receipt.phases[0].extra.sha256:receipt.baseline.extra.sha256,beforeRich=i?receipt.phases[0].rich.sha256:receipt.baseline.rich.sha256;
  requireProof(p.sourceExtraSha256===beforeExtra&&p.sourceRichSha256===beforeRich&&json(p.backupSourceBinding)===json({extraSha256:beforeExtra,richSha256:beforeRich,archiveSha256:pin.before,association:'fresh-export-host-receipt-not-native-semantic-equivalence'}),'backup-source-binding');
  requireProof(i?json(p.predecessor)===json({requestId:phasePins[0].id,renderedSourceSha256:phasePins[0].source,sourceExtraSha256:beforeExtra,sourceRichSha256:beforeRich,backupSha256:pin.before}):p.predecessor===null,'predecessor');
  observations.push({raw:observedRaw,richRaw:afterRichRaw,observed});
 }
 requireProof(observations[1].raw.equals(extraRaw)&&observations[1].richRaw.equals(richRaw),'exact-restoration');
 const changed=compareItemStateObservations(extraRaw,observations[0].raw);
 requireProof(changed.snapshotChanges.length===1&&changed.snapshotChanges[0].field==='name'&&changed.itemStateChanges.length===0,'one-name-delta');
 requireProof(json(receipt.nativeOperationCalls)===json({SetName:2,SaveProject:2,CloseProject:2,LoadProject:2,ExportProject:2}),'call-count');
 return{schemaVersion:1,readOnly:true,status:'verified',scope:'Pure host audit of one guarded disposable rename and independently prepared rollback on Resolve21.1.2.10.',liveProofReadOnly:false,writeAuthority:receipt.writeAuthority,itemCount:50,representedProperties:baselineRich.items.reduce((n,item)=>n+Object.keys(item.properties).length,0),guardedReadFamilies:7,coverage:describeItemStateCoverage(baselineExtra),nameChanges:1,additionalStateChanges:0,exactRepresentedRestoration:true,freshRollbackBackupLinked:true,sourceAndRawHashesVerified:true,nativeArchiveValidation:receipt.nativeArchiveValidation,nativeArchiveByteEqualityProven:false,powerLossDurabilityProven:false,generalLosslessPreservationProven:false,safeToApply:false,ordinaryApplyEnabled:false,
 limitations:['Private native archive validation and export/source association remain host receipts; this pure audit recomputes represented observations and public raw hashes.','The seven observed read families do not enumerate full graphs, retime, effects or opaque native state.','Replay/stale/interrupt failures are covered in generated-Lua mock tests, not additional live mutations.']};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(auditItemStateRenameEvidence(),null,2)+'\n');}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}}
module.exports={auditItemStateRenameEvidence};
