'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDesktopShareLinks } = require('../src/desktop-share-links');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function currentShareLinksAccount('), end = source.indexOf('function currentBranchReviewAccount(', start);
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
function link(id = 'link-1', patch = {}) { return { id, projectId: 'project-1', branch: 'main', revisionId: 'old98765-cut', revisionMessage: 'Pinned older cut',
  manifestId: `sha256:${'a'.repeat(64)}`, issuerId: 'owner', createdAt: 1000, expiresAt: 9000, revokedAt: null, status: 'active', ...patch }; }
function fixture() {
  const document = { body: {}, activeElement: null }, nodes = new Map();
  const make = (tag, name, text = '') => { const node = new Element(text); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }; document.getElementById = element;
  const state = { version: 1, scopeId: 'scope-1', selection: { projectId: 'project-1', branch: 'main' }, available: true, ready: true, busy: false, error: null, role: 'owner',
    headRevisionId: 'abc12345-head', revision: { id: 'abc12345-head', manifestId: `sha256:${'b'.repeat(64)}`, message: 'Current head cut', createdAt: '2026-11-18T12:00:00.000Z' },
    links: [link()], nextCursor: null, total: 1, checkedAt: 3000, outcome: null };
  const context = vm.createContext({ document, make, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    serviceState: { origin: 'https://service.example', status: 'connected', account: { id: 'owner' }, projects: [{ id: 'project-1', name: 'Sharing project', role: 'owner', branches: ['main', 'review'] }] },
    shareLinksState: state, shareLinksVersion: 1, shareLinksAccountKey: '', shareLinksAccessKey: '', shareLinksEvidenceKey: '', shareLinksProjectChoice: 'project-1', shareLinksBranchChoice: 'main',
    shareLinksProjectOptionsKey: '', shareLinksBranchOptionsKey: '', shareLinksTtlDraft: '86400000', shareLinksAction: null, shareLinksNotice: '', shareLinksRows: new Map(),
    window: { desktop: { getShareLinksState() {}, selectShareLinks() {}, refreshShareLinks() {}, copyShareLink() {}, revokeShareLink() {} } },
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value), serviceErrorLabel: () => 'The service action could not finish.' });
  vm.runInContext(source.slice(start, end), context); context.shareLinksAccountKey = context.currentShareLinksAccount(); context.renderShareLinksState(state);
  return { context, state, element, render: () => context.renderShareLinks() };
}
test('sharing is independent of local editor selection and copy requires a refreshed nonempty revision', () => {
  const view = fixture(); assert.equal(view.context.currentAppState, undefined); assert.equal(view.element('share-links-copy').disabled, false);
  assert.equal(view.element('share-links-ttl').value, '86400000'); assert.match(view.element('share-links-revision-stamp').textContent, /Revision abc12345.*Head checked 3000/);
  view.state.ready = false; view.render(); assert.equal(view.element('share-links-copy').disabled, true); assert.equal(view.element('share-links-refresh').disabled, false);
  view.state.ready = true; view.state.headRevisionId = null; view.state.revision = null; view.render();
  assert.equal(view.element('share-links-copy').disabled, true); assert.match(view.element('share-links-status').textContent, /branch is empty/);
});
test('current owner membership gates all private links and revision metadata; editors and viewers get a clear explanation', () => {
  for (const role of ['editor', 'viewer']) {
    const view = fixture(); view.context.serviceState.projects[0].role = role; view.render();
    assert.equal(view.element('share-links-list').children.length, 0); assert.equal(view.element('share-links-revision').hidden, true);
    assert.equal(view.element('share-links-copy').disabled, true); assert.equal(view.element('share-links-refresh').disabled, true);
    assert.match(view.element('share-links-status').textContent, /Only current project owners/);
  }
  const view = fixture(); view.state.role = 'editor'; view.render(); assert.equal(view.element('share-links-list').children.length, 0);
});
test('each row keeps its real pinned message, uses plain text, and reports last-checked status rather than live access', () => {
  const view = fixture(); view.state.links[0].revisionMessage = '<b>Older cut</b>'; view.state.links.push(link('expired', { status: 'expired' }), link('revoked', { status: 'revoked', revokedAt: 4000 }), link('unavailable', { status: 'unavailable' })); view.render();
  const rows = view.element('share-links-list').children;
  assert.equal(rows[0].children[0].textContent, '<b>Older cut</b>'); assert.equal(rows[0].children[0].innerHTML, undefined);
  assert.match(rows[0].children[1].textContent, /Active at last check.*old98765/); assert.match(rows[1].children[1].textContent, /Expired/);
  assert.match(rows[2].children[1].textContent, /Revoked/); assert.match(rows[3].children[1].textContent, /Unavailable/);
  assert.equal(rows[2].children[4].hidden, true); assert.equal(rows[1].children[4].hidden, false); assert.equal(rows[3].children[4].hidden, false);
  assert.equal(rows[0].children[3].children[1].children[3].textContent, 'old98765-cut');
  assert.doesNotMatch(rows[0].children[0].textContent, /Current head/);
});
test('progress and paging preserve stable row controls and drafts, while new head or scope resets the TTL', () => {
  const view = fixture(); view.context.shareLinksTtlDraft = '604800000'; view.render();
  const row = view.element('share-links-list').children[0], revoke = row.children[4]; row.children[3].open = true;
  view.context.renderShareLinksState({ ...view.state, version: 2, busy: true });
  assert.equal(view.element('share-links-list').children[0], row); assert.equal(row.children[4], revoke); assert.equal(row.children[3].open, true); assert.equal(view.element('share-links-ttl').value, '604800000');
  view.context.renderShareLinksState({ ...view.state, version: 3, links: [link(), link('link-2')], total: 2 }); assert.equal(view.element('share-links-list').children[0], row);
  view.context.renderShareLinksState({ ...view.state, version: 4, scopeId: 'scope-2', headRevisionId: 'next-head', revision: { ...view.state.revision, id: 'next-head' } });
  assert.equal(view.element('share-links-ttl').value, '86400000');
});
test('offline state keeps owner receipts visible but disables copy and revoke until connected', () => {
  const view = fixture(); view.context.serviceState.status = 'offline'; view.render();
  assert.equal(view.element('share-links-list').children.length, 1); assert.equal(view.element('share-links-copy').disabled, true);
  assert.equal(view.element('share-links-list').children[0].children[4].disabled, true); assert.equal(view.element('share-links-refresh').disabled, false);
});
test('form handlers submit only the opaque guard and fixed TTL; URL and token never enter renderer copy handling', () => {
  const view = fixture(); let call;
  view.context.runShareLinksAction = (method, input) => { call = { method, input }; };
  const begin = source.indexOf("document.getElementById('share-links-project').addEventListener"), finish = source.indexOf('window.desktop?.onShareLinksState', begin);
  vm.runInContext(source.slice(begin, finish), view.context);
  for (const ttl of ['3600000', '86400000', '604800000', '2592000000']) {
    view.context.shareLinksTtlDraft = ttl; view.render(); view.element('share-links-copy-form').listeners.submit({ preventDefault() {} });
    assert.equal(call.method, 'copyShareLink'); assert.equal(JSON.stringify(call.input), JSON.stringify({ scopeId: 'scope-1', ttlMs: Number(ttl) }));
  }
  view.context.shareLinksTtlDraft = '42'; view.render(); assert.equal(view.element('share-links-copy').disabled, true);
  view.element('share-links-more').listeners.click(); assert.equal(call.input.append, true);
  view.element('share-links-refresh').listeners.click(); assert.equal(call.input.append, false);
  assert.doesNotMatch(source.slice(start, end), /navigator\.clipboard|tokenHash|accessToken|\.url\b/);
});
test('emitted copy receipt survives scope rotation, reload failure and later head advancement without retargeting its notice', async () => {
  const view = fixture(); let finish;
  view.context.window.desktop.copyShareLink = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runShareLinksAction('copyShareLink', { scopeId: 'scope-1', ttlMs: 86400000 });
  const receipt = { ...view.state, version: 2, busy: true, ready: false, scopeId: 'copy-scope', outcome: { kind: 'copied', linkId: 'created-link', revisionId: 'abc12345-head', expiresAt: 9000 } };
  view.context.renderShareLinksState(receipt); assert.equal(view.context.shareLinksAction.method, 'copyShareLink');
  const final = { ...receipt, version: 3, busy: false, error: 'sync-network-unavailable', headRevisionId: 'new98765-head', revision: { ...view.state.revision, id: 'new98765-head', message: 'Later head' } };
  view.context.renderShareLinksState(final); finish(final); await pending;
  assert.match(view.element('share-links-status').textContent, /copied for revision abc12345.*Expires 9000.*Refresh sharing/);
  assert.doesNotMatch(view.element('share-links-status').textContent, /copied for revision new98765/); assert.equal(view.context.shareLinksState.headRevisionId, 'new98765-head');
});
test('a verified revoke acknowledgment survives emitted state and moves hidden originating controls to status', async () => {
  const view = fixture(); const row = view.element('share-links-list').children[0], button = row.children[4]; view.context.document.activeElement = button;
  view.context.window.desktop.revokeShareLink = async () => {
    const receipt = { ...view.state, version: 2, busy: true, scopeId: 'revoked-scope', outcome: { kind: 'revoked', linkId: 'link-1' }, links: [link('link-1', { status: 'revoked', revokedAt: 4000 })] };
    view.context.renderShareLinksState(receipt); return { ...receipt, version: 3, busy: false };
  };
  await view.context.runShareLinksAction('revokeShareLink', { scopeId: 'scope-1', linkId: 'link-1' });
  assert.equal(view.element('share-links-status').textContent, 'Link revoked.'); assert.equal(view.context.document.activeElement, view.element('share-links-status'));
});
test('unrelated scope, selection, role and wrong receipt bindings still discard a late copy acknowledgment', async t => {
  for (const change of ['scope', 'branch', 'role', 'wrong-revision', 'wrong-kind']) await t.test(change, async () => {
    const view = fixture(); let finish;
    view.context.window.desktop.copyShareLink = () => new Promise(resolve => { finish = resolve; });
    const pending = view.context.runShareLinksAction('copyShareLink', { scopeId: 'scope-1', ttlMs: 86400000 });
    const changed = { ...view.state, version: 2, scopeId: 'changed-scope', outcome: { kind: 'copied', linkId: 'copied-link', revisionId: 'abc12345-head', expiresAt: 9000 } };
    if (change === 'scope') changed.outcome = null;
    if (change === 'branch') changed.selection = { projectId: 'project-1', branch: 'review' };
    if (change === 'role') changed.role = 'editor';
    if (change === 'wrong-revision') changed.outcome.revisionId = 'another-revision';
    if (change === 'wrong-kind') changed.outcome.kind = 'revoked';
    view.context.renderShareLinksState(changed); assert.equal(view.context.shareLinksAction, null);
    finish({ ...view.state, version: 999, outcome: { kind: 'copied', linkId: 'copied-link', revisionId: 'abc12345-head', expiresAt: 9000 } }); await pending;
    assert.equal(view.context.shareLinksState.scopeId, 'changed-scope'); assert.doesNotMatch(view.element('share-links-status').textContent, /Read-only link copied/);
  });
});
test('account changes immediately clear private rows and reject old reads and pending receipts', async () => {
  const view = fixture(); const account = view.context.currentShareLinksAccount(); let finish;
  view.context.window.desktop.copyShareLink = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runShareLinksAction('copyShareLink', { scopeId: 'scope-1', ttlMs: 86400000 });
  view.context.serviceState.account.id = 'new-account'; view.context.syncShareLinksAccount();
  assert.equal(view.element('share-links-list').children.length, 0); assert.equal(view.element('share-links-revision').hidden, true);
  assert.equal(view.context.renderShareLinksState({ ...view.state, version: 99 }, account), false);
  finish({ ...view.state, version: 999, outcome: { kind: 'copied', linkId: 'old-link', revisionId: 'abc12345-head', expiresAt: 9000 } }); await pending;
  assert.equal(view.context.shareLinksState, null); assert.doesNotMatch(view.element('share-links-status').textContent, /Read-only link copied/);
});
test('stale mutation guards never invoke the API and clipboard errors do not expose secrets or claim a copy', async () => {
  const view = fixture(); let calls = 0;
  view.context.window.desktop.copyShareLink = async () => { calls++; return { ...view.state, version: 2, error: 'share-clipboard-unavailable' }; };
  await view.context.runShareLinksAction('copyShareLink', { scopeId: 'stale-scope', ttlMs: 86400000 }); assert.equal(calls, 0);
  await view.context.runShareLinksAction('copyShareLink', { scopeId: 'scope-1', ttlMs: 86400000 }); assert.equal(calls, 1);
  assert.match(view.element('share-links-status').textContent, /could not be copied.*revocation status/); assert.doesNotMatch(view.element('share-links-status').textContent, /Read-only link copied/);
  assert.equal(view.context.renderShareLinksState({ ...view.state, version: 1 }), false);
});

