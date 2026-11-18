'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopBranchReview } = require('../src/desktop-branch-review');
const fail = code => Object.assign(new Error('/private/workspace password-secret bearer-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cursor = index => `${Buffer.from(`page-${index}`).toString('base64url')}.${Buffer.alloc(32, 7).toString('base64url')}`;
const iso = '2026-11-18T12:00:00.000Z';
const manifestId = `sha256:${'a'.repeat(64)}`;
function proposal(revisionId = 'candidate-1', patch = {}) { return { revisionId, parentRevisionId: 'head-1', authorId: 'author', message: 'Reviewed sequence', manifestId, createdAt: iso, ...patch }; }
function approval(id = 'request-1', patch = {}) {
  return { id, projectId: 'project-1', branch: 'main', requesterId: 'writer', revisionId: 'candidate-1', expectedHead: 'head-1',
    policyVersion: 1, requiredApprovals: 2, createdAt: iso, expiresAt: '2026-11-25T12:00:00.000Z', status: 'pending',
    proposal: proposal(), approvals: [], recordedApprovals: 0, activeApprovals: 0, canApprove: true, applied: null, ...patch };
}
function fixture(t) {
  const account = { origin: 'https://review.example.test', status: 'connected', account: { id: 'owner' },
    projects: [{ id: 'project-1', role: 'owner', branches: ['main', 'review'] }, { id: 'project-2', role: 'editor', branches: ['main'] }] };
  const model = { headRevisionId: 'head-1', policy: { version: 1, requiredApprovals: 2, updatedAt: iso, updatedBy: 'owner' },
    candidates: [{ ...proposal(), canRequest: true }], requests: [approval()] };
  const events = [], calls = [], hooks = {}, idempotency = new Map();
  const page = (pid = 'project-1', branch = 'main', patch = {}) => {
    const result = { projectId: pid, branch, headRevisionId: model.headRevisionId, policy: structuredClone(model.policy),
      candidates: { items: structuredClone(model.candidates), nextCursor: null, total: model.candidates.length },
      requests: { items: structuredClone(model.requests.map(item => ({ ...item, projectId: pid, branch }))), nextCursor: null, total: model.requests.length }, ...patch };
    result.requests.items = result.requests.items.map(item => ['pending', 'approved'].includes(item.status)
      && (item.expectedHead !== result.headRevisionId || item.policyVersion !== result.policy.version || item.requiredApprovals !== result.policy.requiredApprovals)
      ? { ...item, status: 'stale', canApprove: false } : item);
    return result;
  };
  const client = {
    async getBranchReview(pid, branch, input, options) {
      calls.push({ kind: 'read', pid, branch, input: structuredClone(input), signal: options.signal });
      return hooks.read ? hooks.read(pid, branch, input, options) : page(pid, branch);
    },
    async setBranchProtection(input, options) {
      calls.push({ kind: 'policy', input: structuredClone(input), signal: options.signal });
      if (hooks.policy) return hooks.policy(input, options);
      if (idempotency.has(input.idempotencyKey)) return structuredClone(idempotency.get(input.idempotencyKey));
      if (model.policy.requiredApprovals !== input.requiredApprovals) model.policy = { version: input.expectedVersion + 1,
        requiredApprovals: input.requiredApprovals, updatedAt: iso, updatedBy: account.account.id };
      idempotency.set(input.idempotencyKey, structuredClone(model.policy)); return structuredClone(model.policy);
    },
    async requestBranchApproval(input, options) {
      calls.push({ kind: 'request', input: structuredClone(input), signal: options.signal });
      if (hooks.request) return hooks.request(input, options);
      if (idempotency.has(input.idempotencyKey)) return structuredClone(idempotency.get(input.idempotencyKey));
      const candidate = model.candidates.find(item => item.revisionId === input.revisionId);
      const result = approval(`requested-${model.requests.length + 1}`, { projectId: input.projectId, branch: input.branch,
        requesterId: account.account.id, revisionId: input.revisionId, expectedHead: input.expectedHead, policyVersion: input.policyVersion,
        requiredApprovals: model.policy.requiredApprovals, proposal: Object.fromEntries(Object.entries(candidate).filter(([name]) => name !== 'canRequest')), canApprove: false });
      model.requests.unshift(result); idempotency.set(input.idempotencyKey, result); return structuredClone(result);
    },
    async approveBranchRequest(pid, branch, id, options) {
      calls.push({ kind: 'approve', pid, branch, id, signal: options.signal });
      if (hooks.approve) return hooks.approve(pid, branch, id, options);
      const result = model.requests.find(item => item.id === id);
      if (!result.approvals.some(item => item.actorId === account.account.id)) result.approvals.push({ actorId: account.account.id, at: iso, active: true });
      result.activeApprovals = result.approvals.filter(item => item.active).length; result.recordedApprovals = result.approvals.length;
      result.canApprove = false; result.status = result.activeApprovals >= result.requiredApprovals ? 'approved' : 'pending';
      return structuredClone({ ...result, projectId: pid, branch });
    }
  };
  const controller = createDesktopBranchReview({ connection: { getState: () => structuredClone(account), getClient: () => client },
    onChange: state => events.push(state), now: () => 3000 });
  t.after(() => controller.dispose());
  const select = (projectId = 'project-1', branch = 'main') => controller.selectBranchReview({ projectId, branch });
  const refresh = () => controller.refreshBranchReview({ view: 'all' });
  const mutate = async (method, input) => controller[method]({ scopeId: (await controller.getState()).scopeId, ...input });
  const ready = async () => { await select(); return refresh(); };
  return { controller, account, model, events, calls, hooks, page, client, select, refresh, mutate, ready };
}

test('branch selection/state reads are local, explicit refresh binds server head/policy, and snapshots are isolated', async t => {
  const f = fixture(t); assert.equal((await f.controller.getState()).available, false);
  const selected = await f.select(); assert.equal(selected.ready, false); assert.equal(selected.available, true); assert.equal(f.calls.length, 0);
  assert.equal((await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' })).error, 'branch-review-refresh-required'); assert.equal(f.calls.length, 0);
  const state = await f.refresh(); assert.equal(state.ready, true); assert.equal(state.checkedAt, 3000); assert.equal(state.headRevisionId, 'head-1');
  assert.equal(f.calls[0].input.limit, 20); assert.equal(f.calls[0].signal.aborted, false);
  state.policy.requiredApprovals = 5; state.requests[0].proposal.message = 'Locally changed';
  const fresh = await f.controller.getState(); assert.equal(fresh.policy.requiredApprovals, 2); assert.equal(fresh.requests[0].proposal.message, 'Reviewed sequence');
  f.events[0].selection = { projectId: 'tampered', branch: 'wrong' }; assert.equal((await f.controller.getState()).selection.projectId, 'project-1');
  await f.controller.selectBranchReview(null); const cleared = await f.controller.getState(); assert.equal(cleared.selection, null); assert.equal(cleared.requests.length, 0);
});

test('owner policy changes use checked version, no-op preserves it, and owner/editor requests use exact saved proposals', async t => {
  const f = fixture(t); await f.ready();
  let result = await f.mutate('setBranchProtection', { requiredApprovals: 3 }); assert.equal(result.outcome.kind, 'policy-saved'); assert.equal(result.policy.version, 2);
  const write = f.calls.find(item => item.kind === 'policy').input; assert.equal(write.expectedVersion, 1); assert.equal(write.requiredApprovals, 3);
  result = await f.mutate('setBranchProtection', { requiredApprovals: 3 }); assert.equal(result.policy.version, 2);
  result = await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' }); assert.equal(result.outcome.kind, 'requested');
  const requested = f.calls.find(item => item.kind === 'request').input;
  assert.equal(requested.expectedHead, 'head-1'); assert.equal(requested.policyVersion, 2); assert.equal(requested.revisionId, 'candidate-1');
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); await f.refresh();
  assert.equal((await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' })).outcome.kind, 'requested');
  const count = f.calls.length; assert.equal((await f.mutate('setBranchProtection', { requiredApprovals: 1 })).error, 'forbidden'); assert.equal(f.calls.length, count);
});

test('viewer reads but never writes, requester/revision author cannot approve, and canApprove is mandatory', async t => {
  for (const forbidden of ['viewer', 'requester', 'author', 'ineligible']) await t.test(forbidden, async t => {
    const f = fixture(t);
    if (forbidden === 'viewer') f.account.projects[0].role = 'viewer';
    if (forbidden === 'requester') f.account.account.id = 'writer';
    if (forbidden === 'author') f.account.account.id = 'author';
    if (forbidden === 'ineligible') f.model.requests[0].canApprove = false;
    await f.ready(); const count = f.calls.length;
    const result = await f.mutate('approveBranchRequest', { requestId: 'request-1' });
    assert.equal(result.error, forbidden === 'viewer' ? 'forbidden' : 'approval-forbidden'); assert.equal(f.calls.length, count);
    if (forbidden === 'viewer') {
      await f.refresh(); assert.equal((await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' })).error, 'forbidden');
    }
  });
});

test('eligible approval requires an active server receipt and never advances the service branch itself', async t => {
  const f = fixture(t); await f.ready(); const state = await f.mutate('approveBranchRequest', { requestId: 'request-1' });
  assert.equal(state.outcome.kind, 'approved'); assert.equal(state.requests[0].activeApprovals, 1); assert.equal(state.headRevisionId, 'head-1');
  assert.deepEqual(f.calls.filter(item => item.kind !== 'read').map(item => item.kind), ['approve']);
});

test('mutation inputs reject extra private fields, old scopes and unsaved proposal IDs before contacting the service', async t => {
  const f = fixture(t); const before = await f.ready(), count = f.calls.length;
  for (const [method, input, code] of [
    ['setBranchProtection', { scopeId: before.scopeId, requiredApprovals: 2, token: 'secret' }, 'branch-review-invalid'],
    ['setBranchProtection', { scopeId: before.scopeId, requiredApprovals: 6 }, 'branch-review-invalid'],
    ['requestBranchApproval', { scopeId: before.scopeId, revisionId: 'local-revision-uuid' }, 'approval-candidate-invalid'],
    ['approveBranchRequest', { scopeId: before.scopeId, requestId: 'not-in-page' }, 'approval-forbidden'],
    ['requestBranchApproval', { scopeId: 'older-scope', revisionId: 'candidate-1' }, 'branch-review-selection-changed']]) {
    assert.equal((await f.controller[method](input)).error, code);
  }
  assert.equal(f.calls.length, count);
});

test('an uncertain request acknowledgment retries one exact idempotency key through unrelated projects and authorized role changes', async t => {
  const f = fixture(t); await f.ready(); f.hooks.request = () => { throw fail('sync-network-unavailable'); };
  await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' });
  f.account.projects.push({ id: 'unrelated-project', role: 'viewer', branches: ['main'] }); await f.controller.connectionChanged();
  await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' });
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); await f.refresh();
  await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' });
  const attempts = f.calls.filter(item => item.kind === 'request'); assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(item => item.input.idempotencyKey)).size, 1);
  f.model.candidates.push({ ...proposal('candidate-2'), canRequest: true }); await f.refresh();
  await f.mutate('requestBranchApproval', { revisionId: 'candidate-2' });
  assert.notEqual(f.calls.filter(item => item.kind === 'request').at(-1).input.idempotencyKey, attempts[0].input.idempotencyKey);
});

test('policy retry keys are private and exact to actor/branch/version/value; fresh identities do not reuse them', async t => {
  const f = fixture(t); await f.ready(); f.hooks.policy = () => { throw fail('sync-network-unavailable'); };
  await f.mutate('setBranchProtection', { requiredApprovals: 3 }); await f.mutate('setBranchProtection', { requiredApprovals: 3 });
  let writes = f.calls.filter(item => item.kind === 'policy'); assert.equal(writes[0].input.idempotencyKey, writes[1].input.idempotencyKey);
  await f.mutate('setBranchProtection', { requiredApprovals: 4 }); writes = f.calls.filter(item => item.kind === 'policy'); assert.notEqual(writes[1].input.idempotencyKey, writes[2].input.idempotencyKey);
  f.account.account.id = 'new-owner'; await f.controller.connectionChanged(); await f.refresh(); await f.mutate('setBranchProtection', { requiredApprovals: 4 });
  assert.notEqual(writes[2].input.idempotencyKey, f.calls.filter(item => item.kind === 'policy').at(-1).input.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(f.events), /idempotencyKey|bearer-secret|password-secret|\/private\//);
});

test('a committed request with a lost acknowledgment reuses its identity and returns one server operation after a role change', async t => {
  const f = fixture(t); await f.ready(); const committed = new Map();
  f.hooks.request = input => {
    if (committed.has(input.idempotencyKey)) return structuredClone(committed.get(input.idempotencyKey));
    const result = approval('one-committed-request', { requesterId: 'owner', canApprove: false });
    committed.set(input.idempotencyKey, result); f.model.requests.unshift(result); throw fail('sync-network-unavailable');
  };
  let state = await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' }); assert.equal(state.outcome, null);
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); await f.refresh();
  state = await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' });
  assert.equal(state.outcome.requestId, 'one-committed-request'); assert.equal(committed.size, 1);
  assert.equal(f.model.requests.filter(item => item.id === 'one-committed-request').length, 1);
});

test('offline cached reads remain visible but mutations stop before client IO', async t => {
  const f = fixture(t); await f.ready(); f.account.status = 'offline';
  const state = await f.controller.connectionChanged(); assert.equal(state.requests.length, 1); assert.equal(state.available, true);
  const count = f.calls.length; assert.equal((await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' })).error, 'service-offline'); assert.equal(f.calls.length, count);
  f.account.status = 'connected'; await f.controller.connectionChanged(); assert.equal((await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' })).outcome.kind, 'requested');
});

test('account/origin/branch/role/access changes abort pending reads and late pages cannot restore their scope', async t => {
  for (const change of ['account', 'origin', 'branch', 'role', 'access', 'signout']) await t.test(change, async t => {
    const f = fixture(t); await f.select(); const entered = deferred(), gate = deferred(), oldPage = f.page();
    f.hooks.read = (_pid, _branch, _input, options) => { entered.resolve(options.signal); return gate.promise; };
    const reading = f.refresh(), signal = await entered.promise;
    if (change === 'account') f.account.account.id = 'other-account';
    else if (change === 'origin') f.account.origin = 'https://other.example.test';
    else if (change === 'branch') await f.select('project-1', 'review');
    else if (change === 'role') f.account.projects[0].role = 'viewer';
    else if (change === 'access') f.account.projects = [];
    else { f.account.account = null; f.account.status = 'sign-in-required'; }
    const updated = await f.controller.connectionChanged(); assert.equal(signal.aborted, true); assert.equal(updated.ready, false); assert.equal(updated.requests.length, 0);
    gate.resolve(oldPage); await reading; const state = await f.controller.getState(); assert.equal(state.requests.length, 0); assert.equal(state.outcome, null); assert.equal(state.busy, false);
  });
});

test('late mutation receipts are discarded after selection changes, and disposed state stays empty', async t => {
  const f = fixture(t); await f.ready(); const entered = deferred(), gate = deferred();
  const old = approval('late-request', { requesterId: 'owner', canApprove: false });
  f.hooks.request = (_input, options) => { entered.resolve(options.signal); return gate.promise; };
  const writing = f.mutate('requestBranchApproval', { revisionId: 'candidate-1' }), signal = await entered.promise;
  await f.select('project-2', 'main'); assert.equal(signal.aborted, true); gate.resolve(old); await writing;
  let state = await f.controller.getState(); assert.equal(state.selection.projectId, 'project-2'); assert.equal(state.outcome, null); assert.equal(state.requests.length, 0);
  await f.controller.dispose(); state = await f.controller.getState(); assert.equal(state.available, false); assert.equal(state.selection, null);
  assert.equal((await f.refresh()).requests.length, 0);
});

test('request and candidate cursors append independently, preserve the other list and reject repeated pages', async t => {
  const f = fixture(t); let mode = 'initial';
  f.hooks.read = (pid, branch, input) => {
    if (mode === 'initial') return f.page(pid, branch, { requests: { items: Array.from({ length: 20 }, (_, i) => approval(`request-${i}`)), nextCursor: cursor(1), total: 22 },
      candidates: { items: Array.from({ length: 20 }, (_, i) => ({ ...proposal(`candidate-${i}`), canRequest: true })), nextCursor: cursor(2), total: 22 } });
    if (input.requestCursor) return f.page(pid, branch, { requests: { items: [approval(mode === 'duplicate' ? 'request-0' : 'request-20')], nextCursor: null, total: 22 } });
    return f.page(pid, branch, { candidates: { items: [{ ...proposal('candidate-20'), canRequest: true }], nextCursor: null, total: 22 } });
  };
  let state = await f.ready(); const initialCandidates = structuredClone(state.candidates); mode = 'append';
  state = await f.controller.refreshBranchReview({ view: 'requests' }); assert.equal(state.requests.length, 21); assert.deepEqual(state.candidates, initialCandidates);
  const initialRequests = structuredClone(state.requests);
  state = await f.controller.refreshBranchReview({ view: 'candidates' }); assert.equal(state.candidates.length, 21); assert.deepEqual(state.requests, initialRequests);
  assert.equal(f.calls.at(-1).input.requestCursor, null); assert.equal(f.calls.at(-1).input.candidateCursor, cursor(2));
  mode = 'initial'; await f.refresh(); mode = 'duplicate'; state = await f.controller.refreshBranchReview({ view: 'requests' }); assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.requests.length, 20);
});

test('request paging stops at the explicit 500-row display cap and Refresh starts a fresh page', async t => {
  const f = fixture(t); let pageIndex = 0;
  f.hooks.read = (pid, branch, input) => {
    if (!input.requestCursor) pageIndex = 0; else pageIndex++;
    return f.page(pid, branch, { requests: { items: Array.from({ length: 20 }, (_, i) => approval(`bounded-${pageIndex * 20 + i}`)), nextCursor: cursor(pageIndex + 1), total: 600 } });
  };
  let state = await f.ready(); for (let i = 1; i < 25; i++) state = await f.controller.refreshBranchReview({ view: 'requests' });
  assert.equal(state.requests.length, 500); assert.equal(state.error, 'branch-review-display-limit'); assert.equal(state.nextRequestCursor, null); assert.equal(state.ready, true);
  const calls = f.calls.length; state = await f.controller.refreshBranchReview({ view: 'requests' }); assert.equal(state.error, 'branch-review-display-limit'); assert.equal(f.calls.length, calls);
  state = await f.refresh(); assert.equal(state.requests.length, 20); assert.equal(state.error, null); assert.notEqual(state.nextRequestCursor, null);
});

test('append observations with a changed head or policy invalidate the old review before any new mutation', async t => {
  for (const change of ['head', 'policy']) await t.test(change, async t => {
    const f = fixture(t); f.hooks.read = (pid, branch) => f.page(pid, branch, { requests: { items: Array.from({ length: 20 }, (_, i) => approval(`request-${i}`)), nextCursor: cursor(1), total: 21 } });
    const prior = await f.ready(); f.hooks.read = (pid, branch) => f.page(pid, branch, {
      ...(change === 'head' ? { headRevisionId: 'head-2', candidates: { items: [], nextCursor: null, total: 0 } } : { policy: { ...f.model.policy, version: 2 } }),
      requests: { items: [approval('request-20')], nextCursor: null, total: 21 } });
    const state = await f.controller.refreshBranchReview({ view: 'requests' });
    assert.equal(state.error, 'branch-review-selection-changed'); assert.equal(state.ready, false); assert.notEqual(state.scopeId, prior.scopeId);
    assert.equal(state.requests.length, 0); assert.equal(state.policy, null);
  });
});

test('verified mutation receipts survive follow-up read failure but require a new refresh before more mutations', async t => {
  for (const [method, input, kind] of [['setBranchProtection', { requiredApprovals: 3 }, 'policy-saved'],
    ['requestBranchApproval', { revisionId: 'candidate-1' }, 'requested'], ['approveBranchRequest', { requestId: 'request-1' }, 'approved']]) await t.test(kind, async t => {
    const f = fixture(t); await f.ready(); f.hooks.read = () => { throw fail('sync-network-unavailable'); };
    const state = await f.mutate(method, input); assert.equal(state.outcome.kind, kind); assert.equal(state.error, 'sync-network-unavailable'); assert.equal(state.ready, false);
    const before = f.calls.length; const blocked = await f.mutate(method, input); assert.equal(blocked.error, 'branch-review-refresh-required'); assert.equal(f.calls.length, before);
  });
});

test('unknown failures and malformed replies are sanitized, while forbidden failures clear private evidence', async t => {
  const f = fixture(t); await f.ready();
  f.hooks.read = () => { throw fail('/private/workspace bearer-secret'); }; let state = await f.refresh(); assert.equal(state.error, 'branch-review-local-error');
  f.hooks.read = (pid, branch) => f.page(pid, branch, { privatePath: '/private/workspace' }); state = await f.refresh(); assert.equal(state.error, 'sync-response-invalid');
  f.hooks.read = () => { throw fail('forbidden'); }; state = await f.refresh(); assert.equal(state.ready, false); assert.equal(state.requests.length, 0); assert.equal(state.headRevisionId, null); assert.equal(state.policy, null);
  assert.doesNotMatch(JSON.stringify(state), /\/private|bearer-secret|password-secret|idempotencyKey/);
});

test('dispose aborts and drains an outstanding request before leaving a terminal empty state', async t => {
  const f = fixture(t); await f.select(); const entered = deferred(), gate = deferred();
  f.hooks.read = (_pid, _branch, _input, options) => { entered.resolve(options.signal); return gate.promise; };
  const reading = f.refresh(), signal = await entered.promise; const closing = f.controller.dispose(); assert.equal(signal.aborted, true);
  gate.resolve(f.page()); await closing; await reading; const state = await f.controller.getState();
  assert.equal(state.selection, null); assert.equal(state.ready, false); assert.equal(state.busy, false); assert.equal(state.requests.length, 0);
});

test('a second action cannot replace a pending operation or clear its busy signal', async t => {
  const f = fixture(t); await f.select(); const entered = deferred(), gate = deferred();
  f.hooks.read = (_pid, _branch, _input, options) => { entered.resolve(options.signal); return gate.promise; };
  const reading = f.refresh(); await entered.promise; const count = f.calls.length;
  const second = await f.refresh(); assert.equal(second.busy, true); assert.equal(f.calls.length, count);
  gate.resolve(f.page()); await reading; assert.equal((await f.controller.getState()).busy, false);
});

test('a wrong policy/request/approval receipt is never accepted as an acknowledgment', async t => {
  for (const mismatch of ['policy-version', 'policy-actor', 'proposal', 'request-author', 'request-threshold', 'approval-actor', 'approval-threshold', 'approval-requester', 'approval-created', 'approval-expires']) await t.test(mismatch, async t => {
    const f = fixture(t); await f.ready();
    if (mismatch.startsWith('policy')) f.hooks.policy = () => ({ ...f.model.policy, version: mismatch === 'policy-version' ? 9 : 2, requiredApprovals: 3, updatedBy: 'wrong-actor' });
    else if (mismatch.startsWith('approval')) f.hooks.approve = () => approval('request-1', mismatch === 'approval-actor' ? {} : {
      approvals: [{ actorId: 'owner', at: iso, active: true }], activeApprovals: 1, recordedApprovals: 1, canApprove: false,
      ...(mismatch === 'approval-threshold' ? { requiredApprovals: 1, status: 'approved' } : {}),
      ...(mismatch === 'approval-requester' ? { requesterId: 'different-requester' } : {}),
      ...(mismatch === 'approval-created' ? { createdAt: '2026-11-18T12:01:00.000Z' } : {}),
      ...(mismatch === 'approval-expires' ? { expiresAt: '2026-11-26T12:00:00.000Z' } : {}) });
    else f.hooks.request = () => approval('new-request', { requesterId: mismatch === 'request-author' ? 'wrong-requester' : 'owner', canApprove: false,
      ...(mismatch === 'proposal' ? { proposal: proposal('candidate-1', { message: 'Mismatched body' }) } : {}),
      ...(mismatch === 'request-threshold' ? { requiredApprovals: 1 } : {}) });
    const state = mismatch.startsWith('policy') ? await f.mutate('setBranchProtection', { requiredApprovals: 3 })
      : mismatch.startsWith('approval') ? await f.mutate('approveBranchRequest', { requestId: 'request-1' }) : await f.mutate('requestBranchApproval', { revisionId: 'candidate-1' });
    assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.outcome, null);
  });
});
