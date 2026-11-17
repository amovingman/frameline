const SHA = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Planning-only holds. They must be persisted and enforced by a hosted deletion
// transaction before any production garbage collection can use them.
function createAssetLifecyclePolicy({ authorizeOwner, exportProjectReport, now = () => Date.now() } = {}) {
  if (typeof authorizeOwner !== 'function' || typeof exportProjectReport !== 'function') throw fail('asset-lifecycle-invalid');
  const holds = new Map();
  function checkOwner(actorId, projectId) {
    if (!ID.test(actorId || '') || !ID.test(projectId || '') || authorizeOwner(actorId, projectId) !== true) throw fail('asset-lifecycle-forbidden');
  }
  function key(projectId, assetId) { return JSON.stringify([projectId, assetId]); }
  function setHold({ actorId, projectId, assetId, reason, until = null }) {
    checkOwner(actorId, projectId);
    if (!SHA.test(assetId || '') || !['manual', 'contractual', 'investigation'].includes(reason)
      || until !== null && (!Number.isSafeInteger(until) || until <= now())) throw fail('asset-hold-invalid');
    const hold = { projectId, assetId, reason, until };
    holds.set(key(projectId, assetId), hold);
    return structuredClone(hold);
  }
  function releaseHold({ actorId, projectId, assetId }) {
    checkOwner(actorId, projectId);
    if (!SHA.test(assetId || '')) throw fail('asset-hold-invalid');
    return { released: holds.delete(key(projectId, assetId)) };
  }
  async function planDeletion({ actorId, projectId, assetIds }) {
    checkOwner(actorId, projectId);
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.some(id => !SHA.test(id))
      || new Set(assetIds).size !== assetIds.length) throw fail('asset-deletion-plan-invalid');
    const report = await exportProjectReport(projectId);
    if (!report || report.projectId !== projectId || !Array.isArray(report.assets)) throw fail('asset-deletion-report-invalid');
    const byId = new Map(report.assets.map(asset => [asset.assetId, asset]));
    const items = assetIds.map(assetId => {
      const asset = byId.get(assetId);
      const hold = holds.get(key(projectId, assetId));
      const activeHold = hold && (hold.until === null || hold.until > now());
      const reason = !asset ? 'asset-not-found' : asset.referencedBy?.length ? 'retained-revision'
        : asset.sharedProjects ? 'shared-project' : activeHold ? 'active-hold' : asset.eligible ? null : 'not-eligible';
      return { assetId, deletable: reason === null, reason };
    });
    return { projectId, ready: items.every(item => item.deletable), items, deletionPerformed: false };
  }
  return { setHold, releaseHold, planDeletion, snapshot: () => [...holds.values()].map(value => structuredClone(value)) };
}

module.exports = { createAssetLifecyclePolicy };
