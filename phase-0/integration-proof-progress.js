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
  const identityAuthorityDecision = { file: 'RESOLVE_IDENTITY_AUTHORITY.md',
    sha256: createHash('sha256').update(readInput(path.join(__dirname, '../RESOLVE_IDENTITY_AUTHORITY.md'))).digest('hex'),
    clipWriteLocator: 'live-api-project-timeline-item-uuid', fcpxmlWriteAuthority: false, ordinaryApplyEnabled: false };
  if (performance.measurementEvidenceComplete !== true || performance.safeToApply !== false
    || performance.fullPreservation !== false) throw new Error('integration-proof-incomplete');
  const gates = historical.gates.map(gate => gate.id === performance.gateId ? {
    id: gate.id, status: 'complete',
    evidence: 'Source-bound same-fixture scans, native backup and reviewed rename/save/reopen/rollback timings, independently verified represented restoration, and sampled editor RSS.',
    scope: performance.scope, evidenceSha256: hash(performance)
  } : gate.id === 'stable-clip-and-track-identity' ? { ...gate,
    evidence: 'A fresh challenge-free read-only capture/export interval rebinds all five tracks against 21 independently calibrated associations. It requires the unchanged calibrated identity graph; general empty-track binding remains unproven. API UUIDs locate experimental clip writes; FCPXML is read-only.',
    evidenceSha256: hash({ nativeTrackIdentity, nativeTrackTopology, readOnlyTrackBinding, identityAuthorityDecision })
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
    readOnlyTrackBinding, expandedRenameGuard, colorNodeReads, nodeAnnotationProof, nativeFieldControl, identityAuthorityDecision,
    newlyCompletedGateIds: [performance.gateId],
    limitations: ['Only the personal-scope measurement gate is completed by this report.',
      'The historical editor-choice decision remains intact; enumeration, stable identity and native preservation still block ordinary writes.',
      ...performance.limitations] };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(auditIntegrationProgress(), null, 2) + '\n'); }
  catch { process.stderr.write('integration-proof-progress-failed\n'); process.exitCode = 1; }
}
module.exports = { auditIntegrationProgress };
