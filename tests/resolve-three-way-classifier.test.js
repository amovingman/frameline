const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyResolveThreeWay: classify } = require('../src/resolve-three-way-classifier');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
function manifest() {
  return {schemaVersion:1,readOnly:true,projectId:'project',resolveVersion:'21.1.2.10',timelines:[{
    id:'timeline',name:'Edit',startFrame:0,tracks:[{type:'video',index:1,name:'V1'},{type:'video',index:2,name:'V2'}],
    items:['a','b','c'].map(id=>({id,type:'video',name:'Same',trackType:'video',trackIndex:1,startFrame:0,endFrame:10,sourceStartFrame:0,sourceEndFrame:10,mediaPoolId:'media',linkedItemIds:[],effectCounts:{fusion:0,ofx:0,audio:0}}))}]};
}
const clip = m => m.timelines[0].items[0];
test('classifies all four statuses per field and remains read-only',()=>{
  const b=manifest(),l=manifest(),i=manifest();
  clip(i).startFrame=5;clip(l).endFrame=12;
  clip(l).sourceStartFrame=clip(i).sourceStartFrame=2;
  clip(l).sourceEndFrame=8;clip(i).sourceEndFrame=9;
  const before=JSON.stringify([b,l,i]);
  const result=classify(b,l,i);
  assert.deepEqual(result.decisions.map(d=>[d.field,d.status]),[['endFrame','local-only'],['sourceEndFrame','conflict'],['sourceStartFrame','already-applied'],['startFrame','incoming-only']]);
  assert.equal(result.safeToApply,false);assert.equal(result.readOnly,true);
  assert.equal(result.trackIdentityStatus,'index-only');assert.ok(result.warnings.length);
  assert.equal(JSON.stringify([b,l,i]),before);
  assert.deepEqual(classify(b,b,b).decisions,[]);
});
test('compares tracks, source, links and effect counts; canonicalizes ordering',()=>{
  const b=manifest(),l=manifest(),i=manifest();
  Object.assign(clip(i),{trackIndex:2,mediaPoolId:'other',linkedItemIds:['c','b'],effectCounts:{fusion:2,ofx:1,audio:null}});
  const expected=classify(b,l,i);
  assert.deepEqual(expected.decisions.map(d=>d.field),['effectCounts.audio','effectCounts.fusion','effectCounts.ofx','linkedItemIds','mediaPoolId','track']);
  for (const m of [b,l,i]) {m.timelines[0].tracks.reverse();m.timelines[0].items.reverse();}
  i.timelines[0].items.find(v=>v.id==='a').linkedItemIds.reverse();
  assert.deepEqual(classify(b,l,i),expected);
  expected.decisions.find(d=>d.field==='track').incoming.index=99;
  assert.equal(i.timelines[0].items.find(v=>v.id==='a').trackIndex,2);
});
test('additions and deletions compare full entities and never infer IDs from names or position',()=>{
  const b=manifest(),l=manifest(),i=manifest();
  clip(i).id='replacement';
  assert.deepEqual(classify(b,l,i).decisions.map(d=>[d.itemId,d.field,d.status]),[['a','existence','incoming-only'],['replacement','existence','incoming-only']]);
  clip(l).name='edited';
  assert.equal(classify(b,l,i).decisions[0].status,'conflict');
  const deleted=manifest();deleted.timelines[0].items.shift();
  assert.equal(classify(b,deleted,deleted).decisions[0].status,'already-applied');
  const empty=manifest();empty.timelines[0].items=[];
  assert.ok(classify(empty,l,i).decisions.some(d=>d.itemId==='b' && d.status==='already-applied'));
});
test('timeline deletion versus nested edit is a conflict and metadata changes are explicit',()=>{
  const b=manifest(),l=manifest(),i=manifest();
  clip(l).startFrame=3;i.timelines=[];
  const d=classify(b,l,i).decisions[0];
  assert.equal(d.itemId,null);assert.equal(d.field,'existence');assert.equal(d.status,'conflict');
  assert.equal(d.incoming,null);assert.equal(d.local.items[0].startFrame,3);
  const changed=manifest();changed.timelines[0].name='Renamed';changed.timelines[0].tracks[0].name='Main';
  assert.deepEqual(classify(b,b,changed).decisions.map(d=>d.field),['name','tracks']);
});
test('rejects malformed and incompatible observations using existing validator',()=>{
  const other=manifest();other.projectId='other';
  assert.throws(()=>classify(manifest(),manifest(),other),{code:'incompatible-resolve-manifests'});
  for (const mutate of [m=>m.readOnly=false,m=>m.resolveVersion='other',m=>m.timelines[0].items.push(clip(m)),m=>clip(m).linkedItemIds=['missing']]) {
    const bad=manifest();mutate(bad);
    assert.throws(()=>classify(manifest(),bad,manifest()),{code:'invalid-resolve-manifest'});
  }
});
test('paired Free captures classify the retained-ID move as incoming-only',()=>{
  const fixture=name=>normalizeResolveSnapshot(JSON.parse(fs.readFileSync(path.join(__dirname,'../phase-0/resolve-xml-proof',name),'utf8')));
  const base=fixture('live-mapping-before-schema3.json');
  const incoming=fixture('live-mapping-after-schema3.json');
  const result=classify(base,base,incoming);
  assert.deepEqual(result.decisions.map(d=>[d.field,d.status]),[
    ['endFrame','incoming-only'],['startFrame','incoming-only']
  ]);
  assert.equal(result.decisions[0].itemId,result.decisions[1].itemId);
  assert.equal(result.safeToApply,false);
});
test('classifies the complete entity-presence matrix symmetrically for items and timelines',()=>{
  const cases = [
    [false,false,true,'incoming-only'],[false,true,false,'local-only'],
    [false,true,true,'already-applied'],[true,false,false,'already-applied'],
    [true,true,false,'incoming-only'],[true,false,true,'local-only']
  ];
  for (const level of ['item','timeline']) for (const [bp,lp,ip,status] of cases) {
    const values=[bp,lp,ip].map(present=>{
      const m=manifest();
      if (!present) {
        if (level==='timeline') m.timelines=[];
        else m.timelines[0].items.shift();
      }
      return m;
    });
    const result=classify(...values);
    assert.equal(result.decisions.length,1);
    assert.equal(result.decisions[0].field,'existence');
    assert.equal(result.decisions[0].status,status,`${level}: ${bp}/${lp}/${ip}`);
    assert.equal(result.decisions[0].itemId,level==='item'?'a':null);
  }
});
test('different concurrent additions conflict and delete/edit conflicts are symmetric',()=>{
  for (const level of ['item','timeline']) {
    const b=manifest(),l=manifest(),i=manifest();
    if (level==='item') b.timelines[0].items.shift();
    else b.timelines=[];
    clip(i).name='Incoming edit';
    assert.equal(classify(b,l,i).decisions[0].status,'conflict');
    const base=manifest(),deleted=manifest(),edited=manifest();
    if (level==='item') deleted.timelines[0].items.shift();
    else deleted.timelines=[];
    clip(edited).name='Local edit';
    assert.equal(classify(base,deleted,edited).decisions[0].status,'conflict');
    assert.equal(classify(base,edited,deleted).decisions[0].status,'conflict');
  }
});
test('equivalent concurrent additions ignore collection order and object property order',()=>{
  const b=manifest(),l=manifest(),i=manifest();b.timelines=[];
  clip(l).linkedItemIds=['b','c'];clip(i).linkedItemIds=['c','b'];
  i.timelines[0].tracks.reverse();i.timelines[0].items.reverse();
  i.timelines[0].items=i.timelines[0].items.map(value=>Object.fromEntries(Object.entries(value).reverse()));
  assert.equal(classify(b,l,i).decisions[0].status,'already-applied');
});
test('does not claim full equivalence from equal counts or unknown observations',()=>{
  const b=manifest();clip(b).sourceStartFrame=null;
  const result=classify(b,b,b);
  assert.deepEqual(result.decisions,[]);
  assert.equal(result.safeToApply,false);
  assert.ok(result.warnings.some(value=>value.includes('observed fields only')));
  assert.ok(result.warnings.some(value=>value.includes('Equal effect counts')));
  assert.ok(result.warnings.some(value=>value.includes('unknown values')));
});
