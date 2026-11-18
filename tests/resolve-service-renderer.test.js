'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function resolveServiceExpectedContext(');
const end = source.indexOf('async function refreshResolveHistory(', start);
assert(start >= 0 && end > start);

class Element {
  constructor(value = '') { this.textContent = value; this.value = ''; this.children = []; this.hidden = false;
    this.disabled = false; this.isConnected = true; this.open = false; }
  append(...values) { for (const child of values) { child.remove(); child.parent = this; this.children.push(child); } }
  add(value) { this.append(value); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(value => value !== this); this.parent = null; } }
  replaceChildren(...values) { for (const child of this.children) child.parent = null; this.children = []; this.append(...values); }
  insertBefore(value, before) { value.remove(); value.parent = this; const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, value); }
  querySelector(selector) { const value = /option\[value="([^"]+)"\]/.exec(selector)?.[1]; return this.children.find(item => item.value === value) || null; }
  addEventListener() {}
  closest() { return this.hidden ? this : null; }
  focus() { this.owner.activeElement = this; }
}
function summary() { return { id: 'preview', readOnly: true, safeToApply: false, source: 'saved-head',
  incomingRevisionId: 'incoming', baseLocalRevisionId: 'base', localHeadId: 'head',
  sourceHashes: { base: 'a'.repeat(64), local: 'b'.repeat(64), incoming: 'c'.repeat(64) },
  decisionCount: 3, conflictCount: 1, fetchedAt: 1000, acceptedAt: null }; }
