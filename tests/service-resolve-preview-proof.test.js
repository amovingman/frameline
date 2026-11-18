'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runServiceResolvePreviewProof } = require('../scripts/service-resolve-preview-proof');
test('real HTTPS Resolve v3 history feeds exact saved-head and scoped capture previews with stale receipt refusal', { timeout: 60000 }, async () => {
  const receipt = await runServiceResolvePreviewProof();
  assert.equal(receipt.authorizedAccounts, 2); assert.equal(receipt.hostProcesses, 2); assert.equal(receipt.clientControllerProcesses, 2);
  assert(receipt.networkRequests >= 40 && receipt.networkRequests < 250);
  assert.equal(receipt.manifestVersion, 3); assert.equal(receipt.publisherRevisionCount, 2); assert.equal(receipt.viewerRevisionCount, 1);
  assert.equal(receipt.copiedFixtureObservationOnly, true);
  for (const key of ['mediaFetched', 'editorWrites', 'revisionsImported', 'liveEditorProvenance', 'safeToApply']) assert.equal(receipt[key], false, key);
  for (const key of ['gracefulSigtermExit', 'priorSubprocessesTerminalBeforeRelaunch', 'allOwnedSubprocessesTerminated',
    'propertyOnlyIncomingRetainedCompleteObservation', 'savedHeadIncomingPanPreview', 'capturePanConflictAndIndependentTilt',
    'completePlanRecomputedFromExactRoleSources', 'previewAndSourceRecheckDispatchNoNetwork',
    'previewAndSourceRecheckDoNotMutatePrivateFiles', 'scopeBaseIncomingSubstitutionRefused',
    'captureGenerationSubstitutionRefused', 'changedObservationSubstitutionRefused', 'expiredAndFutureCapturesRefused',
    'viewerPushDenied', 'selectionChangeRetiresPreview', 'legacyBaseUnchanged', 'cachedHistoryAndBaseRecoveredAfterRestart',
    'previewNotAutomaticallyRestored', 'noPullCompletedEvent', 'publicStateOmitsPrivateSourcesAndProofHashes',
    'completeServiceReviewCannotAuthorizeRenameDrill']) assert.equal(receipt[key], true, key);
  assert(receipt.privateFileCount >= 12); assert.equal(receipt.privateFilesMode, '0600');
  assert.doesNotMatch(JSON.stringify(receipt), /Bearer |accessToken|refreshToken|\/Users\/|\/private\/|https:\/\/127|-----BEGIN|[a-f0-9]{64}/);
});
