const { randomUUID } = require('node:crypto');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Local policy gate. The authorized service calls assertCanAdvance immediately
// before its compare-and-swap branch update; the history store still owns CAS.
function createBranchProtection({ authorize, getHead, now = () => Date.now() } = {}) {
  if (typeof authorize !== 'function' || typeof getHead !== 'function') throw fail('branch-protection-invalid');
  const policies = new Map(), requests = new Map();
  const key = (projectId, branch) => JSON.stringify([projectId, branch]);
  function checkIds(projectId, branch) {
    if (!ID.test(projectId || '') || !ID.test(branch || '')) throw fail('branch-protection-invalid');
  }
  function setPolicy({ actorId, projectId, branch, requiredApprovals }) {
    checkIds(projectId, branch);
    if (!ID.test(actorId || '') || authorize(actorId, projectId, 'manage') !== true
      || !Number.isSafeInteger(requiredApprovals) || requiredApprovals < 0 || requiredApprovals > 5) throw fail('branch-protection-forbidden');
    policies.set(key(projectId, branch), requiredApprovals);
    return { projectId, branch, requiredApprovals };
  }
  function request({ actorId, projectId, branch, expectedHead = null, revisionId }) {
    checkIds(projectId, branch);
    if (!ID.test(actorId || '') || !ID.test(revisionId || '')
      || expectedHead !== null && !ID.test(expectedHead)
      || authorize(actorId, projectId, 'request') !== true) throw fail('approval-request-invalid');
    const requiredApprovals = policies.get(key(projectId, branch)) || 0;
    if (!requiredApprovals) throw fail('branch-not-protected');
    if (getHead(projectId, branch) !== expectedHead) throw fail('approval-head-stale');
    const value = { id: randomUUID(), actorId, projectId, branch, expectedHead,
      revisionId, requiredApprovals, approverIds: [], expiresAt: now() + 7 * 24 * 60 * 60_000 };
    requests.set(value.id, value);
    return structuredClone(value);
  }
  function approve({ actorId, requestId }) {
    const value = requests.get(requestId);
    if (!value || now() >= value.expiresAt) throw fail('approval-request-unavailable');
    if (!ID.test(actorId || '') || actorId === value.actorId
      || authorize(actorId, value.projectId, 'approve') !== true) throw fail('approval-forbidden');
    if (getHead(value.projectId, value.branch) !== value.expectedHead) throw fail('approval-head-stale');
    if (!value.approverIds.includes(actorId)) value.approverIds.push(actorId);
    return { requestId, approved: value.approverIds.length, required: value.requiredApprovals };
  }
  function assertCanAdvance({ actorId, projectId, branch, expectedHead = null, revisionId }) {
    checkIds(projectId, branch);
    const required = policies.get(key(projectId, branch)) || 0;
    if (!required) return { protected: false };
    const value = [...requests.values()].find(item => item.actorId === actorId
      && item.projectId === projectId && item.branch === branch && item.expectedHead === expectedHead
      && item.revisionId === revisionId && item.expiresAt > now());
    const activeApprovers = value?.approverIds.filter(id => {
      try { return authorize(id, projectId, 'approve') === true; }
      catch { return false; }
    }) || [];
    if (!value || activeApprovers.length < required) throw fail('branch-approval-required');
    if (getHead(projectId, branch) !== expectedHead) throw fail('approval-head-stale');
    return { protected: true, requestId: value.id, approvals: activeApprovers.length };
  }
  return { setPolicy, request, approve, assertCanAdvance };
}

module.exports = { createBranchProtection };