function fixture() {
  const nodes = new Map(), document = { activeElement: null, body: {} };
  const make = (tag, name, value = '') => { const node = new Element(value); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  document.getElementById = element;
  const capture = make(); capture.value = 'verified-capture'; element('resolve-service-source').append(capture);
  const state = { version: 1, status: 'connected', origin: 'https://service.example', account: { id: 'user' }, busy: false, error: null,
    local: { projectId: 'resolve-project', name: 'Resolve observations', branch: 'main', revisionCount: 2 },
    projects: [{ id: 'remote', name: 'Service project', role: 'viewer', branches: ['main'] }],
    binding: { remoteProjectId: 'remote', remoteProjectName: 'Service project', remoteBranch: 'main', role: 'viewer' },
    sync: { status: 'remote-ahead' }, fetched: { head: 'incoming', checkedAt: 1000, revisionCount: 3 },
    base: { status: 'recorded', localRevisionId: 'base', remoteRevisionId: 'remote-base', verifiedAt: 0 },
    operations: [], comparison: { status: 'ready', error: null, result: summary() } };
  const context = vm.createContext({ resolveServiceState: state, resolveServiceVersion: 1,
    resolveServiceSelection: { projectId: 'resolve-project', branch: 'main' }, resolveServiceSelectionRequest: 0,
    resolveServiceAction: null, resolveServiceNotice: '', resolveServiceAccountKey: '', resolveServiceContextKey: '',
    resolveServiceProjectChoice: '', resolveServiceBranchChoice: '', resolveServiceProjectOptionsKey: '', resolveServiceBranchOptionsKey: '',
    resolveServicePreviewSource: 'saved-head', resolveServiceVisibleJobs: 20, resolveServiceJobRows: new Map(), resolveServiceQueueActions: new Set(),
    serviceState: { status: 'connected', origin: state.origin, account: { id: 'user' } },
    resolveState: null, resolveSelected: null, resolveBusy: false, companionBusy: false, resolveHistoryBranchBusy: false,
    verifiedResolveCaptureAvailable: false, window: { desktop: { getResolveServiceState() {}, previewResolveServiceHistory() {}, retryResolveServiceSync() {}, cancelResolveServiceSync() {} } },
    document, make, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value),
    serviceErrorLabel: () => 'Check history and retry.', syncErrorLabel: () => 'Retry the queued push.' });
  context.renderResolveState = value => { context.resolveState = value; };
  vm.runInContext(source.slice(start, end), context);
  return { state, context, element, render: () => context.renderResolveServicePanel() };
}
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');
test('Resolve service UI shares account identity while preserving independent selection and viewer preview', () => {
  const view = fixture(); view.render();
  assert.equal(view.element('resolve-service-push').disabled, true);
  assert.equal(view.element('resolve-service-fetch').disabled, false);
  assert.equal(view.element('resolve-service-preview').disabled, false);
  assert.match(view.element('resolve-service-status').textContent, /viewer access/);
  assert.match(view.element('resolve-service-preview-status').textContent, /3 classified fields · 1 conflict ·/);
  assert.equal(view.element('resolve-service-source').querySelector('option[value="verified-capture"]').disabled, true);
  view.context.verifiedResolveCaptureAvailable = true; view.context.resolveServicePreviewSource = 'verified-capture'; view.render();
  assert.equal(view.element('resolve-service-source').value, 'verified-capture');
  view.context.verifiedResolveCaptureAvailable = false; view.render();
  assert.equal(view.element('resolve-service-source').value, 'saved-head');
  view.state.status = 'offline'; view.state.sync.status = 'offline'; view.render();
  assert.equal(view.element('resolve-service-preview').disabled, false);
  assert.equal(view.element('resolve-service-fetch').disabled, true);
});
test('same-project graph refresh reads state without reselecting, while branch changes clear prior preview', async () => {
  const view = fixture(), selected = []; let reads = 0;
  view.context.resolveState = { sourceMode: 'service-history', servicePreview: summary() };
  view.context.window.desktop.getResolveServiceState = async () => { reads++; return { ...view.state, version: 2 }; };
  view.context.window.desktop.selectResolveServiceProject = async id => { selected.push(id); return { ...view.state, version: 3,
    local: id ? { ...view.state.local, projectId: id, branch: view.context.resolveServiceSelection.branch } : null,
    comparison: { status: 'none', error: null, result: null } }; };
  await view.context.setResolveServiceSelection('resolve-project', 'main');
  assert.equal(reads, 1); assert.deepEqual(selected, []); assert.equal(view.context.resolveState.sourceMode, 'service-history');
  await view.context.setResolveServiceSelection('resolve-project', 'alternate');
  assert.deepEqual(selected, ['resolve-project']); assert.equal(view.context.resolveState, null);
  assert.equal(view.context.resolveServicePreviewSource, 'saved-head');
});
test('scope/account invalidation hides linked evidence and late responses cannot restore prior project state', () => {
  const view = fixture(); view.render();
  const oldContext = view.context.resolveServiceExpectedContext();
  view.context.resolveState = { sourceMode: 'service-history', servicePreview: summary() };
  view.context.serviceState.account = { id: 'different-user' }; view.context.syncResolveServiceAccount();
  assert.equal(view.context.resolveState, null); assert.equal(view.element('resolve-service-preview').disabled, true);
  assert.doesNotMatch(view.element('resolve-service-base').textContent, /remote-base/);
  view.context.renderResolveServiceState({ ...view.state, version: 999 }, oldContext);
  assert.equal(view.context.resolveServiceState, null);
});
test('an action response missing the Resolve-local scope cannot display linked base or preview claims', () => {
  const view = fixture(); view.render();
  assert.match(view.element('resolve-service-base').textContent, /remote-base/);
  const response = { ...view.state, version: 2 }; delete response.local;
  view.context.renderResolveServiceState(response);
  assert.equal(view.element('resolve-service-preview').disabled, true);
  assert.equal(view.element('resolve-service-fetch').disabled, true);
  assert.doesNotMatch(view.element('resolve-service-base').textContent, /remote-base/);
  assert.doesNotMatch(view.element('resolve-service-fetched').textContent, /head incoming|3 fetched revisions/);
});
test('an account identity change reselects the visible Resolve project once and rejects the prior pending selection', async () => {
  const view = fixture(), requests = [], pending = [];
  view.context.resolveServiceAccountKey = JSON.stringify([view.state.origin, 'user']);
  view.context.window.desktop.selectResolveServiceProject = id => new Promise(resolve => requests.push({ id, resolve }));
  const select = view.context.setResolveServiceSelection;
  view.context.setResolveServiceSelection = (...args) => { const task = select(...args); pending.push(task); return task; };
  view.context.setResolveServiceSelection('resolve-project', 'main', true);
  view.context.serviceState.account = { id: 'other-user' }; view.context.syncResolveServiceAccount();
  assert.deepEqual(requests.map(value => value.id), ['resolve-project', 'resolve-project']);
  requests[1].resolve({ ...view.state, account: { id: 'other-user' }, version: 10 });
  requests[0].resolve({ ...view.state, account: { id: 'user' }, version: 999 });
  await Promise.all(pending);
  assert.equal(view.context.resolveServiceState.account.id, 'other-user');
  assert.equal(view.context.resolveServiceVersion, 10);
});
test('Resolve preview provenance remains historical, and stale/expired preview errors explain recovery', () => {
  const view = fixture(); view.context.resolveState = { sourceMode: 'service-history', servicePreview: { ...summary(), source: 'verified-capture', acceptedAt: 0 } };
  view.context.renderResolveServiceProvenance();
  assert.equal(view.element('resolve-service-provenance').hidden, false);
  assert.match(view.element('resolve-service-provenance-summary').textContent, /capture accepted 0/);
  assert.match(allText(view.element('resolve-service-provenance-facts')), /a{64}/);
  view.state.error = 'service-resolve-comparison-capture-expired'; view.render();
  assert.match(view.element('resolve-service-status').textContent, /older than five minutes/);
  for (const error of ['service-resolve-comparison-capture-expired', 'service-resolve-comparison-verification-invalid']) {
    view.context.resolveState = { sourceMode: 'service-history', servicePreview: summary() };
    view.context.renderResolveServiceState({ ...view.state, version: view.context.resolveServiceVersion + 1,
      error, comparison: { status: 'error', error, result: null } });
    assert.equal(view.context.resolveState, null);
    view.context.renderResolveServiceProvenance();
    assert.equal(view.element('resolve-service-provenance').hidden, true);
  }
  view.context.resolveState = { sourceMode: 'manual' }; view.context.renderResolveServiceProvenance();
  assert.equal(view.element('resolve-service-provenance').hidden, true);
  assert.equal(view.element('resolve-service-provenance-facts').children.length, 0);
});
test('queued Resolve push controls keep stable nodes during progress and allow cancellation while busy', () => {
  const view = fixture(); view.state.operations = Array.from({ length: 21 }, (_, index) => ({ id: `job-${index}`, branch: 'main',
    status: 'queued', progress: { completed: 0, total: 2 }, actions: ['retry'], recoverable: true }));
  view.render(); const row = view.element('resolve-service-jobs').children[0], cancel = row.children[1].children[1];
  assert.equal(view.element('resolve-service-jobs').children.length, 20);
  assert.equal(view.element('resolve-service-jobs-more').hidden, false);
  view.state.busy = true; view.state.operations[0].progress.completed = 1; view.render();
  assert.equal(view.element('resolve-service-jobs').children[0], row); assert.equal(row.children[1].children[1], cancel);
  assert.equal(cancel.disabled, false); assert.equal(row.children[1].children[0].disabled, true);
  view.context.resolveServiceVisibleJobs = 40; view.render(); assert.equal(view.element('resolve-service-jobs').children.length, 21);
});
test('a review invalidation during an action wins over its late preview response', async () => {
  const view = fixture(); let finish;
  Object.assign(view.context, { resolveReviewEventGeneration: 0, resolveReviewEventState: null, resolveActionNotice: '',
    renderResolveState: value => { view.context.resolveState = value; }, refreshResolveServiceState() {} });
  view.context.window.desktop.previewResolveServiceHistory = () => new Promise(resolve => { finish = resolve; });
  view.context.window.desktop.getResolveReviewState = async () => ({ sourceMode: null, status: 'empty' });
  const actionStart = source.indexOf('async function resolveAction('), actionEnd = source.indexOf("document.getElementById('resolve-export-choose')", actionStart);
  assert(actionStart >= 0 && actionEnd > actionStart); vm.runInContext(source.slice(actionStart, actionEnd), view.context);
  const pending = view.context.resolveAction('previewResolveServiceHistory', { source: 'saved-head' });
  view.context.resolveReviewEventGeneration++; view.context.resolveReviewEventState = { sourceMode: null, status: 'empty' };
  finish({ sourceMode: 'service-history', servicePreview: summary(), status: 'ready' }); await pending;
  assert.equal(view.context.resolveState.sourceMode, null); assert.equal(view.context.resolveState.status, 'empty');
});
test('service history always explains and blocks the rename drill even for a completed schema-1 audit', () => {
  const view = fixture(), trialStart = source.indexOf('function renderResolveTrial(');
  const trialEnd = source.indexOf('async function resolveTrialAction(', trialStart);
  assert(trialStart >= 0 && trialEnd > trialStart);
  Object.assign(view.context, { resolveTrialState: { enabled: true, phase: 'idle', busy: false }, resolveTrialBusy: false,
    activeResolveTrial: () => false, renderRetainedResolveTrials() {} });
  view.element('resolve-trial-ack').checked = true;
  vm.runInContext(source.slice(trialStart, trialEnd), view.context);
  for (const schemaVersion of [1, 2]) {
    view.context.resolveState = { sourceMode: 'service-history', audit: { complete: true }, plan: { schemaVersion } };
    view.context.renderResolveTrial();
    assert.equal(view.element('resolve-trial-prepare').disabled, true);
    assert.equal(view.element('resolve-trial-status').textContent, 'Service history reviews are read only and cannot start the rename drill.');
  }
  view.context.resolveState = { sourceMode: 'manual', audit: { complete: true }, plan: { schemaVersion: 1 } };
  view.context.renderResolveTrial(); assert.equal(view.element('resolve-trial-prepare').disabled, false);
});
