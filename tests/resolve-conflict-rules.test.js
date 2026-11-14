const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyResolveThreeWay } = require('../src/resolve-three-way-classifier');
const { analyzeResolveConflictRules: analyze } = require('../src/resolve-conflict-rules');
const manifest = () => ({ schemaVersion: 1, readOnly: true, projectId: 'p', resolveVersion: '21.1.2.10', timelines: [{
  id: 't', name: 'Edit', startFrame: 0, tracks: [{type: 'video', index: 1, name: 'V1'}],
  items: [{id: 'a', type: 'video', name: 'Clip', trackType: 'video', trackIndex: 1,
    startFrame: 0, endFrame: 10, sourceStartFrame: 0, sourceEndFrame: 10, mediaPoolId: 'm',
    linkedItemIds: [], effectCounts: {fusion: 0, ofx: 0, audio: 0}}] }] });
const clip = m => m.timelines[0].items[0];
const run = (b,l,i) => analyze(classifyResolveThreeWay(b,l,i));
test('independent field edits remain observed guidance with no safe properties', () => {
  const b=manifest(), l=manifest(), i=manifest(); clip(l).name='Local'; clip(i).mediaPoolId='other';
  const result=run(b,l,i);
  assert.deepEqual(result.fieldReviews.map(d=>[d.field,d.rule]), [['mediaPoolId','independent-field-edit'],['name','independent-field-edit']]);
  assert.deepEqual(result.provenSafeApplyProperties, []);
  assert.equal(result.safeToApply,false); assert.equal(result.readOnly,true);
});
test('same-field divergent observations require review', () => {
  const b=manifest(), l=manifest(), i=manifest(); clip(l).name='Local'; clip(i).name='Incoming';
  assert.equal(run(b,l,i).fieldReviews[0].rule,'same-field-conflict');
});
test('item and timeline deletion versus edits are entity conflicts in either direction', () => {
  for (const level of ['item','timeline']) for (const reverse of [false,true]) {
    const b=manifest(), edited=manifest(), deleted=manifest(); clip(edited).name='Edited';
    if(level==='item') deleted.timelines[0].items=[]; else deleted.timelines=[];
    const result=run(b,...(reverse?[deleted,edited]:[edited,deleted]));
    assert.equal(result.entityConflicts[0].rule,'delete-edit-conflict');
    assert.deepEqual(result.fieldReviews,[]);
  }
});
test('concurrent additions have canonical review order without placement order', () => {
  const b=manifest(), l=manifest(), i=manifest(); b.timelines[0].items=[];
  clip(l).id='z'; clip(i).id='b';
  const classification=classifyResolveThreeWay(b,l,i), before=JSON.stringify(classification);
  const result=analyze(classification);
  assert.deepEqual(result.timelineReviews[0].additions.map(d=>d.itemId),['b','z']);
  assert.equal(result.automaticTimelineOrdering,false);
  assert.equal(result.timelineReviews[0].automaticTimelineOrdering,false);
  assert.equal(JSON.stringify(classification),before);
  classification.decisions.reverse(); assert.deepEqual(analyze(classification),result);
  result.timelineReviews[0].additions[0].incoming.name='changed';
  assert.equal(clip(i).name,'Clip');
});
test('same-ID concurrent additions retain an entity conflict', () => {
  const b=manifest(), l=manifest(), i=manifest(); b.timelines[0].items=[]; clip(i).name='Other';
  assert.equal(run(b,l,i).entityConflicts[0].rule,'concurrent-addition-conflict');
});
test('moves with overlapping intervals never get automatic timeline ordering', () => {
  const b=manifest(), l=manifest(), i=manifest();
  const second={...structuredClone(clip(b)),id:'b',startFrame:20,endFrame:30};
  for(const m of [b,l,i]) m.timelines[0].items.push(structuredClone(second));
  clip(l).startFrame=15;clip(l).endFrame=25;
  i.timelines[0].items[1].startFrame=18;i.timelines[0].items[1].endFrame=28;
  const result=run(b,l,i);
  assert.equal(result.timelineReviews.length,4);
  assert.ok(result.timelineReviews.every(d=>d.rule==='timeline-interaction-review' && d.automaticTimelineOrdering===false && d.safeToApply===false));
});
test('rejects malformed classifications and handles empty observations', () => {
  assert.throws(()=>analyze({decisions:[]}), {code:'invalid-resolve-classification'});
  const b=manifest();assert.deepEqual(run(b,b,b).fieldReviews,[]);
});
