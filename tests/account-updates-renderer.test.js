'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDesktopAccountUpdates } = require('../src/desktop-account-updates');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function currentAccountUpdatesAccount('), end = source.indexOf('function currentShareLinksAccount(', start);
assert(start >= 0 && end > start);
class Element {
  constructor(text = '') { this.textContent = text; this.value = ''; this.children = []; this.hidden = false; this.disabled = false; this.isConnected = true; this.listeners = {}; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; node.isConnected = true; this.children.push(node); } }
  add(node) { this.append(node); }
  get options() { return this.children; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; this.isConnected = false; }
  replaceChildren(...nodes) { for (const node of this.children) { node.parent = null; node.isConnected = false; } this.children = []; this.append(...nodes); }
  insertBefore(node, before) { node.remove(); node.parent = this; node.isConnected = true; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  closest() { for (let node = this; node; node = node.parent) if (node.hidden) return node; return null; }
  focus() { this.owner.activeElement = this; }
}
function item(id = 'event-1', patch = {}) { return { id, projectId: 'project-1', projectName: 'Current project', actorId: 'member-1', subjectId: 'revision-1', type: 'revision.created', at: 1000, read: false, accessLost: false, ...patch }; }
function fixture() {
  const document = { body: {}, activeElement: null }, nodes = new Map();
  const make = (tag, name, text = '') => { const node = new Element(text); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }; document.getElementById = element;
  for (const mode of ['off', 'immediate', 'daily']) { const option = make('option'); option.value = mode; element('notification-preferences-mode').add(option); }
  const state = { version: 1, scopeId: 'account-scope', available: true, ready: true, busy: false, error: null, filter: 'all', items: [item()], unreadCount: 1,
    nextCursor: null, checkedAt: 2000, watch: false, outcome: null,
    preference: { scopeId: 'preference-scope', projectId: 'project-1', role: 'viewer', ready: true, busy: false, error: null,
      value: { projectId: 'project-1', version: 0, mode: 'off', digestHourUtc: 9, updatedAt: null, deliveryAvailable: true, accountEmail: 'user@example.test' } } };
  const context = vm.createContext({ document, make, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    serviceState: { origin: 'https://service.example', status: 'connected', account: { id: 'user-1', email: 'user@example.test' }, projects: [{ id: 'project-1', name: 'Current project', role: 'viewer', branches: ['main'] }] },
    accountUpdatesState: state, accountUpdatesVersion: 1, accountUpdatesAccountKey: '', accountUpdatesAccessKey: '', accountUpdatesAction: null, accountUpdatesFilter: 'all', accountUpdatesNotice: '',
    notificationPreferencesNotice: '', notificationProjectChoice: 'project-1', notificationProjectOptionsKey: '', notificationPreferenceEvidenceKey: '', notificationPreferenceDraft: { mode: 'off', digestHourUtc: '9' }, accountUpdateRows: new Map(),
    window: { desktop: { getAccountUpdatesState() {}, refreshAccountUpdates() {}, markAccountUpdateRead() {}, setAccountUpdatesWatch() {}, selectNotificationProject() {}, refreshNotificationPreferences() {}, saveNotificationPreferences() {}, disableNotificationDelivery() {} } },
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value), serviceErrorLabel: () => 'The service action could not finish.' });
  vm.runInContext(source.slice(start, end), context); context.accountUpdatesAccountKey = context.currentAccountUpdatesAccount(); context.renderAccountUpdatesState(state);
  return { context, state, element, render: () => context.renderAccountUpdates() };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
