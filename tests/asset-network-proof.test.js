'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAssetNetworkProof } = require('../scripts/asset-network-proof');

test('signed HTTPS asset chunks resume across service process restarts and recheck revoked project access', { timeout: 60000 }, async () => {
  const receipt = await runAssetNetworkProof();
  assert.equal(receipt.authenticatedAccounts, 3); assert.equal(receipt.projects, 2); assert.equal(receipt.hostProcesses, 3);
  assert.equal(receipt.assetBytes, 2 * 1024 * 1024 + 17); assert.equal(receipt.chunks, 3); assert(receipt.networkRequests >= 30);
  for (const key of ['outOfOrderChunkAccepted', 'partialUploadSurvivedRestart', 'capabilitySurvivedGracefulRestart',
    'resumeReusedUpload', 'wholeContentHashVerified', 'viewerDownloadedExactBytes', 'completedRetryReusedAsset',
    'viewerWriteDenied', 'outsiderAccessDenied', 'crossProjectContentIsolation', 'malformedChecksumRejected', 'oversizedChunkRejected',
    'capabilityTamperingRejected', 'wrongMethodRejected', 'alteredExpiredCapabilityRejected',
    'removedViewerOldTicketDeniedAfterRestart', 'retainedOwnerContentAvailable', 'encryptedChunksOmitPlaintext',
    'gracefulSigtermExit', 'priorOwnedProcessesTerminalBeforeRestart', 'allOwnedProcessesTerminated',
    'publicLogsAndReceiptOmitCredentialsCapabilitiesAndPrivatePaths', 'policyDefaultsDisabled', 'ownerPolicyPersistsAcrossRestart',
    'viewerPolicyAndArchiveWritesDenied', 'partialAndPublishedUsageVerified', 'archivedBytesRetainedAndBlocked',
    'excludedBytesRetainedAndBlocked', 'outstandingTicketsRecheckArchiveAndPolicy', 'stalePolicyUpdateRejected',
    'restoredPolicyAllowsRead']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.privateFileMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|signature=|\/Users\/|\/private\/|https:\/\/127/);
});
