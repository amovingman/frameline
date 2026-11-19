'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/shared-storage-renderer.js'), 'utf8');
class Element {
  constructor(document) { this.document = document; this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.document.activeElement = this; }
  closest() { return this.hidden ? this : null; }
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function fixture(withDesktop = true) {
  const document = { activeElement: null }, nodes = new Map(), calls = [];
  const element = key => { if (!nodes.has(key)) nodes.set(key, new Element(document)); return nodes.get(key); };
  document.getElementById = element; document.createElement = () => new Element(document);
  const state = { available: true, volumes: [{ id: 'volume-1', label: 'Studio', version: 1, status: 'online' }],
    selectedId: 'volume-1', busy: false, request: { projectId: 'film', sourceHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), assetCount: 2 },
    report: null, historicalReport: null, proposal: null, interrupted: null, error: null, outcome: null, progress: null };
  let listener;
  const desktop = { getSharedStorageState: async () => structuredClone(state), onSharedStorageState: callback => listener = callback };
  for (const method of ['registerSharedStorage', 'selectSharedStorage', 'renameSharedStorage', 'forgetSharedStorage', 'checkSharedStorage',
    'reconnectSharedStorage', 'importSharedStorageRequest', 'verifySharedStorage', 'cancelSharedStorage', 'prepareSharedStorageProposal', 'exportSharedStorageProposal']) {
    desktop[method] = async input => { calls.push({ method, input }); return structuredClone(state); };
  }
  element('storage-filter').value = 'all';
  const window = withDesktop ? { desktop } : {};
  vm.runInNewContext(source, { document, window }); await settle();
  return { state, calls, desktop, element: key => element(`storage-${key}`),
    emit(value = state) { listener(structuredClone(value)); },
    async event(key, event = 'click') { await element(`storage-${key}`).listeners[event]({ preventDefault() {} }); await settle(); } };
}
function report(count = 2) {
  return { checkedAt: 1000, projectId: 'film', reportHash: 'c'.repeat(64), items: Array.from({ length: count }, (_, i) => ({
    id: i === 0 ? '<img src=x onerror=alert(1)>' : `clip-${i}`, assetClass: i === 0 ? 'original' : 'proxy',
    verified: i % 2 === 0, reason: i % 2 === 0 ? 'size-and-hash-match' : 'candidate-missing'
  })) };
}
test('browser fallback disables real actions and desktop registration requires a usable label', async () => {
  const browser = await fixture(false); assert.equal(browser.element('register').disabled, true); assert.match(browser.element('status').textContent, /desktop app/);
  const view = await fixture(); assert.equal(view.element('register').disabled, true);
  view.element('label').value = 'Archive'; await view.event('label', 'input'); assert.equal(view.element('register').disabled, false);
  await view.event('register-form', 'submit'); assert.equal(view.calls[0].input, 'Archive');
  view.element('label').value = '/private/path'; await view.event('label', 'input'); assert.equal(view.element('register').disabled, true);
});
test('result filters, bounded paging and literal asset text keep large reports usable', async () => {
  const view = await fixture(); view.state.report = report(205); view.emit();
  assert.equal(view.element('results').children.length, 100); assert.equal(view.element('more').hidden, false);
  assert.equal(view.element('results').children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  await view.event('more'); assert.equal(view.element('results').children.length, 200);
  await view.event('more'); assert.equal(view.element('results').children.length, 205); assert.equal(view.element('more').hidden, true);
  view.element('filter').value = 'failed'; await view.event('filter', 'change');
  assert.equal(view.element('results').children.length, 100); assert.match(view.element('results-count').textContent, /100 of 102/);
  view.element('filter').value = 'verified'; await view.event('filter', 'change'); assert.match(view.element('results-count').textContent, /100 of 103/);
});
test('historical reports and interrupted checks never enable proposal preparation', async () => {
  const view = await fixture(); view.state.historicalReport = report(); view.state.interrupted = { volumeId: 'volume-1' }; view.emit();
  assert.equal(view.element('interrupted').hidden, false); assert.equal(view.element('prepare').disabled, true);
  assert.match(view.element('report-title').textContent, /Last saved/);
  assert.match(view.element('report-summary').textContent, /verify again/);
});
test('verification and export handlers bind the selected volume, request, report and proposal hashes', async () => {
  const view = await fixture(); view.state.report = report(1); view.state.proposal = { assets: [{ id: 'clip' }], projectId: 'film', proposalHash: 'd'.repeat(64) }; view.emit();
  assert.equal(view.element('prepare').disabled, false); assert.equal(view.element('export').disabled, false);
  await view.event('export'); assert.equal(view.calls[0].method, 'exportSharedStorageProposal');
  assert.equal(view.calls[0].input.volumeId, 'volume-1'); assert.equal(view.calls[0].input.volumeVersion, 1);
  assert.equal(view.calls[0].input.proposalHash, 'd'.repeat(64)); assert.equal(view.calls[0].input.requestHash, 'b'.repeat(64));
  assert.equal(view.calls[0].input.reportHash, 'c'.repeat(64));
});
test('forget review is scoped to the selected folder and requires its own confirmation', async () => {
  const view = await fixture(); await view.event('forget'); assert.equal(view.element('forget-review').hidden, false); assert.equal(view.calls.length, 0);
  await view.event('forget-cancel'); assert.equal(view.element('forget-review').hidden, true);
  await view.event('forget'); view.state.selectedId = null; view.emit(); await view.event('forget-confirm'); assert.equal(view.calls.length, 0);
  view.state.selectedId = 'volume-1'; view.emit(); await view.event('forget'); await view.event('forget-confirm');
  assert.equal(view.calls[0].method, 'forgetSharedStorage'); assert.equal(view.calls[0].input.volumeId, 'volume-1');
});
test('busy checks allow cancellation while blocking selection and show progress with recoverable errors', async () => {
  const view = await fixture(); view.state.busy = true; view.state.progress = { completed: 1, total: 4, bytesRead: 1234 }; view.emit();
  assert.equal(view.element('volume').disabled, true); assert.equal(view.element('verify').disabled, true);
  assert.equal(view.element('cancel').hidden, false); assert.equal(view.element('progress').value, 1);
  await view.event('cancel'); assert.equal(view.calls[0].method, 'cancelSharedStorage');
  view.state.busy = false; view.state.error = 'shared-storage-volume-changed'; view.emit();
  assert.match(view.element('status').textContent, /different folder identity/); assert.equal(view.element('volume').disabled, false);
});
