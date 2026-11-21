'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {auditItemStateEvidence}=require('../phase-0/item-state-evidence');
const {auditItemEnabledEvidence}=require('../phase-0/item-enabled-evidence');
test('native item-state evidence preserves failed attempts and diagnoses98 availability changes without filling defaults',()=>{
  const report=auditItemStateEvidence();assert.equal(report.failedCaptureCount,2);assert.equal(report.diagnosticAcceptedAsStable,false);assert.equal(report.diagnosticChanges,98);
  assert.deepEqual(report.diagnosticChangesByField,{outputBlanking:49,usesTimelineOutputBlanking:49});assert.equal(report.richBeforeAfterMatchesBaseline,true);
  assert.equal(report.coverage.capturePage,'color');assert.equal(report.coverage.readOrderPolicy,'color-graph-before-item-state');
  assert.equal(report.coverage.itemCount,50);assert(Object.values(report.coverage.reads).every(read=>read.captured===50&&read.unavailable===0));
  assert.equal(report.coverage.reads.speed.returnedKeys.Percentage,50);assert.equal(report.coverage.reads.speed.returnedKeys.PitchCorrection,0);
  assert.equal(report.coverage.reads.outputBlanking.returnedKeys.Top,0);assert.equal(report.safeToApply,false);assert.equal(report.losslessRoundTripProven,false);
});
test('native enabled-state phases reveal one hidden field edit and exact restoration with a fresh disabled-state backup',()=>{
  const report=auditItemEnabledEvidence();assert.equal(report.disabledDifferenceCount,1);assert.equal(report.disabledField,'clipEnabled');assert.equal(report.snapshotDifferenceCount,0);assert.equal(report.richOutcomesMatchBaseline,true);assert.equal(report.exactRepresentedBytesRestored,true);assert.equal(report.freshRestoreBackupMatchesDisabledExport,true);assert.equal(report.safeToApply,false);assert.equal(report.ordinaryApplyEnabled,false);assert.equal(report.generalLosslessPreservationProven,false);
});
test('changed compressed evidence or historical capture source fails audit instead of upgrading the proof',()=>{
  assert.throws(()=>auditItemStateEvidence(filename=>filename.endsWith('ordered-baseline.json.gz')?Buffer.from('changed'):fs.readFileSync(filename)),/compressed-changed/);
  assert.throws(()=>auditItemStateEvidence(filename=>filename.endsWith('page-aware-before-order.lua')?Buffer.from('changed'):fs.readFileSync(filename)),/history-source-changed|diagnostic-source-changed/);
});
