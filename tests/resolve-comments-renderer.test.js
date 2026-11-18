'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function emptyResolveCommentDraft('), end = source.indexOf('function resolveServiceExpectedContext(', start);
assert(start >= 0 && end > start);
class Element {
  constructor(text = '') { this.textContent = text; this.value = ''; this.children = []; this.disabled = false;
    this.hidden = false; this.isConnected = true; this.listeners = {}; this.attributes = {}; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; node.isConnected = true; this.children.push(node); } }
  add(node) { this.append(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; this.isConnected = false; }
  replaceChildren(...nodes) { for (const node of this.children) { node.parent = null; node.isConnected = false; } this.children = []; this.append(...nodes); }
  insertBefore(node, before) { node.remove(); node.parent = this; node.isConnected = true;
    const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  closest() { for (let node = this; node; node = node.parent) if (node.hidden) return node; return null; }
  focus() { this.owner.activeElement = this; }
}
function comment(id = 'comment-1') { return { id, projectId: 'service-project', revisionId: 'incoming-revision', authorId: 'owner',
  anchor: { kind: 'clip', timelineId: 'timeline-1', clipId: 'clip-1' }, body: 'Check this trim\nKeep the pause.',
  status: 'open', createdAt: '2026-11-18T12:00:00.000Z', resolvedAt: null, canResolve: true }; }
function fixture() {
  const document = { body: {}, activeElement: null }, nodes = new Map();
  const make = (tag, className, text = '') => { const node = new Element(text); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  document.getElementById = element;
  const state = { version: 1, scopeId: 'scope-1', available: true, ready: true, busy: false, error: null, role: 'owner',
    target: { serviceProjectId: 'service-project', revisionId: 'incoming-revision', revisionMessage: 'Incoming cut', fetchedAt: 1000, manifestSha256: 'a'.repeat(64) },
    timelines: [{ id: 'timeline-1', name: 'Sequence', startFrame: 100, endFrame: 160,
      clips: [{ id: 'clip-1', name: 'Mountain', startFrame: 110, endFrame: 140 }] }],
    items: [comment()], nextCursor: null, postingAvailable: true, outcome: null };
  const context = vm.createContext({ document, make, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    serviceState: { origin: 'https://service.example', status: 'connected', account: { id: 'owner' } },
    resolveServiceState: { account: { id: 'owner' }, binding: { remoteProjectId: 'service-project', remoteBranch: 'main', role: 'owner' }, fetched: { head: 'incoming-revision' } },
    serviceScope: true, resolveServiceScopeMatches: () => context.serviceScope,
    resolveServiceExpectedContext: () => JSON.stringify([context.serviceState.origin, context.serviceState.account?.id,
      context.resolveServiceState.binding?.remoteProjectId, context.resolveServiceState.binding?.remoteBranch]),
    resolveCommentsState: state, resolveCommentsVersion: 1, resolveCommentsContext: '', resolveCommentsAccessKey: '',
    resolveCommentsScopeId: 'scope-1', resolveCommentsAction: null, resolveCommentsNotice: '', resolveCommentsDraft: null,
    resolveCommentsTimelineKey: '', resolveCommentsClipKey: '', resolveCommentRows: new Map(),
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value),
    window: { desktop: { getResolveComments() {}, addResolveComment() {}, resolveResolveComment() {}, refreshResolveComments() {} } } });
  vm.runInContext(source.slice(start, end), context);
  context.resolveCommentsContext = context.currentResolveCommentsContext(); context.resolveCommentsDraft = context.emptyResolveCommentDraft();
  return { context, state, element, render: () => context.renderResolveComments(),
    draft(body = 'A new comment') { Object.assign(context.resolveCommentsDraft, { timelineId: 'timeline-1', clipId: 'clip-1', body }); } };
}
test('comments require explicit thread refresh and role permission before posting to a verified clip', () => {
  const view = fixture(); view.draft(); view.state.ready = false; view.render();
  assert.equal(view.element('resolve-comments-post').disabled, true);
  view.state.ready = true; view.render(); assert.equal(view.element('resolve-comments-post').disabled, false);
  assert.equal(JSON.stringify(view.context.resolveCommentAnchor()), JSON.stringify({ kind: 'clip', timelineId: 'timeline-1', clipId: 'clip-1' }));
  view.state.role = 'viewer'; view.state.postingAvailable = false; view.render();
  assert.equal(view.element('resolve-comments-fields').disabled, true);
  assert.equal(view.element('resolve-comments-post').disabled, true);
  assert.equal(view.element('resolve-comments-list').children[0].children[3].disabled, false);
  assert.match(view.element('resolve-comments-status').textContent, /Posting requires editor or owner/);
});
test('frame anchors use exact absolute half-open bounds and reject invalid or unselected targets', () => {
  const view = fixture(); view.draft(); Object.assign(view.context.resolveCommentsDraft, { kind: 'range', startFrame: '100', endFrame: '160' });
  view.render(); assert.equal(view.element('resolve-comments-post').disabled, false);
  assert.equal(JSON.stringify(view.context.resolveCommentAnchor()), JSON.stringify({ kind: 'range', timelineId: 'timeline-1', startFrame: 100, endFrame: 160 }));
  for (const [a, b] of [['99', '160'], ['100', '161'], ['110', '110'], ['100.5', '120'], ['', '120']]) {
    Object.assign(view.context.resolveCommentsDraft, { startFrame: a, endFrame: b }); assert.equal(view.context.resolveCommentAnchor(), null);
  }
  Object.assign(view.context.resolveCommentsDraft, { kind: 'clip', clipId: 'not-in-snapshot' }); assert.equal(view.context.resolveCommentAnchor(), null);
});
test('plain text bodies remain literal and row controls/typed drafts stay stable across progress refresh', () => {
  const view = fixture(); view.state.items[0].body = '<img src=x onerror=alert(1)>\nSecond line'; view.draft('Draft\ntext'); view.render();
  const row = view.element('resolve-comments-list').children[0], resolve = row.children[3];
  assert.equal(row.children[2].textContent, '<img src=x onerror=alert(1)>\nSecond line'); assert.equal(row.children[2].innerHTML, undefined);
  view.state.busy = true; view.render(); assert.equal(view.element('resolve-comments-list').children[0], row);
  assert.equal(row.children[3], resolve); assert.equal(view.element('resolve-comments-body').value, 'Draft\ntext');
  view.state.busy = false; view.context.resolveCommentsDraft.body = 'x'.repeat(1001); view.render(); assert.equal(view.element('resolve-comments-post').disabled, true);
});
test('comment rows identify the current author and show snapshot clip frames without full working-flow IDs', () => {
  const view = fixture(); view.state.items.push({ ...comment('comment-2'), authorId: 'member-1234567890' }); view.render();
  const rows = view.element('resolve-comments-list').children;
  assert.match(rows[0].children[0].textContent, /^You ·/);
  assert.equal(rows[0].children[0].title, 'Author ID: owner');
  assert.match(rows[1].children[0].textContent, /^Member member-1 ·/);
  assert.equal(rows[1].children[0].title, 'Author ID: member-1234567890');
  assert.equal(rows[0].children[1].textContent, 'Sequence · Mountain · frames 110–140 (end excluded)');
  assert.equal(view.context.resolveCommentAnchorLabel({ kind: 'range', timelineId: 'timeline-1', startFrame: 100, endFrame: 160 }, view.state.timelines),
    'Sequence · frames 100–160 (end excluded)');
});
test('account/binding/incoming-revision and opaque scope changes clear drafts and reject late data', () => {
  for (const change of [view => { view.context.serviceState.account.id = 'other-account'; },
    view => { view.context.resolveServiceState.binding.remoteBranch = 'alternate'; },
    view => { view.context.resolveServiceState.fetched.head = 'new-incoming'; }]) {
    const view = fixture(); view.draft('Private unsent draft'); view.render(); const prior = view.context.currentResolveCommentsContext();
    change(view); view.context.syncResolveCommentsContext();
    assert.equal(view.element('resolve-comments-body').value, ''); assert.equal(view.element('resolve-comments-list').children.length, 0);
    assert.equal(view.context.applyResolveCommentsState({ ...view.state, version: 99 }, prior), false);
  }
  const view = fixture(); view.draft(); view.render();
  view.context.applyResolveCommentsState({ ...view.state, version: 2, scopeId: 'new-scope' });
  assert.equal(view.element('resolve-comments-body').value, ''); assert.equal(view.context.resolveCommentsDraft.timelineId, '');
});
test('failed posts retain the draft; a verified add receipt clears it even if reloading the thread fails', async () => {
  const view = fixture(); view.draft('Keep this failed post'); view.render();
  const input = { scopeId: view.state.scopeId, anchor: view.context.resolveCommentAnchor(), body: view.context.resolveCommentsDraft.body };
  view.context.window.desktop.addResolveComment = async () => ({ ...view.state, version: 2, error: 'sync-network-unavailable', outcome: null });
  await view.context.runResolveCommentsAction('addResolveComment', input);
  assert.equal(view.element('resolve-comments-body').value, 'Keep this failed post');
  view.context.window.desktop.addResolveComment = async () => ({ ...view.state, version: 3, ready: false, postingAvailable: false,
    error: 'sync-network-unavailable', outcome: { kind: 'added', commentId: 'confirmed-comment' } });
  await view.context.runResolveCommentsAction('addResolveComment', input);
  assert.equal(view.element('resolve-comments-body').value, '');
  assert.match(view.element('resolve-comments-status').textContent, /Comment posted.*Refresh comments/);
});
test('resolve acknowledgments preserve user focus elsewhere and move hidden originating controls to status', async () => {
  const view = fixture(); view.render(); let finish;
  const button = view.element('resolve-comments-list').children[0].children[3]; view.context.document.activeElement = button;
  view.context.window.desktop.resolveResolveComment = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runResolveCommentsAction('resolveResolveComment', 'comment-1');
  finish({ ...view.state, version: 2, items: [{ ...comment(), status: 'resolved', resolvedAt: '2026-11-18T12:01:00.000Z', canResolve: false }],
    outcome: { kind: 'resolved', commentId: 'comment-1' } }); await pending;
  assert.equal(view.context.document.activeElement, view.element('resolve-comments-status'));
  const second = fixture(); second.render(); second.context.document.activeElement = second.element('resolve-comments-refresh');
  second.context.window.desktop.refreshResolveComments = () => new Promise(resolve => { finish = resolve; });
  const refreshing = second.context.runResolveCommentsAction('refreshResolveComments', false);
  second.context.document.activeElement = second.element('resolve-comments-timeline'); finish({ ...second.state, version: 2 }); await refreshing;
  assert.equal(second.context.document.activeElement, second.element('resolve-comments-timeline'));
});
test('only exact target rows render and paging does not replace existing comment controls', async () => {
  const view = fixture(); view.state.items.push({ ...comment('foreign'), revisionId: 'local-uuid' }); view.state.nextCursor = 'next-page'; view.render();
  assert.equal(view.element('resolve-comments-list').children.length, 1);
  const first = view.element('resolve-comments-list').children[0]; let append;
  view.context.window.desktop.refreshResolveComments = async input => { append = input; return { ...view.state, version: 2,
    items: [comment(), comment('comment-2')], nextCursor: null }; };
  await view.context.runResolveCommentsAction('refreshResolveComments', true);
  assert.equal(append, true); assert.equal(view.element('resolve-comments-list').children[0], first);
  assert.equal(view.element('resolve-comments-list').children.length, 2); assert.equal(view.element('resolve-comments-more').hidden, true);
});
test('form submission sends an opaque scope guard, body and snapshot anchor without a renderer-selected revision identifier', () => {
  const view = fixture(); let posted;
  view.context.runResolveCommentsAction = (method, input) => { posted = { method, input }; };
  const handlersStart = source.indexOf("document.getElementById('resolve-comments-refresh').addEventListener");
  const handlersEnd = source.indexOf('window.desktop?.onResolveServiceState', handlersStart);
  assert(handlersStart >= 0 && handlersEnd > handlersStart); vm.runInContext(source.slice(handlersStart, handlersEnd), view.context);
  view.draft('Review this shot'); view.render();
  view.element('resolve-comments-form').listeners.submit({ preventDefault() {} });
  assert.equal(posted.method, 'addResolveComment'); assert.deepEqual(Object.keys(posted.input).sort(), ['anchor', 'body', 'scopeId']);
  assert.equal(posted.input.scopeId, 'scope-1');
  assert.equal(posted.input.body, 'Review this shot'); assert.equal(posted.input.anchor.clipId, 'clip-1');
});
test('an old submitted scope cannot post or let a late acknowledgment clear a new scoped draft', async () => {
  const view = fixture(); view.draft('First scoped draft'); view.render(); let finish, calls = 0;
  view.context.window.desktop.addResolveComment = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const input = { scopeId: 'scope-1', anchor: view.context.resolveCommentAnchor(), body: 'First scoped draft' };
  const pending = view.context.runResolveCommentsAction('addResolveComment', input);
  view.context.applyResolveCommentsState({ ...view.state, version: 2, scopeId: 'scope-2' }); view.draft('New scoped draft'); view.render();
  finish({ ...view.state, version: 999, scopeId: 'scope-1', outcome: { kind: 'added', commentId: 'old-comment' } }); await pending;
  assert.equal(view.context.resolveCommentsState.scopeId, 'scope-2');
  assert.equal(view.element('resolve-comments-body').value, 'New scoped draft');
  await view.context.runResolveCommentsAction('addResolveComment', input);
  assert.equal(calls, 1); assert.equal(view.element('resolve-comments-body').value, 'New scoped draft');
});
