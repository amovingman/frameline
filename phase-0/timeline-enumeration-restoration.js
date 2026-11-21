'use strict';
// Construct inventory restoration; replacement transitions remain new objects.
const {assembleActiveTimelineEnumeration,compareActiveTimelineEnumerations}=require('./timeline-enumeration-acceptance');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const json=value=>JSON.stringify(canonical(value));
const need=(value,code)=>{if(!value)throw new Error('enumeration-restoration-'+code);};
const sort=(rows,fields)=>[...rows].sort((a,b)=>json(fields.map(k=>a[k])).localeCompare(json(fields.map(k=>b[k]))));
function requireLogicalEnumerationRestoration(initial,changed,restored){
 const a=assembleActiveTimelineEnumeration(initial),b=assembleActiveTimelineEnumeration(changed),c=assembleActiveTimelineEnumeration(restored),diff=compareActiveTimelineEnumerations(initial,restored);
 need(a.projectId===b.projectId&&a.projectId===c.projectId,'project');
 for(const family of ['timelines','tracks','effects','links'])need(!diff[family].added.length&&!diff[family].removed.length&&!diff[family].changed.length,'inventory-'+family);
 need(!diff.items.changed.length&&diff.items.added.length===1&&diff.items.removed.length===1&&diff.items.added[0].type==='transition'&&diff.items.removed[0].type==='transition','replacement-scope');
 const old=diff.items.removed[0],fresh=diff.items.added[0];
 need(json({...old,id:null})===json({...fresh,id:null})&&fresh.id!==old.id,'logical-transition');
 const historical=new Set([...initial.observations,...changed.observations].flatMap(d=>d.timelines.value.flatMap(t=>t.trackGroups.flatMap(g=>g.tracks.value.flatMap(tr=>tr.items.value.map(i=>i.id))))));
 need(!historical.has(fresh.id),'transition-history-reuse');
 const withoutTransitions=rich=>{rich=structuredClone(rich);for(const timeline of rich.snapshot.timelines)timeline.items=sort(timeline.items.filter(i=>i.type!=='transition'),['id']);const ids=new Set(rich.snapshot.timelines.flatMap(t=>t.items.map(i=>json([t.id,i.id]))));rich.items=sort(rich.items.filter(i=>ids.has(json([i.timelineId,i.itemId]))),['timelineId','itemId']);return rich;};
 for(const doc of initial.observations){const owner=doc.activeTimelineId.value,after=restored.observations.find(v=>v.activeTimelineId.value===owner);need(after&&json(withoutTransitions(doc.richContext.value))===json(withoutTransitions(after.richContext.value)),'ordinary-owner-rich-state');}
 const nativeFacts=input=>input.nativeInventories[0].timelines.map(t=>({...t,tracks:t.tracks.map(tr=>({...tr,items:sort(tr.items.filter(i=>i.kind!=='transition').map(({opaqueEffectPayload,opaqueLinkSync,...item})=>item),['itemId'])}))}));
 need(json(nativeFacts(initial))===json(nativeFacts(restored)),'native-ordinary-parentage');
 const transitions=input=>input.observations.flatMap(d=>d.richContext.value.snapshot.timelines.filter(t=>t.id===d.activeTimelineId.value).flatMap(t=>t.items.filter(i=>i.type==='transition').map(i=>({timelineId:t.id,...i,id:null}))));
 need(json(sort(transitions(initial),['timelineId','track_type','track_index','start_frame']))===json(sort(transitions(restored),['timelineId','track_type','track_index','start_frame'])),'transition-placement');
 const transitionMetadata=input=>input.observations.flatMap(doc=>{const rich=doc.richContext.value,owner=doc.activeTimelineId.value,ids=new Set(rich.snapshot.timelines.find(t=>t.id===owner).items.filter(i=>i.type==='transition').map(i=>i.id));return rich.items.filter(i=>i.timelineId===owner&&ids.has(i.itemId)).map(({itemId,...row})=>row);});
 need(json(sort(transitionMetadata(initial),['timelineId']))===json(sort(transitionMetadata(restored),['timelineId'])),'transition-metadata');
 return {schemaVersion:1,readOnly:true,logicalConstructRestorationVerified:true,restoredTimelineCount:c.timelineCount,restoredTrackCount:c.trackCount,restoredItemCount:c.itemCount,restoredEffectSlotCount:c.effectSlotCount,restoredLinkedEdgeCount:c.linkedEdgeCount,ordinaryApiItemIdsRetained:true,ordinaryOwnerRepresentedStateRestored:true,ordinaryNativeParentageRestored:true,logicalTransitionMetadataRestored:true,replacementTransition:{timelineId:old.timelineId,originalItemId:old.id,restoredItemId:fresh.id,freshAgainstAllEarlierCases:true},originalTransitionIdentityRestored:false,persistentEffectIdentityProven:false,effectParametersCompared:false,fullNativePreservationProven:false,safeToApply:false,ordinaryApplySupported:false};
}
module.exports={requireLogicalEnumerationRestoration,json};
