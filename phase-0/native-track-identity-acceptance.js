'use strict';
// Independent acceptance checks. No editor calls, writes, or prior-UUID locator.
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { bindNativeTrackLocations, joinSynchronizedNativeTracks, json, sha, PROFILE } = require('./native-track-location-binding');
const {requireApiLocationWitnesses}=require('../src/resolve-api-location-observation');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHALLENGE=/^Frameline-TrackProof-([0-9a-f]{32})-(video|audio)-([1-9][0-9]*)$/;
const need=(value,code)=>{if(!value)throw new Error('identity-acceptance-'+code);};
const parsed=value=>parseEffectObservation(JSON.stringify(value));
const flat=binding=>binding.timelines.flatMap(t=>t.bindings.map(row=>({timelineId:t.timelineId,...row})));
const location=row=>`${row.timelineId}:${row.type}:${row.index}`;
const identities=graph=>[graph.projectId,...graph.timelines.flatMap(t=>[t.timelineId,t.nativeSequenceId,t.nativeContainerId,...t.tracks.flatMap(track=>[track.nativeContainerId,track.nativeTrackId])])].filter(value=>typeof value==='string');
const archive=value=>need(value&&/^[a-f0-9]{64}$/.test(value.sha256)&&Number.isSafeInteger(value.size)&&value.size>0,'archive-receipt');
function finiteProfile(graph){need(graph.nativeStructuralProfile===PROFILE&&graph.timelines.every(t=>t.tracks.every(row=>row.nativeFlags===0&&(row.kind==='video'?row.nativeType===0&&row.nativeSubType===0:row.kind==='audio'&&row.nativeType===1&&row.nativeSubType===1))),'unsupported-finite-native-profile');}
function continuityFacts(graph,includeNames=false){return{projectId:graph.projectId,timelines:graph.timelines.map(t=>({timelineId:t.timelineId,nativeSequenceId:t.nativeSequenceId,nativeContainerId:t.nativeContainerId,tracks:t.tracks.map(row=>({nativeTrackId:row.nativeTrackId,nativeContainerId:row.nativeContainerId,kind:row.kind,currentVectorIndex:row.currentVectorIndex,itemIds:row.itemIds,...(includeNames?{nameSha256:row.nameSha256}:{})})).sort((a,b)=>a.nativeTrackId.localeCompare(b.nativeTrackId))})).sort((a,b)=>a.timelineId.localeCompare(b.timelineId))};}

function independentChallengeBindings(graph,input){
 const observation=parsed(input),snapshot=observation.snapshot;
 need(graph.projectId===snapshot.project_id&&graph.timelines.length===snapshot.timelines.length,'challenge-namespace');
 let nonce=null;const bindings=[];
 for(const timeline of snapshot.timelines){const candidates=graph.timelines.filter(t=>t.timelineId===timeline.id);need(candidates.length===1,'challenge-timeline');const native=candidates[0];
  need(native.tracks.length===timeline.tracks.length,'challenge-track-count');
  for(const track of timeline.tracks){const match=CHALLENGE.exec(track.name);need(match&&match[2]===track.type&&Number(match[3])===track.index&&(!nonce||nonce===match[1]),'challenge-name');nonce=match[1];
   // Deliberately no vector ordinal or old binding in this independent witness.
   const found=native.tracks.filter(row=>row.kind===track.type&&row.nameSha256===sha(track.name));need(found.length===1,'challenge-name-ambiguity');
   const itemIds=timeline.items.filter(item=>item.track_type===track.type&&item.track_index===track.index).map(item=>item.id).sort();
   need(json(found[0].itemIds)===json(itemIds),'challenge-item-parentage');bindings.push({timelineId:timeline.id,type:track.type,index:track.index,nativeTrackId:found[0].nativeTrackId,itemCount:itemIds.length});
  }
 }
 need(nonce&&new Set(bindings.map(row=>`${row.timelineId}:${row.nativeTrackId}`)).size===bindings.length,'challenge-collision');
 return {nonce,bindings:bindings.sort((a,b)=>location(a).localeCompare(location(b)))};
}