test('an uncertain create acknowledgment tells the owner to inspect links without claiming that nothing was created', async () => {
  const view = fixture();
  view.context.window.desktop.copyShareLink = async () => ({ ...view.state, version: 2, error: 'sync-network-unavailable', outcome: null });
  await view.context.runShareLinksAction('copyShareLink', { scopeId: 'scope-1', ttlMs: 86400000 });
  assert.match(view.element('share-links-status').textContent, /may have created a link.*Refresh sharing/);
  assert.doesNotMatch(view.element('share-links-status').textContent, /Read-only link copied|nothing was created/);
});

test('actual main-process share receipts emitted before RPC return preserve copy and cleanup outcomes without bearer data', async t => {
  for (const mode of ['copied', 'reload-failed', 'clipboard-revoked', 'clipboard-unconfirmed']) await t.test(mode, async t => {
    const view = fixture(), clone = value => JSON.parse(JSON.stringify(value)), events = [], clipboard = [];
    const token = Buffer.alloc(32, 13).toString('base64url'); let created = false, rpcReturned = false, receiptBeforeReply = false;
    const links = [link('link-1', { expiresAt: 86401000 })];
    const client = {
      async getShareReview() {
        if (created && mode === 'reload-failed') throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' });
        return { projectId: 'project-1', branch: 'main', headRevisionId: view.state.headRevisionId, revision: clone(view.state.revision), links: { items: clone(links), nextCursor: null, total: links.length } };
      },
      async createShareLink(input) {
        const receipt = link('created-link', { revisionId: view.state.headRevisionId, revisionMessage: view.state.revision.message,
          manifestId: view.state.revision.manifestId, createdAt: 3000, expiresAt: 3000 + input.ttlMs });
        links.push(receipt); created = true; return { link: clone(receipt), token };
      },
      async revokeShareLink(_projectId, linkId) {
        if (mode === 'clipboard-unconfirmed') throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' });
        const found = links.find(item => item.id === linkId); Object.assign(found, { status: 'revoked', revokedAt: 4000 }); return clone(found);
      }
    };
    const controller = createDesktopShareLinks({ connection: { getState: () => clone(view.context.serviceState), getClient: () => client }, now: () => 3000,
      async writeClipboard(url) { clipboard.push(url); if (mode.startsWith('clipboard-')) throw new Error('clipboard rejected'); },
      onChange(state) { events.push(state); if (state.outcome && !rpcReturned) receiptBeforeReply = true; view.context.renderShareLinksState(state); } });
    t.after(() => controller.dispose());
    await controller.selectShareLinks({ projectId: 'project-1', branch: 'main' }); await controller.refreshShareLinks({ append: false });
    view.context.window.desktop.copyShareLink = async input => { const state = await controller.copyShareLink(clone(input)); rpcReturned = true; return state; };
    await view.context.runShareLinksAction('copyShareLink', { scopeId: view.context.shareLinksState.scopeId, ttlMs: 86400000 });
    assert.equal(receiptBeforeReply, true); assert.equal(clipboard.length, 1);
    assert.equal(JSON.stringify(events).includes(token), false); assert.doesNotMatch(JSON.stringify(events), /tokenHash|\.example\/share#|"url"/);
    const status = view.element('share-links-status').textContent;
    if (mode === 'copied' || mode === 'reload-failed') assert.match(status, /Read-only link copied for revision abc12345/);
    if (mode === 'reload-failed') assert.match(status, /Refresh sharing to reload/);
    if (mode === 'clipboard-revoked') { assert.match(status, /could not be copied and was revoked/); assert.doesNotMatch(status, /Read-only link copied/); }
    if (mode === 'clipboard-unconfirmed') { assert.match(status, /revocation was not confirmed.*revoke link created-/); assert.doesNotMatch(status, /Read-only link copied/); }
  });
});
