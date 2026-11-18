'use strict';

const BRANCH_REVIEW_ERROR_CODES = Object.freeze(['branch-review-invalid', 'branch-review-unavailable', 'branch-review-cursor-invalid',
  'branch-review-capacity', 'branch-policy-version-conflict', 'branch-not-protected', 'approval-request-invalid',
  'approval-request-unavailable', 'approval-head-stale', 'approval-policy-stale', 'approval-candidate-invalid',
  'approval-forbidden', 'branch-approval-required', 'branch-review-idempotency-conflict']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const identifier = value => typeof value === 'string' && ID.test(value);
const optionalId = value => value === null || identifier(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
const fail = (code = 'sync-response-invalid') => Object.assign(new Error(code), { code });
function validBranchReviewCursor(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [payload, signature] = value.split('.');
  return Buffer.from(payload, 'base64url').toString('base64url') === payload
    && Buffer.from(signature, 'base64url').length === 32 && Buffer.from(signature, 'base64url').toString('base64url') === signature;
}
function validateBranchReviewPageInput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['limit', 'requestCursor', 'candidateCursor'].includes(key))) throw fail('branch-review-invalid');
  const limit = value.limit === undefined ? 20 : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('branch-review-invalid');
  const requestCursor = value.requestCursor ?? null, candidateCursor = value.candidateCursor ?? null;
  if (requestCursor !== null && !validBranchReviewCursor(requestCursor)
    || candidateCursor !== null && !validBranchReviewCursor(candidateCursor)) throw fail('branch-review-cursor-invalid');
  return { limit, requestCursor, candidateCursor };
}
function validateBranchProtection(value) {
  if (!exact(value, ['version', 'requiredApprovals', 'updatedAt', 'updatedBy']) || !integer(value.version)
    || !Number.isSafeInteger(value.requiredApprovals) || value.requiredApprovals < 0 || value.requiredApprovals > 5
    || (value.version === 0 ? value.requiredApprovals !== 0 || value.updatedAt !== null || value.updatedBy !== null
      : !timestamp(value.updatedAt) || !identifier(value.updatedBy))) throw fail();
  return { version: value.version, requiredApprovals: value.requiredApprovals, updatedAt: value.updatedAt, updatedBy: value.updatedBy };
}
function validateBranchCandidate(value, { proposal = false, expectedHead } = {}) {
  const keys = ['revisionId', 'parentRevisionId', 'authorId', 'message', 'manifestId', 'createdAt', ...(proposal ? [] : ['canRequest'])];
  if (!exact(value, keys) || !identifier(value.revisionId) || !optionalId(value.parentRevisionId) || !identifier(value.authorId)
    || !/^sha256:[a-f0-9]{64}$/.test(value.manifestId || '') || typeof value.message !== 'string'
    || !value.message.trim() || value.message !== value.message.trim() || value.message.length > 240
    || /[\x00-\x1f\x7f]/.test(value.message) || !timestamp(value.createdAt)
    || !proposal && typeof value.canRequest !== 'boolean'
    || expectedHead !== undefined && value.parentRevisionId !== expectedHead) throw fail();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function validateBranchApprovalRequest(value, context = {}, branchValue) {
  const { projectId, branch, requestId = null, revisionId = null, expectedHead = undefined, policyVersion = null }
    = typeof context === 'string' ? { projectId: context, branch: branchValue } : context;
  const keys = ['id', 'projectId', 'branch', 'requesterId', 'revisionId', 'expectedHead', 'policyVersion', 'requiredApprovals',
    'createdAt', 'expiresAt', 'status', 'proposal', 'approvals', 'recordedApprovals', 'activeApprovals', 'canApprove', 'applied'];
  if (!exact(value, keys) || !identifier(projectId) || !identifier(branch) || value.projectId !== projectId || value.branch !== branch
    || !identifier(value.id) || requestId !== null && value.id !== requestId || !identifier(value.requesterId)
    || !identifier(value.revisionId) || revisionId !== null && value.revisionId !== revisionId || !optionalId(value.expectedHead)
    || expectedHead !== undefined && value.expectedHead !== expectedHead || !integer(value.policyVersion) || value.policyVersion < 1
    || policyVersion !== null && value.policyVersion !== policyVersion || !Number.isSafeInteger(value.requiredApprovals)
    || value.requiredApprovals < 1 || value.requiredApprovals > 5 || !timestamp(value.createdAt) || !timestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt) || !['pending', 'approved', 'stale', 'expired', 'applied'].includes(value.status)
    || !Array.isArray(value.approvals) || value.approvals.length > 100 || !integer(value.recordedApprovals)
    || value.recordedApprovals !== value.approvals.length || !integer(value.activeApprovals)
    || typeof value.canApprove !== 'boolean') throw fail();
  const proposal = validateBranchCandidate(value.proposal, { proposal: true, expectedHead: value.expectedHead });
  if (proposal.revisionId !== value.revisionId) throw fail();
  const seen = new Set(), approvals = value.approvals.map(item => {
    if (!exact(item, ['actorId', 'at', 'active']) || !identifier(item.actorId) || !timestamp(item.at)
      || typeof item.active !== 'boolean' || seen.has(item.actorId) || [value.requesterId, proposal.authorId].includes(item.actorId)) throw fail();
    seen.add(item.actorId); return { actorId: item.actorId, at: item.at, active: item.active };
  });
  if (value.activeApprovals !== approvals.filter(item => item.active).length
    || value.status === 'approved' && value.activeApprovals < value.requiredApprovals
    || value.status === 'pending' && value.activeApprovals >= value.requiredApprovals
    || ['stale', 'expired'].includes(value.status) && value.canApprove) throw fail();
  let applied = null;
  if (value.status === 'applied') {
    if (!exact(value.applied, ['actorId', 'at', 'revisionId']) || !identifier(value.applied.actorId)
      || value.applied.actorId !== value.requesterId || !timestamp(value.applied.at)
      || value.applied.revisionId !== value.revisionId || value.canApprove) throw fail();
    applied = { actorId: value.applied.actorId, at: value.applied.at, revisionId: value.applied.revisionId };
  } else if (value.applied !== null) throw fail();
  return Object.fromEntries(keys.map(key => [key, key === 'proposal' ? proposal : key === 'approvals' ? approvals : key === 'applied' ? applied : value[key]]));
}
function validateBranchReview(value, projectId, branch, { limit = 20 } = {}) {
  if (!exact(value, ['projectId', 'branch', 'headRevisionId', 'policy', 'candidates', 'requests'])
    || !identifier(projectId) || !identifier(branch) || value.projectId !== projectId || value.branch !== branch
    || !optionalId(value.headRevisionId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail();
  const policy = validateBranchProtection(value.policy);
  function page(input, check, idField) {
    if (!exact(input, ['items', 'nextCursor', 'total']) || !Array.isArray(input.items) || input.items.length > limit
      || !integer(input.total) || input.total < input.items.length
      || input.nextCursor !== null && (!validBranchReviewCursor(input.nextCursor) || input.items.length !== limit)) throw fail();
    const seen = new Set(), items = input.items.map(item => {
      const checked = check(item); if (seen.has(checked[idField])) throw fail(); seen.add(checked[idField]); return checked;
    });
    return { items, nextCursor: input.nextCursor, total: input.total };
  }
  return { projectId, branch, headRevisionId: value.headRevisionId, policy,
    candidates: page(value.candidates, item => {
      const checked = validateBranchCandidate(item, { expectedHead: value.headRevisionId });
      if (checked.canRequest && policy.requiredApprovals === 0) throw fail(); return checked;
    }, 'revisionId'),
    requests: page(value.requests, item => {
      const checked = validateBranchApprovalRequest(item, { projectId, branch });
      if (['pending', 'approved'].includes(checked.status) && (checked.expectedHead !== value.headRevisionId
        || checked.policyVersion !== policy.version || checked.requiredApprovals !== policy.requiredApprovals)) throw fail();
      return checked;
    }, 'id') };
}
module.exports = { BRANCH_REVIEW_ERROR_CODES, validBranchReviewCursor, validateBranchReviewPageInput,
  validateBranchProtection, validateBranchProtectionPolicy: validateBranchProtection,
  validateBranchCandidate, validateBranchApprovalRequest, validateBranchReview };
