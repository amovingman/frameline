'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { auditNativeTrackEvidence } = require('../phase-0/native-track-evidence-audit');
test('pure native proof audit recomputes observations and pinned public facts without claiming private reconstruction', () => {
  const report = auditNativeTrackEvidence();
  assert.equal(report.itemCount, 50); assert.equal(report.nativeTrackCount, 5);
  assert.equal(report.controlledEmptyTrackBindings, 4); assert.equal(report.nativeTrackIdsRetainedAcrossNameSaveReopen, true);
  assert.equal(report.nativeGraphsRecomputedFromArchives, false); assert.equal(report.publicNativeGraphConsistencyVerified, true);
  assert.equal(report.stableTrackIdentityProven, false); assert.equal(report.safeToApply, false);
  assert.throws(() => auditNativeTrackEvidence(filename => filename.endsWith('live-observation.json')
    ? Buffer.from(JSON.stringify({ ...JSON.parse(fs.readFileSync(filename)), safeToApply: true })) : fs.readFileSync(filename)), /invalid-native-track-evidence/);
});
