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
