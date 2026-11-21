'use strict';
// The generic mutation harness can export stale saved database graphs before
// SaveProject. Only its explicitly saved/reopened endpoint is accepted here.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path');
const{readInput}=require('./integration-input');
const{renderPerturb,planPerturb}=require('./prepare-native-blind-perturb');
const{readChallenge}=require('./prepare-native-blind-challenge');
const{readCapture}=require('./prepare-native-blind-capture');
const{readNativeLocationGraph,bindNativeTrackLocations,identityFacts,json,sha}=require('./native-track-location-binding');
const ROOT=path.resolve(__dirname,'..');
const SOURCE_FILES=['phase-0/prepare-native-blind-perturb.js','phase-0/prepare-native-blind-capture.js','phase-0/prepare-native-blind-challenge.js',
 'phase-0/native-track-location-binding.js','phase-0/resolve-native-location-graph.py','phase-0/resolve-native-track-identity.py','phase-0/compare-native-resolve-exports.py',
 'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
function verifyEndpointSourceHashes(sourceHashes,read=readInput){
 if(!sourceHashes||typeof sourceHashes!=='object'||Array.isArray(sourceHashes)||Object.keys(sourceHashes).sort().join(',')!==[...SOURCE_FILES].sort().join(','))throw new Error('saved-endpoint-source-receipt-incomplete');
 for(const file of SOURCE_FILES)if(!/^[a-f0-9]{64}$/.test(sourceHashes[file])||sha(read(path.join(ROOT,file)))!==sourceHashes[file])throw new Error('saved-endpoint-transitive-source-changed');
 return true;
}

function verifySavedReplacement(before,after,observation){
 const left=bindNativeTrackLocations(before,observation),right=bindNativeTrackLocations(after,observation);
 if(left.projectId!==right.projectId||left.timelines.length!==1||right.timelines.length!==1
  ||left.timelines[0].timelineId!==right.timelines[0].timelineId||left.timelines[0].nativeSequenceId!==right.timelines[0].nativeSequenceId
  ||left.timelines[0].nativeContainerId!==right.timelines[0].nativeContainerId)throw new Error('saved-endpoint-namespace-differs');
 const old=new Map(left.timelines[0].bindings.map(row=>[row.nativeTrackId,row])),next=new Map(right.timelines[0].bindings.map(row=>[row.nativeTrackId,row]));
 const removed=[...old.keys()].filter(id=>!next.has(id)),added=[...next.keys()].filter(id=>!old.has(id));
 if(removed.length!==1||added.length!==1)throw new Error('saved-endpoint-replacement-differs');
 const a=old.get(removed[0]),b=next.get(added[0]);
 if(a.type!=='video'||a.index!==4||a.itemCount!==0||b.type!=='video'||b.index!==4||b.itemCount!==0)throw new Error('saved-endpoint-replaced-nonempty-or-other-location');
 for(const[id,row]of old)if(next.has(id)&&json(row)!==json(next.get(id)))throw new Error('saved-endpoint-retained-binding-differs');
 return{removedTrackId:removed[0],addedTrackId:added[0],retainedTrackCount:old.size-1,sameSlotSameNameEmptyReplacementVerified:true,allItemUuidParentageUnchanged:true};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-saved-endpoint-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function readNativeBlindSavedEndpoint(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.schemaVersion!==1||record.operation!=='prepare-native-blind-perturb'||record.stageOperation!=='recreate-empty-video-4'||record.directory!==directory||!/^[a-f0-9]{32}$/.test(record.probeId)
  ||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory||record.sourcePath!==path.join(directory,`Frameline Blind Perturb ${record.probeId.slice(0,12)}.lua`)
  ||record.backupPath!==path.join(directory,'verified-baseline.drp')||record.resultPath!==path.join(directory,'perturb-result.json')||record.markerPath!==path.join(directory,'perturb-complete.txt')||record.startedPath!==path.join(directory,'perturb-started.txt')
  ||json(record.exports)!==json(Object.fromEntries(['before','appended','deleted','after'].map(key=>[key,path.join(directory,'stage-'+key+'.drp')]))))throw new Error('invalid-saved-endpoint-record');
 const prior=await readChallenge(record.previousChallenge),plan=planPerturb(prior.observations.restored,record.stageOperation,record.probeId),source=await owned(record.sourcePath);
 if(prior.status!=='restored'||json(plan)!==json(record.plan)||json(record.before)!==json(plan.before)||json(plan.before)!==json(plan.after)||record.projectId!==prior.projectId
  ||sha(source)!==record.sourceSha256||source.toString()!==await renderPerturb(record)||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==prior.graphs.restored.archive.sha256
  ||json(JSON.parse(await owned(path.join(directory,'preparation.json'))))!==json(record.captureRecord))throw new Error('saved-endpoint-source-changed');
 verifyEndpointSourceHashes(record.sourceHashes);
 if((await owned(record.markerPath)).toString()!==`FRAMELINE_BLIND_PERTURB_COMPLETE:${record.probeId}\n`||(await owned(record.startedPath)).toString()!==`FRAMELINE_BLIND_PERTURB_STARTED:${record.probeId}\n`)throw new Error('saved-endpoint-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);
 if(result.schemaVersion!==1||result.operation!=='resolve-native-blind-perturb'||result.status!=='ready-for-capture'||result.stage!=='ready-for-capture'||result.stageOperation!==record.stageOperation||result.probeId!==record.probeId
  ||result.safeToApply!==false||result.ordinaryApplySupported!==false||result.captureSourceSha256!==record.captureRecord.sourceSha256||json(result.before)!==json(plan.before)||json(result.after)!==json(plan.after))throw new Error('saved-endpoint-result-differs');
 const graphs={};for(const[key,filename]of Object.entries(record.exports)){await owned(filename);graphs[key]=readNativeLocationGraph(filename);}
 if(json(identityFacts(graphs.before))!==json(identityFacts(prior.graphs.restored)))throw new Error('saved-endpoint-native-before-differs');
 const delta=verifySavedReplacement(graphs.before,graphs.after,plan.after),capture=await readCapture(path.join(directory,'preparation.json'));
 if(json(capture.observations[0])!==json(plan.after)||json(identityFacts(capture.graphs[0]))!==json(identityFacts(graphs.after))||!capture.apiWitnessAssessment.requiredPopulatedKindsCapturedAndAgree)throw new Error('saved-endpoint-capture-differs');
 const intermediateExports=Object.fromEntries(['deleted','appended'].map(key=>[key,{archive:graphs[key].archive,
  sameIdentityGraphAsBeforeSave:json(identityFacts(graphs[key]))===json(identityFacts(graphs.before)),sameIdentityGraphAsFinalSavedEndpoint:json(identityFacts(graphs[key]))===json(identityFacts(graphs.after)),
  nativeTrackCount:graphs[key].timelines.reduce((n,t)=>n+t.tracks.length,0),acceptedAsObservationOfUnsavedMutation:false}]));
 return{schemaVersion:1,operation:'native-blind-saved-endpoint-receipt',status:'captured',projectId:record.projectId,resultSha256:sha(raw),resultBytes:raw.length,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,
  saveReopenVerified:true,savedEndpointOnly:true,intermediateExportsUsedForMutationProof:false,requiresSavedReopenedCheckpointForNativeLocationBinding:true,intermediateExports,...delta,graphs,beforeObservation:plan.before,afterObservation:plan.after,capture,
  sourceAndResultVerified:true,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module)readNativeBlindSavedEndpoint(process.argv[2]).then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{process.stderr.write('native-blind-saved-endpoint-failed:'+e.message+'\n');process.exitCode=1;});
module.exports={verifySavedReplacement,verifyEndpointSourceHashes,readNativeBlindSavedEndpoint};
