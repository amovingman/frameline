'use strict';
// Current evidence extends, rather than rewrites, the historical gate decision.
const { createHash } = require('node:crypto');
const path = require('node:path');
const { readInput } = require('./integration-input');
const { auditIntegrationGates } = require('./integration-gates');
const { auditOperationPerformance } = require('./audit-operation-performance');
const { auditNativeTrackEvidence } = require('./native-track-evidence-audit');
const { auditNativeTrackTopologyEvidence } = require('./native-track-topology-evidence-audit');
const { auditItemStateEvidence } = require('./item-state-evidence');
const { auditNativeTrackReadOnlyEvidence } = require('./native-track-readonly-evidence-audit');
const { auditItemStateRenameEvidence } = require('./item-state-rename-evidence');
const { auditColorNodeEvidence } = require('./color-node-evidence');
const { auditColorNodeChallengeEvidence } = require('./color-node-challenge-evidence');
const { auditNativeFieldControlEvidence } = require('./native-field-control-evidence');
const { auditNativeBlindIdentityEvidence } = require('./native-blind-identity-evidence-audit');
const { auditTimelineEnumerationEvidence } = require('./timeline-enumeration-evidence-audit');
const { auditClosedCopyPreservation } = require('./preservation-closed-copy-evidence');
const { auditNativeByteDiagnostics } = require('./native-byte-diagnostics-evidence');
const { auditInterruptedPreservationName } = require('./preservation-interrupted-name-evidence');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function auditIntegrationProgress() {
  const historical = auditIntegrationGates();
  const performance = auditOperationPerformance();
  const nativeTrackIdentity = auditNativeTrackEvidence();
  const nativeTrackTopology = auditNativeTrackTopologyEvidence();
  const additionalItemState = auditItemStateEvidence();
  const readOnlyTrackBinding = auditNativeTrackReadOnlyEvidence();
  const expandedRenameGuard = auditItemStateRenameEvidence();
  const colorNodeReads = auditColorNodeEvidence();
  const nodeAnnotationProof = auditColorNodeChallengeEvidence();
  const nativeFieldControl = auditNativeFieldControlEvidence();
  const blindIdentity = auditNativeBlindIdentityEvidence();
  const timelineEnumeration = auditTimelineEnumerationEvidence();
  const nativeByteDiagnostics = auditNativeByteDiagnostics();
  const closedCopyPreservation = auditClosedCopyPreservation();
  const interruptedPreservationName = auditInterruptedPreservationName();
  const identityAuthorityDecision = { file: 'RESOLVE_IDENTITY_AUTHORITY.md',
    sha256: createHash('sha256').update(readInput(path.join(__dirname, '../RESOLVE_IDENTITY_AUTHORITY.md'))).digest('hex'),
    clipWriteLocator: 'live-api-project-timeline-item-uuid', fcpxmlWriteAuthority: false, ordinaryApplyEnabled: false };
  if (performance.measurementEvidenceComplete !== true || performance.safeToApply !== false
    || performance.fullPreservation !== false || blindIdentity.status !== 'complete'
    || blindIdentity.personalScopeEvidenceComplete !== true || blindIdentity.stableClipIdentityProven !== true
    || blindIdentity.stableTrackIdentityProven !== true || blindIdentity.safeToApply !== false
    || blindIdentity.ordinaryApplySupported !== false || blindIdentity.fullNativePreservationProven !== false
    || timelineEnumeration.status !== 'complete' || timelineEnumeration.enumerationEvidenceComplete !== true
    || timelineEnumeration.completeForProfile !== true || timelineEnumeration.completeEditorEnumerationProven !== false
    || timelineEnumeration.safeToApply !== false || timelineEnumeration.ordinaryApplySupported !== false
    || timelineEnumeration.fullNativePreservationProven !== false) throw new Error('integration-proof-incomplete');
  const gates = historical.gates.map(gate => gate.id === performance.gateId ? {
    id: gate.id, status: 'complete',
    evidence: 'Source-bound same-fixture scans, native backup and reviewed rename/save/reopen/rollback timings, independently verified represented restoration, and sampled editor RSS.',
    scope: performance.scope, evidenceSha256: hash(performance)
  } : gate.id === blindIdentity.gateId ? { id: gate.id, status: 'complete', scope: blindIdentity.scope,
    evidence: 'Three verified saved/reopened checkpoint predictions match 24 independent native name-challenge bindings, including duplicate-name empty video/audio tracks. All 52 clip UUIDs persist through a rename/move and save/reopen; native track UUIDs persist through index shifts, while same-slot recreation produces a fresh UUID. The exact-build flat video/mono-audio profile requires source-bound save/reopen provenance and complete independent API location witnesses; current unsaved binding is unproven and FCPXML remains read-only.',
    evidenceSha256: hash({ blindIdentity, identityAuthorityDecision })
  } : gate.id === 'lossless-editor-fields' ? { ...gate, status: 'complete', scope: closedCopyPreservation.scope,
    evidence: 'The UUID-bound private-copy Name writer preserves all other 9,788 typed cells. Actual source-bound editor Load verifies the persisted Name; separate UI Close and fresh absence capture precede a byte-identical complete database snapshot. Scope is the controlled closed-copy existing-custom video Name workflow. The earlier SDK Save experiment failed and remains retained; ordinary Apply stays disabled.',
    evidenceSha256: hash({ closedCopyPreservation, interruptedPreservationName, nativeByteDiagnostics })
  } : gate.id === timelineEnumeration.gateId ? { id: gate.id, status: 'complete', scope: timelineEnumeration.scope,
    evidence: 'Source-bound active-owner traversal enumerates the six outer construct families, independently cross-checks saved native typed membership, detects three same-count substitutions and a held-out timeline, verifies logical restoration, and refuses real nested content. Inactive audio effects can silently appear empty; off-owner reads never supply the supported inventory. Internal graphs, parameters and opaque native fields remain unproven.',
    evidenceSha256: hash(timelineEnumeration)
  } : { ...gate });
  return { schemaVersion: 1, readOnly: true, safeToApply: false, ordinaryApplyEnabled: false,
    releaseSupported: false, fullNativePreservationProven: false,
    historicalAuditSha256: hash(historical), historical, performance, nativeTrackIdentity, nativeTrackTopology, additionalItemState, gates,
    readOnlyTrackBinding, expandedRenameGuard, colorNodeReads, nodeAnnotationProof, nativeFieldControl, identityAuthorityDecision, blindIdentity, timelineEnumeration, nativeByteDiagnostics, interruptedPreservationName, closedCopyPreservation,
    newlyCompletedGateIds: [performance.gateId, blindIdentity.gateId, timelineEnumeration.gateId, 'lossless-editor-fields'],
    limitations: ['The measurement, finite identity and six-family outer enumeration gates are completed for their declared personal scopes.',
      'The historical editor-choice decision remains intact; complete processing graphs and safe apply remain unproven; opaque persisted fields are preserved within the declared closed-copy Name workflow.',
      'Identity support is limited to the exact Free build and observed normal flat video/mono-audio structures; concurrent track writes and XML identity mapping remain unproven.',
      'Unsaved exports can retain stale native UUIDs; the supported reader binds verified saved/reopened checkpoints only, not current unsaved editor state.',
      'Enumeration uses saved native structure and sequential active-owner API effects/links; it does not prove an atomic current-unsaved editor inventory.',
      ...performance.limitations] };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(auditIntegrationProgress(), null, 2) + '\n'); }
  catch { process.stderr.write('integration-proof-progress-failed\n'); process.exitCode = 1; }
}
module.exports = { auditIntegrationProgress };
