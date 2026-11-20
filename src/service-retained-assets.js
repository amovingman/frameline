'use strict';
const { fingerprint } = require('./project-api-contracts');
const { createMediaAssetIdentity } = require('./media-asset-identity');
const { exact, id, asset, hash, fail } = require('./asset-lifecycle-protocol');
const { validateOwnerReport, validateGcPlan, validateGcInput, validateGcReceipt, validateReportInput, validatePlanInput } = require('./retained-asset-protocol');
const emptyGc = () => ({ version: 1, deleted: [], receipts: [], pending: [] });
function validateReferences(value, projectId) {
  if (!exact(value, ['projectId', 'stateHash', 'complete', 'revisions']) || value.projectId !== projectId || !hash(value.stateHash)
    || typeof value.complete !== 'boolean' || !Array.isArray(value.revisions) || value.revisions.length > 10000) throw fail('asset-reference-invalid');
  const revisions = new Set();
  for (const row of value.revisions) {
    if (!exact(row, ['revisionId', 'manifestId', 'sourceHash', 'assets']) || !id(row.revisionId) || revisions.has(row.revisionId)
      || !asset(row.manifestId) || !(row.sourceHash === null && !value.complete || hash(row.sourceHash)) || !Array.isArray(row.assets) || row.assets.length > 10000) throw fail('asset-reference-invalid');
    revisions.add(row.revisionId);
    for (const identity of row.assets) {
      let checked; try { checked = createMediaAssetIdentity({ size: identity.size, sha256: identity.contentId.slice(7) }, identity); } catch { throw fail('asset-reference-invalid'); }
      if (fingerprint(checked) !== fingerprint(identity)) throw fail('asset-reference-invalid');
    }
  }
  const { stateHash, ...body } = value; if (fingerprint(body) !== stateHash) throw fail('asset-reference-invalid');
  return structuredClone(value);
}
function validateGcState(value, validateIdentity, uuid) {
  if (!exact(value, ['version', 'deleted', 'receipts', 'pending']) || value.version !== 1
    || ['deleted', 'receipts', 'pending'].some(key => !Array.isArray(value[key]) || value[key].length > 10000)) throw fail('asset-state-invalid');
  const deleted = new Set(), keys = new Set(), blobs = new Set();
  for (const row of value.deleted) {
    const key = JSON.stringify([row.projectId, row.assetId]);
    if (!exact(row, ['projectId', 'assetId', 'uploadId', 'identity']) || !id(row.projectId) || !asset(row.assetId) || !uuid.test(row.uploadId) || deleted.has(key)
      || row.assetId !== row.identity?.contentId) throw fail('asset-state-invalid');
    validateIdentity(row.identity); deleted.add(key);
  }
  for (const receipt of value.receipts) {
    if (!exact(receipt, ['keyHash', 'requestHash', 'actorId', 'projectId', 'input', 'result']) || !hash(receipt.keyHash) || keys.has(receipt.keyHash)
      || !hash(receipt.requestHash) || !id(receipt.actorId) || !id(receipt.projectId)) throw fail('asset-state-invalid');
    validateGcInput(receipt.input); validateGcReceipt(receipt.result);
    if (receipt.result.projectId !== receipt.projectId || receipt.result.operationId !== receipt.requestHash
      || receipt.keyHash !== fingerprint({ domain: 'asset-gc-receipt-v1', actorId: receipt.actorId, projectId: receipt.projectId, key: receipt.input.idempotencyKey })
      || JSON.stringify(receipt.result.assetIds) !== JSON.stringify([...receipt.input.assetIds].sort())
      || receipt.requestHash !== fingerprint({ actorId: receipt.actorId, projectId: receipt.projectId, input: receipt.input })) throw fail('asset-state-invalid');
    keys.add(receipt.keyHash);
  }
  for (const row of value.pending) {
    if (!exact(row, ['projectId', 'blob']) || !id(row.projectId) || !row.blob || !uuid.test(row.blob.id) || blobs.has(row.blob.id)) throw fail('asset-state-invalid');
    blobs.add(row.blob.id);
  }
}
function createRetainedAssetOperations({ lifecycle }) {
  function report(state, projectId, references, raw, selectedIds = null) {
    const input = validateReportInput(raw), refs = validateReferences(references, projectId), policy = lifecycle.retention(state, projectId), at = lifecycle.clock();
    const retained = new Map();
    for (const revision of refs.revisions) for (const identity of revision.assets) {
      if (!retained.has(identity.contentId)) retained.set(identity.contentId, new Set()); retained.get(identity.contentId).add(revision.revisionId);
    }
    const uploads = new Map(state.uploads.map(upload => [upload.id, upload]));
    const blobUses = new Map(), projectCounts = new Map();
    for (const upload of state.uploads) blobUses.set(upload.blobId, (blobUses.get(upload.blobId) || 0) + 1);
    for (const item of state.assets) projectCounts.set(item.assetId, (projectCounts.get(item.assetId) || 0) + 1);
    const archives = new Map(state.lifecycle.archives.filter(row => row.projectId === projectId).map(row => [row.assetId, row.archivedAt]));
    const holds = new Map(state.lifecycle.holds.filter(row => row.projectId === projectId).map(row => [row.assetId, row]));
    const activeJobs = new Set(state.jobs.jobs.filter(job => job.projectId === projectId && ['queued', 'running'].includes(job.status)).map(job => job.assetId));
    const rows = state.assets.filter(item => item.projectId === projectId).map(item => {
      const upload = uploads.get(item.uploadId), archivedAt = archives.get(item.assetId) ?? null;
      const hold = structuredClone(holds.get(item.assetId) || { projectId, assetId: item.assetId, version: 0, held: false, reason: null, until: null, updatedAt: null });
      const retainedBy = [...(retained.get(item.assetId) || [])].sort();
      const verificationActive = activeJobs.has(item.assetId);
      const physicalShared = blobUses.get(upload.blobId) > 1;
      const blockers = [];
      if (!item.archived) blockers.push('not-archived'); else if (archivedAt + policy.minimumArchiveAgeMs > at) blockers.push('retention-period');
      if (hold.held && (hold.until === null || hold.until > at)) blockers.push('active-hold');
      if (retainedBy.length) blockers.push('retained-revision'); if (!refs.complete) blockers.push('revision-references-unverified');
      if (verificationActive) blockers.push('verification-active');
      return { assetId: item.assetId, identity: structuredClone(upload.identity), archived: item.archived, archivedAt,
        eligibleAt: archivedAt === null ? null : archivedAt + policy.minimumArchiveAgeMs,
        sharedProjects: projectCounts.get(item.assetId) > 1, retainedBy, hold, verificationActive,
        cleanupCandidate: blockers.length === 0, blockers, physicalBytesReclaimable: physicalShared ? 0 : upload.identity.size };
    }).sort((a, b) => a.assetId < b.assetId ? -1 : 1);
    const stateHash = fingerprint({ projectId, referenceStateHash: refs.stateHash, policy, rows });
    const remaining = rows.filter(row => input.afterAssetId === null || row.assetId > input.afterAssetId);
    const byId = new Map(rows.map(row => [row.assetId, row]));
    const selected = selectedIds ? [...selectedIds].sort().map(aid => { if (!byId.has(aid)) throw fail('asset-not-found'); return byId.get(aid); }) : remaining.slice(0, input.limit);
    const known = new Set(rows.map(row => row.assetId));
    return validateOwnerReport({ schemaVersion: 2, projectId, generatedAt: at, stateHash, referenceStateHash: refs.stateHash,
      referenceCoverage: refs.complete ? 'complete' : 'incomplete', revisionCount: refs.revisions.length, missingRetainedAssets: [...retained.keys()].filter(aid => !known.has(aid)).sort(),
      retentionPolicy: policy, totalAssets: rows.length, items: selected, nextAssetId: !selectedIds && remaining.length > selected.length ? selected.at(-1).assetId : null,
      logicalBytes: rows.reduce((sum, row) => sum + row.identity.size, 0), pendingPhysicalBytes: state.garbageCollection.pending.filter(row => row.projectId === projectId).reduce((sum, row) => sum + row.blob.identity.size, 0), deletionPerformed: false });
  }
  function plan(state, projectId, references, raw) {
    const input = validatePlanInput(raw); const all = report(state, projectId, references, { afterAssetId: null, limit: 100 }, input.assetIds);
    if (all.stateHash !== input.expectedStateHash) throw fail('asset-lifecycle-plan-stale');
    const items = all.items;
    const body = { ...all, items, nextAssetId: null, ready: items.every(row => row.cleanupCandidate),
      releaseBytes: items.reduce((sum, row) => sum + (row.cleanupCandidate ? row.identity.size : 0), 0),
      physicalBytesReclaimable: items.reduce((sum, row) => sum + (row.cleanupCandidate ? row.physicalBytesReclaimable : 0), 0) };
    return validateGcPlan({ ...body, planId: fingerprint({ projectId, stateHash: body.stateHash, assetIds: items.map(item => item.assetId) }) });
  }
  function execute(state, actorId, projectId, references, raw) {
    const input = validateGcInput(raw); const requestHash = fingerprint({ actorId, projectId, input });
    const keyHash = fingerprint({ domain: 'asset-gc-receipt-v1', actorId, projectId, key: input.idempotencyKey });
    const previous = state.garbageCollection.receipts.find(item => item.keyHash === keyHash);
    if (previous) { if (previous.requestHash !== requestHash) throw fail('asset-lifecycle-idempotency-conflict'); return structuredClone(previous.result); }
    const checked = plan(state, projectId, references, { assetIds: input.assetIds, expectedStateHash: input.expectedStateHash });
    if (checked.planId !== input.planId) throw fail('asset-lifecycle-plan-stale');
    if (!checked.ready) throw fail('asset-gc-blocked');
    if (state.garbageCollection.receipts.length >= 10000 || state.garbageCollection.deleted.length + input.assetIds.length > 10000) throw fail('asset-capacity-exceeded');
    const ids = new Set(input.assetIds); const removed = state.assets.filter(item => item.projectId === projectId && ids.has(item.assetId));
    const uploadIds = new Set(removed.map(item => item.uploadId));
    for (const item of removed) {
      const upload = state.uploads.find(row => row.id === item.uploadId); const tombstone = { projectId, assetId: item.assetId, uploadId: item.uploadId, identity: structuredClone(upload.identity) };
      const existing = state.garbageCollection.deleted.findIndex(row => row.projectId === projectId && row.assetId === item.assetId);
      if (existing < 0) state.garbageCollection.deleted.push(tombstone); else state.garbageCollection.deleted[existing] = tombstone;
    }
    state.assets = state.assets.filter(item => !uploadIds.has(item.uploadId)); state.uploads = state.uploads.filter(item => !uploadIds.has(item.id));
    state.lifecycle.archives = state.lifecycle.archives.filter(item => item.projectId !== projectId || !ids.has(item.assetId));
    const used = new Set(state.uploads.map(upload => upload.blobId)); const unused = state.blobs.filter(blob => !used.has(blob.id));
    state.blobs = state.blobs.filter(blob => used.has(blob.id));
    for (const blob of unused) state.garbageCollection.pending.push({ projectId, blob });
    const result = validateGcReceipt({ schemaVersion: 1, projectId, operationId: requestHash, assetIds: [...input.assetIds].sort(), logicalBytesReleased: checked.releaseBytes,
      physicalBytesScheduled: unused.reduce((sum, blob) => sum + blob.identity.size, 0), deletionPerformed: true });
    state.garbageCollection.receipts.push({ keyHash, requestHash, actorId, projectId, input, result }); return result;
  }
  return { report, plan, execute };
}
module.exports = { emptyGc, validateGcState, validateReferences, createRetainedAssetOperations };
