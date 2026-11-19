'use strict';
const { fingerprint } = require('./project-api-contracts');
const { fail, exact, id, asset, hash, time, DAY, MAX_TIME, validateHoldInput, validateRetentionInput,
  validateReportInput, validatePlanInput, validateHold, validateRetention, validateReport, validatePlan } = require('./asset-lifecycle-protocol');
const clone = value => structuredClone(value);
const fields = (value, omit) => Object.fromEntries(Object.entries(value).filter(([key]) => !omit.includes(key)));
const emptyLifecycle = () => ({ version: 1, holds: [], policies: [], receipts: [], archives: [] });
function validateAssetLifecycleState(value, assets) {
  try {
    if (!exact(value, ['version', 'holds', 'policies', 'receipts', 'archives']) || value.version !== 1
      || ['holds', 'policies', 'receipts', 'archives'].some(key => !Array.isArray(value[key]) || value[key].length > 10000)) throw fail('invalid');
    const published = new Map(assets.map(item => [JSON.stringify([item.projectId, item.assetId]), item]));
    const holds = new Map(), policies = new Map(), keys = new Set(), archives = new Set();
    for (const hold of value.holds) {
      validateHold(hold); const key = JSON.stringify([hold.projectId, hold.assetId]);
      if (hold.version < 1 || holds.has(key) || !published.has(key)) throw fail('invalid'); holds.set(key, hold);
    }
    for (const policy of value.policies) {
      validateRetention(policy);
      if (policy.version < 1 || policies.has(policy.projectId)) throw fail('invalid'); policies.set(policy.projectId, policy);
    }
    for (const item of value.archives) {
      const key = JSON.stringify([item.projectId, item.assetId]);
      if (!exact(item, ['projectId', 'assetId', 'archivedAt']) || !id(item.projectId) || !asset(item.assetId)
        || !time(item.archivedAt) || item.archivedAt > MAX_TIME - 3650 * DAY || archives.has(key) || !published.get(key)?.archived) throw fail('invalid');
      archives.add(key);
    }
    if (assets.some(item => item.archived && !archives.has(JSON.stringify([item.projectId, item.assetId])))) throw fail('invalid');
    for (const receipt of value.receipts) {
      if (!exact(receipt, ['keyHash', 'requestHash', 'actorId', 'projectId', 'kind', 'assetId', 'input', 'result'])
        || !hash(receipt.keyHash) || !hash(receipt.requestHash) || keys.has(receipt.keyHash) || !id(receipt.actorId)
        || !id(receipt.projectId) || !['hold', 'retention'].includes(receipt.kind)) throw fail('invalid');
      const validation = receipt.kind === 'hold' ? validateHoldInput : validateRetentionInput;
      validation({ ...receipt.input, idempotencyKey: 'receipt-validation' });
      if (Object.hasOwn(receipt.input, 'idempotencyKey')) throw fail('invalid');
      const result = receipt.kind === 'hold' ? validateHold(receipt.result) : validateRetention(receipt.result);
      const current = receipt.kind === 'hold' ? holds.get(JSON.stringify([receipt.projectId, receipt.assetId])) : policies.get(receipt.projectId);
      if (receipt.kind === 'hold' ? !asset(receipt.assetId) || result.assetId !== receipt.assetId
        || ['held', 'reason', 'until'].some(key => result[key] !== receipt.input[key]) : receipt.assetId !== null
        || result.minimumArchiveAgeMs !== receipt.input.minimumArchiveAgeMs) throw fail('invalid');
      if (!current || result.projectId !== receipt.projectId || result.version !== receipt.input.expectedVersion + 1
        || result.version > current.version || result.version === current.version && fingerprint(result) !== fingerprint(current)
        || receipt.requestHash !== fingerprint(fields(receipt, ['keyHash', 'requestHash', 'result']))) throw fail('invalid');
      keys.add(receipt.keyHash);
    }
    return clone(value);
  } catch { throw fail('asset-state-invalid'); }
}
function createAssetLifecycleOperations({ now = Date.now } = {}) {
  function clock() { const at = now(); if (!time(at) || at > MAX_TIME - 3650 * DAY) throw fail('asset-lifecycle-invalid'); return at; }
  const hold = (state, pid, aid) => clone(state.lifecycle.holds.find(item => item.projectId === pid && item.assetId === aid)
    || { projectId: pid, assetId: aid, version: 0, held: false, reason: null, until: null, updatedAt: null });
  const retention = (state, pid) => clone(state.lifecycle.policies.find(item => item.projectId === pid)
    || { projectId: pid, version: 0, minimumArchiveAgeMs: 30 * DAY, updatedAt: null });
  function published(state, pid, aid) {
    if (!asset(aid)) throw fail('asset-lifecycle-invalid');
    const found = state.assets.find(item => item.projectId === pid && item.assetId === aid);
    if (!found) throw fail('asset-not-found'); return found;
  }
  function mutate(state, actorId, projectId, assetId, kind, raw) {
    const input = (kind === 'hold' ? validateHoldInput : validateRetentionInput)(raw);
    if (!id(actorId) || !id(projectId)) throw fail('asset-lifecycle-invalid');
    if (kind === 'hold') published(state, projectId, assetId);
    const intent = { actorId, projectId, kind, assetId, input: fields(input, ['idempotencyKey']) };
    const keyHash = fingerprint({ domain: 'asset-lifecycle-receipt-v1', actorId, projectId, key: input.idempotencyKey });
    const requestHash = fingerprint(intent), receipt = state.lifecycle.receipts.find(item => item.keyHash === keyHash);
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw fail('asset-lifecycle-idempotency-conflict'); return clone(receipt.result);
    }
    const previous = kind === 'hold' ? hold(state, projectId, assetId) : retention(state, projectId);
    if (previous.version !== input.expectedVersion) throw fail('asset-lifecycle-version-conflict');
    if (state.lifecycle.receipts.length >= 10000 || previous.version === Number.MAX_SAFE_INTEGER) throw fail('asset-capacity-exceeded');
    const at = Math.max(clock(), previous.updatedAt || 0);
    if (kind === 'hold' && input.until !== null && input.until <= at) throw fail('asset-lifecycle-invalid');
    const result = kind === 'hold' ? { projectId, assetId, version: previous.version + 1, held: input.held, reason: input.reason, until: input.until, updatedAt: at }
      : { projectId, version: previous.version + 1, minimumArchiveAgeMs: input.minimumArchiveAgeMs, updatedAt: at };
    const collection = kind === 'hold' ? state.lifecycle.holds : state.lifecycle.policies;
    if (previous.version === 0 && collection.length >= 10000) throw fail('asset-capacity-exceeded');
    const atIndex = collection.findIndex(item => item.projectId === projectId && (kind !== 'hold' || item.assetId === assetId));
    if (atIndex < 0) collection.push(result); else collection[atIndex] = result;
    state.lifecycle.receipts.push({ keyHash, requestHash, ...intent, result }); return clone(result);
  }
  function data(state, projectId) {
    const policy = retention(state, projectId), uploads = new Map(state.uploads.map(item => [item.id, item]));
    const counts = new Map(); for (const item of state.assets) counts.set(item.assetId, (counts.get(item.assetId) || 0) + 1);
    const archives = new Map(state.lifecycle.archives.filter(item => item.projectId === projectId).map(item => [item.assetId, item.archivedAt]));
    const rows = state.assets.filter(item => item.projectId === projectId).map(item => {
      const upload = uploads.get(item.uploadId), archivedAt = archives.get(item.assetId) ?? null;
      return { assetId: item.assetId, assetClass: upload.identity.assetClass, size: upload.identity.size, archived: item.archived,
        archivedAt, eligibleAt: archivedAt === null ? null : archivedAt + policy.minimumArchiveAgeMs,
        sharedProjects: counts.get(item.assetId) > 1, hold: hold(state, projectId, item.assetId) };
    }).sort((a, b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
    return { policy, rows, stateHash: fingerprint({ domain: 'asset-lifecycle-state-v1', projectId, policy, rows }) };
  }
  function describe(row, at) {
    const blockers = [];
    if (!row.archived) blockers.push('not-archived'); else if (row.eligibleAt > at) blockers.push('retention-period');
    if (row.hold.held && (row.hold.until === null || row.hold.until > at)) blockers.push('active-hold');
    if (row.sharedProjects) blockers.push('shared-project');
    const cleanupCandidate = blockers.length === 0;
    blockers.push('revision-references-unverified'); return { ...row, cleanupCandidate, blockers };
  }
  return {
    clock,
    hold: (state, pid, aid) => { published(state, pid, aid); return hold(state, pid, aid); }, retention,
    setHold: (state, actor, pid, aid, input) => mutate(state, actor, pid, aid, 'hold', input),
    setRetention: (state, actor, pid, input) => mutate(state, actor, pid, null, 'retention', input),
    report(state, pid, raw) {
      const input = validateReportInput(raw), { policy, rows, stateHash } = data(state, pid), at = clock();
      const remaining = rows.filter(row => input.afterAssetId === null || row.assetId > input.afterAssetId), selected = remaining.slice(0, input.limit);
      return validateReport({ schemaVersion: 1, projectId: pid, generatedAt: at, stateHash, retentionPolicy: policy, totalAssets: rows.length,
        items: selected.map(row => describe(row, at)), nextAssetId: remaining.length > selected.length ? selected.at(-1).assetId : null,
        referenceCoverage: 'unverified', deletionPerformed: false });
    },
    plan(state, pid, raw) {
      const input = validatePlanInput(raw), { policy, rows, stateHash } = data(state, pid), at = clock();
      if (stateHash !== input.expectedStateHash) throw fail('asset-lifecycle-plan-stale');
      const byId = new Map(rows.map(row => [row.assetId, row]));
      const items = [...input.assetIds].sort().map(aid => {
        if (!byId.has(aid)) throw fail('asset-not-found'); return describe(byId.get(aid), at);
      });
      const body = { schemaVersion: 1, projectId: pid, generatedAt: at, stateHash, retentionPolicy: policy, items,
        candidateBytes: items.reduce((sum, item) => sum + (item.cleanupCandidate ? item.size : 0), 0), ready: false,
        deletionPerformed: false, referenceCoverage: 'unverified' };
      return validatePlan({ ...body, planId: fingerprint(body) });
    }
  };
}
module.exports = { emptyLifecycle, validateAssetLifecycleState, createAssetLifecycleOperations };