function loadIndependentIdentityCalibrationGraphs(read){
 const path=require('node:path'),reader=read||require('./integration-input').readInput;
 // This old ledger is an exclusion set for blind acceptance only. The mapper
 // never imports it and never uses an old UUID to locate a fresh object.
 require('./native-track-readonly-join').loadCalibration(reader);
 return ['phase-0/native-track-challenge-live-observation.json',...['append','delete','recreate'].map(label=>`phase-0/native-track-topology-${label}-live-observation.json`)]
  .flatMap(file=>Object.values(JSON.parse(reader(path.join(__dirname,'..',file))).graphs));
}

function requireSupportedIdentityProfile(graph,input,apiLocationWitnesses){
 const observation=parsed(input);finiteProfile(graph);
 need(observation.snapshot.timelines.every(t=>t.tracks.every(track=>['video','audio'].includes(track.type))&&t.items.every(item=>['video','audio'].includes(item.track_type)&&item.type===item.track_type)),'unsupported-nonflat-item');
 const witness=requireApiLocationWitnesses(JSON.stringify(apiLocationWitnesses),{requireKinds:['video','audio']});
 need(json(apiLocationWitnesses.richContext)===json(observation),'api-witness-context');
 const binding=bindNativeTrackLocations(graph,observation);
 return{schemaVersion:1,operation:'supported-native-api-identity-profile',readOnly:true,profile:PROFILE,binding,apiLocationWitnesses:witness,observedIdentityShapeValidated:true,supportedIdentityProfileValidated:false,savedCheckpointRequired:true,currentUnsavedStateBindingProven:false,independentPopulatedApiLocationsVerified:true,captureSynchronizationRequired:true,persistentTrackIdentityEstablishedByThisRead:false,safeToApply:false,ordinaryApplySupported:false};
}

function validateBlindTrackBindingCase({calibrationGraphs,observations,graphs,prediction,predictionSha256,predictionCanonicalSha256,challengePredictionSha256,challengePredictionCanonicalSha256,apiLocationWitnesses,challenged,restored}){
 need(Array.isArray(calibrationGraphs)&&calibrationGraphs.length>0&&challenged&&restored,'case-envelope');
 const actual=joinSynchronizedNativeTracks(observations,graphs),baseline=parsed(observations[0]);
 for(const graph of[...graphs,challenged.graph,restored.graph])finiteProfile(graph);
 need(actual.currentLocationRuleVersion===PROFILE&&actual.priorUuidLedgerRequired===false&&actual.oldWholeGraphEqualityRequired===false&&actual.identityEqualsOrdinal===false,'generic-locator');
 for(const type of['video','audio']){const all=baseline.snapshot.timelines.flatMap(t=>t.tracks.filter(track=>track.type===type).map(track=>({...track,timelineId:t.id,empty:!t.items.some(item=>item.track_type===type&&item.track_index===track.index)})));
  need(baseline.snapshot.timelines.some(t=>t.items.some(item=>item.track_type===type)),'missing-audio-video-item-witness');
  need(all.some(track=>track.empty&&all.filter(other=>other.empty&&other.timelineId===track.timelineId&&other.name===track.name).length>=2),'missing-empty-duplicate-name-tracks');}
 const supported=requireSupportedIdentityProfile(graphs[0],baseline,apiLocationWitnesses),witness=supported.apiLocationWitnesses;
 const oldIds=new Set(calibrationGraphs.flatMap(identities)),newIds=identities(graphs[0]);
 need(newIds.every(id=>UUID.test(id)&&!oldIds.has(id)),'held-out-identities');
 need(json(prediction)===json(actual)&&predictionSha256===sha(json(prediction)+'\n')&&predictionCanonicalSha256===sha(json(prediction))&&challengePredictionSha256===predictionSha256&&challengePredictionCanonicalSha256===predictionCanonicalSha256,'recorded-prediction');
 archive(graphs[0].archive);archive(graphs[1].archive);archive(challenged.graph.archive);archive(restored.graph.archive);
 const independent=independentChallengeBindings(challenged.graph,challenged.observation),predicted=flat(actual).map(({timelineId,type,index,nativeTrackId,itemCount})=>({timelineId,type,index,nativeTrackId,itemCount})).sort((a,b)=>location(a).localeCompare(location(b)));
 need(json(predicted)===json(independent.bindings),'independent-challenge-disagrees');
 // Structural validation is separate from the ordinal-free name witness above.
 bindNativeTrackLocations(challenged.graph,challenged.observation);
 need(json(continuityFacts(graphs[0]))===json(continuityFacts(challenged.graph)),'challenge-identity-or-parentage-drift');
 const challengeState=parsed(challenged.observation),expected=structuredClone(baseline);
 for(const timeline of expected.snapshot.timelines)for(const track of timeline.tracks)track.name=`Frameline-TrackProof-${independent.nonce}-${track.type}-${track.index}`;
 need(json(challengeState)===json(expected),'challenge-unrelated-api-drift');
 need(json(parsed(restored.observation))===json(baseline)&&json(continuityFacts(restored.graph,true))===json(continuityFacts(graphs[0],true)),'restoration');
 const restoredBinding=bindNativeTrackLocations(restored.graph,restored.observation);
 need(json(flat(restoredBinding))===json(flat(actual)),'restored-binding');
 return {schemaVersion:1,operation:'blind-native-track-binding-acceptance',readOnly:true,profile:PROFILE,projectId:actual.projectId,
  timelineCount:actual.timelines.length,trackCount:actual.trackCount,itemCount:actual.itemCount,emptyTrackCount:actual.emptyTrackCount,
  heldOutNativeIdentityCount:new Set(newIds).size,independentChallengeTrackCount:independent.bindings.length,independentNameWitnessIgnoresOrdinals:true,
  recordedPredictionSha256:predictionSha256,recordedPredictionCanonicalSha256:predictionCanonicalSha256,recordedPredictionFormat:'canonical-json-lf',apiLocationWitnessesComplete:true,apiLocationWitnessCount:witness.itemCount,actualFreeBuildWitnessCaptured:witness.freeBuildWitnessCaptured,challengePredictionBindingVerified:true,savedCheckpointEvidenceRequired:true,savedCheckpointEvidenceValidatedByThisFunction:false,currentUnsavedStateBindingProven:false,exactRepresentedRestoration:true,identitiesRetainedAcrossSuppliedChallengeStates:true,
  binding:actual,independentBindings:independent.bindings,safeToApply:false,ordinaryApplySupported:false,
  limitations:['Temporal ordering and save/reopen execution require separately source-bound native harness evidence; this validator checks its supplied prediction binding and state facts.',
   'The empirical location rule is limited to the exact installed Free build and observed normal flat video (Type0/SubType0/Flags0) and mono audio (Type1/SubType1/Flags0) track structures.','This proves object identity evidence, not complete enumeration, opaque preservation, atomic capture or ordinary Apply.']};
}

