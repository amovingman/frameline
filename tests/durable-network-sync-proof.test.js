'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runDurableNetworkSyncProof } = require('../scripts/durable-network-sync-proof');

test('encrypted collaboration metadata and authorization survive disposable server process restarts', { timeout: 60000 }, async () => {
  const receipt = await runDurableNetworkSyncProof();
  assert.equal(receipt.authorizedAccounts, 2); assert.equal(receipt.serverProcesses, 3);
  assert.equal(receipt.distinctServerPorts, 3); assert(receipt.networkRequests >= 35);
  assert.equal(receipt.fetchedRevisionCount, 2); assert.equal(receipt.mediaFetched, false);
  for (const key of ['acknowledgedBranchSurvivedSigkill', 'sessionsAndRolesSurvivedRestart',
    'metadataHistoryPreserved', 'retryCreatedNoDuplicateRevisions', 'authorBoundToSession',
    'forgedAuthenticationDenied', 'removedMemberDeniedAfterRestart',
    'rotatedAndSignedOutSessionsDeniedAfterRestart', 'revokedRefreshTokensDeniedAfterRestart',
    'plaintextCredentialsAbsent', 'ownedSubprocessesTerminalBeforeRestart', 'allOwnedSubprocessesTerminated']) {
    assert.equal(receipt[key], true, key);
  }
  assert.equal(receipt.encryptedFileMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|\/private\/|\/Users\/|\.enc\.json/);
});
