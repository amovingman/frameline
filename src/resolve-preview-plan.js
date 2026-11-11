// In-memory, read-only three-way preview for Resolve Free schema-3 captures.
const { bindSnapshotSources, verifySnapshotSources } = require('./resolve-snapshot-bindings');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { classifyResolveThreeWay } = require('./resolve-three-way-classifier');
const { assessResolvePlan } = require('./resolve-plan-policy');

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
      manifests[role] = normalizeResolveSnapshot(JSON.parse(Buffer.isBuffer(source) ? source.toString('utf8') : source));
    }
    const classification = classifyResolveThreeWay(manifests.base, manifests.local, manifests.incoming);
    const assessment = assessResolvePlan(classification);
    return {
      schemaVersion: 1,
      readOnly: true,
      safeToApply: false,
      binding,
      classification,
      assessment
    };
  } catch {
    invalid();
  }
}

function verifyResolvePreviewPlan(plan, sources) {
  try {
    if (!plan || plan.schemaVersion !== 1 || plan.readOnly !== true || plan.safeToApply !== false
      || !plan.binding || !plan.classification || !plan.assessment) invalid();
    return verifySnapshotSources(plan.binding, sources);
  } catch {
    invalid();
  }
}

module.exports = { createResolvePreviewPlan, verifyResolvePreviewPlan };
