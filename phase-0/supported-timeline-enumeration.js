'use strict';
// The supported boundary requires source-verified traversal of every active owner.
// A passive whole-project read is diagnostic: inactive audio FX can look empty.
const { readEnumerationCaptureAny } = require('./prepare-enumeration-capture-v2');
const { assembleActiveTimelineEnumeration } = require('./timeline-enumeration-acceptance');

async function readSupportedTimelineEnumeration(preparation) {
  const capture = await readEnumerationCaptureAny(preparation);
  if (capture.status !== 'captured' || capture.sourceAndResultVerified !== true || capture.activeTimelineRestored !== true
    || capture.saveReopenVerified !== true || capture.savedCheckpointScopeOnly !== true) throw new Error('source-verified-owner-traversal-required');
  const assembled = assembleActiveTimelineEnumeration({ observations: capture.observations.map(row => row.before),
    nativeInventories: capture.nativeInventories });
  if (assembled.completeForProfile !== true || assembled.activeOwnerCoverageRequired !== true || assembled.offOwnerReadsUsed !== false
    || assembled.contextSelectionRequired !== true || assembled.safeToApply !== false || assembled.ordinaryApplySupported !== false) throw new Error('incomplete-active-owner-enumeration');
  return { ...assembled, operation: 'supported-active-timeline-enumeration', supportedEnumerationProfileValidated: true,
    savedCheckpointEvidenceVerified: true, activeTimelineRestored: true, atomicSnapshotProven: false,
    nativeStructuralSource: 'verified-saved-reopened-checkpoint', apiConstructSource: 'sequential-active-owner-read-interval',
    completeEditorEnumerationProven: false, fullNativePreservationProven: false,
    provenance: { captureSourceSha256: capture.sourceSha256, captureResultSha256: capture.resultSha256,
      checkpoint: capture.checkpoint, nativeReaderSha256: capture.nativeReaderSha256, orientationSources: capture.rawReceipts },
    limitations: ['Applied API effect slots are enumerated by category and current index; catalogue IDs are not persistent effect-instance identities.',
      'Inactive audio-effect lists can be silently empty. Only each timeline\'s active-owner reads contribute construct inventories.',
      'Native saved structure cross-checks typed membership and media references; native effect and link payloads remain opaque.',
      'The combined observation is sequential, not atomic. Internal Color/Fusion graphs and parameter preservation remain unproven.'] };
}
module.exports = { readSupportedTimelineEnumeration };
if (require.main === module) {
  const [preparation, ...extra] = process.argv.slice(2);
  (preparation && !extra.length ? readSupportedTimelineEnumeration(preparation) : Promise.reject(new Error('usage')))
    .then(value => process.stdout.write(JSON.stringify(value, null, 2)+'\n'))
    .catch(() => { process.stderr.write('supported-timeline-enumeration-refused\n'); process.exitCode=1; });
}
