'use strict';
const { fingerprint } = require('./project-api-contracts');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, ASSET = /^sha256:[a-f0-9]{64}$/, SHA = /^[a-f0-9]{64}$/;
const MAX_TIME = 8_640_000_000_000_000, DAY = 86400000, MAX_AGE = 3650 * DAY;
const REASONS = ['manual', 'contractual', 'investigation'];
const BLOCKERS = ['not-archived', 'retention-period', 'active-hold', 'shared-project', 'revision-references-unverified'];
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
const id = value => typeof value === 'string' && ID.test(value);
const asset = value => typeof value === 'string' && ASSET.test(value);
const hash = value => typeof value === 'string' && SHA.test(value);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const time = value => integer(value, MAX_TIME);
function check(condition, code = 'asset-lifecycle-invalid') { if (!condition) throw fail(code); }
function validateHoldInput(value) {
  check(exact(value, ['expectedVersion', 'held', 'reason', 'until', 'idempotencyKey']) && integer(value.expectedVersion)
    && typeof value.held === 'boolean' && id(value.idempotencyKey)
    && (value.held ? REASONS.includes(value.reason) && (value.until === null || time(value.until)) : value.reason === null && value.until === null));
  return structuredClone(value);
}
function validateRetentionInput(value) {
  check(exact(value, ['expectedVersion', 'minimumArchiveAgeMs', 'idempotencyKey']) && integer(value.expectedVersion)
    && integer(value.minimumArchiveAgeMs, MAX_AGE) && id(value.idempotencyKey));
  return structuredClone(value);
}
function validateReportInput(value) {
  check(exact(value, ['afterAssetId', 'limit']) && (value.afterAssetId === null || asset(value.afterAssetId))
    && integer(value.limit, 100) && value.limit > 0); return structuredClone(value);
}
function validatePlanInput(value) {
  check(exact(value, ['assetIds', 'expectedStateHash']) && hash(value.expectedStateHash) && Array.isArray(value.assetIds)
    && value.assetIds.length > 0 && value.assetIds.length <= 100 && value.assetIds.every(asset)
    && new Set(value.assetIds).size === value.assetIds.length); return structuredClone(value);
}
function validateHold(value) {
  const valid = exact(value, ['projectId', 'assetId', 'version', 'held', 'reason', 'until', 'updatedAt'])
    && id(value.projectId) && asset(value.assetId) && integer(value.version) && typeof value.held === 'boolean'
    && (value.held ? REASONS.includes(value.reason) && (value.until === null || time(value.until)) : value.reason === null && value.until === null)
    && (value.version === 0 ? value.updatedAt === null && !value.held : time(value.updatedAt))
    && (value.until === null || value.until > value.updatedAt);
  check(valid, 'asset-response-invalid'); return structuredClone(value);
}
function validateRetention(value) {
  check(exact(value, ['projectId', 'version', 'minimumArchiveAgeMs', 'updatedAt']) && id(value.projectId) && integer(value.version)
    && integer(value.minimumArchiveAgeMs, MAX_AGE) && (value.version === 0 ? value.updatedAt === null : time(value.updatedAt)), 'asset-response-invalid');
  return structuredClone(value);
}
function validateItem(value, projectId, observedAt, retention) {
  check(exact(value, ['assetId', 'assetClass', 'size', 'archived', 'archivedAt', 'eligibleAt', 'sharedProjects', 'hold', 'cleanupCandidate', 'blockers'])
    && asset(value.assetId) && ['original', 'proxy', 'audio', 'graphics', 'other'].includes(value.assetClass)
    && integer(value.size, 64 * 1024 ** 3) && typeof value.archived === 'boolean' && typeof value.sharedProjects === 'boolean'
    && (value.archived ? time(value.archivedAt) && time(value.eligibleAt) && value.eligibleAt === value.archivedAt + retention.minimumArchiveAgeMs
      : value.archivedAt === null && value.eligibleAt === null)
    && Array.isArray(value.blockers) && value.blockers.every(reason => BLOCKERS.includes(reason)), 'asset-response-invalid');
  const hold = validateHold(value.hold);
  check(hold.projectId === projectId && hold.assetId === value.assetId, 'asset-response-invalid');
  const blockers = [];
  if (!value.archived) blockers.push('not-archived');
  else if (value.eligibleAt > observedAt) blockers.push('retention-period');
  if (hold.held && (hold.until === null || hold.until > observedAt)) blockers.push('active-hold');
  if (value.sharedProjects) blockers.push('shared-project');
  check(value.cleanupCandidate === (blockers.length === 0), 'asset-response-invalid');
  blockers.push('revision-references-unverified');
  check(JSON.stringify(value.blockers) === JSON.stringify(blockers), 'asset-response-invalid');
}
function validateReport(value) {
  check(exact(value, ['schemaVersion', 'projectId', 'generatedAt', 'stateHash', 'retentionPolicy', 'totalAssets', 'items', 'nextAssetId', 'referenceCoverage', 'deletionPerformed'])
    && value.schemaVersion === 1 && id(value.projectId) && time(value.generatedAt) && hash(value.stateHash)
    && integer(value.totalAssets, 10000) && Array.isArray(value.items) && value.items.length <= 100
    && value.items.length <= value.totalAssets && (value.nextAssetId === null || asset(value.nextAssetId))
    && value.referenceCoverage === 'unverified' && value.deletionPerformed === false, 'asset-response-invalid');
  validateRetention(value.retentionPolicy); check(value.retentionPolicy.projectId === value.projectId, 'asset-response-invalid');
  let previous = '';
  for (const item of value.items) {
    validateItem(item, value.projectId, value.generatedAt, value.retentionPolicy);
    check(item.assetId > previous, 'asset-response-invalid'); previous = item.assetId;
  }
  check(value.nextAssetId === null || value.items.length > 0 && value.nextAssetId === previous, 'asset-response-invalid');
  return structuredClone(value);
}
function validatePlan(value) {
  check(exact(value, ['schemaVersion', 'projectId', 'generatedAt', 'stateHash', 'retentionPolicy', 'items', 'candidateBytes', 'ready', 'deletionPerformed', 'referenceCoverage', 'planId'])
    && value.schemaVersion === 1 && id(value.projectId) && time(value.generatedAt) && hash(value.stateHash) && hash(value.planId)
    && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 100 && integer(value.candidateBytes)
    && value.ready === false && value.deletionPerformed === false && value.referenceCoverage === 'unverified', 'asset-response-invalid');
  validateReport({ schemaVersion: 1, projectId: value.projectId, generatedAt: value.generatedAt, stateHash: value.stateHash,
    retentionPolicy: value.retentionPolicy, totalAssets: value.items.length, items: value.items, nextAssetId: null,
    referenceCoverage: value.referenceCoverage, deletionPerformed: false });
  const { planId, ...body } = value;
  check(planId === fingerprint(body) && value.candidateBytes === value.items.reduce((sum, item) => sum + (item.cleanupCandidate ? item.size : 0), 0), 'asset-response-invalid');
  return structuredClone(value);
}
module.exports = { fail, exact, id, asset, hash, integer, time, MAX_TIME, MAX_AGE, DAY,
  validateHoldInput, validateRetentionInput, validateReportInput, validatePlanInput, validateHold, validateRetention, validateReport, validatePlan };
