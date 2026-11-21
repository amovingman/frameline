'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gunzipSync}=require('node:zlib');
const {readInput}=require('./integration-input');
const {parseColorNodeObservation,describeColorNodeCoverage}=require('../src/resolve-color-node-observation');
const {parseEffectObservation}=require('../src/resolve-effect-observation');
const root=path.resolve(__dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const rawSha256='b165113a00b20a4ba047991933f6db3388e812f56c589250f3932c3f2e92d2e4';
const compressedSha256='d28d59620c4c6eff999fb4ce83ca126578aee0f586e4d520d24a11f4284e6b37';
const resultSha256='1a04aac9d7c9ba93520d92fb4861fadcdbdf1d2315273c1edb613048f654724e';
const sourceFiles=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-color-nodes.lua','src/resolve-property-contract.json','phase-0/resolve-color-node-menu.lua'];
function auditColorNodeEvidence(read=file=>readInput(path.join(root,file))){
  try{
    const receipt=JSON.parse(read('phase-0/color-node-evidence/receipt.json'));
    const compressed=read('phase-0/color-node-evidence/baseline.json.gz'),resultRaw=read('phase-0/color-node-evidence/baseline-result.json');
    if(receipt.schemaVersion!==1||receipt.status!=='complete'||receipt.readOnly!==true||receipt.safeToApply!==false||receipt.newLiveEditorRun!==true
      ||receipt.observationFile!=='phase-0/color-node-evidence/baseline.json.gz'||receipt.resultFile!=='phase-0/color-node-evidence/baseline-result.json'
      ||receipt.observationSha256!==rawSha256||receipt.compressedSha256!==compressedSha256||receipt.resultSha256!==resultSha256
      ||receipt.installedScriptRemoved!==true||receipt.installedSourceVerifiedBeforeRemoval!==true||receipt.privateEvidenceCopyRetained!==true
      ||sha(compressed)!==compressedSha256||sha(resultRaw)!==resultSha256)throw new Error();
    const raw=gunzipSync(compressed,{maxOutputLength:2*1024*1024});if(sha(raw)!==rawSha256)throw new Error();
    const observation=parseColorNodeObservation(raw),coverage=describeColorNodeCoverage(observation),result=JSON.parse(resultRaw);
    if(observation.snapshot.project_id!=='dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff'||observation.snapshot.project_name!=='Frameline Integration Gate Fixture 20261120'
      ||observation.snapshot.resolve_version!=='21.1.2.10'||observation.capturePage!=='color'||observation.items.length!==50
      ||coverage.capturedGraphs!==50||coverage.nodeSlots!==50||coverage.nodeSlotsWithNonemptyTools!==0
      ||!same(coverage.fields,{tools:{captured:0,unavailable:50},color:{captured:50,unavailable:0},cacheMode:{captured:50,unavailable:0}})||!same(coverage,receipt.coverage))throw new Error();
    const richRaw=gunzipSync(read('phase-0/resolve-operation-baseline-observation.json.gz'),{maxOutputLength:2*1024*1024});
    if(sha(richRaw)!=='e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af'||receipt.baselineSha256!==sha(richRaw)||!same(parseEffectObservation(richRaw).snapshot,observation.snapshot))throw new Error();
    if(Object.keys(result).sort().join(',')!=='itemCount,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion'
      ||result.schemaVersion!==1||result.operation!=='resolve-color-node-menu'||result.requestId!=='6e1f78fe0f22104a2f62b69724d672e1'
      ||result.requestId!==receipt.requestId||result.readOnly!==true||result.safeToApply!==false||result.projectId!==observation.snapshot.project_id||result.itemCount!==50||result.observationBytes!==raw.length-1
      ||receipt.completionMarkerVerified!==true||receipt.completionMarkerSha256!==sha(Buffer.from(`FRAMELINE_COLOR_NODE_COMPLETE_V1:${result.requestId}\n`))
      ||receipt.sourceSha256!=='9959ee3c7cc73a5b11177d9aeb315c2108c26be13b093401af438e53209d63ed'||receipt.projectMutationCalls!==0)throw new Error();
    if(Object.keys(receipt.sourceHashes).sort().join(',')!==[...sourceFiles].sort().join(','))throw new Error();
    for(const file of sourceFiles)if(sha(read(file))!==receipt.sourceHashes[file])throw new Error();
    for(const [field,file]of [['hostReaderSource','phase-0/prepare-color-node-observation.js'],['validatorSource','src/resolve-color-node-observation.js']])if(receipt[field]!==file||sha(read(file))!==receipt[`${field}Sha256`])throw new Error();
    if(receipt.referenceSha256!=='2a6c156fcba727b73e16fdc21b90e77db9b914c08c5bf5b53b584380a972f8d7')throw new Error();
    return{schemaVersion:1,readOnly:true,safeToApply:false,rawObservationProofRecomputed:true,observationSha256:rawSha256,projectId:observation.snapshot.project_id,
      coverage,documentedToolsGetterAvailableInThisCapture:false,nodeColorAndCacheReadsCaptured:true,
      sourceHashes:receipt.sourceHashes,exactRenderedSourceRecomputed:false,privateRenderedSourceHashPinned:true,nativeProvenanceAuthenticated:false,
      persistentNodeIdentityProven:false,completeEnumerationProven:false,losslessRoundTripProven:false,projectMutationCalls:0,
      limitations:['All50 tools reads were unavailable; this capture does not distinguish a thrown getter from a nil return.','Only per-slot color and cache mode are observed beyond counts; no tool contents, topology, node UUIDs or complete graphs are established.','Two identical reads and rich baseline guards do not prove opaque native preservation or absence of getter side effects.','Exact generated source and runtime receipts remain private; hashes do not authenticate editor provenance.']};
  }catch{throw new Error('invalid-color-node-live-evidence');}
}
module.exports={auditColorNodeEvidence};