function selectApiOccurrence(input,{projectId,timelineId,itemId}){
 const snapshot=parsed(input).snapshot;need(snapshot.project_id===projectId,'clip-project-namespace');
 const timelines=snapshot.timelines.filter(t=>t.id===timelineId);need(timelines.length===1,'clip-timeline-namespace');
 const items=timelines[0].items.filter(item=>item.id===itemId);need(items.length===1,'clip-occurrence-namespace');
 return{projectId,timelineId,itemId,item:structuredClone(items[0]),locator:'API-project-timeline-item-UUID',writeAuthorized:false};
}

function validateIdentityPersistenceTransition({before,after,deletedTrackId,recreatedTrackId,movedItemId,renamedItemId,movedTimelineId=null,renamedTimelineId=null}){
 finiteProfile(before.graph);finiteProfile(after.graph);
 const a=parsed(before.observation),b=parsed(after.observation),left=bindNativeTrackLocations(before.graph,a),right=bindNativeTrackLocations(after.graph,b);
 need(left.projectId===right.projectId&&json(left.timelines.map(t=>t.timelineId).sort())===json(right.timelines.map(t=>t.timelineId).sort()),'transition-namespace');
 need(json(left.timelines.map(({timelineId,nativeSequenceId,nativeContainerId})=>({timelineId,nativeSequenceId,nativeContainerId})))===json(right.timelines.map(({timelineId,nativeSequenceId,nativeContainerId})=>({timelineId,nativeSequenceId,nativeContainerId}))),'transition-parent-namespace');
 if(left.timelines.length===1){movedTimelineId??=left.timelines[0].timelineId;renamedTimelineId??=left.timelines[0].timelineId;}need(UUID.test(movedTimelineId||'')&&UUID.test(renamedTimelineId||''),'transition-occurrence-locators');
 const tracks=value=>new Map(flat(value).map(row=>[`${row.timelineId}:${row.nativeTrackId}`,row]));
 const x=tracks(left),y=tracks(right),removed=[...x.keys()].filter(key=>!y.has(key)),added=[...y.keys()].filter(key=>!x.has(key));
 need(removed.length===1&&added.length===1&&x.get(removed[0]).nativeTrackId===deletedTrackId&&y.get(added[0]).nativeTrackId===recreatedTrackId&&deletedTrackId!==recreatedTrackId,'delete-recreate-control');
 need(x.get(removed[0]).itemCount===0&&y.get(added[0]).itemCount===0&&x.get(removed[0]).type===y.get(added[0]).type,'empty-delete-recreate-control');
 const retained=[...x.keys()].filter(key=>y.has(key));let shifted=0;
 for(const key of retained){need(x.get(key).type===y.get(key).type,'retained-track-kind');if(x.get(key).index!==y.get(key).index)shifted++;}
 need(shifted>0,'retained-track-index-shift');
 const items=(observation,binding)=>{const locations=new Map(flat(binding).map(row=>[location(row),row.nativeTrackId]));return new Map(observation.snapshot.timelines.flatMap(t=>t.items.map(item=>[`${t.id}:${item.id}`,{timelineId:t.id,item,parent:locations.get(`${t.id}:${item.track_type}:${item.track_index}`)}])));};
 const oldItems=items(a,left),newItems=items(b,right);need(json([...oldItems.keys()].sort())===json([...newItems.keys()].sort()),'retained-clip-set');
 let moved=0,renamed=0;
 for(const[key,old]of oldItems){const current=newItems.get(key),oldItem=old.item,newItem=current.item;
  if(old.parent!==current.parent){need(oldItem.id===movedItemId&&old.timelineId===movedTimelineId,'unexpected-clip-parent-change');moved++;}
  if(oldItem.name!==newItem.name){need(oldItem.id===renamedItemId&&old.timelineId===renamedTimelineId,'unexpected-clip-rename');renamed++;}
  const maskedOld=structuredClone(oldItem),maskedNew=structuredClone(newItem);for(const value of[maskedOld,maskedNew]){delete value.name;delete value.track_index;if(oldItem.id===movedItemId&&old.timelineId===movedTimelineId){delete value.start_frame;delete value.end_frame;}}
  need(json(maskedOld)===json(maskedNew)&&oldItem.end_frame-oldItem.start_frame===newItem.end_frame-newItem.start_frame,'unrelated-clip-change');
 }
 need(moved===1&&renamed===1,'required-clip-rename-and-move');
 const keyedRichItems=value=>[...value.items].sort((x,y)=>`${x.timelineId}:${x.itemId}`.localeCompare(`${y.timelineId}:${y.itemId}`));
 need(json(keyedRichItems(a))===json(keyedRichItems(b))&&a.activeTimelineId===b.activeTimelineId,'unrelated-rich-item-change');
 return{schemaVersion:1,operation:'native-api-identity-persistence-acceptance',readOnly:true,profile:PROFILE,projectId:left.projectId,retainedClipCount:oldItems.size,renamedClipCount:renamed,movedClipCount:moved,retainedTrackCount:retained.length,retainedTracksWithNewIndex:shifted,removedEmptyTrackId:deletedTrackId,recreatedEmptyTrackId:recreatedTrackId,recreationUsesFreshIdentity:true,identityEqualsNameOrIndex:false,clipWriteLocator:'API-project-timeline-item-UUID',safeToApply:false,ordinaryApplySupported:false};
}
function validateNativeTrackTopologyStage({before,after,operation,expectedRemovedTrackId=null,expectedAddedTrackId=null}){
 need(['append-empty','delete-empty','replace-empty'].includes(operation),'topology-operation');
 finiteProfile(before.graph);finiteProfile(after.graph);
 const a=parsed(before.observation),b=parsed(after.observation),left=bindNativeTrackLocations(before.graph,a),right=bindNativeTrackLocations(after.graph,b);
 const namespace=value=>({projectId:value.projectId,timelines:value.timelines.map(({timelineId,nativeSequenceId,nativeContainerId})=>({timelineId,nativeSequenceId,nativeContainerId}))});
 need(json(namespace(left))===json(namespace(right)),'topology-namespace');
 const rows=value=>new Map(flat(value).map(row=>[`${row.timelineId}:${row.nativeTrackId}`,row]));
 const x=rows(left),y=rows(right),removed=[...x.keys()].filter(k=>!y.has(k)).map(k=>x.get(k)),added=[...y.keys()].filter(k=>!x.has(k)).map(k=>y.get(k));
 need(removed.length===(operation==='append-empty'?0:1)&&added.length===(operation==='delete-empty'?0:1),'topology-id-delta');
 const deleted=removed[0],created=added[0];
 if(deleted)need(deleted.itemCount===0&&deleted.nativeTrackId===expectedRemovedTrackId,'topology-empty-delete');else need(expectedRemovedTrackId===null,'unexpected-topology-delete');
 if(created)need(created.itemCount===0&&created.nativeTrackId===expectedAddedTrackId&&!flat(left).some(row=>row.nativeTrackId===created.nativeTrackId),'topology-fresh-empty-create');else need(expectedAddedTrackId===null,'unexpected-topology-create');
 if(operation==='replace-empty')need(deleted.timelineId===created.timelineId&&deleted.type===created.type&&deleted.index===created.index,'topology-replacement-location');
 if(operation==='append-empty')need(created.index===1+flat(left).filter(row=>row.timelineId===created.timelineId&&row.type===created.type).length,'topology-appended-location');
 let shifted=0;
 for(const[key,old]of x){if(!y.has(key))continue;const current=y.get(key);let expectedIndex=old.index;
  if(operation==='delete-empty'&&old.timelineId===deleted.timelineId&&old.type===deleted.type&&old.index>deleted.index)expectedIndex--;
  need(old.type===current.type&&current.index===expectedIndex,'topology-retained-location');need(json(old.itemIds)===json(current.itemIds),'topology-retained-item-parentage');if(old.index!==current.index)shifted++;
 }
 const clipKeys=observation=>observation.snapshot.timelines.flatMap(t=>t.items.map(item=>`${t.id}:${item.id}`)).sort();
 need(json(clipKeys(a))===json(clipKeys(b)),'topology-clip-identity-set');
 return{schemaVersion:1,operation:'native-track-topology-stage-acceptance',stage:operation,readOnly:true,profile:PROFILE,projectId:left.projectId,removedTrackId:deleted?.nativeTrackId||null,addedTrackId:created?.nativeTrackId||null,retainedTrackCount:[...x.keys()].filter(k=>y.has(k)).length,retainedTracksWithNewIndex:shifted,clipIdentitySetUnchanged:true,allRetainedItemParentageUnchanged:true,safeToApply:false,ordinaryApplySupported:false};
}
function requireNoTrackIdentityResurrection(earlierGraphs,afterGraph,recreatedNativeTrackId){
 need(Array.isArray(earlierGraphs)&&earlierGraphs.length>=2&&UUID.test(recreatedNativeTrackId||''),'aba-evidence');
 finiteProfile(afterGraph);const seen=new Set();
 for(const graph of earlierGraphs){need(graph.projectId===afterGraph.projectId&&json(graph.timelines.map(t=>t.timelineId).sort())===json(afterGraph.timelines.map(t=>t.timelineId).sort()),'aba-namespace');finiteProfile(graph);for(const timeline of graph.timelines)for(const row of timeline.tracks)seen.add(`${timeline.timelineId}:${row.nativeTrackId}`);}
 const rows=afterGraph.timelines.flatMap(t=>t.tracks.filter(row=>row.nativeTrackId===recreatedNativeTrackId).map(row=>({timelineId:t.timelineId,...row})));need(rows.length===1&&!seen.has(`${rows[0].timelineId}:${recreatedNativeTrackId}`),'aba-identity-resurrection');
 return{schemaVersion:1,readOnly:true,projectId:afterGraph.projectId,recreatedNativeTrackId,allEarlierObservedTrackIdentityCount:seen.size,identityReusedFromEarlierCase:false,safeToApply:false};
}
module.exports={requireNoTrackIdentityResurrection,loadIndependentIdentityCalibrationGraphs,requireSupportedIdentityProfile,validateBlindTrackBindingCase,independentChallengeBindings,validateIdentityPersistenceTransition,validateNativeTrackTopologyStage,selectApiOccurrence};
