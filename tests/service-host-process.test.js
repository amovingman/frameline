'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runServiceHostProof } = require('../scripts/service-host-proof');

test('operator initialization, stdin administration and real HTTPS history survive a graceful service process restart', { timeout: 60000 }, async () => {
  const receipt = await runServiceHostProof();
  assert.equal(receipt.authorizedAccounts, 2); assert.equal(receipt.hostProcesses, 2);
  assert(receipt.networkRequests >= 30); assert.equal(receipt.fetchedRevisionCount, 2); assert.equal(receipt.mediaFetched, false);
  for (const key of ['missingStoreServeRejected', 'explicitInitializationRequired', 'existingInitializationPreserved',
    'insecureConfigRejected', 'insecureTlsKeyRejected', 'stdinOnlyAdministration', 'viewerMetadataWritesDenied',
    'sessionAndProjectAccessPreservedAfterRestart', 'revisionHistoryPreservedAfterRestart',
    'idempotentRetryCreatedNoDuplicateRevisions', 'acknowledgedBranchPreserved', 'gracefulSigtermExit',
    'priorSubprocessesTerminalBeforeRelaunch', 'allOwnedSubprocessesTerminated',
    'publicLogsOmitCredentialsAndPrivatePaths', 'encryptedStateOmitsPlaintextCredentials']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.privateConfigMode, '0600'); assert.equal(receipt.privateTlsKeyMode, '0600'); assert.equal(receipt.encryptedStateMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|\/Users\/|\/private\/|https:\/\/127|-----BEGIN/);
});
