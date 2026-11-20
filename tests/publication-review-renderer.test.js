'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture() {
  const elements = new Map(), subscribers = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, checked: false, textContent: '', isConnected: true,
      events: {}, addEventListener(event, handler) { this.events[event] = handler; }, focus() {}, scrollIntoView() {} });
    return elements.get(id);
  };
  let state = { version: 1, publicationScopeId: 'scope-a', publicationGeneration: 1, binding: { role: 'owner' } }, serial = 0;
  const review = () => ({ reviewId: `review-${++serial}`, scopeId: state.publicationScopeId, generation: state.publicationGeneration,
    sha256: 'a'.repeat(64), byteLength: 24, revisionCount: 1, page: 0, pageCount: 2, destination: 'https://owner.example.test',
    projectName: 'Private owner cut', branch: 'main', text: '{"message":"Private cut"}' });
  const desktop = { onServiceState: listener => { subscribers.fcpxml = listener; }, onResolveServiceState() {},
    getServiceState: async () => ({ ...state }), previewServicePublication: async () => review(),
    getServicePublicationPage: async () => ({ reviewId: 'review-1', page: 1, pageCount: 2, text: 'Private page two' }),
    dismissServicePublication: async () => ({}), pushServiceRevisions: async () => ({ error: null }) };
  const window = { desktop }, document = { getElementById: element, activeElement: element('return-focus') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/publication-review-renderer.js'), 'utf8'), { window, document });
  return { window, desktop, el: key => element(`publication-${key}`), panel: element('publication-review'), review,
    change(patch) { state = { ...state, ...patch, version: state.version + 1 }; subscribers.fcpxml({ ...state }); },
    click: async id => element(`publication-${id}`).events.click() };
}
test('completion and failed page reads clear private metadata before a later sign-out', async () => {
  const f = fixture(); await f.window.FramePublicationReview.start('fcpxml'); assert.match(f.el('json').textContent, /Private/);
  f.el('consent').checked = true; await f.click('approve');
  for (const id of ['json', 'scope', 'hash']) assert.equal(f.el(id).textContent, '');
  f.change({ publicationScopeId: null, binding: null }); assert.equal(f.el('json').textContent, '');
  f.change({ publicationScopeId: 'scope-b', binding: { role: 'owner' } });
  await f.window.FramePublicationReview.start('fcpxml');
  f.desktop.getServicePublicationPage = async () => { throw new Error('private details'); };
  await f.click('next'); assert.equal(f.el('json').textContent, ''); assert.equal(f.el('scope').textContent, '');
});
test('delayed previews and page failures cannot restore another account or clear its newer review', async () => {
  const f = fixture(); let release;
  f.desktop.previewServicePublication = async () => { const value = f.review(); await new Promise(resolve => { release = resolve; }); return value; };
  const pending = f.window.FramePublicationReview.start('fcpxml');
  await Promise.resolve(); f.change({ publicationScopeId: 'scope-b', publicationGeneration: 2 }); release(); await pending;
  assert.equal(f.el('json').textContent, '');
  f.desktop.previewServicePublication = async () => f.review(); await f.window.FramePublicationReview.start('fcpxml');
  let rejectPage; f.desktop.getServicePublicationPage = () => new Promise((_resolve, reject) => { rejectPage = reject; });
  const oldPage = f.click('next'); await Promise.resolve();
  f.change({ publicationScopeId: 'scope-c', publicationGeneration: 3 });
  await f.window.FramePublicationReview.start('fcpxml'); const current = f.el('json').textContent;
  rejectPage(new Error('old account')); await oldPage;
  assert.equal(f.el('json').textContent, current); assert.equal(f.panel.hidden, false);
});

test('Resolve publish and queued retry reveal the History review before opening it', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), calls = [];
  const context = vm.createContext({ window: { FramePublicationReview: { start: (...args) => calls.push(['review', ...args]) } },
    showView: name => calls.push(['view', name]) });
  for (const [name, end] of [['runResolveServiceQueueAction', 'async function runResolveServiceAction'], ['runResolveServiceAction', 'function renderResolveServiceProvenance']]) {
    vm.runInContext(source.slice(source.indexOf(`async function ${name}`), source.indexOf(end)), context);
  }
  await context.runResolveServiceAction('pushResolveServiceRevisions');
  await context.runResolveServiceQueueAction('retryResolveServiceSync', 'queued-request');
  assert.deepEqual(calls, [['view', 'history'], ['review', 'resolve'], ['view', 'history'], ['review', 'resolve', 'queued-request']]);
});
