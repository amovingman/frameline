'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDesktopBranchReview } = require('../src/desktop-branch-review');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function currentBranchReviewAccount('), end = source.indexOf('function serviceSelectionMatches(', start);
assert(start >= 0 && end > start);
class Element {
  constructor(text = '') { this.textContent = text; this.value = ''; this.children = []; this.hidden = false; this.disabled = false; this.isConnected = true; this.listeners = {}; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; node.isConnected = true; this.children.push(node); } }
  add(node) { this.append(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; this.isConnected = false; }
  replaceChildren(...nodes) { for (const node of this.children) { node.parent = null; node.isConnected = false; } this.children = []; this.append(...nodes); }
  insertBefore(node, before) { node.remove(); node.parent = this; node.isConnected = true; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  closest() { for (let node = this; node; node = node.parent) if (node.hidden) return node; return null; }
  focus() { this.owner.activeElement = this; }
}
function candidate(revisionId = 'proposal-1') { return { revisionId, parentRevisionId: 'head-1', authorId: 'author', message: 'Reviewed cut', manifestId: 'manifest-1', createdAt: '2026-11-18T12:00:00.000Z', canRequest: true }; }
function request(id = 'request-1') { return { id, projectId: 'project-1', branch: 'main', requesterId: 'writer', revisionId: 'proposal-1', expectedHead: 'head-1', policyVersion: 1,
  requiredApprovals: 2, createdAt: '2026-11-18T12:00:00.000Z', expiresAt: '2026-11-25T12:00:00.000Z', status: 'pending', proposal: candidate(), approvals: [], recordedApprovals: 0, activeApprovals: 0, canApprove: true, applied: null }; }
function fixture() {
  const document = { body: {}, activeElement: null }, nodes = new Map();
  const make = (tag, name, text = '') => { const node = new Element(text); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }; document.getElementById = element;
  const state = { version: 1, scopeId: 'scope-1', selection: { projectId: 'project-1', branch: 'main' }, available: true, ready: true, busy: false, error: null, role: 'owner',
    headRevisionId: 'head-1', checkedAt: 1000, policy: { version: 1, requiredApprovals: 2 }, candidates: [candidate()], requests: [request()], nextCandidateCursor: null, nextRequestCursor: null, outcome: null };
  const context = vm.createContext({ document, make, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    serviceState: { origin: 'https://service.example', status: 'connected', account: { id: 'reviewer' }, projects: [{ id: 'project-1', name: 'Review project', role: 'owner', branches: ['main', 'other'] }] },
    branchReviewState: state, branchReviewVersion: 1, branchReviewAccountKey: '', branchReviewAccessKey: '', branchReviewEvidenceKey: '', branchReviewProjectChoice: 'project-1', branchReviewBranchChoice: 'main',
    branchReviewProjectOptionsKey: '', branchReviewBranchOptionsKey: '', branchReviewCandidateOptionsKey: '', branchReviewPolicyDraft: '2', branchReviewCandidateChoice: '', branchReviewAction: null, branchReviewNotice: '', branchReviewRows: new Map(),
    window: { desktop: { getBranchReviewState() {}, selectBranchReview() {}, refreshBranchReview() {}, setBranchProtection() {}, requestBranchApproval() {}, approveBranchRequest() {} } },
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value), serviceErrorLabel: code => code });
  vm.runInContext(source.slice(start, end), context); context.branchReviewAccountKey = context.currentBranchReviewAccount();
  context.renderBranchReviewState(state);
  return { context, state, element, render: () => context.renderBranchReview() };
}
test('branch reviews work without a local export and require a verified refresh before mutations', () => {
  const view = fixture(); view.render(); assert.equal(view.context.currentAppState, undefined);
  assert.equal(view.element('branch-review-refresh').disabled, false); assert.equal(view.element('branch-review-required').disabled, false);
  assert.match(view.element('branch-review-head').textContent, /Service head at last check: head-1.*Checked 1000/);
  view.state.ready = false; view.render(); assert.equal(view.element('branch-review-required').disabled, true);
  assert.equal(view.element('branch-review-candidate').disabled, true); assert.equal(view.element('branch-review-requests').children[0].children[5].disabled, true);
});
test('only owners change policy; viewers cannot request or approve and server eligibility remains authoritative', () => {
  const view = fixture(); view.context.branchReviewPolicyDraft = '3'; view.context.branchReviewCandidateChoice = 'proposal-1'; view.render();
  assert.equal(view.element('branch-review-policy-save').disabled, false); assert.equal(view.element('branch-review-request').disabled, false);
  view.state.role = 'editor'; view.render(); assert.equal(view.element('branch-review-required').disabled, true); assert.equal(view.element('branch-review-request').disabled, false);
  view.state.role = 'viewer'; view.render(); assert.equal(view.element('branch-review-request').disabled, true); assert.equal(view.element('branch-review-requests').children[0].children[5].disabled, true);
  view.state.role = 'owner'; view.state.requests[0].canApprove = false; view.render(); assert.equal(view.element('branch-review-requests').children[0].children[5].hidden, true);
});
test('only saved direct-child candidates are offered and request rows keep exact context separately', () => {
  const view = fixture(); view.state.candidates.push({ ...candidate('other-head'), parentRevisionId: 'wrong-head' }, { ...candidate('other-project'), projectId: 'foreign' }); view.render();
  assert.deepEqual(view.element('branch-review-candidate').children.map(item => item.value), ['', 'proposal-1']);
  const row = view.element('branch-review-requests').children[0];
  assert.match(row.children[1].textContent, /0 active \/ 2 required · 0 recorded/);
  const facts = row.children[4].children[1].children;
  assert.equal(facts[3].textContent, 'head-1'); assert.equal(facts[5].textContent, 'proposal-1'); assert.equal(facts[7].textContent, 'manifest-1');
});
test('typed policy/proposal drafts and keyed controls survive progress; head/policy/role changes reset drafts', () => {
  const view = fixture(); view.context.branchReviewPolicyDraft = '4'; view.context.branchReviewCandidateChoice = 'proposal-1'; view.render();
  const row = view.element('branch-review-requests').children[0], button = row.children[5]; row.children[4].open = true;
  view.context.renderBranchReviewState({ ...view.state, version: 2, busy: true });
  assert.equal(view.element('branch-review-required').value, '4'); assert.equal(view.element('branch-review-candidate').value, 'proposal-1');
  assert.equal(view.element('branch-review-requests').children[0], row); assert.equal(row.children[5], button); assert.equal(row.children[4].open, true);
  for (const change of [{ headRevisionId: 'head-2' }, { policy: { version: 2, requiredApprovals: 1 } }, { role: 'editor' }]) {
    view.context.branchReviewPolicyDraft = '5'; view.context.branchReviewCandidateChoice = 'proposal-1';
    view.context.renderBranchReviewState({ ...view.state, ...change, version: ++view.context.branchReviewVersion });
    assert.equal(view.context.branchReviewPolicyDraft, String(change.policy?.requiredApprovals ?? 2)); assert.equal(view.context.branchReviewCandidateChoice, '');
  }
});
test('account changes clear private review rows and reject responses captured for the former account', () => {
  const view = fixture(); const account = view.context.currentBranchReviewAccount();
  view.context.serviceState.account.id = 'another-account'; view.context.syncBranchReviewAccount();
  assert.equal(view.element('branch-review-requests').children.length, 0); assert.equal(view.element('branch-review-head').textContent, '');
  assert.equal(view.context.renderBranchReviewState({ ...view.state, version: 99 }, account), false);
});
test('outdated mutation scopes and late action replies cannot restore a changed branch/head', async () => {
  const view = fixture(); let finish, calls = 0;
  view.context.window.desktop.approveBranchRequest = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  await view.context.runBranchReviewAction('approveBranchRequest', { scopeId: 'stale', requestId: 'request-1' }); assert.equal(calls, 0);
  const pending = view.context.runBranchReviewAction('approveBranchRequest', { scopeId: 'scope-1', requestId: 'request-1' });
  view.context.renderBranchReviewState({ ...view.state, version: 2, scopeId: 'scope-2', headRevisionId: 'head-2' });
  finish({ ...view.state, version: 999, outcome: { kind: 'approved' } }); await pending;
  assert.equal(view.context.branchReviewState.scopeId, 'scope-2'); assert.match(view.element('branch-review-head').textContent, /head-2/);
});
test('all request states remain readable, approval does not claim publication, and completed controls hand focus to status', async () => {
  const view = fixture(); view.render(); const row = view.element('branch-review-requests').children[0], button = row.children[5];
  view.context.document.activeElement = button;
  view.context.window.desktop.approveBranchRequest = async () => ({ ...view.state, version: 2, requests: [{ ...request(), status: 'approved', activeApprovals: 2, recordedApprovals: 2, canApprove: false }], outcome: { kind: 'approved', requestId: 'request-1' } });
  await view.context.runBranchReviewAction('approveBranchRequest', { scopeId: 'scope-1', requestId: 'request-1' });
  assert.match(row.children[1].textContent, /Approved — requester must retry push/); assert.match(view.element('branch-review-status').textContent, /requester must retry the push/);
  assert.equal(view.context.document.activeElement, view.element('branch-review-status'));
  for (const [status, label] of [['stale', 'Stale'], ['expired', 'Expired'], ['applied', 'Published']]) {
    view.context.renderBranchReviewState({ ...view.state, version: ++view.context.branchReviewVersion, requests: [{ ...request(), status, canApprove: false }] }); assert.match(row.children[1].textContent, new RegExp(label));
  }
});
test('explicit handlers send scoped policy/proposal actions and cursor paging without arbitrary revision input', () => {
  const view = fixture(); let posted;
  view.context.runBranchReviewAction = (method, input) => { posted = { method, input }; };
  const handlerStart = source.indexOf("document.getElementById('branch-review-project').addEventListener"), handlerEnd = source.indexOf('window.desktop?.onBranchReviewState', handlerStart);
  vm.runInContext(source.slice(handlerStart, handlerEnd), view.context);
  view.context.branchReviewPolicyDraft = '3'; view.render(); view.element('branch-review-policy-form').listeners.submit({ preventDefault() {} });
  assert.equal(posted.method, 'setBranchProtection'); assert.equal(JSON.stringify(posted.input), JSON.stringify({ scopeId: 'scope-1', requiredApprovals: 3 }));
  view.context.branchReviewCandidateChoice = 'proposal-1'; view.render(); view.element('branch-review-request-form').listeners.submit({ preventDefault() {} });
  assert.equal(posted.method, 'requestBranchApproval'); assert.equal(JSON.stringify(posted.input), JSON.stringify({ scopeId: 'scope-1', revisionId: 'proposal-1' }));
  view.element('branch-review-requests-more').listeners.click(); assert.equal(posted.input.view, 'requests');
  view.element('branch-review-candidates-more').listeners.click(); assert.equal(posted.input.view, 'candidates');
  view.element('branch-review-refresh').listeners.click(); assert.equal(posted.input.view, 'all');
});

