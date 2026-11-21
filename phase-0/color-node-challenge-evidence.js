'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gunzipSync}=require('node:zlib');
const {readInput}=require('./integration-input');
const {auditColorNodeEvidence}=require('./color-node-evidence');
const {parseColorNodeObservation,compareColorNodeObservations}=require('../src/resolve-color-node-observation');
const {parseEffectObservation}=require('../src/resolve-effect-observation');
const {parseItemStateObservation}=require('../src/resolve-item-state-observation');
const root=path.resolve(__dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const target='ccb4c9a5-2189-4b81-82c9-bf099c49eec1';
const richSha='e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af',extraSha='1d051df28bb9b2260e24c48847710ea07958ef5c74a9b54b28736d7554f0772f',baselineSha='b165113a00b20a4ba047991933f6db3388e812f56c589250f3932c3f2e92d2e4',coloredSha='58d2b4eeb58b197f91416c9531a96e32651effb43a3fa7ad92110efbc5506db6';
const sources=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-item-state.lua','src/companion/resolve-color-nodes.lua','src/resolve-property-contract.json','phase-0/resolve-color-node-challenge.lua'];
const validators=['src/resolve-effect-observation.js','src/resolve-item-state-observation.js','src/resolve-color-node-observation.js'];
const fixtures={
  color:{status:'colored',color:'Blue',requestId:'0b471b286a0f0514ab4643e8656d00af',nodeFile:'colored.json.gz',rawSha:coloredSha,compressedSha:'865ece4666fa517a984b034854a1790419e2dfc465a3fbfe1ef714a151938ad4',resultSha:'95ee290f6b5f9303fc41950a71e970041ba2199a04b17debc6cf44ecd6ff08f9',sourceSha:'eb82e58f7359f90d39d21c081db5ff4cec6436632990a9f8fbd7a0e5a0faea6c',backupSha:'df3b9d8690574d806deb96f01880e8946735b0a573ae8212303d5f873a49a337',backupSize:53465,postSha:'77e5c9c8fbe76dd9eb5cc302345970e6b5c01df97bcfab6193c867496fbb2bf5',postSize:54045},
  restore:{status:'restored',color:'',requestId:'95663532494537c9846206791a1e034d',nodeFile:'restored.json.gz',rawSha:baselineSha,compressedSha:'d28d59620c4c6eff999fb4ce83ca126578aee0f586e4d520d24a11f4284e6b37',resultSha:'d07b3faebb27bf98778ceae36d968ded81b1197d77d3cea4f4a8fcdcee70b6d0',sourceSha:'49c957b76800450888ea4589a8db436bed7985c08eca5c5e8f5380e85b978ce3',backupSha:'77e5c9c8fbe76dd9eb5cc302345970e6b5c01df97bcfab6193c867496fbb2bf5',backupSize:54045,postSha:'8726151dfa6801fad733c256f9257ee5f1d05f658fc38a875bac76276b4ba548',postSize:54049}
};
function auditColorNodeChallengeEvidence(read=file=>readInput(path.join(root,file))){
  try{
    const initial=auditColorNodeEvidence(read),baselineRaw=gunzipSync(read('phase-0/color-node-evidence/baseline.json.gz'),{maxOutputLength:2*1024*1024}),baseline=parseColorNodeObservation(baselineRaw);
    const richRaw=gunzipSync(read('phase-0/resolve-operation-baseline-observation.json.gz'),{maxOutputLength:2*1024*1024}),extraRaw=gunzipSync(read('phase-0/item-state-evidence/ordered-baseline.json.gz'),{maxOutputLength:2*1024*1024});
    if(sha(richRaw)!==richSha||sha(extraRaw)!==extraSha)throw new Error();const rich=parseEffectObservation(richRaw),extra=parseItemStateObservation(extraRaw);
    if(!same(rich.snapshot,extra.snapshot)||!same(rich.snapshot,baseline.snapshot)||rich.items.length!==50||rich.tracks.length!==5||rich.items.reduce((n,i)=>n+Object.keys(i.properties).length,0)!==1600||rich.items.some(i=>i.propertyReadStatus!=='captured')||extra.items.some(i=>['clipEnabled','speed','fades','outputBlanking','usesTimelineOutputBlanking','fusionCompCount','firstColorLayerNodeCount'].some(field=>i[field].status!=='captured')))throw new Error();
    const expectedColored=structuredClone(baseline),slot=expectedColored.items.find(i=>i.itemId===target);if(slot.graph.count!==1||slot.graph.nodes[0].color.value!=='')throw new Error();slot.graph.nodes[0].color.value='Blue';
    const reports={},observations={};
    for(const[mode,pin]of Object.entries(fixtures)){
      const base='phase-0/color-node-evidence/',report=JSON.parse(read(`${base}${mode}-receipt.json`)),resultRaw=read(`${base}${mode}-result.json`),compressed=read(`${base}${pin.nodeFile}`);
      if(report.schemaVersion!==1||report.status!==pin.status||report.mode!==mode||report.experimental!==true||report.safeToApply!==false||report.newLiveEditorRun!==true||report.proofScope!=='single-node-cosmetic-annotation-only'||report.targetItemId!==target||report.nodeIndex!==1||report.color!==pin.color||report.itemCount!==50||report.requestId!==pin.requestId||report.sourceSha256!==pin.sourceSha||report.nodesObservationFile!==`${base}${pin.nodeFile}`||report.nodesCompressedSha256!==pin.compressedSha||sha(compressed)!==pin.compressedSha||report.resultFile!==`${base}${mode}-result.json`||report.resultSha256!==pin.resultSha||sha(resultRaw)!==pin.resultSha)throw new Error();
      const raw=gunzipSync(compressed,{maxOutputLength:2*1024*1024}),observation=parseColorNodeObservation(raw);if(sha(raw)!==pin.rawSha||report.nodesObservationSha256!==pin.rawSha||!same(observation,mode==='color'?expectedColored:baseline)||report.richObservationSha256!==richSha||report.extraObservationSha256!==extraSha)throw new Error();
      for(const[family,original]of [['rich',richRaw],['extra',extraRaw]]){const file=`${base}${mode}-${family}.json.gz`;if(report[`${family}ObservationFile`]!==file)throw new Error();const stored=read(file);if(sha(stored)!==report[`${family}CompressedSha256`]||!gunzipSync(stored,{maxOutputLength:2*1024*1024}).equals(original))throw new Error();}
      const expectedResult={schemaVersion:1,operation:'resolve-color-node-challenge',requestId:pin.requestId,mode,experimental:true,readOnly:false,safeToApply:false,projectId:baseline.snapshot.project_id,targetItemId:target,nodeIndex:1,color:pin.color,itemCount:50};if(!same(JSON.parse(resultRaw),expectedResult))throw new Error();
      const baselineHashes={rich:richSha,extra:extraSha,nodes:baselineSha},currentHashes={...baselineHashes,nodes:mode==='color'?baselineSha:coloredSha};
      if(!same(report.baselineHashes,baselineHashes)||!same(report.sourceObservationHashes,currentHashes)||!same(report.backupSourceBinding,{archiveSha256:pin.backupSha,sourceHashes:currentHashes,association:'fresh-export-host-receipt-not-native-semantic-equivalence'}))throw new Error();
      for(const[field,digest,size]of [['backup',pin.backupSha,pin.backupSize],['postStateBackup',pin.postSha,pin.postSize]])if(!same(report[field],{schemaVersion:1,sha256:digest,size,mode:0o600,timelineCount:1,archiveVerified:true}))throw new Error();
      if(report.backupSha256!==pin.backupSha||report.completionMarkerVerified!==true||report.completionMarkerSha256!==sha(Buffer.from(`FRAMELINE_COLOR_NODE_CHALLENGE_COMPLETE_V1:${pin.requestId}\n`))||report.startedMarkerSha256!==sha(Buffer.from(JSON.stringify({schemaVersion:1,operation:'color-node-challenge-started',id:pin.requestId,mode})+'\n'))||report.installedScriptRemoved!==true||report.installedSourceVerifiedBeforeRemoval!==true||report.privateEvidenceCopyRetained!==true)throw new Error();
      if(report.startedMarkerFile!==`${base}${mode}-started.json`||report.completionMarkerFile!==`${base}${mode}-complete.txt`||sha(read(report.startedMarkerFile))!==report.startedMarkerSha256||sha(read(report.completionMarkerFile))!==report.completionMarkerSha256)throw new Error();
      if(Object.keys(report.sourceHashes).sort().join(',')!==[...sources].sort().join(',')||Object.keys(report.validatorHashes).sort().join(',')!==[...validators].sort().join(','))throw new Error();
      for(const file of sources)if(sha(read(file))!==report.sourceHashes[file])throw new Error();for(const file of validators)if(sha(read(file))!==report.validatorHashes[file])throw new Error();
      if(report.readerSource!=='phase-0/prepare-color-node-challenge.js'||sha(read(report.readerSource))!==report.readerSourceSha256||report.referenceSha256!=='2a6c156fcba727b73e16fdc21b90e77db9b914c08c5bf5b53b584380a972f8d7')throw new Error();
      reports[mode]=report;observations[mode]={raw,observation};
    }
    if(reports.color.predecessor!==null||!same(reports.restore.predecessor,{requestId:fixtures.color.requestId,sourceSha256:fixtures.color.sourceSha,sourceHashes:{rich:richSha,extra:extraSha,nodes:coloredSha},backupSha256:fixtures.color.postSha})||!same(reports.restore.backup,reports.color.postStateBackup)||!same(reports.color.sourceHashes,reports.restore.sourceHashes)||!observations.restore.raw.equals(baselineRaw))throw new Error();
    const diff=compareColorNodeObservations(baselineRaw,observations.color.raw);if(diff.snapshotChanges.length||diff.slotChanges.length!==1||diff.slotChanges[0].itemId!==target||diff.slotChanges[0].before.count!==1||diff.slotChanges[0].after.count!==1)throw new Error();
    return{schemaVersion:1,readOnly:true,safeToApply:false,initialRead:initial,rawNativeResultProofRecomputed:true,cosmeticNodeColorChallengePassed:true,sameNodeCountsRetained:true,exactNodeObservationRestored:true,richAndSevenFieldObservationsUnchanged:true,richPropertyValues:1600,itemCount:50,trackCount:5,
      sourceHashes:reports.color.sourceHashes,nodeObservationHashes:{before:baselineSha,colored:coloredSha,restored:baselineSha},nativeArchiveReceiptsPinned:true,nativeArchivesRecomputed:false,archiveSourcesPrivate:true,allThreeInstalledScriptsRemoved:true,
      persistentNodeIdentityProven:false,completeEnumerationProven:false,gradeParameterPreservationProven:false,losslessRoundTripProven:false,
      limitations:['The changed field is cosmetic node UI color, not image-grading parameters.','Index1 is unambiguous only in the guarded single-node target source; no persistent node identity is established.','All50 tool readings remain unavailable in both passes; topology, grading parameters, additional layers and full graph contents remain unobserved.','Native archive hashes/metadata are pinned host-verification receipts; archive bytes and exact generated sources remain private.','An incomplete host read while the same invocation is publishing is not a completed outcome or known failure; it must not trigger command replay.']};
  }catch{throw new Error('invalid-color-node-challenge-evidence');}
}
module.exports={auditColorNodeChallengeEvidence};
