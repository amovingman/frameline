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
  const identityAuthorityDecision = { file: 'RESOLVE_IDENTITY_AUTHORITY.md',
    sha256: createHash('sha256').update(readInput(path.join(__dirname, '../RESOLVE_IDENTITY_AUTHORITY.md'))).digest('hex'),
    clipWriteLocator: 'live-api-project-timeline-item-uuid', fcpxmlWriteAuthority: false, ordinaryApplyEnabled: false };
  if (performance.measurementEvidenceComplete !== true || performance.safeToApply !== false
    || performance.fullPreservation !== false || blindIdentity.status !== 'complete'
    || blindIdentity.personalScopeEvidenceComplete !== true || blindIdentity.stableClipIdentityProven !== true
    || blindIdentity.stableTrackIdentityProven !== true || blindIdentity.safeToApply !== false
    || blindIdentity.ordinaryApplySupported !== false || blindIdentity.fullNativePreservationProven !== false) throw new Error('integration-proof-incomplete');
  const gates = historical.gates.map(gate => gate.id === performance.gateId ? {
    id: gate.id, status: 'complete',
    evidence: 'Source-bound same-fixture scans, native backup and reviewed rename/save/reopen/rollback timings, independently verified represented restoration, and sampled editor RSS.',
    scope: performance.scope, evidenceSha256: hash(performance)
  } : gate.id === blindIdentity.gateId ? { id: gate.id, status: 'complete', scope: blindIdentity.scope,
    evidence: 'Three verified saved/reopened checkpoint predictions match 24 independent native name-challenge bindings, including duplicate-name empty video/audio tracks. All 52 clip UUIDs persist through a rename/move and save/reopen; native track UUIDs persist through index shifts, while same-slot recreation produces a fresh UUID. The exact-build flat video/mono-audio profile requires source-bound save/reopen provenance and complete independent API location witnesses; current unsaved binding is unproven and FCPXML remains read-only.',
    evidenceSha256: hash({ blindIdentity, identityAuthorityDecision })
  } : gate.id === 'lossless-editor-fields' ? { ...gate,
    evidence: 'A separate rename/rollback guard now checks the seven additional item-state families before and after setter/save/reopen/export and restores exact represented bytes. Color-slot metadata extends counts, but tools, complete graphs and opaque fields remain unobserved. Native read-only controls retain unexplained record differences.',
    evidenceSha256: hash({ additionalItemState, expandedRenameGuard, colorNodeReads, nodeAnnotationProof, nativeFieldControl })
  } : gate.id === 'complete-timeline-enumeration' ? { ...gate,
    evidence: 'The existing item/effect/link inventory is supplemented by 50 first-layer node-slot color/cache reads. All 50 documented tool-list reads were unavailable; graph topology, persistent node IDs, nested content and complete enumeration remain unproven.',
    evidenceSha256: hash(colorNodeReads)
  } : { ...gate });
  return { schemaVersion: 1, readOnly: true, safeToApply: false, ordinaryApplyEnabled: false,
    releaseSupported: false, fullNativePreservationProven: false,
    historicalAuditSha256: hash(historical), historical, performance, nativeTrackIdentity, nativeTrackTopology, additionalItemState, gates,
    readOnlyTrackBinding, expandedRenameGuard, colorNodeReads, nodeAnnotationProof, nativeFieldControl, identityAuthorityDecision, blindIdentity,
    newlyCompletedGateIds: [performance.gateId, blindIdentity.gateId],
    limitations: ['The measurement and finite identity gates are completed for their declared personal scopes.',
      'The historical editor-choice decision remains intact; complete enumeration and native preservation still block ordinary writes.',
      'Identity support is limited to the exact Free build and observed normal flat video/mono-audio structures; concurrent track writes and XML identity mapping remain unproven.',
      'Unsaved exports can retain stale native UUIDs; the supported reader binds verified saved/reopened checkpoints only, not current unsaved editor state.',
      ...performance.limitations] };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(auditIntegrationProgress(), null, 2) + '\n'); }
  catch { process.stderr.write('integration-proof-progress-failed\n'); process.exitCode = 1; }
}
module.exports = { auditIntegrationProgress };
