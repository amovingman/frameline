'use strict';
const { fingerprint } = require('./project-api-contracts');
const { exact, id, asset, hash, integer, time, fail, validateReportInput, validatePlanInput, validateHold, validateRetention } = require('./asset-lifecycle-protocol');
const failResponse = () => { throw fail('asset-response-invalid'); };
const assert = condition => { if (!condition) failResponse(); };
const BLOCKERS = ['not-archived', 'retention-period', 'active-hold', 'retained-revision', 'revision-references-unverified', 'verification-active'];
function validateOwnerReport(value) {
  assert(exact(value, ['schemaVersion', 'projectId', 'generatedAt', 'stateHash', 'referenceStateHash', 'referenceCoverage', 'revisionCount', 'missingRetainedAssets', 'retentionPolicy', 'totalAssets', 'items', 'nextAssetId', 'logicalBytes', 'pendingPhysicalBytes', 'deletionPerformed'])
    && value.schemaVersion === 2 && id(value.projectId) && time(value.generatedAt) && hash(value.stateHash) && hash(value.referenceStateHash)
    && ['complete', 'incomplete'].includes(value.referenceCoverage) && integer(value.revisionCount, 10000) && integer(value.totalAssets, 10000)
    && Array.isArray(value.missingRetainedAssets) && value.missingRetainedAssets.length <= 10000 && value.missingRetainedAssets.every(asset)
    && new Set(value.missingRetainedAssets).size === value.missingRetainedAssets.length && integer(value.logicalBytes) && integer(value.pendingPhysicalBytes)
    && value.deletionPerformed === false && Array.isArray(value.items) && value.items.length <= 100 && value.items.length <= value.totalAssets
    && (value.nextAssetId === null || asset(value.nextAssetId)));
  const policy = validateRetention(value.retentionPolicy); assert(policy.projectId === value.projectId);
  let previous = '';
  for (const row of value.items) {
    assert(exact(row, ['assetId', 'identity', 'archived', 'archivedAt', 'eligibleAt', 'sharedProjects', 'retainedBy', 'hold', 'verificationActive', 'cleanupCandidate', 'blockers', 'physicalBytesReclaimable'])
      && asset(row.assetId) && row.assetId > previous && row.identity?.contentId === row.assetId
      && typeof row.archived === 'boolean' && typeof row.sharedProjects === 'boolean' && typeof row.verificationActive === 'boolean'
      && (row.archived ? time(row.archivedAt) && row.eligibleAt === row.archivedAt + policy.minimumArchiveAgeMs : row.archivedAt === null && row.eligibleAt === null)
      && Array.isArray(row.retainedBy) && row.retainedBy.every(id) && new Set(row.retainedBy).size === row.retainedBy.length
      && Array.isArray(row.blockers) && row.blockers.every(reason => BLOCKERS.includes(reason)) && integer(row.physicalBytesReclaimable));
    const expectedIdentity = require('./media-asset-identity').createMediaAssetIdentity({ size: row.identity.size, sha256: row.assetId.slice(7) }, row.identity);
    assert(fingerprint(expectedIdentity) === fingerprint(row.identity));
    assert(row.physicalBytesReclaimable === 0 || row.physicalBytesReclaimable === row.identity.size);
    const hold = validateHold(row.hold); assert(hold.projectId === value.projectId && hold.assetId === row.assetId);
    const blockers = [];
    if (!row.archived) blockers.push('not-archived'); else if (row.eligibleAt > value.generatedAt) blockers.push('retention-period');
    if (hold.held && (hold.until === null || hold.until > value.generatedAt)) blockers.push('active-hold');
    if (row.retainedBy.length) blockers.push('retained-revision');
    if (value.referenceCoverage !== 'complete') blockers.push('revision-references-unverified');
    if (row.verificationActive) blockers.push('verification-active');
    assert(JSON.stringify(row.blockers) === JSON.stringify(blockers) && row.cleanupCandidate === (blockers.length === 0));
    previous = row.assetId;
  }
  assert(value.nextAssetId === null || value.items.length > 0 && value.nextAssetId === previous);
  return structuredClone(value);
}
function validateGcPlan(value) {
  assert(exact(value, ['schemaVersion', 'projectId', 'generatedAt', 'stateHash', 'referenceStateHash', 'referenceCoverage', 'revisionCount', 'missingRetainedAssets', 'retentionPolicy', 'totalAssets', 'items', 'nextAssetId', 'logicalBytes', 'pendingPhysicalBytes', 'deletionPerformed', 'ready', 'releaseBytes', 'physicalBytesReclaimable', 'planId'])
    && hash(value.planId) && typeof value.ready === 'boolean' && integer(value.releaseBytes) && integer(value.physicalBytesReclaimable));
  const { ready, releaseBytes, physicalBytesReclaimable, planId, ...report } = value;
  validateOwnerReport(report);
  assert(value.items.length > 0 && value.nextAssetId === null && ready === value.items.every(item => item.cleanupCandidate)
    && releaseBytes === value.items.reduce((sum, item) => sum + (item.cleanupCandidate ? item.identity.size : 0), 0)
    && physicalBytesReclaimable === value.items.reduce((sum, item) => sum + (item.cleanupCandidate ? item.physicalBytesReclaimable : 0), 0)
    && fingerprint({ projectId: value.projectId, stateHash: value.stateHash, assetIds: value.items.map(item => item.assetId) }) === planId);
  return structuredClone(value);
}
function validateGcInput(value) {
  if (!exact(value, ['assetIds', 'expectedStateHash', 'planId', 'idempotencyKey']) || !hash(value.planId) || !id(value.idempotencyKey)) throw fail('asset-lifecycle-invalid');
  validatePlanInput({ assetIds: value.assetIds, expectedStateHash: value.expectedStateHash }); return structuredClone(value);
}
function validateGcReceipt(value) {
  assert(exact(value, ['schemaVersion', 'projectId', 'operationId', 'assetIds', 'logicalBytesReleased', 'physicalBytesScheduled', 'deletionPerformed'])
    && value.schemaVersion === 1 && id(value.projectId) && hash(value.operationId) && Array.isArray(value.assetIds)
    && value.assetIds.length > 0 && value.assetIds.length <= 100 && value.assetIds.every(asset) && new Set(value.assetIds).size === value.assetIds.length
    && integer(value.logicalBytesReleased) && integer(value.physicalBytesScheduled) && value.deletionPerformed === true);
  return structuredClone(value);
}
module.exports = { validateOwnerReport, validateGcPlan, validateGcInput, validateGcReceipt, validateReportInput, validatePlanInput };
