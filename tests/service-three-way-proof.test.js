'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runServiceThreeWayProof } = require('../scripts/service-three-way-proof');
test('real HTTPS divergent histories compare verified current unsaved XML against explicit cached incoming without mutations', { timeout: 60000 }, async () => {
  const receipt = await runServiceThreeWayProof();
  assert.equal(receipt.hostProcesses, 2); assert.equal(receipt.clientControllerProcesses, 2); assert.equal(receipt.authorizedAccounts, 1);
  assert(receipt.networkRequests >= 30 && receipt.networkRequests < 300);
  assert.equal(receipt.localRevisionCount, 2); assert.equal(receipt.remoteRevisionCount, 3); assert(receipt.privateFileCount >= 10);
  assert.deepEqual(receipt.statusesObserved, ['incoming-only', 'local-only', 'already-applied', 'conflict']);
  for (const key of ['actualFcpxmlScans', 'unsavedCurrentLocalSourceCompared', 'verifiedCommonRootAndDivergedHistories',
    'compareUsesExplicitFetchedIncoming', 'comparisonWithoutExplicitFetchRefused', 'compareDispatchesNoNetworkRequests', 'compareDoesNotWriteSourceMetadataCacheOrBases',
    'rationalEquivalentFrameDurationsNormalized', 'cachedIncomingSurvivedRestart', 'comparisonNotAutomaticallyRestored',
    'changedSourceWithoutRescanRefused', 'sourceChangeBetweenVerificationReadsRefused',
    'explicitFetchReplacedIncomingAndClearedComparison', 'localAndServiceHeadsPreservedByCompare', 'legacyUnscopedBaseUnchanged',
    'gracefulSigtermExit', 'priorSubprocessesTerminalBeforeRelaunch', 'allOwnedSubprocessesTerminated',
    'publicLogsOmitCredentialsAndPrivatePaths']) assert.equal(receipt[key], true, key);
  for (const key of ['clipComparisonAvailable', 'mediaIdentityAvailable', 'safeToApply', 'revisionsImported', 'mediaFetched']) assert.equal(receipt[key], false, key);
  assert.equal(receipt.privateFilesMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|\/Users\/|\/private\/|https:\/\/127|-----BEGIN|[a-f0-9]{64}/);
});
