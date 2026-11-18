'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function evidence(filename, hash) {
  const bytes = fs.readFileSync(path.join(__dirname, '../phase-0', filename));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  return JSON.parse(bytes);
}
test('recorded native startup recovery and history transfer evidence retain their tested scope', () => {
  const startup = evidence('startup-drill-discovery-live-observation.json', '161808422711d4b14b84eacc1dbe63c86069188983ced5d91e16fb08533c58f5');
  assert.equal(startup.nativeUiVerified, true); assert.equal(startup.liveResolveFlowVerified, true);
  assert.equal(startup.initialAttentionCount, 2); assert.equal(startup.finalAttentionCount, 0);
  assert.equal(startup.completedStateSurvivesRestart, true); assert.equal(startup.selectedFromDiscoveredRow, true);
  assert.equal(startup.retainedPreparationRecords, true); assert.equal(startup.originalCommandExecuted, false);
  assert.equal(startup.status, 'source-verified'); assert.equal(startup.recovery.operation, 'verify-source');
  assert.equal(startup.sourceSha256, '654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850');
  assert.equal(startup.resultingSnapshotSha256, startup.sourceSha256); assert.equal(startup.safeToApply, false);
  assert.equal(startup.fullProjectApplyVerified, false);
  const transfer = evidence('resolve-history-transfer-native-observation.json', '328e72787139a551378c2af4b61d15776ffa7bfa036738dce3b7368642456aa3');
  assert.equal(transfer.nativeFileDialogsVerified, true); assert.equal(transfer.nativeAuditInspectorVerified, true);
  assert.equal(transfer.exportedRevisions, 6); assert.equal(transfer.importedRevisions, 6);
  assert.equal(transfer.importedBranch, 'import-main'); assert.equal(transfer.currentBranchPreserved, 'main');
  assert.equal(transfer.mainHeadPreserved, startup.revisionId);
  assert.equal(transfer.transactionAuditsPreserved, true); assert.equal(transfer.localRevisionIdsRemapped, true);
  assert.equal(transfer.backupMode, 0o600); assert.equal(transfer.nativeBackupsIncluded, false); assert.equal(transfer.safeToApply, false);
});

test('recorded completed-trial replay evidence distinguishes a native flag reset from an editor restart', () => {
  const report = evidence('completed-trial-replay-live-observation.json', '26c460e5e0326d17653b7f3c48e3b27f9130ec190e3355dcfaff609713b1987d');
  const fixture = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json'));
  const hash = createHash('sha256').update(fixture).digest('hex');
  assert.equal(report.nativeConsoleVerified, true);
  assert.equal(report.processLocalConsumedEntryCleared, true);
  assert.equal(report.resolveRestarted, false);
  assert.equal(report.replayRefused, true);
  assert.equal(report.refusal, 'Trial outcome already recorded');
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.forcedFailure, true);
  for (const field of ['sourceObservationSha256', 'resultObservationSha256', 'afterRefusedReplayObservationSha256']) {
    assert.equal(report[field], hash);
  }
  assert.equal(report.coverage.propertyValueCount, 443);
  assert.equal(report.coverage.unavailablePropertyReads, 0);
  assert.equal(report.trialFilesUnchangedOnReplay, true);
  assert.equal(report.backup.archiveVerified, true);
  assert.equal(report.backup.mode, 0o600);
  assert.equal(report.desktopIntegrated, false);
  assert.equal(report.safeToApply, false);
  assert.equal(report.fullNativePropertiesVerified, false);
});
