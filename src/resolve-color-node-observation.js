'use strict';
const {createHash}=require('node:crypto');
const {validateResolveSnapshot}=require('./resolve-snapshot-validator');
const {normalizeResolveSnapshot}=require('./resolve-snapshot-normalizer');
const {compareResolveManifests}=require('./resolve-id-diff');
const colors=new Set(['','Orange','Apricot','Yellow','Lime','Olive','Green','Teal','Navy','Blue','Purple','Violet','Pink','Tan','Beige','Brown','Chocolate']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const sha=value=>createHash('sha256').update(value).digest('hex');
function fail(){throw new Error('invalid-color-node-observation');}
function plain(value,depth=0){
  if(value===null||typeof value!=='object')return;
  if(depth>40||![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)))fail();
  if(Array.isArray(value)&&Reflect.ownKeys(value).length!==value.length+1)fail();
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!Object.hasOwn(d,'value')||(!d.enumerable&&key!=='length'))fail();plain(d.value,depth+1);}
}
function exact(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))fail();}
function count(value,max){if(!Number.isSafeInteger(value)||value<0||value>max)fail();}
function read(value,kind){
  exact(value,['status','value']);
  if(value.status==='unavailable'){if(value.value!==null)fail();return;}
  if(value.status!=='captured')fail();
  if(kind==='tools'){
    if(!Array.isArray(value.value)||value.value.length>128||value.value.some(tool=>typeof tool!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(tool)))fail();
  }else if(kind==='color'){if(!colors.has(value.value))fail();}
  else if(!Number.isSafeInteger(value.value))fail();
}
function validateColorNodeObservation(observation){
  plain(observation);
  exact(observation,['schemaVersion','operation','readOnly','safeToApply','snapshot','activeTimelineId','capturePage','items','capturePasses','representedStateUnchangedAcrossReads','graphScope','graphReadPolicy','nodeIdentity','topologyObserved','persistentNodeIdsObserved','completeGraphObserved']);
  if(observation.schemaVersion!==1||observation.operation!=='resolve-color-node-observation'||observation.readOnly!==true||observation.safeToApply!==false||observation.capturePasses!==2||observation.representedStateUnchangedAcrossReads!==true||observation.graphScope!=='first-layer-node-slots'||observation.graphReadPolicy!=='color-page-only'||observation.nodeIdentity!=='capture-local-one-based-index'||observation.topologyObserved!==false||observation.persistentNodeIdsObserved!==false||observation.completeGraphObserved!==false||![null,'media','photo','cut','edit','fusion','color','fairlight','deliver'].includes(observation.capturePage))fail();
  validateResolveSnapshot(observation.snapshot);
  if(observation.snapshot.timelines.length>20||observation.snapshot.timelines.reduce((n,t)=>n+t.tracks.length,0)>200||!Array.isArray(observation.items)||observation.items.length>200)fail();
  if(observation.activeTimelineId!==null&&!observation.snapshot.timelines.some(t=>t.id===observation.activeTimelineId))fail();
  const expected=new Set(observation.snapshot.timelines.flatMap(t=>t.items.map(i=>JSON.stringify([t.id,i.id]))));
  if(expected.size!==observation.items.length)fail();
  let total=0;
  for(const item of observation.items){
    exact(item,['timelineId','itemId','graph']);if(!expected.delete(JSON.stringify([item.timelineId,item.itemId])))fail();
    const graph=item.graph;exact(graph,['status','count','nodes']);
    if(graph.status==='unavailable'){if(graph.count!==null||graph.nodes!==null)fail();continue;}
    if(graph.status!=='captured'||observation.capturePage!=='color')fail();count(graph.count,256);
    if(!Array.isArray(graph.nodes)||graph.nodes.length!==graph.count||(total+=graph.count)>2048)fail();
    graph.nodes.forEach((node,index)=>{exact(node,['index','tools','color','cacheMode']);if(node.index!==index+1)fail();read(node.tools,'tools');read(node.color,'color');read(node.cacheMode,'cache');});
  }
  return observation;
}
function parseColorNodeObservation(bytes){if((!Buffer.isBuffer(bytes)&&typeof bytes!=='string')||Buffer.byteLength(bytes)>2*1024*1024)fail();return validateColorNodeObservation(JSON.parse(bytes.toString('utf8')));}
function describeColorNodeCoverage(observation){
  validateColorNodeObservation(observation);const graphs=observation.items.filter(i=>i.graph.status==='captured'),nodes=graphs.flatMap(i=>i.graph.nodes);
  return {itemCount:observation.items.length,capturedGraphs:graphs.length,unavailableGraphs:observation.items.length-graphs.length,nonemptyGraphs:graphs.filter(i=>i.graph.count>0).length,nodeSlots:nodes.length,
    fields:Object.fromEntries(['tools','color','cacheMode'].map(field=>[field,{captured:nodes.filter(n=>n[field].status==='captured').length,unavailable:nodes.filter(n=>n[field].status==='unavailable').length}])),
    nodeSlotsWithNonemptyTools:nodes.filter(n=>n.tools.status==='captured'&&n.tools.value.length>0).length,
    topologyObserved:false,persistentNodeIdsObserved:false,completeGraphObserved:false};
}
function compareColorNodeObservations(beforeBytes,afterBytes){
  const before=parseColorNodeObservation(beforeBytes),after=parseColorNodeObservation(afterBytes);
  if(before.snapshot.project_id!==after.snapshot.project_id)throw new Error('color-node-project-mismatch');
  const key=item=>JSON.stringify([item.timelineId,item.itemId]);const a=new Map(before.items.map(i=>[key(i),i])),b=new Map(after.items.map(i=>[key(i),i]));const slotChanges=[];
  for(const identity of [...new Set([...a.keys(),...b.keys()])].sort()){
    const old=a.get(identity),next=b.get(identity),ref=next||old;
    if(!same(old?.graph??null,next?.graph??null))slotChanges.push({timelineId:ref.timelineId,itemId:ref.itemId,before:old?.graph??null,after:next?.graph??null});
  }
  return {schemaVersion:1,readOnly:true,safeToApply:false,sourceHashes:{before:sha(beforeBytes),after:sha(afterBytes)},snapshotChanges:compareResolveManifests(normalizeResolveSnapshot(before.snapshot),normalizeResolveSnapshot(after.snapshot)).changes,
    slotChanges,activeTimelineChange:before.activeTimelineId===after.activeTimelineId?null:{before:before.activeTimelineId,after:after.activeTimelineId},capturePageChange:before.capturePage===after.capturePage?null:{before:before.capturePage,after:after.capturePage},
    beforeCoverage:describeColorNodeCoverage(before),afterCoverage:describeColorNodeCoverage(after),persistentNodeIdentityProven:false,completeEnumerationProven:false,losslessRoundTripProven:false,
    limitations:['Node positions are capture-local slots, not persistent identities or graph connections.','Returned tool tokens are observed strings, not complete typed tool instances or parameters.','Missing reads remain unavailable; an empty tool list is a captured empty list.','Only the first clip color layer is read on Color; group/timeline/multiple-layer graphs and Fusion contents remain unobserved.','Two matching reads and schema-3 guards do not establish atomicity, absence of getter side effects, or native preservation.']};
}
module.exports={validateColorNodeObservation,parseColorNodeObservation,describeColorNodeCoverage,compareColorNodeObservations};
