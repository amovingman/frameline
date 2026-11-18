'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function serviceComparisonScopeReady(');
const end = source.indexOf('function currentServiceBase(', start);
assert(start >= 0 && end > start);
const comparisonFunctions = source.slice(start, end);
const sourceHash = 'a'.repeat(64);
function comparisonResult() {
  return { id: 'comparison-1', readOnly: true, safeToApply: false, createdAt: 2000,
    binding: { baseLocalRevisionId: 'base', baseRemoteRevisionId: 'remote-base', incomingRevisionId: 'incoming',
      localHeadId: 'local-head', baseSourceHash: 'b'.repeat(64), localSourceHash: sourceHash,
      incomingSourceHash: 'c'.repeat(64), fetchedAt: 1000 },
    changes: [{ field: 'name', status: 'conflict', base: 'Assembly', local: 'Local cut', incoming: 'Incoming cut' },
      { field: 'durationFrames', status: 'already-applied', base: 12, local: 24, incoming: 24 }],
    context: Object.fromEntries(['base', 'local', 'incoming'].map(role => [role,
      { clipCount: 2, mediaCount: 3, mediaNamesAmbiguous: role === 'incoming' }])), warnings: ['Clip identity remains unresolved.'] };
}
class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.hidden = false; this.disabled = false; this.open = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
}
function fixture() {
  const nodes = new Map(), element = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const state = { status: 'connected', account: { id: 'viewer' }, binding: { role: 'viewer' },
    base: { status: 'recorded', localRevisionId: 'base', remoteRevisionId: 'remote-base' },
    fetched: { head: 'incoming', checkedAt: 1000 },
    comparison: { status: 'ready', error: null, result: comparisonResult() } };
  const context = vm.createContext({ serviceState: state, serviceBaseTransition: false, serviceActionBusy: false,
    serviceActionMethod: null, serviceComparisonRenderKey: '',
    currentAppState: { scanStatus: 'ready', error: null, scan: { sourceHash }, revisions: [{ id: 'local-head' }] },
    serviceSelectionMatches: () => true, currentServiceBase: () => context.serviceState?.base,
    currentProjectActivityContext: () => context.serviceState?.account ? 'scope' : '',
    serviceErrorLabel: () => 'Check history and retry.', serviceDate: value => String(value),
    document: { getElementById: element }, window: { desktop: { compareServiceRevisions() {} } },
    setServiceText: (node, text) => { node.textContent = text; }, make: (tag, name, text = '') => new Element(text) });
  vm.runInContext(comparisonFunctions, context);
  return { context, state, element, render: () => context.renderServiceComparison(), result: () => context.currentServiceComparison() };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
test('viewer can compare verified cached snapshots offline, with explicit conflict and observation labels', () => {
  const view = fixture(); view.state.status = 'offline'; view.render();
  assert.equal(view.element('service-comparison-run').disabled, false);
  assert.equal(view.element('service-comparison-result').hidden, false);
  assert.match(view.element('service-comparison-stamp').textContent, /Incoming history fetched 1000/);
  assert.match(view.element('service-comparison-status').textContent, /2 changed sequence fields · 1 conflict/);
  const fields = text(view.element('service-comparison-fields'));
  assert.match(fields, /Different local and incoming changes/); assert.match(fields, /Same change observed/);
  assert.match(fields, /24 frames/); assert.doesNotMatch(fields, /Already applied/);
  assert.match(text(view.element('service-comparison-facts')), new RegExp(sourceHash));
  assert.match(text(view.element('service-comparison-context')), /repeated media names observed/);
});
test('changed scan, local head, base, incoming head or fetch snapshot clears stale comparison evidence', () => {
  for (const mutate of [view => { view.context.currentAppState.scan.sourceHash = 'd'.repeat(64); },
    view => { view.context.currentAppState.revisions[0].id = 'new-local-head'; },
    view => { view.state.base.localRevisionId = 'different-base'; },
    view => { view.state.base.remoteRevisionId = 'different-remote-base'; },
    view => { view.state.fetched.head = 'new-incoming'; }, view => { view.state.fetched.checkedAt = 1001; },
    view => { view.state.comparison.result.safeToApply = true; }, view => { view.state.comparison.result.readOnly = false; }]) {
    const view = fixture(); view.render(); assert(view.element('service-comparison-fields').children.length);
    mutate(view); view.render(); assert.equal(view.result(), null);
    assert.equal(view.element('service-comparison-result').hidden, true);
    assert.equal(view.element('service-comparison-fields').children.length, 0);
    assert.equal(view.element('service-comparison-facts').children.length, 0);
  }
});
test('sign-out, binding transitions and selection changes hide evidence and disable comparison', () => {
  for (const mutate of [view => { view.context.serviceState = null; }, view => { view.state.account = null; },
    view => { view.state.binding = null; }, view => { view.context.serviceBaseTransition = true; },
    view => { view.context.serviceSelectionMatches = () => false; }]) {
    const view = fixture(); view.render(); mutate(view); view.render();
    assert.equal(view.element('service-comparison-result').hidden, true);
    assert.equal(view.element('service-comparison-run').disabled, true);
    assert.equal(view.element('service-comparison-facts').children.length, 0);
  }
});
test('unchanged notifications preserve rendered evidence; missing prerequisites and safe errors explain recovery', () => {
  const view = fixture(); view.render(); const field = view.element('service-comparison-fields').children[0];
  view.element('service-comparison-evidence').open = true; view.render();
  assert.equal(view.element('service-comparison-fields').children[0], field);
  assert.equal(view.element('service-comparison-evidence').open, true);
  view.state.base.status = 'unconfirmed'; view.render();
  assert.equal(view.element('service-comparison-run').disabled, true);
  assert.match(view.element('service-comparison-status').textContent, /Check history/);
  view.state.base.status = 'recorded'; view.state.fetched = null; view.render();
  assert.equal(view.element('service-comparison-run').disabled, true);
  assert.match(view.element('service-comparison-status').textContent, /Fetch service history/);
  view.state.comparison = { status: 'error', error: 'comparison-source-required', result: null }; view.render();
  assert.match(view.element('service-comparison-status').textContent, /Scan the selected FCPXML/);
});
test('comparison remains bounded to known sequence fields and handles no observed differences', () => {
  const view = fixture(); view.state.comparison.result.changes = []; view.render();
  assert.match(view.element('service-comparison-status').textContent, /No sequence-level differences/);
  view.state.comparison.result.changes = [{ field: 'clipId', status: 'conflict', base: 1, local: 2, incoming: 3 }];
  view.render(); assert.equal(view.result(), null);
  assert.equal(view.element('service-comparison-result').hidden, true);
});
test('stale export recovery allows an unsaved rescan and never instructs comparison users to push', () => {
  const view = fixture();
  view.state.comparison = { status: 'error', error: 'revision-source-changed', result: null }; view.render();
  const message = view.element('service-comparison-status').textContent;
  assert.match(message, /Rescan it, then compare again/); assert.doesNotMatch(message, /save|push/i);
  const labelStart = source.indexOf('function serviceErrorLabel(');
  const labelEnd = source.indexOf('function serviceSelectionMatches(', labelStart);
  assert(labelStart >= 0 && labelEnd > labelStart);
  vm.runInContext(source.slice(labelStart, labelEnd), view.context);
  const notice = view.context.serviceErrorLabel('revision-source-changed');
  assert.match(notice, /Rescan it before continuing/); assert.doesNotMatch(notice, /save|push/i);
});
