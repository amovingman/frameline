'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function activeResolveTrial('), end = source.indexOf('async function resolveTrialAction(', start);
const changeStart = source.indexOf('function changeResolveTrialMode(');
const changeEnd = source.indexOf("document.getElementById('resolve-trial-mode').addEventListener", changeStart);
assert(start >= 0 && end > start && changeStart > end && changeEnd > changeStart);
class Element {
  constructor(text = '') { this.textContent = text; this.value = ''; this.checked = false; this.disabled = false; this.children = []; this.listeners = {}; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}
function fixture() {
  const nodes = new Map(), element = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const context = vm.createContext({ resolveTrialState: { enabled: true, phase: 'idle', busy: false,
    discovery: { ready: true, items: [], scanned: 0, hasMore: false } }, resolveTrialBusy: false, resolveTrialModeDraft: 'forced-rollback',
    resolveState: { sourceMode: 'manual', audit: { complete: true }, plan: { schemaVersion: 1 } },
    document: { getElementById: element }, setServiceText: (node, text) => { node.textContent = text; },
    make: (tag, name, text = '') => new Element(text) });
  vm.runInContext(source.slice(start, end) + source.slice(changeStart, changeEnd), context);
  return { context, element, render: () => context.renderResolveTrial() };
}
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');
test('forced rollback is default and an explicit mode change clears the disposable acknowledgement', () => {
  const view = fixture(); view.element('resolve-trial-ack').checked = true; view.render();
  assert.equal(view.element('resolve-trial-mode').value, 'forced-rollback');
  assert.match(view.element('resolve-trial-mode-help').textContent, /forced rollback/);
  view.element('resolve-trial-mode').value = 'rename-verify'; view.context.changeResolveTrialMode();
  assert.equal(view.element('resolve-trial-ack').checked, false);
  assert.equal(view.element('resolve-trial-prepare').disabled, true);
  assert.match(view.element('resolve-trial-mode-help').textContent, /reviewed rename remains/);
  assert.match(view.element('resolve-trial-ack-label').textContent, /named disposable project/);
  assert.equal(view.element('resolve-trial-ack').getAttribute('aria-label'), view.element('resolve-trial-ack-label').textContent);
  assert.match(view.element('resolve-trial-ack').getAttribute('aria-label'), /rename verification experiment/);
  view.element('resolve-trial-ack').checked = true; view.render();
  assert.equal(view.element('resolve-trial-prepare').disabled, false);
});
test('preparation and recovered phases use locked durable mode rather than editable renderer state', () => {
  const view = fixture(); view.element('resolve-trial-ack').checked = true;
  view.context.resolveTrialState.projectName = 'Frameline recorded disposable';
  for (const phase of ['effect-command', 'backup-command', 'edit-command', 'verified', 'recovery-capture', 'recovery-ready']) {
    view.context.resolveTrialState.phase = phase; view.context.resolveTrialState.mode = 'rename-verify'; view.render();
    assert.equal(view.element('resolve-trial-mode').value, 'rename-verify');
    assert.equal(view.element('resolve-trial-mode').disabled, true);
    assert.equal(view.element('resolve-trial-name').disabled, true);
    assert.equal(view.element('resolve-trial-name').value, 'Frameline recorded disposable');
    assert.match(view.element('resolve-trial-ack').getAttribute('aria-label'), /rename verification experiment/);
    assert.doesNotMatch(view.element('resolve-trial-ack').getAttribute('aria-label'), /forced rollback/);
    view.element('resolve-trial-mode').value = 'forced-rollback'; view.context.changeResolveTrialMode();
    assert.equal(view.element('resolve-trial-mode').value, 'rename-verify');
    assert.equal(view.element('resolve-trial-ack').checked, true);
  }
  view.context.resolveTrialState.phase = 'backup-command'; view.render();
  assert.equal(view.element('resolve-trial-issue').textContent, 'Verify backup and copy rename experiment');
  assert.equal(view.element('resolve-trial-read').textContent, 'Read rename result');
  view.context.resolveTrialState.phase = 'edit-command'; view.render();
  assert.equal(view.context.activeResolveTrial(), true);
  assert.equal(view.element('resolve-trial-copy').disabled, false);
  assert.equal(view.element('resolve-trial-read').disabled, false);
  assert.equal(view.element('resolve-trial-cancel').disabled, true);
  assert.equal(view.element('resolve-trial-read').textContent, 'Read rename result');
});
test('legacy recovered records remain forced rollback and interrupted renames retain original-name restoration', () => {
  const view = fixture(); view.context.resolveTrialModeDraft = 'rename-verify';
  view.context.resolveTrialState.phase = 'rollback-command'; view.render();
  assert.equal(view.element('resolve-trial-mode').value, 'forced-rollback');
  assert.equal(view.element('resolve-trial-copy').disabled, false);
  assert.equal(view.element('resolve-trial-read').disabled, false);
  assert.equal(view.element('resolve-trial-cancel').disabled, true);
  view.context.resolveTrialState.mode = 'rename-verify'; view.context.resolveTrialState.phase = 'recovery-ready';
  view.context.resolveTrialState.recovery = { classification: 'renamed' }; view.render();
  assert.equal(view.element('resolve-trial-issue').textContent, 'Restore original name');
  assert.match(view.element('resolve-trial-status').textContent, /Restore the original clip name/);
});
test('both modes preserve service-history and richer-review restrictions', () => {
  const view = fixture(); view.element('resolve-trial-ack').checked = true;
  for (const mode of ['forced-rollback', 'rename-verify']) {
    view.context.resolveTrialModeDraft = mode;
    for (const schemaVersion of [1, 2]) {
      view.context.resolveState = { sourceMode: 'service-history', audit: { complete: true }, plan: { schemaVersion } }; view.render();
      assert.equal(view.element('resolve-trial-prepare').disabled, true);
      assert.match(view.element('resolve-trial-status').textContent, /Service history reviews are read only/);
    }
    view.context.resolveState = { sourceMode: 'manual', audit: { complete: true }, plan: { schemaVersion: 2 } }; view.render();
    assert.equal(view.element('resolve-trial-prepare').disabled, true);
  }
});
test('saved outcome labels and retained rows reflect recorded mode while the next experiment remains editable', () => {
  const view = fixture();
  Object.assign(view.context.resolveTrialState, { mode: 'rename-verify', phase: 'verified', outcome: { status: 'applied' } }); view.render();
  assert.match(view.element('resolve-trial-status').textContent, /Rename and verify: reviewed rename observed after save\/reopen/);
  view.context.resolveTrialState.phase = 'saved'; view.context.resolveTrialState.revisionId = 'saved-revision'; view.render();
  assert.equal(view.element('resolve-trial-mode').disabled, false);
  assert.equal(view.element('resolve-trial-mode').value, 'forced-rollback');
  assert.match(view.element('resolve-trial-status').textContent, /Rename and verify outcome revision saved/);
  view.context.resolveTrialState.discovery.items = [{ transactionId: 'legacy-record', state: 'prepared', action: 'none' },
    { transactionId: 'rename-record', state: 'unfinished', action: 'none', mode: 'rename-verify' },
    { transactionId: 'corrupt-record', state: 'unreadable', action: 'none', mode: null }]; view.render();
  const rows = view.element('resolve-retained-list').children;
  assert.match(allText(rows[0]), /Force rollback test/); assert.match(allText(rows[1]), /Rename and verify/);
  assert.match(allText(rows[2]), /Mode unavailable/); assert.doesNotMatch(allText(rows[2]), /Force rollback test/);
});
test('preparation forwards the named project, explicit acknowledgement and selected mode', () => {
  const view = fixture(); let received;
  view.context.resolveTrialAction = (...args) => { received = args; };
  const formStart = source.indexOf("document.getElementById('resolve-trial-form').addEventListener");
  assert(formStart > end && changeStart > formStart); vm.runInContext(source.slice(formStart, changeStart), view.context);
  view.element('resolve-trial-name').value = '  Frameline disposable experiment  ';
  view.element('resolve-trial-ack').checked = true; view.element('resolve-trial-mode').value = 'rename-verify';
  let prevented = false; view.element('resolve-trial-form').listeners.submit({ preventDefault() { prevented = true; } });
  assert(prevented); assert.deepEqual(received, ['prepareResolveTrial', 'Frameline disposable experiment', true, 'rename-verify']);
});
test('retained-file issued results direct users back after reopen without asking for Console output', () => {
  const view = fixture();
  for (const [phase, mode, label] of [['edit-command', 'rename-verify', 'Read rename result'],
    ['rollback-command', 'forced-rollback', 'Read rollback result'], ['recovery-command', 'rename-verify', 'Read recovery result']]) {
    Object.assign(view.context.resolveTrialState, { phase, mode, resultTransport: 'retained-file' }); view.render();
    const message = view.element('resolve-trial-status').textContent;
    assert.match(message, /After the project reopens, return to Frameline/);
    assert(message.includes(label)); assert.match(message, /verify the private retained output/);
    assert.doesNotMatch(message, /copy all Console output/);
    assert.equal(view.element('resolve-trial-read').textContent, label);
  }
});
test('legacy issued commands and read-only capture/backup keep their existing Console handoff', () => {
  const view = fixture();
  for (const resultTransport of [undefined, 'console']) for (const [phase, mode] of [
    ['edit-command', 'rename-verify'], ['rollback-command', 'forced-rollback'], ['recovery-command', 'rename-verify']]) {
    Object.assign(view.context.resolveTrialState, { phase, mode, resultTransport }); view.render();
    assert.match(view.element('resolve-trial-status').textContent, /copy all Console output/);
    assert.doesNotMatch(view.element('resolve-trial-status').textContent, /private retained output/);
  }
  for (const phase of ['effect-command', 'backup-command', 'recovery-capture']) {
    Object.assign(view.context.resolveTrialState, { phase, mode: 'rename-verify', resultTransport: 'retained-file' }); view.render();
    assert.match(view.element('resolve-trial-status').textContent, /Lua Console/);
    assert.doesNotMatch(view.element('resolve-trial-status').textContent, /private retained output/);
  }
});
test('only a complete unacknowledged retained output offers Read retained result', () => {
  const view = fixture(); let selected;
  view.context.resolveTrialAction = (...args) => { selected = args; };
  view.context.resolveTrialState.discovery.items = [
    { recordId: 'retained', transactionId: 'retained-record', state: 'unfinished', action: 'recover', mode: 'rename-verify', resultTransport: 'retained-file', transportOutputAvailable: true },
    { recordId: 'outcome', transactionId: 'outcome-record', state: 'outcome', action: 'recover', mode: 'rename-verify', transportOutputAvailable: true },
    { recordId: 'legacy', transactionId: 'legacy-record', state: 'unfinished', action: 'recover' },
    { recordId: 'incomplete', transactionId: 'incomplete-record', state: 'unfinished', action: 'recover', resultTransport: 'retained-file', transportOutputAvailable: false }
  ];
  view.render(); const rows = view.element('resolve-retained-list').children;
  assert.match(allText(rows[0]), /Retained result ready to read/);
  assert.equal(rows[0].children[1].textContent, 'Read retained result');
  rows[0].children[1].listeners.click(); assert.deepEqual(selected, ['recoverDiscoveredResolveTrial', 'retained']);
  assert.equal(rows[1].children[1].textContent, 'Open outcome');
  for (const row of rows.slice(2)) {
    assert.equal(row.children[1].textContent, 'Inspect live state');
    assert.doesNotMatch(allText(row), /Retained result ready to read/);
  }
});
