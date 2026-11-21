'use strict';
// Read-only entry point for the finite identity profile. Diagnostic graphs
// alone never bypass the runtime, complete-item or synchronization checks.
const { readInput } = require('./integration-input');
const { joinSynchronizedNativeTracks, sha, json } = require('./native-track-location-binding');
const { requireSupportedIdentityProfile } = require('./native-track-identity-acceptance');

function bindDiagnosticSynchronizedTracks(observations, graphs, apiLocationWitnesses) {
  const synchronized = joinSynchronizedNativeTracks(observations, graphs);
  const supported = graphs.map(graph => requireSupportedIdentityProfile(graph, observations[0], apiLocationWitnesses));
  return { ...synchronized, observedIdentityShapeValidated: true, supportedIdentityProfileValidated: false,
    savedCheckpointRequired: true, currentUnsavedStateBindingProven: false,
    independentPopulatedApiLocationsVerified: true, apiLocationWitnesses: supported[0].apiLocationWitnesses,
    safeToApply: false, ordinaryApplySupported: false };
}

async function bindSupportedSavedTracks(preparation) {
  const record = JSON.parse(readInput(preparation));
  let receipt, capture;
  if (record.operation === 'prepare-native-blind-capture' && record.stage === 'initialize') {
    receipt = capture = await require('./prepare-native-blind-capture').readCapture(preparation);
  } else if (record.operation === 'prepare-native-blind-continuation') {
    receipt = await require('./prepare-native-blind-continuation').readContinuation(preparation);
    if (receipt.saveReopenVerified !== true) throw new Error('saved-checkpoint-required');
    capture = receipt.capture;
  } else if (record.operation === 'prepare-native-blind-perturb' && record.stageOperation === 'recreate-empty-video-4') {
    receipt = await require('./native-blind-saved-endpoint').readNativeBlindSavedEndpoint(preparation);
    if (receipt.saveReopenVerified !== true) throw new Error('saved-checkpoint-required');
    capture = receipt.capture;
  } else throw new Error('saved-checkpoint-required');
  const binding = bindDiagnosticSynchronizedTracks(capture.observations, capture.graphs, capture.apiLocationWitnesses);
  return { ...binding, operation: 'saved-native-api-identity-binding', supportedIdentityProfileValidated: true,
    savedCheckpointRequired: true, savedReopenProven: true, currentUnsavedStateBindingProven: false,
    savedCheckpoint: { sourceSha256: receipt.sourceSha256, resultSha256: receipt.resultSha256,
      captureResultSha256: capture.resultSha256, identityGraphSha256: binding.nativeIdentityFactsSha256,
      representedStateSha256: sha(json(capture.observations[0])) },
    limitations: [...binding.limitations, 'This binds a source-verified saved/reopened checkpoint, not the present unsaved editor state. Unsaved exports can retain stale native UUIDs.'] };
}

if (require.main === module) {
  (async () => {
    const [preparation, ...extra] = process.argv.slice(2);
    if (!preparation || extra.length) throw new Error('usage');
    process.stdout.write(JSON.stringify(await bindSupportedSavedTracks(preparation), null, 2) + '\n');
  })().catch(() => { process.stderr.write('supported-native-track-binding-refused\n'); process.exitCode = 1; });
}
module.exports = { bindDiagnosticSynchronizedTracks, bindSupportedSavedTracks };
