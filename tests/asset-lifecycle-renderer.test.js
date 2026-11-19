'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/asset-lifecycle-renderer.js'), 'utf8');
class Element {
  constructor(document) { this.document = document; this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.isConnected = true; }
  replaceChildren(...children) { for (const child of this.children) child.isConnected = false; this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.document.activeElement = this; }
  closest() { return this.hidden ? this : null; }
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const aid = `sha256:${'a'.repeat(64)}`;
async function fixture(desktopEnabled = true) {
  const document = { activeElement: null }, nodes = new Map(), calls = [];
  const element = key => { if (!nodes.has(key)) nodes.set(key, new Element(document)); return nodes.get(key); };
  document.getElementById = element; document.createElement = () => new Element(document);
  const row = { assetId: aid, assetClass: 'original', size: 1000, archived: true, archivedAt: 1000, eligibleAt: 1000, sharedProjects: false,
    hold: { version: 0, held: false, reason: null, until: null }, cleanupCandidate: true, blockers: ['revision-references-unverified'] };
  const state = { version: 1, scopeId: 'scope-1', available: true, connected: true, projects: [{ id: 'film', name: '<b>Film</b>', role: 'owner' }], projectId: 'film',
    busy: false, ready: true, report: { generatedAt: Date.now(), totalAssets: 1, nextAssetId: null, retentionPolicy: { version: 0, minimumArchiveAgeMs: 0 } },
    items: [row], selectedAssetId: aid, selectedIds: [], plan: null, exportReview: null, pending: null, outcome: null, error: null };
  let listener;
  const desktop = { getAssetLifecycleState: async () => structuredClone(state), onAssetLifecycleState: callback => listener = callback };
  for (const name of ['refreshLifecycleProjects', 'selectLifecycleProject', 'refreshLifecycleReport', 'loadMoreLifecycleAssets', 'selectLifecycleAsset',
    'selectLifecyclePlanAssets', 'saveLifecycleHold', 'saveLifecycleRetention', 'prepareLifecyclePlan', 'retryLifecycleRequest', 'dismissLifecycleRequest', 'prepareLifecycleExport', 'saveLifecycleExport']) {
    desktop[name] = async input => { calls.push({ name, input: structuredClone(input) }); return structuredClone(state); };
  }
  element('lifecycle-search').value = ''; element('lifecycle-class').value = 'all'; element('lifecycle-filter').value = 'all';
  vm.runInNewContext(source, { document, window: desktopEnabled ? { desktop } : {}, Date, Number }); await settle();
  return { state, calls, row, desktop, element: key => element(`lifecycle-${key}`), emit(value = state) { listener(structuredClone(value)); },
    async event(key, name = 'click') { await element(`lifecycle-${key}`).listeners[name]({ preventDefault() {} }); await settle(); } };
}
test('desktop lifecycle controls have a signed-out fallback and render project text literally', async () => {
  const browser = await fixture(false); assert.equal(browser.element('refresh').disabled, true); assert.match(browser.element('status').textContent, /Sign in/);
  const view = await fixture(); assert.equal(view.element('project').children[1].textContent, '<b>Film</b>'); assert.equal(view.element('detail-id').textContent, aid);
});
test('hold and release require an explicit review and preserve the exact observed version and settings', async () => {
  const view = await fixture(); view.element('reason').value = 'contractual'; await view.event('hold-form', 'submit');
  assert.equal(view.calls.length, 0); assert.equal(view.element('mutation-review').hidden, false); assert.match(view.element('mutation-summary').textContent, /contractual/);
  await view.event('mutation-confirm'); assert.equal(view.calls[0].name, 'saveLifecycleHold');
  assert.deepEqual(view.calls[0].input, { scopeId: 'scope-1', assetId: aid, expectedVersion: 0, held: true, reason: 'contractual', until: null });
  view.row.hold = { version: 3, held: true, reason: 'manual', until: null }; view.emit(); await view.event('release-review');
  await view.event('mutation-confirm'); assert.equal(view.calls[1].input.held, false); assert.equal(view.calls[1].input.expectedVersion, 3);
});
test('changed scopes discard open reviews while progress preserves hold/retention drafts', async () => {
  const view = await fixture(); view.element('reason').value = 'investigation'; view.element('days').value = '10';
  view.state.version++; view.state.busy = true; view.emit(); assert.equal(view.element('days').value, '10'); assert.equal(view.element('reason').value, 'investigation');
  view.state.version++; view.state.busy = false; view.emit(); await view.event('hold-form', 'submit');
  view.state.version++; view.state.scopeId = 'new-scope'; view.emit(); assert.equal(view.element('mutation-review').hidden, true);
  await view.event('mutation-confirm'); assert.equal(view.calls.length, 0);
});
test('report filters operate on loaded data; hidden selections stay explicit and paging is bounded', async () => {
  const view = await fixture(); view.state.items = Array.from({ length: 205 }, (_, index) => ({ ...view.row,
    assetId: `sha256:${index.toString(16).padStart(64, '0')}`, assetClass: index % 2 ? 'proxy' : 'original' }));
  view.state.report.totalAssets = 205; view.state.selectedIds = [view.state.items[1].assetId]; view.emit();
  assert.equal(view.element('assets').children.length, 100); await view.event('show-more'); assert.equal(view.element('assets').children.length, 200);
  view.element('class').value = 'original'; await view.event('class', 'change'); assert.match(view.element('visible').textContent, /100 of 103/);
  assert.match(view.element('visible').textContent, /1 selected/); assert.equal(view.element('plan-prepare').disabled, false);
  view.element('search').value = 'missing'; await view.event('search', 'input'); assert.equal(view.element('assets').children.length, 0);
});
test('pending recovery shows exact project/settings, hides request keys and requires a dismissal acknowledgment', async () => {
  const view = await fixture(); view.state.pending = { id: 'request-1', projectId: 'other-film', assetId: aid, kind: 'hold', createdAt: 1000,
    settings: { expectedVersion: 2, held: false, reason: null, until: null } }; view.emit();
  assert.equal(view.element('pending').hidden, false); assert.equal(view.element('hold-fields').disabled, true);
  assert.equal(view.element('dismiss').disabled, true); view.element('dismiss-reviewed').checked = true; await view.event('dismiss-reviewed', 'change');
  await view.event('dismiss'); assert.deepEqual(view.calls[0].input, { scopeId: 'scope-1', pendingId: 'request-1', reviewed: true });
});
test('retention review converts days to milliseconds and export actions bind the reviewed hash', async () => {
  const view = await fixture(); view.element('days').value = '1.5'; await view.event('retention-form', 'submit'); await view.event('mutation-confirm');
  assert.equal(view.calls[0].input.minimumArchiveAgeMs, 129600000); assert.equal(view.calls[0].input.expectedVersion, 0);
  view.state.exportReview = { kind: 'report', projectId: 'film', hash: 'b'.repeat(64), assetCount: 1, complete: false }; view.emit();
  assert.match(view.element('export-summary').textContent, /partial report/); await view.event('export-save');
  assert.deepEqual(view.calls[1].input, { scopeId: 'scope-1', hash: 'b'.repeat(64) });
});
test('older responses cannot restore another scope and cleanup always explains the blocked reference gate', async () => {
  const view = await fixture(); view.state.version = 5; view.state.plan = { items: [view.row], candidateBytes: 1000 }; view.emit();
  assert.match(view.element('plan-summary').textContent, /deletion blocked/); assert.match(view.element('plan-items').children[0].textContent, /Revision references unverified/);
  view.emit({ ...view.state, version: 2, scopeId: 'old', plan: null }); assert.equal(view.element('plan').hidden, false);
  view.state.version++; view.state.available = false; view.state.connected = false; view.state.items = []; view.state.report = null; view.state.plan = null; view.state.exportReview = null; view.emit();
  assert.equal(view.element('plan').hidden, true); assert.equal(view.element('report-area').hidden, true);
});
