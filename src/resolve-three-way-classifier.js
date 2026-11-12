// Read-only classification of normalized API observations. This is never an apply plan.
const { validateResolveIdManifest } = require('./resolve-id-diff');
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ITEM_FIELDS = ['type', 'name', 'startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame', 'mediaPoolId'];
const tracks = timeline => [...timeline.tracks].sort((a,b) => cmp(a.type,b.type) || a.index-b.index).map(t => ({type:t.type,index:t.index,name:t.name}));
function item(value) {
  return {id:value.id,track:{type:value.trackType,index:value.trackIndex},
    ...Object.fromEntries(ITEM_FIELDS.map(field => [field,value[field]])),
    linkedItemIds:[...value.linkedItemIds].sort(cmp),
    ...Object.fromEntries(['fusion','ofx','audio'].map(field => [`effectCounts.${field}`,value.effectCounts[field]]))};
}
function timeline(value) {
  return {id:value.id,name:value.name,startFrame:value.startFrame,tracks:tracks(value),items:value.items.map(item).sort((a,b)=>cmp(a.id,b.id))};
}
function classifyResolveThreeWay(base, local, incoming) {
  for (const manifest of [base,local,incoming]) validateResolveIdManifest(manifest);
  if ([local,incoming].some(value => value.projectId !== base.projectId || value.resolveVersion !== base.resolveVersion)) {
    const error = new Error('Resolve manifests must have the same project ID and Resolve version');
    error.code = 'incompatible-resolve-manifests';
    throw error;
  }
  const decisions = [];
  function decide(timelineId,itemId,field,b,l,i) {
    if (same(b,l) && same(b,i)) return;
    const status = same(l,i) ? 'already-applied' : same(b,l) ? 'incoming-only' : same(b,i) ? 'local-only' : 'conflict';
    decisions.push({timelineId,itemId,field,status,base:b,local:l,incoming:i});
  }
  function entities(lists, canonical, visit, onPresence) {
    const maps = lists.map(list => new Map(list.map(value => [value.id,value])));
    const ids = [...new Set(maps.flatMap(map => [...map.keys()]))].sort(cmp);
    for (const id of ids) {
      const values = maps.map(map => map.get(id));
      // Any absence is an entity-level decision, so edits cannot disappear behind a deletion.
      if (values.some(value => !value)) onPresence(id,...values.map(value => value ? canonical(value) : null));
      else visit(id,...values);
    }
  }
  entities([base.timelines,local.timelines,incoming.timelines],timeline,(timelineId,b,l,i) => {
    for (const field of ['name','startFrame']) decide(timelineId,null,field,b[field],l[field],i[field]);
    decide(timelineId,null,'tracks',tracks(b),tracks(l),tracks(i));
    entities([b.items,l.items,i.items],item,(itemId,bv,lv,iv) => {
      const [bc,lc,ic] = [bv,lv,iv].map(item);
      for (const field of Object.keys(bc).filter(field=>field!=='id')) decide(timelineId,itemId,field,bc[field],lc[field],ic[field]);
    },(itemId,bv,lv,iv) => decide(timelineId,itemId,'existence',bv,lv,iv));
  },(timelineId,b,l,i) => decide(timelineId,null,'existence',b,l,i));
  decisions.sort((a,b) => cmp(a.timelineId,b.timelineId) || cmp(a.itemId || '',b.itemId || '') || cmp(a.field,b.field));
  return JSON.parse(JSON.stringify({schemaVersion:1,readOnly:true,safeToApply:false,
    projectId:base.projectId,resolveVersion:base.resolveVersion,trackIdentityStatus:'index-only',
    warnings:['Track identities are index-only; track changes do not establish persistent track identity.'],decisions}));
}
module.exports = { classifyResolveThreeWay };
