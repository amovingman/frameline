const test=require('node:test'),assert=require('node:assert/strict');const{sampleRss}=require('../phase-0/sample-resolve-rss');
test('RSS proof retains sampled maximum, warm-process limits and verified-result separation',async()=>{
  const values=[10,30,20];let i=0;const r=await sampleRss({pid:1,intervalMs:1,query:async()=>values[i++],finished:async()=>i===3});
  assert.equal(r.maximumObservedKiB,30);assert.equal(r.lastKiB,20);assert.equal(r.status,'completion-marker-observed');assert.equal(r.safeToApply,false);
});
test('RSS sampling refuses process-query failure and reports timeout without operation success',async()=>{
  await assert.rejects(sampleRss({pid:0}),/invalid-rss-options/);
  await assert.rejects(sampleRss({pid:1,query:async()=>{throw new Error('resolve-process-changed');}}),/resolve-process-changed/);
  const r=await sampleRss({pid:1,intervalMs:1,timeoutMs:2,query:async()=>12,finished:async()=>false});assert.equal(r.status,'timed-out');
});
