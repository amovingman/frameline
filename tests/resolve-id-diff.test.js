const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareResolveManifests, validateResolveIdManifest } = require('../src/resolve-id-diff');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
function manifest() {
  return {schemaVersion:1,readOnly:true,projectId:'project',resolveVersion:'21.1.2.10',timelines:[{
    id:'timeline',name:'Edit',startFrame:0,tracks:[{type:'video',index:1,name:'V1'},{type:'video',index:2,name:'V2'}],
    items:['a','b'].map(id=>({id,type:'video',name:'Same name',trackType:'video',trackIndex:1,startFrame:0,endFrame:10,sourceStartFrame:0,sourceEndFrame:10,mediaPoolId:'media',linkedItemIds:[],effectCounts:{fusion:0,ofx:0,audio:0}}))
  }]};
}
test('retained IDs report track, fields, links and effects without mutation',()=>{
  const before=manifest(),after=structuredClone(before);
  Object.assign(after.timelines[0].items[0],{trackIndex:2,startFrame:5,linkedItemIds:['b'],effectCounts:{fusion:1,ofx:2,audio:0}});
  const snapshot=JSON.stringify([before,after]);
  const result=compareResolveManifests(before,after);
  assert.equal(result.safeToApply,false);
  assert.equal(result.readOnly,true);
  assert.equal(result.trackIdentityStatus,'index-only');
  assert.deepEqual(result.changes.map(c=>[c.kind,c.field]),[['item-moved','track'],['item-changed','startFrame'],['links-changed','linkedItemIds'],['effects-changed','fusion'],['effects-changed','ofx']]);
  assert.equal(JSON.stringify([before,after]),snapshot);
  result.changes[0].after.index=99;
  assert.equal(after.timelines[0].items[0].trackIndex,2);
});
test('never infers identity from matching names and positions',()=>{
  const before=manifest(),after=structuredClone(before);
  after.timelines[0].items[0].id='replacement';
  assert.deepEqual(compareResolveManifests(before,after).changes.map(c=>c.kind),['item-deleted','item-added']);
});
test('ordering of timelines, tracks, items and links does not affect output',()=>{
  const before=manifest();
  before.timelines[0].items[0].linkedItemIds=['b'];
  const after=structuredClone(before);
  after.timelines[0].items[0].name='Renamed';
  const expected=compareResolveManifests(before,after);
  for(const input of [before,after]) {
    input.timelines[0].items.reverse();
    input.timelines[0].tracks.reverse();
    input.timelines[0].items.find(i=>i.id==='a').linkedItemIds.reverse();
  }
  assert.deepEqual(compareResolveManifests(before,after),expected);
});
test('timeline and track additions, deletions and metadata changes are explicit',()=>{
  const before=manifest(),after=manifest();
  after.timelines[0].name='Renamed';
  after.timelines[0].tracks[0].name='Main';
  after.timelines[0].tracks.pop();
  after.timelines.push({...structuredClone(after.timelines[0]),id:'new'});
  assert.deepEqual(compareResolveManifests(before,after).changes.map(c=>c.kind),['timeline-added','timeline-changed','track-changed','track-deleted']);
  assert.ok(compareResolveManifests(after,before).changes.some(c=>c.kind==='timeline-deleted'));
});
test('refuses incompatible or ambiguous identity and malformed inputs',()=>{
  const differentProject=manifest();differentProject.projectId='other';
  assert.throws(()=>compareResolveManifests(manifest(),differentProject),{code:'incompatible-resolve-manifests'});
  const differentVersion=manifest();differentVersion.resolveVersion='21.1.2.11';
  assert.throws(()=>compareResolveManifests(manifest(),differentVersion),{code:'invalid-resolve-manifest'});
  for(const mutate of [m=>m.timelines.push(structuredClone(m.timelines[0])),m=>m.timelines[0].items.push(structuredClone(m.timelines[0].items[0])),m=>m.timelines[0].items[0].id='',m=>m.timelines[0].tracks.push({...m.timelines[0].tracks[0]}),m=>m.timelines[0].items[0].linkedItemIds=['b','b'],m=>m.readOnly=false]) {
    const changed=manifest();mutate(changed);
    assert.throws(()=>validateResolveIdManifest(changed),{code:'invalid-resolve-manifest'});
  }
  const unsafe=manifest(); unsafe.timelines[0].items[0].id='/private/secret';
  assert.throws(()=>validateResolveIdManifest(unsafe), error=>error.code==='invalid-resolve-manifest' && !error.message.includes('secret'));
});
test('paired live Free snapshots retain the moved clip ID',()=>{
  const fixture=name=>normalizeResolveSnapshot(JSON.parse(fs.readFileSync(path.join(__dirname,'../phase-0/resolve-xml-proof',name),'utf8')));
  const result=compareResolveManifests(fixture('live-mapping-before-schema3.json'),fixture('live-mapping-after-schema3.json'));
  assert.deepEqual(result.changes.map(change=>[change.kind,change.field,change.before,change.after]),[
    ['item-changed','startFrame',457,600],
    ['item-changed','endFrame',554,697]
  ]);
  assert.equal(result.changes[0].itemId,result.changes[1].itemId);
  assert.equal(result.safeToApply,false);
});
