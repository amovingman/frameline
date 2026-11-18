// In-memory, read-only three-way preview for Resolve Free schema-3 captures.
const { bindSnapshotSources, verifySnapshotSources } = require('./resolve-snapshot-bindings');
const { parseResolvePreviewSource } = require('./resolve-preview-source');
const { classifyResolveObservations } = require('./resolve-observation-three-way');
const { assessResolvePlan } = require('./resolve-plan-policy');
const { analyzeResolveConflictRules } = require('./resolve-conflict-rules');
const { isDeepStrictEqual } = require('node:util');

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const ROLES = ['base', 'local', 'incoming'];

function invalid() {
  const error = new Error('Invalid or incompatible Resolve preview sources.');
  error.code = 'invalid-resolve-preview';
  throw error;
}

function createResolvePreviewPlan(sources) {
  try {
    const binding = bindSnapshotSources(sources);
    const manifests = {};
    for (const role of ROLES) {
      const source = sources[role];
      if ((Buffer.isBuffer(source) ? source.length : Buffer.byteLength(source, 'utf8')) > MAX_SNAPSHOT_BYTES) invalid();
      manifests[role] = parseResolvePreviewSource(source);
    }
    const classification = classifyResolveObservations(manifests);
    const assessment = assessResolvePlan(classification);
    const conflictRules = analyzeResolveConflictRules(classification);
    const plan = {
      schemaVersion: classification.observationCoverage ? 2 : 1,
      readOnly: true,
      safeToApply: false,
      binding,
      classification,
      assessment,
      conflictRules
    };
    if (plan.schemaVersion === 2 && Buffer.byteLength(JSON.stringify(plan)) > 31 * 1024 * 1024) invalid();
    return plan;
  } catch {
    invalid();
  }
}

function verifyResolvePreviewPlan(plan, sources) {
  try {
    if (!plan || ![1, 2].includes(plan.schemaVersion) || plan.readOnly !== true || plan.safeToApply !== false
      || !plan.binding || !plan.classification || !plan.assessment || !plan.conflictRules) invalid();
    const verification = verifySnapshotSources(plan.binding, sources);
    if (verification.valid && !isDeepStrictEqual(plan, createResolvePreviewPlan(sources))) invalid();
    return verification;
  } catch {
    invalid();
  }
}

/** Verify a prior preview and recalculate it against the current source bytes.
 * Staleness is reported against the prior binding; the returned plan always
 * describes the current sources and remains read-only, including after refresh.
 */
function refreshResolvePreviewPlan(plan, sources) {
  const verification = verifyResolvePreviewPlan(plan, sources);
  return {
    schemaVersion: 1,
    readOnly: true,
    safeToApply: false,
    refreshed: !verification.valid,
    verification,
    plan: createResolvePreviewPlan(sources)
  };
}

module.exports = { createResolvePreviewPlan, verifyResolvePreviewPlan, refreshResolvePreviewPlan };
