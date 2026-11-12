const test = require('node:test');
const assert = require('node:assert/strict');
const { assessResolveRiskGates } = require('../src/resolve-risk-gates');
const classification = decisions => ({schemaVersion:1,readOnly:true,safeToApply:false,decisions});
const decision = (field, extra = {}) => ({timelineId:'t',itemId:'a',field,status:'incoming-only',base:null,local:null,incoming:null,...extra});
const category = (result, name) => result.decisions[0].riskCategories.find(value => value.category === name).status;

test('empty and name-only observations retain unknown coverage and never authorize writes', () => {
  for (const decisions of [[], [decision('name')]]) {
    const result = assessResolveRiskGates(classification(decisions));
    assert.equal(result.safeToApply, false);
    assert.equal(result.gate, 'blocked');
    assert.ok(result.warningCodes.includes('transition-coverage-unknown'));
    assert.ok(result.warningCodes.includes('linked-coverage-unknown'));
    if (decisions.length) assert.ok(result.decisions[0].riskCategories.every(value => value.status === 'unknown'));
  }
});

test('timing and link changes have explicit per-decision blocked categories', () => {
  for (const field of ['startFrame','endFrame','sourceStartFrame','sourceEndFrame','track','tracks','existence']) {
    assert.equal(category(assessResolveRiskGates(classification([decision(field)])), 'timing-ripple'), 'blocked');
  }
  assert.equal(category(assessResolveRiskGates(classification([decision('linkedItemIds')])), 'linked-clips'), 'blocked');
});

test('whole entities expose transition, compound and linked risks without claiming full detection', () => {
  const result = assessResolveRiskGates(classification([decision('existence', {itemId:null,incoming:{items:[
    {id:'a',type:'transition',linkedItemIds:[]}, {id:'b',type:'compound',linkedItemIds:['a']}
  ]}})]));
  for (const name of ['timing-ripple','linked-clips','transitions','nested-unknown']) assert.equal(category(result,name),'blocked');
  assert.ok(result.warningCodes.includes('transition-observed'));
  assert.ok(result.warningCodes.includes('nested-coverage-unknown'));
});

test('normalized snapshot context finds existing links for a name decision', () => {
  const item = id => ({id,type:'video',name:id,trackType:'video',trackIndex:1,startFrame:0,endFrame:10,
    sourceStartFrame:null,sourceEndFrame:null,mediaPoolId:null,linkedItemIds:[id === 'a' ? 'b' : 'a'],
    effectCounts:{fusion:0,ofx:0,audio:0}});
  const manifest = {schemaVersion:1,readOnly:true,projectId:'p',resolveVersion:'21.1.2.10',timelines:[
    {id:'t',name:'Timeline',startFrame:0,tracks:[{type:'video',index:1,name:'V1'}],items:[item('a'),item('b')]}
  ]};
  const input = classification([decision('name')]);
  const before = JSON.stringify({input,manifest});
  const result = assessResolveRiskGates(input,{base:manifest});
  assert.equal(category(result,'linked-clips'),'blocked');
  assert.equal(category(result,'transitions'),'unknown');
  assert.equal(JSON.stringify({input,manifest}),before);
});

test('risk output is deterministic across decision order and validates inputs', () => {
  const a = decision('type',{incoming:'Compound'}), b = decision('startFrame',{status:'conflict'});
  assert.deepEqual(assessResolveRiskGates(classification([a,b])),assessResolveRiskGates(classification([b,a])));
  assert.throws(() => assessResolveRiskGates({}),{code:'invalid-resolve-classification'});
  assert.throws(() => assessResolveRiskGates(classification([]),{base:{}}),{code:'invalid-resolve-manifest'});
});
