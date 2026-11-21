'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditIntegrationProgress } = require('../phase-0/integration-proof-progress');
const { auditIntegrationGates } = require('../phase-0/integration-gates');

test('current proof closes verified personal measurements and finite identity while retaining the historical decision', () => {
  const report = auditIntegrationProgress();
  const { historical, ...summary } = report;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/integration-proof-progress-observation.json'))), summary);
  assert.deepEqual(historical, auditIntegrationGates());
  assert.deepEqual(report.newlyCompletedGateIds, ['representative-scan-write-reopen', 'stable-clip-and-track-identity']);
  assert.equal(report.gates.find(gate => gate.id === 'representative-scan-write-reopen').status, 'complete');
  assert.equal(report.gates.find(gate => gate.id === 'stable-clip-and-track-identity').status, 'complete');
  for (const gate of report.historical.gates.filter(gate => !report.newlyCompletedGateIds.includes(gate.id))) {
    assert.equal(report.gates.find(current => current.id === gate.id).status, gate.status);
  }
  for (const flag of ['safeToApply', 'ordinaryApplyEnabled', 'releaseSupported', 'fullNativePreservationProven']) assert.equal(report[flag], false);
  assert.equal(report.performance.exactRepresentedRestoration, true);
  assert.equal(report.nativeTrackIdentity.controlledEmptyTrackBindings, 4);
  assert.equal(report.nativeTrackIdentity.stableTrackIdentityProven, false);
  assert.equal(report.nativeTrackTopology.controlledApiUuidIndexShiftVerified, true);
  assert.equal(report.nativeTrackTopology.deleteRecreateNegativeControlVerified, true);
  assert.equal(report.nativeTrackTopology.stableTrackIdentityProven, false);
  assert.equal(report.additionalItemState.coverage.itemCount, 50);
  assert.equal(report.additionalItemState.losslessRoundTripProven, false);
  assert.equal(report.additionalItemState.enabledProof.disabledDifferenceCount, 1);
  assert.equal(report.additionalItemState.enabledProof.exactRepresentedBytesRestored, true);
  assert.equal(report.additionalItemState.enabledProof.generalLosslessPreservationProven, false);
  assert.equal(report.readOnlyTrackBinding.challengeFreeReadOnlyRebindingVerified, true);
  assert.equal(report.readOnlyTrackBinding.stableTrackIdentityProven, false);
  assert.equal(report.expandedRenameGuard.guardedReadFamilies, 7);
  assert.equal(report.expandedRenameGuard.exactRepresentedRestoration, true);
  assert.equal(report.colorNodeReads.coverage.fields.tools.unavailable, 50);
  assert.equal(report.nodeAnnotationProof.exactNodeObservationRestored, true);
  assert.equal(report.nodeAnnotationProof.gradeParameterPreservationProven, false);
  assert.equal(report.nativeFieldControl.fullNativePreservationProven, false);
  assert.equal(report.identityAuthorityDecision.fcpxmlWriteAuthority, false);
  assert.equal(report.blindIdentity.status, 'complete');
  assert.equal(report.blindIdentity.stableClipIdentityProven, true);
  assert.equal(report.blindIdentity.stableTrackIdentityProven, true);
  assert.equal(report.blindIdentity.personalScopeEvidenceComplete, true);
  assert.equal(report.blindIdentity.fullNativePreservationProven, false);
  assert.equal(report.blindIdentity.ordinaryApplySupported, false);
});
