// Identity-only comparison of normalized Resolve API observations. No write plan is produced.
const ITEM_FIELDS = ['type', 'name', 'startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame', 'mediaPoolId'];
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const copy = value => JSON.parse(JSON.stringify(value));
function invalid() {
  const error = new Error('Invalid Resolve manifest.');
  error.code = 'invalid-resolve-manifest';
  throw error;
}
function id(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\\/\u0000-\u001f\u007f]/u.test(value)) invalid();
}
function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) invalid();
    seen.add(value);
  }
}
function validateResolveIdManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.readOnly !== true) invalid('Expected a read-only Resolve manifest version 1');
  id(manifest.projectId, 'projectId');
  if (manifest.resolveVersion !== '21.1.2.10') invalid();
  if (!Array.isArray(manifest.timelines)) invalid('timelines must be an array');
  unique(manifest.timelines.map(t => t && t.id), 'timeline ID');
  for (const timeline of manifest.timelines) {
    if (!timeline) invalid('Invalid timeline');
    id(timeline.id, 'timeline ID');
    if (typeof timeline.name !== 'string' || /[\\/\u0000-\u001f\u007f]/u.test(timeline.name)
      || !Number.isSafeInteger(timeline.startFrame) || timeline.startFrame < 0) invalid();
    if (!Array.isArray(timeline.tracks) || !Array.isArray(timeline.items)) invalid('Expected timeline tracks and items');
    unique(timeline.tracks.map(t => t && `${t.type}:${t.index}`), 'track identity');
    for (const track of timeline.tracks) {
      if (!track || typeof track.type !== 'string' || !track.type || !Number.isSafeInteger(track.index) || track.index < 1
        || typeof track.name !== 'string' || /[\\/\u0000-\u001f\u007f]/u.test(track.name)) invalid();
    }
    unique(timeline.items.map(item => item && item.id), 'item ID');
    for (const item of timeline.items) {
      if (!item) invalid('Invalid item');
      id(item.id, 'item ID');
      if (!timeline.tracks.some(t => t.type === item.trackType && t.index === item.trackIndex)) invalid('Item references an unknown track');
      for (const field of ['type', 'name']) if (typeof item[field] !== 'string' || /[\\/\u0000-\u001f\u007f]/u.test(item[field])) invalid();
      for (const field of ['startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame']) {
        if (item[field] !== null && (!Number.isSafeInteger(item[field]) || item[field] < 0)) invalid();
      }
      if (item.mediaPoolId !== null) id(item.mediaPoolId, 'mediaPoolId');
      if (!Array.isArray(item.linkedItemIds)) invalid('linkedItemIds must be an array');
      item.linkedItemIds.forEach(value => id(value, 'linked item ID'));
      unique(item.linkedItemIds, 'linked item ID');
      if (item.linkedItemIds.includes(item.id)) invalid();
      for (const field of ['fusion', 'ofx', 'audio']) {
        if (!item.effectCounts || (item.effectCounts[field] !== null && (!Number.isSafeInteger(item.effectCounts[field]) || item.effectCounts[field] < 0))) invalid(`Invalid effect count ${field}`);
      }
    }
    const itemIds = new Set(timeline.items.map(item => item.id));
    if (timeline.items.some(item => item.linkedItemIds.some(link => !itemIds.has(link)))) invalid();
  }
  return manifest;
}
function canonicalItem(item) {
  return { id: item.id, trackType: item.trackType, trackIndex: item.trackIndex,
    ...Object.fromEntries(ITEM_FIELDS.map(field => [field, item[field]])),
    linkedItemIds: [...item.linkedItemIds].sort(cmp),
    effectCounts: Object.fromEntries(['fusion', 'ofx', 'audio'].map(field => [field, item.effectCounts[field]])) };
}
function canonicalTimeline(timeline) {
  return { id: timeline.id, name: timeline.name, startFrame: timeline.startFrame,
    tracks: [...timeline.tracks].sort((a, b) => cmp(a.type, b.type) || a.index - b.index).map(t => ({type:t.type,index:t.index,name:t.name})),
    items: [...timeline.items].sort((a, b) => cmp(a.id, b.id)).map(canonicalItem) };
}
function compareResolveManifests(before, after) {
  validateResolveIdManifest(before);
  validateResolveIdManifest(after);
  if (before.projectId !== after.projectId || before.resolveVersion !== after.resolveVersion) {
    const error = new Error('Resolve manifests must have the same project ID and Resolve version');
    error.code = 'incompatible-resolve-manifests';
    throw error;
  }
  const changes = [];
  function diffEntities(oldList, newList, key, added, deleted, retained) {
    const oldMap = new Map(oldList.map(value => [key(value), value]));
    const newMap = new Map(newList.map(value => [key(value), value]));
    for (const identity of [...new Set([...oldMap.keys(), ...newMap.keys()])].sort(cmp)) {
      const oldValue = oldMap.get(identity), newValue = newMap.get(identity);
      if (!oldValue) added(newValue);
      else if (!newValue) deleted(oldValue);
      else retained(oldValue, newValue);
    }
  }
  diffEntities(before.timelines, after.timelines, t => t.id,
    t => changes.push({kind:'timeline-added',timelineId:t.id,before:null,after:canonicalTimeline(t)}),
    t => changes.push({kind:'timeline-deleted',timelineId:t.id,before:canonicalTimeline(t),after:null}),
    (oldTimeline, newTimeline) => {
      const timelineId = oldTimeline.id;
      const change = (kind, field, oldValue, newValue, extra = {}) => {
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changes.push({kind,timelineId,...extra,field,before:oldValue,after:newValue});
      };
      for (const field of ['name', 'startFrame']) change('timeline-changed',field,oldTimeline[field],newTimeline[field]);
      diffEntities(oldTimeline.tracks,newTimeline.tracks,t=>`${t.type}:${t.index}`,
        t=>changes.push({kind:'track-added',timelineId,before:null,after:{type:t.type,index:t.index,name:t.name}}),
        t=>changes.push({kind:'track-deleted',timelineId,before:{type:t.type,index:t.index,name:t.name},after:null}),
        (a,b)=>change('track-changed','name',a.name,b.name,{trackType:a.type,trackIndex:a.index}));
      diffEntities(oldTimeline.items,newTimeline.items,item=>item.id,
        item=>changes.push({kind:'item-added',timelineId,itemId:item.id,before:null,after:canonicalItem(item)}),
        item=>changes.push({kind:'item-deleted',timelineId,itemId:item.id,before:canonicalItem(item),after:null}),
        (a,b)=>{
          const extra = {itemId:a.id};
          change('item-moved','track',{type:a.trackType,index:a.trackIndex},{type:b.trackType,index:b.trackIndex},extra);
          for (const field of ITEM_FIELDS) change('item-changed',field,a[field],b[field],extra);
          change('links-changed','linkedItemIds',[...a.linkedItemIds].sort(cmp),[...b.linkedItemIds].sort(cmp),extra);
          for (const field of ['fusion','ofx','audio']) change('effects-changed',field,a.effectCounts[field],b.effectCounts[field],extra);
        });
    });
  return copy({schemaVersion:1,readOnly:true,safeToApply:false,trackIdentityStatus:'index-only',projectId:before.projectId,resolveVersion:before.resolveVersion,changes});
}
module.exports = { compareResolveManifests, compareResolveIdManifests: compareResolveManifests, validateResolveIdManifest };