test('real controller receipt events emitted before the RPC response preserve confirmed action notices', async t => {
  for (const method of ['setBranchProtection', 'requestBranchApproval', 'approveBranchRequest']) for (const failReload of [false, true]) {
    await t.test(`${method}/${failReload ? 'reload-failed' : 'refreshed'}`, async t => {
      const view = fixture(), emitted = [], clone = value => JSON.parse(JSON.stringify(value));
      const policy = { version: 1, requiredApprovals: 2, updatedAt: '2026-11-18T12:00:00.000Z', updatedBy: 'reviewer' };
      const proposal = { ...candidate(), manifestId: `sha256:${'a'.repeat(64)}` }; delete proposal.canRequest;
      let requests = [{ ...request(), proposal }], mutated = false, enter, release;
      const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const client = {
        async getBranchReview() {
          if (mutated) { enter(); await gate; if (failReload) throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' }); }
          return { projectId: 'project-1', branch: 'main', headRevisionId: 'head-1', policy: clone(policy),
            candidates: { items: [{ ...proposal, canRequest: true }], total: 1, nextCursor: null },
            requests: { items: clone(requests.map(item => item.policyVersion !== policy.version ? { ...item, status: 'stale', canApprove: false } : item)), total: requests.length, nextCursor: null } };
        },
        async setBranchProtection(input) { Object.assign(policy, { version: 2, requiredApprovals: input.requiredApprovals }); mutated = true; return clone(policy); },
        async requestBranchApproval() {
          const receipt = { ...request('requested-1'), requesterId: 'reviewer', proposal, canApprove: false }; requests.unshift(receipt); mutated = true; return clone(receipt);
        },
        async approveBranchRequest() {
          const receipt = { ...requests[0], approvals: [{ actorId: 'reviewer', at: policy.updatedAt, active: true }], activeApprovals: 1, recordedApprovals: 1, canApprove: false };
          requests = [receipt]; mutated = true; return clone(receipt);
        }
      };
      const controller = createDesktopBranchReview({ connection: { getState: () => clone(view.context.serviceState), getClient: () => client },
        now: () => 2000, onChange(state) { emitted.push(state); view.context.renderBranchReviewState(state); } });
      t.after(() => controller.dispose());
      await controller.selectBranchReview({ projectId: 'project-1', branch: 'main' }); await controller.refreshBranchReview({ view: 'all' });
      view.context.window.desktop[method] = input => controller[method](clone(input));
      const originalScope = view.context.branchReviewState.scopeId;
      const input = { scopeId: originalScope, ...(method === 'setBranchProtection' ? { requiredApprovals: 3 }
        : method === 'requestBranchApproval' ? { revisionId: 'proposal-1' } : { requestId: 'request-1' }) };
      const pending = view.context.runBranchReviewAction(method, input); await entered;
      assert(emitted.some(state => state.outcome && state.busy && state.scopeId !== originalScope));
      assert.equal(view.context.branchReviewAction.method, method);
      assert.equal(view.element('branch-review-refresh').disabled, true);
      release(); await pending;
      const expected = method === 'setBranchProtection' ? /Branch policy saved/ : method === 'requestBranchApproval' ? /Review requested/ : /Approval recorded/;
      assert.match(view.element('branch-review-status').textContent, expected);
      if (failReload) {
        assert.match(view.element('branch-review-status').textContent, /Refresh branch review to reload/);
        assert.equal(view.context.branchReviewState.ready, false);
      }
      assert.equal(view.context.branchReviewAction, null);
    });
  }
});

test('unrelated emitted scope/head/policy/selection/role changes still discard a late matching-kind receipt', async t => {
  for (const change of ['scope', 'head', 'policy', 'selection', 'role', 'wrong-kind', 'wrong-request']) await t.test(change, async () => {
    const view = fixture(); let finish;
    view.context.window.desktop.approveBranchRequest = () => new Promise(resolve => { finish = resolve; });
    const pending = view.context.runBranchReviewAction('approveBranchRequest', { scopeId: 'scope-1', requestId: 'request-1' });
    const changed = { ...view.state, version: 2, scopeId: 'scope-2', busy: true };
    if (change !== 'scope') changed.outcome = { kind: 'approved', requestId: 'request-1' };
    if (change === 'head') changed.headRevisionId = 'head-2';
    if (change === 'policy') changed.policy = { version: 2, requiredApprovals: 2 };
    if (change === 'selection') changed.selection = { projectId: 'project-1', branch: 'other' };
    if (change === 'role') changed.role = 'editor';
    if (change === 'wrong-kind') changed.outcome.kind = 'requested';
    if (change === 'wrong-request') changed.outcome.requestId = 'another-request';
    view.context.renderBranchReviewState(changed); assert.equal(view.context.branchReviewAction, null);
    finish({ ...view.state, version: 999, outcome: { kind: 'approved', requestId: 'request-1' } }); await pending;
    assert.equal(view.context.branchReviewState.scopeId, 'scope-2');
    assert.doesNotMatch(view.element('branch-review-status').textContent, /Approval recorded\./);
  });
});

test('a receipt from a pending former-account action cannot restore its review or success notice', async () => {
  const view = fixture(); let finish;
  view.context.window.desktop.approveBranchRequest = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runBranchReviewAction('approveBranchRequest', { scopeId: 'scope-1', requestId: 'request-1' });
  view.context.serviceState.account.id = 'different-account'; view.context.syncBranchReviewAccount();
  finish({ ...view.state, version: 999, scopeId: 'old-receipt-scope', outcome: { kind: 'approved', requestId: 'request-1' } }); await pending;
  assert.equal(view.context.branchReviewState, null); assert.equal(view.element('branch-review-requests').children.length, 0);
  assert.doesNotMatch(view.element('branch-review-status').textContent, /Approval recorded\./);
});
