'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { auditNativeTrackTopologyEvidence } = require('../phase-0/native-track-topology-evidence-audit');
test('retained native topology chain proves controlled UUID index shifts and fresh recreation while preserving all pictures', () => {
  const report = auditNativeTrackTopologyEvidence();
  assert.equal(report.projectId, 'dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff');
  assert.equal(report.itemCount, 50); assert.equal(report.finalTrackCount, 5);
  assert.equal(report.retainedOriginalNativeTrackIds.length, 4);
  assert.deepEqual(report.newFinalNativeTrackIds, ['d196e846-3ce4-4ece-af4a-98690db4ce0a']);
  assert.deepEqual(report.retiredNativeTrackIds, ['9950ea6e-7c1c-4281-9c49-1beb75543769', 'ebccb2e6-6309-4750-bf8c-7012db202f10']);
  assert.equal(report.stages.length, 3); assert.deepEqual(report.stages.map(stage => stage.trackCount), [6, 5, 5]);
  const shifted = report.stages[1].retainedTracks.filter(row => row.apiIndexBefore !== row.apiIndexAfter);
  assert(shifted.some(row => row.nativeTrackId === '5690d038-9896-4252-83e1-1aab62c25289' && row.apiIndexBefore === 3 && row.apiIndexAfter === 2));
  assert.equal(report.controlledApiUuidIndexShiftVerified, true); assert.equal(report.deleteRecreateNegativeControlVerified, true);
  assert.equal(report.noObservedUuidReuse, true); assert.equal(report.representedFinalObservationMatchesInitial, true);
  assert.equal(report.nativeGraphsReconstructedFromArchives, false); assert.equal(report.stableTrackIdentityProven, false);
  assert.equal(report.safeToApply, false);
});
test('topology audit rejects changed raw payload or graph facts without promoting a partial proof', () => {
  assert.throws(() => auditNativeTrackTopologyEvidence(filename => filename.endsWith('append-live-observation.json')
    ? Buffer.from(JSON.stringify({ ...JSON.parse(fs.readFileSync(filename)), topology: {} })) : fs.readFileSync(filename)), /facts-changed/);
  assert.throws(() => auditNativeTrackTopologyEvidence(filename => filename.endsWith('recreate-topology-result.json.gz')
    ? Buffer.from('changed') : fs.readFileSync(filename)), /compression-changed/);
});
