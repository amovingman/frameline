'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{auditOperationPerformance}=require('../phase-0/audit-operation-performance');
const root=path.join(__dirname,'..');

test('bounded personal operation measurement proof recomputes native outcome, same-fixture scans and process sampling',()=>{
  const report=auditOperationPerformance();assert.equal(report.measurementEvidenceComplete,true);assert.equal(report.itemCount,50);assert.equal(report.trackCount,5);
  assert.equal(report.returnedPropertyValues,1600);assert.equal(report.exactRepresentedRestoration,true);
  assert.equal(report.renameAndRollback.outcome,'rolled-back');assert.equal(report.renameAndRollback.callCount,8);
  assert.equal(report.renameAndRollback.wallWindow.lowerNs,2000000000);assert.equal(report.renameAndRollback.wallWindow.upperExclusiveNs,4000000000);
  assert.equal(report.scan.pairs,3);assert.deepEqual(report.scan.mediaAvailability,{missing:50});assert.equal(report.scan.warnings.length,1);
  assert.equal(report.sampledRss.sampleCount,84);assert.equal(report.sampledRss.maximumObservedKiB,653008);assert.equal(report.sampledRss.truePeak,false);
  assert.equal(report.safeToApply,false);assert.equal(report.fullPreservation,false);assert.equal(report.releaseSupported,false);
  assert(!JSON.stringify(report).includes('/Users/'));assert(!JSON.stringify(report).includes('/private/'));
});

test('changed native timing, portable audit, worker source or scan evidence fails closed',()=>{
  for(const target of ['phase-0/resolve-operation-rename-live-result.json','phase-0/resolve-operation-rename-portable-audit.json.gz','phase-0/resolve-operation-scan-live-observation.json','src/fcpxml-scan-worker.js']){
    const read=file=>{const data=fs.readFileSync(path.join(root,file));return file===target?Buffer.concat([data,Buffer.from('changed')]):data;};
    assert.throws(()=>auditOperationPerformance(read),/operation-performance-evidence-invalid/);
  }
});

test('corrupted metadata file links, source bindings or archive metadata cannot pass the proof auditor',()=>{
  for(const mutate of [
    value=>{value.resultFile='phase-0/resolve-operation-clock-live-result.json';value.resultSha256='2d1875a0271dd984861cb04a9e3d05853f68519f1d344e1239d4b3e5c5f6a141';},
    value=>{value.independentTrial.sourceSha256='0'.repeat(64);},
    value=>{value.independentTrial.backup.timelineCount=999;}
  ]){
    const target=mutate.toString().includes('resultFile')?'phase-0/resolve-operation-backup-live-observation.json':'phase-0/resolve-operation-rename-live-observation.json';
    const read=file=>{const data=fs.readFileSync(path.join(root,file));if(file!==target)return data;const value=JSON.parse(data);mutate(value);return Buffer.from(JSON.stringify(value));};
    assert.throws(()=>auditOperationPerformance(read),/operation-performance-evidence-invalid/);
  }
});
