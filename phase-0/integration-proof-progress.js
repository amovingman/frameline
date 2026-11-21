'use strict';
// Current evidence extends, rather than rewrites, the historical gate decision.
const { createHash } = require('node:crypto');
const { auditIntegrationGates } = require('./integration-gates');
const { auditOperationPerformance } = require('./audit-operation-performance');
const { auditNativeTrackEvidence } = require('./native-track-evidence-audit');
const { auditNativeTrackTopologyEvidence } = require('./native-track-topology-evidence-audit');
const { auditItemStateEvidence } = require('./item-state-evidence');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function auditIntegrationProgress() {
  const historical = auditIntegrationGates();
  const performance = auditOperationPerformance();
  const nativeTrackIdentity = auditNativeTrackEvidence();
  const nativeTrackTopology = auditNativeTrackTopologyEvidence();
  const additionalItemState = auditItemStateEvidence();
  if (performance.measurementEvidenceComplete !== true || performance.safeToApply !== false
    || performance.fullPreservation !== false) throw new Error('integration-proof-incomplete');
  const gates = historical.gates.map(gate => gate.id === performance.gateId ? {
    id: gate.id, status: 'complete',
    evidence: 'Source-bound same-fixture scans, native backup and reviewed rename/save/reopen/rollback timings, independently verified represented restoration, and sampled editor RSS.',
    scope: performance.scope, evidenceSha256: hash(performance)
  } : gate.id === 'stable-clip-and-track-identity' ? { ...gate,
    evidence: 'Controlled native name/save/reopen and topology challenges retain track UUIDs through index shifts and distinguish same-index recreation, including empty duplicate-name tracks. A general read-only API/export identity binding remains unproven.',
    evidenceSha256: hash({ nativeTrackIdentity, nativeTrackTopology })
  } : gate.id === 'lossless-editor-fields' ? { ...gate,
    evidence: 'Typed reads cover seven additional item-state families on 50 items and detect a saved/reopened enabled-state change invisible to the older rich capture, followed by exact restoration. Failed captures expose getter-context dependence. General write guards and complete native field coverage remain unproven.',
    evidenceSha256: hash(additionalItemState)
  } : { ...gate });
  return { schemaVersion: 1, readOnly: true, safeToApply: false, ordinaryApplyEnabled: false,
    releaseSupported: false, fullNativePreservationProven: false,
    historicalAuditSha256: hash(historical), historical, performance, nativeTrackIdentity, nativeTrackTopology, additionalItemState, gates,
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
