'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8');
const actions = source.slice(source.indexOf('let scanActionGeneration = 0;'), source.indexOf('async function saveRevision('));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const nodes = new Map(), states = [], events = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; } });
    return nodes.get(id);
  };
  const choose = deferred(), rescan = deferred(), cancellation = deferred();
  const context = vm.createContext({ document: { getElementById: node }, renderAppState: state => states.push(state),
    window: { desktop: { chooseProject: () => choose.promise, rescanProject: () => rescan.promise, cancelScan: () => cancellation.promise }, dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(name, options) { this.name = name; this.detail = options.detail; } } });
  vm.runInContext(actions, context);
  return { context, node, choose, rescan, cancellation, states, events };
}
test('an obsolete picker result and finally cannot replace a newer scan state or clear its busy controls', async () => {
  const f = fixture(); const old = f.context.chooseFile(); const cancelled = f.context.cancelProjectScan();
  f.cancellation.resolve({ scanStatus: 'cancelled' }); await cancelled;
  const fresh = f.context.rescanProject(); assert.equal(f.node('choose-file').disabled, true);
  f.choose.resolve({ selectedProject: { name: 'old.fcpxml' }, scanStatus: 'ready' }); await old;
  assert.equal(f.node('choose-file').disabled, true); assert.equal(f.node('view-workspace')['aria-busy'], 'true');
  assert.equal(f.states.length, 1); assert.equal(f.events.length, 0);
  f.rescan.resolve({ selectedProject: { name: 'fresh.fcpxml' }, scanStatus: 'ready' }); await fresh;
  assert.equal(f.states.at(-1).selectedProject.name, 'fresh.fcpxml'); assert.equal(f.node('choose-file').disabled, false);
});
test('an obsolete rejected rescan cannot overwrite a newer picker notice or reset its busy state', async () => {
  const f = fixture(); const old = f.context.rescanProject(), fresh = f.context.chooseFile();
  f.rescan.reject(new Error('old scan failed')); await old;
  assert.equal(f.node('choose-file').disabled, true); assert.notEqual(f.node('file-notice').textContent, 'Could not rescan the selected project. Try again.');
  f.choose.resolve({ selectedProject: { name: 'fresh.fcpxml' }, scanStatus: 'ready' }); await fresh;
  assert.match(f.node('file-notice').textContent, /^fresh.fcpxml scanned read only/);
});
test('failed cancellation reports uncertainty and releases busy controls without accepting an old scan result', async () => {
  const f = fixture(); const old = f.context.rescanProject(), cancelled = f.context.cancelProjectScan();
  f.cancellation.reject(new Error('cancel unavailable')); await cancelled;
  assert.match(f.node('file-notice').textContent, /could not be confirmed/); assert.equal(f.node('cancel-scan').disabled, false);
  f.rescan.resolve({ selectedProject: { name: 'obsolete.fcpxml' } }); await old;
  assert.equal(f.states.length, 0); assert.match(f.node('file-notice').textContent, /could not be confirmed/);
});
test('visible scan counters remain current while live announcements are limited to phase and ten-percent changes', () => {
  const f = fixture(); const progress = { scanId: 'scan-one', phase: 'reading', bytesRead: 100, totalBytes: 1000 };
  f.context.renderProjectScanProgress(progress); assert.equal(f.node('project-scan-progress').value, 0.1);
  const first = f.node('project-scan-status').textContent;
  f.context.renderProjectScanProgress({ ...progress, bytesRead: 109 });
  assert.equal(f.node('project-scan-progress').value, 0.109); assert.equal(f.node('project-scan-status').textContent, first);
  assert.match(f.node('project-scan-progress-text').textContent, /109 of 1,000 bytes/);
  f.context.renderProjectScanProgress({ ...progress, bytesRead: 200 }); assert.match(f.node('project-scan-status').textContent, /20%/);
  f.context.renderProjectScanProgress({ ...progress, phase: 'cancelled' });
  assert.match(f.node('project-scan-status').textContent, /export was not changed/); assert.equal(f.node('project-scan-progress').value, undefined);
});