function handlers(view) {
  const begin = source.indexOf("document.getElementById('account-updates-refresh').addEventListener"), finish = source.indexOf('window.desktop?.onAccountUpdatesState', begin);
  vm.runInContext(source.slice(begin, finish), view.context);
}
test('account feed works without local selection or any remaining projects and never marks entries read by opening', () => {
  const view = fixture(); assert.equal(view.context.currentAppState, undefined); assert.equal(view.element('account-updates-watch').checked, false);
  view.context.serviceState.projects = []; view.state.preference = null;
  view.state.items = [item('access-loss', { accessLost: true, type: 'member.removed', projectId: null, projectName: null, actorId: null, subjectId: null })]; view.render();
  assert.equal(view.element('account-updates-list').children.length, 1); assert.equal(view.element('account-updates-refresh').disabled, false);
  assert.equal(view.element('notification-preferences-disable').disabled, false); assert.equal(view.state.items[0].read, false);
  assert.match(view.element('account-updates-unread').textContent, /1 unread account update/);
});
test('an unchecked feed does not present its default unread zero as a measured count', () => {
  const view = fixture();
  view.context.renderAccountUpdatesState({ ...view.state, version: 2, ready: false, checkedAt: null, unreadCount: 0, items: [] });
  assert.equal(view.element('account-updates-unread').textContent, 'Unread not checked');
  assert.equal(view.element('account-updates-refresh').disabled, false);
  view.context.renderAccountUpdatesState({ ...view.state, version: 3, ready: true, checkedAt: 3000, unreadCount: 0, items: [] });
  assert.equal(view.element('account-updates-unread').textContent, '0 unread account updates');
});
test('access-loss rows remain generic even if stale private metadata appears; current project names are plain text', () => {
  const view = fixture(); view.state.items = [item('redacted', { accessLost: true, type: 'project.deleted', projectName: 'Private old name', actorId: 'private-actor', subjectId: 'private-subject' }), item('safe', { projectName: '<b>Current name</b>' })]; view.render();
  const rows = view.element('account-updates-list').children;
  assert.match(text(rows[0]), /Your project access ended/); assert.doesNotMatch(text(rows[0]), /Private old name|private-actor|private-subject|project-1/);
  assert.equal(rows[1].children[0].children[1].textContent, '<b>Current name</b>'); assert.equal(rows[1].children[0].children[1].innerHTML, undefined);
  view.context.serviceState.projects = []; view.render();
  assert.equal(view.element('account-updates-list').children.length, 1); assert.doesNotMatch(text(view.element('account-updates-list')), /Current name/);
});
test('feed progress preserves email drafts and keyed controls; preference project/version/role scope changes reset drafts', () => {
  const view = fixture(); view.context.notificationPreferenceDraft = { mode: 'daily', digestHourUtc: '14' }; view.render();
  const row = view.element('account-updates-list').children[0], button = row.children[1];
  view.context.renderAccountUpdatesState({ ...view.state, version: 2, busy: true, items: [item(), item('event-2')], unreadCount: 2 });
  assert.equal(view.element('notification-preferences-mode').value, 'daily'); assert.equal(view.element('notification-preferences-hour').value, '14');
  assert.equal(view.element('account-updates-list').children[0], row); assert.equal(row.children[1], button);
  view.context.renderAccountUpdatesState({ ...view.state, version: 3, preference: { ...view.state.preference, scopeId: 'new-preference-scope', value: { ...view.state.preference.value, version: 1, mode: 'immediate', updatedAt: 2500 } } });
  assert.equal(view.element('notification-preferences-mode').value, 'immediate');
});
test('all project roles manage only their own loaded preferences; delivery-disabled servers prevent enabling email', () => {
  for (const role of ['owner', 'editor', 'viewer']) {
    const view = fixture(); view.context.serviceState.projects[0].role = role; view.state.preference.role = role;
    view.context.notificationPreferenceDraft.mode = 'immediate'; view.render(); assert.equal(view.element('notification-preferences-save').disabled, false);
    view.state.preference.value.deliveryAvailable = false; view.render(); assert.equal(view.element('notification-preferences-save').disabled, true);
    assert.equal(view.element('notification-preferences-mode').options.find(item => item.value === 'off').disabled, false);
    assert.equal(view.element('notification-preferences-mode').options.find(item => item.value === 'daily').disabled, true);
    assert.match(view.element('notification-preferences-status').textContent, /not configured/);
    view.state.preference.value.mode = 'daily'; view.context.notificationPreferenceDraft.mode = 'off'; view.render(); assert.equal(view.element('notification-preferences-save').disabled, false);
  }
});
test('preferences require explicit loading, exact UTC hour bounds and current project role; email address is not editable', () => {
  const view = fixture(); view.state.preference.ready = false; view.render(); assert.equal(view.element('notification-preferences-fields').disabled, true);
  assert.equal(view.element('notification-preferences-load').disabled, false); assert.equal(view.element('notification-preferences-email').textContent, 'Account email: user@example.test');
  view.state.preference.ready = true; view.context.notificationPreferenceDraft.mode = 'daily';
  for (const hour of ['0', '23']) { view.context.notificationPreferenceDraft.digestHourUtc = hour; view.render(); assert.equal(view.element('notification-preferences-save').disabled, false); }
  for (const hour of ['', '-1', '24', '2.5']) { view.context.notificationPreferenceDraft.digestHourUtc = hour; view.render(); assert.equal(view.element('notification-preferences-save').disabled, true); }
  view.context.serviceState.projects[0].role = 'editor'; view.context.syncAccountUpdatesAccount(); assert.equal(view.element('notification-preferences-fields').disabled, true);
  assert.equal(view.context.notificationPreferenceDraft.mode, 'off'); assert.equal(view.context.notificationPreferenceDraft.digestHourUtc, '9');
});
test('handlers use explicit load, account/preference opaque scopes, exact filter paging and opt-in watch only', () => {
  const view = fixture(), calls = []; view.context.runAccountUpdatesAction = (method, input) => { calls.push({ method, input }); }; handlers(view);
  view.element('notification-preferences-project').listeners.change({ target: { value: 'project-1' } }); assert.equal(calls.at(-1).method, 'selectNotificationProject'); assert.equal(calls.length, 1);
  view.element('notification-preferences-load').listeners.click(); assert.equal(calls.at(-1).method, 'refreshNotificationPreferences');
  view.context.notificationPreferenceDraft = { mode: 'daily', digestHourUtc: '14' }; view.render(); view.element('notification-preferences-form').listeners.submit({ preventDefault() {} });
  assert.equal(calls.at(-1).method, 'saveNotificationPreferences'); assert.equal(JSON.stringify(calls.at(-1).input), JSON.stringify({ scopeId: 'preference-scope', mode: 'daily', digestHourUtc: 14 }));
  view.element('notification-preferences-disable').listeners.click(); assert.equal(JSON.stringify(calls.at(-1).input), JSON.stringify({ scopeId: 'account-scope' }));
  view.element('account-updates-watch').listeners.change({ target: { checked: true } }); assert.equal(calls.at(-1).method, 'setAccountUpdatesWatch'); assert.equal(calls.at(-1).input, true);
  view.element('account-updates-filter').listeners.change({ target: { value: 'unread' } }); assert.equal(JSON.stringify(calls.at(-1).input), JSON.stringify({ append: false, filter: 'unread' }));
  view.element('account-updates-more').listeners.click(); assert.equal(calls.at(-1).input.append, true);
});
test('mode changes can turn email off after an invalid hidden daily hour without sending an invalid value', () => {
  const view = fixture(); handlers(view); view.context.notificationPreferenceDraft = { mode: 'daily', digestHourUtc: '24' };
  view.element('notification-preferences-mode').listeners.change({ target: { value: 'off' } });
  assert.equal(view.context.notificationPreferenceDraft.digestHourUtc, '9'); assert.equal(view.element('notification-preferences-hour-field').hidden, true);
});
test('emitted read acknowledgment updates receipts and restores focus after the originating button disappears', async () => {
  const view = fixture(); const button = view.element('account-updates-list').children[0].children[1]; view.context.document.activeElement = button;
  view.context.window.desktop.markAccountUpdateRead = async () => {
    const receipt = { ...view.state, version: 2, scopeId: 'read-scope', busy: true, items: [item('event-1', { read: true })], unreadCount: 0, outcome: { kind: 'read', eventId: 'event-1' } };
    view.context.renderAccountUpdatesState(receipt); return { ...receipt, version: 3, busy: false };
  };
  await view.context.runAccountUpdatesAction('markAccountUpdateRead', { scopeId: 'account-scope', eventId: 'event-1' });
  assert.equal(view.element('account-updates-status').textContent, 'Update marked read.'); assert.equal(view.context.document.activeElement, view.element('account-updates-status'));
});
test('preference ACK emitted before RPC retains success even when reloading fails; wrong project/role receipts are rejected', async t => {
  const view = fixture();
  view.context.window.desktop.saveNotificationPreferences = async () => {
    const receipt = { ...view.state, version: 2, outcome: { kind: 'preferences-saved', projectId: 'project-1', version: 1 }, preference: { ...view.state.preference,
      scopeId: 'saved-preference-scope', ready: false, value: { ...view.state.preference.value, version: 1, mode: 'daily', digestHourUtc: 14, updatedAt: 2500 } } };
    view.context.renderAccountUpdatesState(receipt); return { ...receipt, version: 3, preference: { ...receipt.preference, error: 'sync-network-unavailable' } };
  };
  await view.context.runAccountUpdatesAction('saveNotificationPreferences', { scopeId: 'preference-scope', mode: 'daily', digestHourUtc: 14 });
  assert.match(view.element('notification-preferences-status').textContent, /were saved.*Load email preferences/); assert.equal(view.element('notification-preferences-save').disabled, true);
  for (const change of ['project', 'role']) await t.test(change, async () => {
    const other = fixture(); let finish; other.context.window.desktop.saveNotificationPreferences = () => new Promise(resolve => { finish = resolve; });
    const pending = other.context.runAccountUpdatesAction('saveNotificationPreferences', { scopeId: 'preference-scope', mode: 'immediate', digestHourUtc: 9 });
    const changed = { ...other.state, version: 2, outcome: { kind: 'preferences-saved', projectId: 'project-1', version: 1 }, preference: { ...other.state.preference, scopeId: 'changed-preference-scope' } };
    if (change === 'project') changed.preference.projectId = 'another-project'; else changed.preference.role = 'editor';
    other.context.renderAccountUpdatesState(changed); finish({ ...other.state, version: 999, outcome: { kind: 'preferences-saved', projectId: 'project-1', version: 1 } }); await pending;
    assert.equal(other.context.accountUpdatesState.preference.scopeId, 'changed-preference-scope'); assert.doesNotMatch(other.element('notification-preferences-status').textContent, /were saved/);
  });
});
test('turn off all email works with no accessible projects and keeps the global acknowledgment visible', async () => {
  const view = fixture(); view.context.serviceState.projects = []; view.state.preference = null; view.render();
  view.context.window.desktop.disableNotificationDelivery = async () => {
    const receipt = { ...view.state, version: 2, scopeId: 'disabled-scope', outcome: { kind: 'delivery-disabled' } }; view.context.renderAccountUpdatesState(receipt); return { ...receipt, version: 3 };
  };
  await view.context.runAccountUpdatesAction('disableNotificationDelivery', { scopeId: 'account-scope' });
  assert.equal(view.element('notification-preferences-status').textContent, 'All email delivery is off for this account.');
});
test('account changes hide all old feed/settings and reject late mutation outcomes; offline mode keeps refresh retry available', async () => {
  const view = fixture(); view.context.serviceState.status = 'offline'; view.render(); assert.equal(view.element('account-updates-refresh').disabled, false); assert.equal(view.element('notification-preferences-save').disabled, true);
  view.context.serviceState.status = 'connected'; let finish; view.context.window.desktop.markAccountUpdateRead = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runAccountUpdatesAction('markAccountUpdateRead', { scopeId: 'account-scope', eventId: 'event-1' });
  const account = view.context.currentAccountUpdatesAccount(); view.context.serviceState.account.id = 'new-account'; view.context.syncAccountUpdatesAccount();
  assert.equal(view.element('account-updates-list').children.length, 0); assert.equal(view.element('account-updates-watch').checked, false);
  assert.equal(view.context.renderAccountUpdatesState({ ...view.state, version: 99 }, account), false);
  finish({ ...view.state, version: 999, outcome: { kind: 'read', eventId: 'event-1' } }); await pending;
  assert.equal(view.context.accountUpdatesState, null); assert.doesNotMatch(view.element('account-updates-status').textContent, /marked read/);
});

