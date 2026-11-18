'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runServiceSharedBaseProof } = require('../scripts/service-shared-base-proof');
test('scoped shared bases and immutable witnesses recover from real HTTPS lost acknowledgments across fresh processes', { timeout: 60000 }, async () => {
  const receipt = await runServiceSharedBaseProof();
  assert.equal(receipt.hostProcesses, 3); assert.equal(receipt.clientControllerProcesses, 3); assert.equal(receipt.authorizedAccounts, 2);
  assert(receipt.networkRequests >= 70 && receipt.networkRequests < 500);
  assert.equal(receipt.localRevisionCount, 3); assert.equal(receipt.remoteRevisionCount, 4);
  assert.equal(receipt.discardedCommittedBranchAcknowledgments, 1); assert.equal(receipt.localMetadataSchema, 5);
  assert(receipt.proofSnapshots >= 4); assert(receipt.privateFileCount >= 10);
  for (const key of ['independentAccountScopedBases', 'originalPublisherPreservedForViewer',
    'proofChecksDoNotPublishFetchedHistory', 'explicitFetchOnlyUpdatesFetchedHistory',
    'recordedBaseAndQueueRestoredWithoutNetwork', 'committedAckLossPreservedPriorBase',
    'explicitRetryRepairedBaseWithoutDuplicateRevision', 'immutableProofSurvivedProcessRestart',
    'remoteAheadFetchPreservedLocalHeadAndCommonBase', 'legacyUnscopedBaseUnchanged', 'viewerPushDenied',
    'stdinOnlyAdministration', 'gracefulSigtermExit', 'priorSubprocessesTerminalBeforeRelaunch',
    'allOwnedSubprocessesTerminated', 'publicStateOmitsProofHashesAndPrivatePaths', 'publicLogsOmitCredentialsAndPrivatePaths']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.revisionsImported, false); assert.equal(receipt.mediaFetched, false);
  assert.equal(receipt.privateLocalFilesMode, '0600'); assert.equal(receipt.encryptedStateMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|\/Users\/|\/private\/|https:\/\/127|-----BEGIN|[a-f0-9]{64}/);
});
