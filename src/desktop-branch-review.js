'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { BRANCH_REVIEW_ERROR_CODES, validateBranchReview, validateBranchProtectionPolicy,
  validateBranchApprovalRequest } = require('./branch-review-protocol');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const ERRORS = new Set([...BRANCH_REVIEW_ERROR_CODES, 'branch-review-selection-changed', 'branch-review-refresh-required',
  'branch-review-busy', 'branch-review-display-limit', 'branch-review-local-error', 'forbidden', 'project-not-found',
  'branch-not-found', 'access-token-invalid', 'service-sign-in-required', 'service-credential-storage-unavailable',
  'sync-network-unavailable', 'service-offline', 'sync-cancelled', 'sync-response-invalid', 'sync-response-too-large',
  'rate-limit-exceeded', 'service-connection-failed']);
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const safeError = error => ERRORS.has(error?.code) ? error.code : 'branch-review-local-error';

// The renderer chooses an accessible service branch. Head, policy, candidate and
// retry identities come from validated service observations in the main process.
function createDesktopBranchReview({ connection, onChange = () => {}, now = Date.now } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof onChange !== 'function' || typeof now !== 'function') throw fail('branch-review-invalid');
  const empty = () => ({ scopeId: null, selection: null, available: false, ready: false, busy: false, error: null,
    role: null, headRevisionId: null, policy: null, candidates: [], requests: [], nextCandidateCursor: null,
    nextRequestCursor: null, checkedAt: null, outcome: null });
  let state = { version: 0, ...empty() }, selected = null, identity = null, accessKey = null;
  let epoch = 0, active = null, closed = false, nonce = randomUUID();
  const tasks = new Set(), retries = new Map();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* A display failure cannot undo a receipt. */ }
    return clone(state);
  }
  function context() {
    const account = connection.getState();
    if (!selected || !['connected', 'offline'].includes(account.status) || !account.origin || !ID.test(account.account?.id || '')) return null;
    const project = account.projects?.find(item => item.id === selected.projectId && item.branches?.includes(selected.branch));
    if (!project || !['owner', 'editor', 'viewer'].includes(project.role)) return null;
    const id = fingerprint([account.origin, account.account.id, selected.projectId, selected.branch]);
    return { identity: id, key: fingerprint([id, project.role]), actorId: account.account.id,
      role: project.role, connected: account.status === 'connected', ...selected };
  }
  function scope(ctx, head = null, policy = null) { return fingerprint([nonce, ctx.key, head, policy?.version ?? null]); }
  function align() {
    const ctx = context();
    if (closed) return null;
    if ((ctx?.key || null) !== accessKey) {
      epoch++; active?.controller.abort(); active = null; nonce = randomUUID();
      if ((ctx?.identity || null) !== identity) retries.clear();
      identity = ctx?.identity || null; accessKey = ctx?.key || null;
      publish({ ...empty(), selection: selected ? clone(selected) : null, available: !!ctx, role: ctx?.role || null,
        scopeId: ctx ? scope(ctx) : null });
    }
    return ctx;
  }
  function current(operation) {
    const ctx = align();
    if (closed || !ctx || ctx.key !== operation.key || epoch !== operation.epoch
      || active !== operation || operation.controller.signal.aborted) throw fail('branch-review-selection-changed');
    return ctx;
  }
  function errorState(error) {
    const code = safeError(error);
    const invalid = ['forbidden', 'project-not-found', 'branch-not-found', 'access-token-invalid', 'service-sign-in-required',
      'branch-review-selection-changed', 'branch-review-cursor-invalid', 'branch-policy-version-conflict', 'approval-head-stale', 'approval-policy-stale'].includes(code);
    if (invalid) {
      nonce = randomUUID(); const ctx = context();
      publish({ ready: false, headRevisionId: null, policy: null, candidates: [], requests: [], nextCandidateCursor: null,
        nextRequestCursor: null, checkedAt: null, scopeId: ctx ? scope(ctx) : null, error: code });
    } else publish({ error: code });
  }
  async function page(operation, client, ctx, view = 'all') {
    const append = view !== 'all', field = view === 'requests' ? 'requests' : 'candidates';
    const cursorField = view === 'requests' ? 'nextRequestCursor' : 'nextCandidateCursor';
    const cursor = append ? state[cursorField] : null, previous = append ? clone(state[field]) : [];
    if (append && (!state.ready || !cursor || previous.length >= 500)) throw fail('branch-review-display-limit');
    const result = validateBranchReview(await client.getBranchReview(ctx.projectId, ctx.branch, { limit: 20,
      requestCursor: view === 'requests' ? cursor : null, candidateCursor: view === 'candidates' ? cursor : null },
    { signal: operation.controller.signal }), ctx.projectId, ctx.branch, { limit: 20 });
    current(operation);
    if (append && (result.headRevisionId !== state.headRevisionId || result.policy.version !== state.policy?.version)) {
      throw fail('branch-review-selection-changed');
    }
    let candidates = result.candidates.items, requests = result.requests.items;
    let nextCandidateCursor = result.candidates.nextCursor, nextRequestCursor = result.requests.nextCursor, capped = false;
    if (append) {
      const rows = result[field], id = field === 'requests' ? 'id' : 'revisionId';
      if (rows.nextCursor === cursor || rows.items.some(item => previous.some(old => old[id] === item[id]))) throw fail('sync-response-invalid');
      const items = [...previous, ...rows.items]; capped = items.length >= 500 && rows.nextCursor !== null;
      if (field === 'requests') { requests = items.slice(0, 500); nextRequestCursor = capped ? null : rows.nextCursor;
        candidates = state.candidates; nextCandidateCursor = state.nextCandidateCursor; }
      else { candidates = items.slice(0, 500); nextCandidateCursor = capped ? null : rows.nextCursor;
        requests = state.requests; nextRequestCursor = state.nextRequestCursor; }
    }
    const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('branch-review-local-error');
    publish({ ready: true, headRevisionId: result.headRevisionId, policy: result.policy, candidates, requests,
      nextCandidateCursor, nextRequestCursor, checkedAt: at, scopeId: scope(ctx, result.headRevisionId, result.policy),
      error: capped ? 'branch-review-display-limit' : null });
  }
  function run(action) { return track((async () => {
    let operation;
    try {
      if (closed) throw fail('branch-review-unavailable');
      const ctx = align(); if (!ctx) throw fail('branch-review-unavailable');
      if (active) throw fail('branch-review-busy');
      operation = { key: ctx.key, epoch, controller: new AbortController() }; active = operation;
      publish({ busy: true, error: null, outcome: null });
      await action(operation, connection.getClient(), ctx);
    } catch (error) {
      if (operation && active === operation && epoch === operation.epoch && !closed) {
        try { current(operation); errorState(error); } catch { /* The new account/selection owns the view. */ }
      } else if (!operation && !active && !closed) errorState(error);
    } finally {
      if (operation && active === operation) { active = null; if (!closed) publish({ busy: false }); }
    }
    return clone(state);
  })()); }
  function intent(ctx, input, fields) {
    if (!exact(input, ['scopeId', ...fields])) throw fail('branch-review-invalid');
    if (!state.ready) throw fail('branch-review-refresh-required');
    if (typeof input.scopeId !== 'string' || input.scopeId !== state.scopeId) throw fail('branch-review-selection-changed');
    if (!ctx.connected) throw fail('service-offline');
  }
  function retry(kind, value) {
    const hash = fingerprint({ identity, value }), previous = retries.get(kind);
    if (previous?.hash === hash) return previous.key;
    const key = randomUUID(); retries.set(kind, { hash, key }); return key;
  }
  function receipt(ctx, outcome) {
    nonce = randomUUID();
    publish({ outcome, ready: false, scopeId: scope(ctx, state.headRevisionId, state.policy) });
  }
  function setBranchProtection(input) { return run(async (operation, client, ctx) => {
    intent(ctx, input, ['requiredApprovals']);
    if (ctx.role !== 'owner') throw fail('forbidden');
    if (!Number.isSafeInteger(input.requiredApprovals) || input.requiredApprovals < 0 || input.requiredApprovals > 5) throw fail('branch-review-invalid');
    const expectedVersion = state.policy.version, requiredApprovals = input.requiredApprovals;
    const value = { projectId: ctx.projectId, branch: ctx.branch, expectedVersion, requiredApprovals };
    const result = validateBranchProtectionPolicy(await client.setBranchProtection({ ...value,
      idempotencyKey: retry('policy', value) }, { signal: operation.controller.signal }));
    current(operation);
    if (result.requiredApprovals !== requiredApprovals || result.version !== expectedVersion + (state.policy.requiredApprovals === requiredApprovals ? 0 : 1)
      || result.version !== expectedVersion && result.updatedBy !== ctx.actorId) throw fail('sync-response-invalid');
    retries.delete('policy'); receipt(ctx, { kind: 'policy-saved' });
    await page(operation, client, ctx);
  }); }
  function requestBranchApproval(input) { return run(async (operation, client, ctx) => {
    intent(ctx, input, ['revisionId']);
    if (ctx.role === 'viewer') throw fail('forbidden');
    const candidate = state.candidates.find(item => item.revisionId === input.revisionId && item.canRequest);
    if (!candidate || !ID.test(input.revisionId || '') || state.policy.requiredApprovals < 1) throw fail('approval-candidate-invalid');
    const value = { projectId: ctx.projectId, branch: ctx.branch, expectedHead: state.headRevisionId,
      revisionId: candidate.revisionId, policyVersion: state.policy.version };
    const result = validateBranchApprovalRequest(await client.requestBranchApproval({ ...value,
      idempotencyKey: retry('request', value) }, { signal: operation.controller.signal }), value);
    current(operation);
    if (result.requesterId !== ctx.actorId || result.requiredApprovals !== state.policy.requiredApprovals
      || fingerprint(result.proposal) !== fingerprint(Object.fromEntries(
      Object.entries(candidate).filter(([name]) => name !== 'canRequest')))) throw fail('sync-response-invalid');
    retries.delete('request'); receipt(ctx, { kind: 'requested', requestId: result.id });
    await page(operation, client, ctx);
  }); }
  function approveBranchRequest(input) { return run(async (operation, client, ctx) => {
    intent(ctx, input, ['requestId']);
    if (ctx.role === 'viewer') throw fail('forbidden');
    const request = state.requests.find(item => item.id === input.requestId && item.canApprove);
    if (!request || !ID.test(input.requestId || '') || [request.requesterId, request.proposal.authorId].includes(ctx.actorId)) throw fail('approval-forbidden');
    const result = validateBranchApprovalRequest(await client.approveBranchRequest(ctx.projectId, ctx.branch, request.id,
      { signal: operation.controller.signal }), { projectId: ctx.projectId, branch: ctx.branch, requestId: request.id,
      revisionId: request.revisionId, expectedHead: request.expectedHead, policyVersion: request.policyVersion });
    current(operation);
    if (result.requesterId !== request.requesterId || result.requiredApprovals !== request.requiredApprovals
      || result.createdAt !== request.createdAt || result.expiresAt !== request.expiresAt
      || !result.approvals.some(item => item.actorId === ctx.actorId && item.active)
      || fingerprint(result.proposal) !== fingerprint(request.proposal)) throw fail('sync-response-invalid');
    receipt(ctx, { kind: 'approved', requestId: result.id });
    await page(operation, client, ctx);
  }); }
  function selectBranchReview(input) { return track((async () => {
    if (closed) return clone(state);
    if (input !== null && (!exact(input, ['projectId', 'branch']) || !ID.test(input.projectId || '') || !ID.test(input.branch || ''))) {
      errorState(fail('branch-review-invalid')); return clone(state);
    }
    epoch++; active?.controller.abort(); active = null; nonce = randomUUID(); retries.clear();
    selected = input ? clone(input) : null; identity = null; accessKey = null;
    publish({ ...empty(), selection: selected ? clone(selected) : null }); align(); return clone(state);
  })()); }
  function getState() { if (!closed) align(); return Promise.resolve(clone(state)); }
  async function dispose() {
    if (closed) return; closed = true; epoch++; active?.controller.abort(); active = null; retries.clear();
    state = { version: state.version + 1, ...empty() };
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, selectBranchReview, refreshBranchReview: (input = { view: 'all' }) => run((operation, client, ctx) => {
    if (!exact(input, ['view']) || !['all', 'requests', 'candidates'].includes(input.view)) throw fail('branch-review-invalid');
    return page(operation, client, ctx, input.view);
  }), setBranchProtection, requestBranchApproval, approveBranchRequest, connectionChanged: getState, dispose };
}
module.exports = { createDesktopBranchReview };