test('actual controller emitted-before-RPC receipts preserve explicit read/save/disable acknowledgments and reload recovery', async t => {
  for (const [kind, failReload] of [['read', false], ['save', false], ['save', true], ['disable', true], ['disable-no-projects', false]]) await t.test(`${kind}/${failReload}`, async t => {
    const view = fixture(), clone = value => JSON.parse(JSON.stringify(value));
    let value = clone(view.state.preference.value), rows = [item()], mutated = false, returned = false, beforeReply = false;
    if (kind.startsWith('disable')) Object.assign(value, { version: 1, mode: 'daily', updatedAt: 2000 });
    const client = {
      async getAccountNotifications() { return { items: clone(rows), nextCursor: null, unreadCount: rows.filter(row => !row.read).length }; },
      async markAccountNotificationRead(eventId) { rows = rows.map(row => ({ ...row, read: row.id === eventId || row.read })); return { eventId, read: true }; },
      async getNotificationPreferences() { if (mutated && failReload) throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' }); return clone(value); },
      async setNotificationPreferences(input) { Object.assign(value, { version: value.version + 1, mode: input.mode, digestHourUtc: input.digestHourUtc, updatedAt: 3000 }); mutated = true; return clone(value); },
      async disableNotificationDelivery() { value = { ...value, version: value.version + 1, mode: 'off', updatedAt: 3000 }; mutated = true; return { disabled: true }; }
    };
    const controller = createDesktopAccountUpdates({ connection: { getState: () => clone(view.context.serviceState), getClient: () => client }, now: () => 3000,
      onChange(state) { if (state.outcome && !returned) beforeReply = true; view.context.renderAccountUpdatesState(state); } });
    t.after(() => controller.dispose());
    await controller.getState(); await controller.selectNotificationProject('project-1'); await controller.refreshNotificationPreferences();
    await controller.refreshAccountUpdates({ append: false, filter: 'all' });
    if (kind === 'disable-no-projects') { view.context.serviceState.projects = []; await controller.connectionChanged(); }
    const method = kind === 'read' ? 'markAccountUpdateRead' : kind === 'save' ? 'saveNotificationPreferences' : 'disableNotificationDelivery';
    view.context.window.desktop[method] = async input => { const result = await controller[method](clone(input)); returned = true; return result; };
    const state = view.context.accountUpdatesState;
    const input = kind === 'read' ? { scopeId: state.scopeId, eventId: 'event-1' } : kind === 'save'
      ? { scopeId: state.preference.scopeId, mode: 'daily', digestHourUtc: 14 } : { scopeId: state.scopeId };
    await view.context.runAccountUpdatesAction(method, input); assert.equal(beforeReply, true);
    if (kind === 'read') assert.equal(view.element('account-updates-status').textContent, 'Update marked read.');
    else {
      assert.match(view.element('notification-preferences-status').textContent, kind === 'save' ? /preferences were saved/ : /All email delivery is off/);
      if (failReload) { assert.match(view.element('notification-preferences-status').textContent, /Load email preferences/); assert.equal(view.element('notification-preferences-save').disabled, true); }
    }
    assert.equal(view.context.accountUpdatesAction, null);
  });
});
