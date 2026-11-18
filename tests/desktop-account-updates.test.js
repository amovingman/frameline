'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopAccountUpdates } = require('../src/desktop-account-updates');
const fail = code => Object.assign(new Error('/private/workspace bearer-secret password-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cursor = index => `${Buffer.from(`account-page-${index}`).toString('base64url')}.${Buffer.alloc(32, 9).toString('base64url')}`;
function item(id = 'event-1', patch = {}) { return { id, projectId: 'project-1', projectName: 'Current project', actorId: 'owner-1', subjectId: 'revision-1', type: 'revision.created', at: 1000, read: false, accessLost: false, ...patch }; }
function fixture(t) {
  const account = { origin: 'https://updates.example.test', status: 'connected', account: { id: 'member-1', email: 'member@example.test' },
    projects: [{ id: 'project-1', name: 'Current project', role: 'viewer', branches: ['main'] }, { id: 'project-2', name: 'Second project', role: 'editor', branches: ['main'] }] };
  const rows = [item()], events = [], calls = [], hooks = {}, preferences = new Map(), committed = new Map(), timers = new Map();
  const clock = { value: 3000 }, mail = { available: true }; let timerId = 0;
  const timer = (fn, delay) => { const id = { number: ++timerId, unref() {} }; timers.set(id, { fn, delay }); return id; };
  const pref = pid => {
    const key = `${account.account.id}:${pid}`;
    if (!preferences.has(key)) preferences.set(key, { projectId: pid, version: 0, mode: 'off', digestHourUtc: 9, updatedAt: null });
    return { ...preferences.get(key), deliveryAvailable: mail.available, accountEmail: account.account.email };
  };
  const page = (input = { filter: 'all' }, patch = {}) => ({ items: structuredClone(rows.filter(value => input.filter !== 'unread' || !value.read)),
    nextCursor: null, unreadCount: rows.filter(value => !value.read).length, ...patch });
  const client = {
    async getAccountNotifications(input, options) { calls.push({ kind: 'feed', input: structuredClone(input), signal: options.signal }); return hooks.feed ? hooks.feed(input, options) : page(input); },
    async markAccountNotificationRead(eventId, options) {
      calls.push({ kind: 'read', eventId, signal: options.signal }); if (hooks.read) return hooks.read(eventId, options);
      const found = rows.find(value => value.id === eventId); if (found) found.read = true; return { eventId, read: true };
    },
    async getNotificationPreferences(pid, options) { calls.push({ kind: 'load', pid, signal: options.signal }); return hooks.load ? hooks.load(pid, options) : pref(pid); },
    async setNotificationPreferences(input, options) {
      calls.push({ kind: 'save', input: structuredClone(input), signal: options.signal }); if (hooks.save) return hooks.save(input, options);
      if (committed.has(input.idempotencyKey)) return structuredClone(committed.get(input.idempotencyKey));
      const previous = pref(input.projectId); if (previous.version !== input.expectedVersion) throw fail('notification-preference-version-conflict');
      const changed = previous.mode !== input.mode || previous.digestHourUtc !== input.digestHourUtc;
      const result = { ...previous, version: previous.version + (changed ? 1 : 0), mode: input.mode, digestHourUtc: input.digestHourUtc, updatedAt: changed ? clock.value : previous.updatedAt };
      preferences.set(`${account.account.id}:${input.projectId}`, result); committed.set(input.idempotencyKey, result); return structuredClone(result);
    },
    async disableNotificationDelivery(options) {
      calls.push({ kind: 'disable', signal: options.signal }); if (hooks.disable) return hooks.disable(options);
      for (const [key, value] of preferences) if (key.startsWith(`${account.account.id}:`)) preferences.set(key, { ...value, mode: 'off', version: value.version + (value.mode === 'off' ? 0 : 1), updatedAt: value.mode === 'off' ? value.updatedAt : clock.value });
      return { disabled: true };
    }
  };
  const controller = createDesktopAccountUpdates({ connection: { getState: () => structuredClone(account), getClient: () => client }, now: () => clock.value,
    onChange(state) { events.push(state); if (hooks.change) hooks.change(state); }, setTimer: timer, clearTimer: id => timers.delete(id) });
  t.after(() => controller.dispose());
  const feed = (filter = 'all') => controller.refreshAccountUpdates({ append: false, filter });
  const select = (pid = 'project-1') => controller.selectNotificationProject(pid);
  const load = () => controller.refreshNotificationPreferences();
  const ready = async () => { await select(); return load(); };
  const save = async (mode = 'daily', digestHourUtc = 14) => controller.saveNotificationPreferences({ scopeId: (await controller.getState()).preference.scopeId, mode, digestHourUtc });
  const mark = async eventId => controller.markAccountUpdateRead({ scopeId: (await controller.getState()).scopeId, eventId });
  const disable = async () => controller.disableNotificationDelivery({ scopeId: (await controller.getState()).scopeId });
  const tick = async () => { const [id, task] = timers.entries().next().value; timers.delete(id); task.fn(); await new Promise(setImmediate); return controller.getState(); };
  return { controller, account, rows, events, calls, hooks, preferences, committed, timers, clock, mail, pref, page, feed, select, load, ready, save, mark, disable, tick };
}

test('local state reads do no IO, defaults stay off, and feed remains usable without local editor or project selection', async t => {
  const f = fixture(t), state = await f.controller.getState(); assert.equal(state.available, true); assert.equal(state.watch, false); assert.equal(state.preference.projectId, null); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.account.projects = []; f.rows.splice(0, 1, item('lost-access', { type: 'member.removed', accessLost: true, projectId: null, projectName: null, actorId: null, subjectId: null }));
  await f.controller.connectionChanged(); const refreshed = await f.feed(); assert.equal(refreshed.ready, true); assert.equal(refreshed.items[0].accessLost, true); assert.equal(refreshed.items[0].projectName, null);
  assert.equal(refreshed.preference.projectId, null); assert.equal(refreshed.checkedAt, 3000);
});

test('explicit project loading permits all current roles to manage only their own preferences and forbids arbitrary recipients', async t => {
  for (const role of ['owner', 'editor', 'viewer']) await t.test(role, async t => {
    const f = fixture(t); f.account.projects[0].role = role; await f.select(); assert.equal(f.calls.length, 0);
    const state = await f.load(); assert.equal(state.preference.role, role); assert.equal(state.preference.value.mode, 'off'); assert.equal(state.preference.value.digestHourUtc, 9);
    const count = f.calls.length; const invalid = await f.controller.saveNotificationPreferences({ scopeId: state.preference.scopeId, mode: 'immediate', digestHourUtc: 9, to: 'other@example.test' });
    assert.equal(invalid.preference.error, 'notification-invalid'); assert.equal(f.calls.length, count);
    const saved = await f.save('immediate', 9); assert.equal(saved.outcome.kind, 'preferences-saved'); assert.equal(saved.preference.value.accountEmail, 'member@example.test');
    assert.deepEqual(Object.keys(f.calls.find(value => value.kind === 'save').input).sort(), ['digestHourUtc', 'expectedVersion', 'idempotencyKey', 'mode', 'projectId']);
  });
});

test('loaded preference clones are isolated, UTC hour bounds are strict and unconfigured delivery cannot enable email', async t => {
  const f = fixture(t); const state = await f.ready(); state.preference.value.mode = 'daily'; assert.equal((await f.controller.getState()).preference.value.mode, 'off');
  for (const hour of [-1, 24, 2.5, '14']) assert.equal((await f.save('daily', hour)).preference.error, 'notification-invalid');
  for (const hour of [0, 23]) { const result = await f.save('daily', hour); assert.equal(result.preference.value.digestHourUtc, hour); }
  f.mail.available = false; await f.load(); const count = f.calls.length;
  assert.equal((await f.save('immediate', 9)).preference.error, 'notification-delivery-unavailable'); assert.equal(f.calls.length, count);
  assert.equal((await f.save('off', 9)).preference.value.mode, 'off');
});

test('a stale account or preference scope cannot target a new project, and input IDs are not arbitrary', async t => {
  const f = fixture(t); const before = await f.ready(); await f.select('project-2'); await f.load(); const count = f.calls.length;
  const result = await f.controller.saveNotificationPreferences({ scopeId: before.preference.scopeId, mode: 'daily', digestHourUtc: 14 });
  assert.equal(result.preference.error, 'account-updates-selection-changed'); assert.equal(f.calls.length, count);
  assert.equal((await f.controller.selectNotificationProject('not-accessible')).preference.error, 'notification-invalid');
  await f.feed(); assert.equal((await f.controller.markAccountUpdateRead({ scopeId: 'stale', eventId: 'event-1' })).error, 'account-updates-selection-changed');
  assert.equal((await f.mark('not-in-feed')).error, 'notification-not-found');
});

test('mark read updates only after a valid ACK, removes an unread-filter row, and shares unread totals', async t => {
  const f = fixture(t); await f.feed('unread'); f.hooks.read = id => ({ eventId: id, read: false });
  let state = await f.mark('event-1'); assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.items[0].read, false); assert.equal(state.unreadCount, 1);
  delete f.hooks.read; state = await f.mark('event-1'); assert.equal(state.outcome.kind, 'read'); assert.equal(state.items.length, 0); assert.equal(state.unreadCount, 0);
  await f.feed('all'); state = await f.mark('event-1'); assert.equal(state.unreadCount, 0);
});

test('feed progress and unrelated project catalog changes preserve the selected preference scope and pending save', async t => {
  const f = fixture(t); const initial = await f.ready(); const entered = deferred(), gate = deferred();
  f.hooks.save = (input, options) => { entered.resolve(options.signal); return gate.promise; };
  const saving = f.save(), signal = await entered.promise;
  await f.feed(); f.account.projects.push({ id: 'new-unrelated', name: 'Unrelated', role: 'viewer', branches: ['main'] }); await f.controller.connectionChanged();
  const after = await f.controller.getState(); assert.equal(signal.aborted, false); assert.equal(after.preference.scopeId, initial.preference.scopeId); assert.equal(after.preference.busy, true);
  gate.resolve({ ...f.pref('project-1'), version: 1, mode: 'daily', digestHourUtc: 14, updatedAt: 3000 }); await saving;
  assert.equal((await f.controller.getState()).outcome.kind, 'preferences-saved');
});

test('catalog changes clear old feed details but preserve generic permission-loss updates when reloaded', async t => {
  const f = fixture(t); await f.feed(); const before = await f.controller.getState(); f.account.projects = [];
  const cleared = await f.controller.connectionChanged(); assert.equal(cleared.items.length, 0); assert.equal(cleared.ready, false); assert.notEqual(cleared.scopeId, before.scopeId);
  f.rows.splice(0, 1, item('permission-loss', { type: 'project.deleted', accessLost: true, projectId: null, projectName: null, actorId: null, subjectId: null }));
  const ready = await f.feed(); assert.equal(ready.items[0].accessLost, true); assert.equal(ready.items[0].projectName, null);
});

test('lost preference ACK retries one private intent through feed refresh, unrelated projects and still-authorized role changes', async t => {
  const f = fixture(t); await f.ready(); f.hooks.save = () => { throw fail('sync-network-unavailable'); };
  await f.save(); await f.feed(); f.account.projects.push({ id: 'unrelated', name: 'Unrelated', role: 'viewer', branches: ['main'] }); await f.controller.connectionChanged(); await f.save();
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); await f.load(); await f.save();
  let attempts = f.calls.filter(value => value.kind === 'save'); assert.equal(attempts.length, 3); assert.equal(new Set(attempts.map(value => value.input.idempotencyKey)).size, 1);
  await f.save('immediate', 9); attempts = f.calls.filter(value => value.kind === 'save'); assert.notEqual(attempts[2].input.idempotencyKey, attempts[3].input.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(f.events), /idempotencyKey|bearer-secret|password-secret|\/private\//);
});

test('committed preference save with a lost response replays one operation rather than restarting email enrollment', async t => {
  const f = fixture(t); await f.ready(); let first = true;
  f.hooks.save = input => {
    if (!f.committed.has(input.idempotencyKey)) {
      const result = { ...f.pref(input.projectId), version: 1, mode: input.mode, digestHourUtc: input.digestHourUtc, updatedAt: 3000 };
      f.committed.set(input.idempotencyKey, result); f.preferences.set(`member-1:${input.projectId}`, result);
    }
    if (first) { first = false; throw fail('sync-network-unavailable'); } return structuredClone(f.committed.get(input.idempotencyKey));
  };
  let result = await f.save(); assert.equal(result.outcome, null); result = await f.save(); assert.equal(result.outcome.kind, 'preferences-saved'); assert.equal(f.committed.size, 1); assert.equal(result.preference.value.version, 1);
});

test('new failed mutations cannot reuse a prior successful outcome; read-only feed refresh preserves a pending valid ACK', async t => {
  const f = fixture(t); await f.ready(); assert.equal((await f.save()).outcome.kind, 'preferences-saved');
  f.hooks.save = () => { throw fail('sync-network-unavailable'); }; let result = await f.save('immediate', 9); assert.equal(result.outcome, null); assert.equal(result.preference.error, 'sync-network-unavailable');
  delete f.hooks.save; const entered = deferred(), gate = deferred(); f.hooks.load = () => { entered.resolve(); return gate.promise; };
  const saving = f.save('immediate', 9); await entered.promise;
  await f.feed(); assert.equal((await f.controller.getState()).outcome.kind, 'preferences-saved');
  gate.resolve(f.pref('project-1')); result = await saving; assert.equal(result.outcome.kind, 'preferences-saved');
});

test('validated preference and global-disable ACKs survive follow-up load failure with ready false', async t => {
  for (const method of ['save', 'disable']) await t.test(method, async t => {
    const f = fixture(t); await f.ready(); f.hooks.load = () => { throw fail('sync-network-unavailable'); };
    const result = method === 'save' ? await f.save() : await f.disable();
    assert.equal(result.outcome.kind, method === 'save' ? 'preferences-saved' : 'delivery-disabled'); assert.equal(result.preference.ready, false); assert.equal(result.preference.error, 'sync-network-unavailable');
    const count = f.calls.length; assert.equal((await f.save()).preference.error, 'account-updates-refresh-required'); assert.equal(f.calls.length, count);
  });
});

test('turn off all affects only authenticated self and still works after all project access is lost', async t => {
  const f = fixture(t); await f.ready(); await f.save(); f.account.projects = []; await f.controller.connectionChanged();
  const result = await f.disable(); assert.equal(result.outcome.kind, 'delivery-disabled'); assert.equal(f.preferences.get('member-1:project-1').mode, 'off'); assert.equal(result.preference.projectId, null);
  assert.equal(f.calls.at(-1).kind, 'disable'); assert.deepEqual(Object.keys(f.calls.at(-1)).sort(), ['kind', 'signal']);
});

test('account/origin/email/signout switches abort both pending lanes and cannot restore old feed or preferences', async t => {
  for (const change of ['account', 'origin', 'email', 'signout']) await t.test(change, async t => {
    const f = fixture(t); await f.ready(); const enteredFeed = deferred(), enteredPref = deferred(), feedGate = deferred(), prefGate = deferred(); const oldPref = f.pref('project-1');
    f.hooks.feed = (_input, options) => { enteredFeed.resolve(options.signal); return feedGate.promise; };
    f.hooks.load = (_pid, options) => { enteredPref.resolve(options.signal); return prefGate.promise; };
    const reading = f.feed(), loading = f.load(); const [feedSignal, prefSignal] = await Promise.all([enteredFeed.promise, enteredPref.promise]);
    if (change === 'account') f.account.account.id = 'another-account'; else if (change === 'origin') f.account.origin = 'https://other.example.test';
    else if (change === 'email') f.account.account.email = 'new@example.test'; else { f.account.account = null; f.account.status = 'sign-in-required'; }
    await f.controller.connectionChanged(); assert.equal(feedSignal.aborted, true); assert.equal(prefSignal.aborted, true);
    feedGate.resolve(f.page()); prefGate.resolve(oldPref); await Promise.all([reading, loading]); const state = await f.controller.getState();
    assert.equal(state.items.length, 0); assert.equal(state.preference.value, null); assert.equal(state.preference.projectId, null); assert.equal(state.watch, false); assert.equal(state.outcome, null);
  });
});

test('selected project/role/access changes abort only pending preference IO while unrelated feed work remains valid', async t => {
  for (const change of ['project', 'role', 'removed']) await t.test(change, async t => {
    const f = fixture(t); await f.ready(); const entered = deferred(), gate = deferred(), old = f.pref('project-1');
    f.hooks.load = (_pid, options) => { entered.resolve(options.signal); return gate.promise; };
    const loading = f.load(), signal = await entered.promise;
    if (change === 'project') await f.select('project-2'); else if (change === 'role') { f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); }
    else { f.account.projects = []; await f.controller.connectionChanged(); }
    assert.equal(signal.aborted, true); gate.resolve(old); await loading; assert.equal((await f.controller.getState()).preference.value, null);
  });
});

test('opt-in watch schedules exactly 30 seconds, polls the current filter, retries offline and stops on account change/dispose', async t => {
  const f = fixture(t); await f.controller.getState(); assert.equal(f.timers.size, 0); await f.feed('unread'); await f.controller.setAccountUpdatesWatch(true);
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 30000); let result = await f.tick(); assert.equal(result.watch, true); assert.equal(f.calls.at(-1).input.filter, 'unread'); assert.equal(f.timers.size, 1);
  f.account.status = 'offline'; f.hooks.feed = () => { throw fail('sync-network-unavailable'); }; result = await f.tick(); assert.equal(result.error, 'sync-network-unavailable'); assert.equal(f.timers.size, 1);
  await f.controller.setAccountUpdatesWatch(false); assert.equal(f.timers.size, 0); await f.controller.setAccountUpdatesWatch(true); f.account.account.id = 'new-account'; await f.controller.connectionChanged(); assert.equal(f.timers.size, 0); assert.equal((await f.controller.getState()).watch, false);
  await f.controller.setAccountUpdatesWatch(true); await f.controller.dispose(); assert.equal(f.timers.size, 0); assert.equal((await f.controller.getState()).watch, false);
});

test('signed feed pages reject duplicates, preserve unread filter and stop at the explicit 500-row cap', async t => {
  const f = fixture(t); let index = 0;
  f.hooks.feed = input => { if (!input.cursor) index = 0; else index++; return { items: Array.from({ length: 20 }, (_, i) => item(`page-${index * 20 + i}`)), nextCursor: cursor(index + 1), unreadCount: 600 }; };
  let state = await f.feed('unread'); for (let i = 1; i < 25; i++) state = await f.controller.refreshAccountUpdates({ append: true, filter: 'unread' });
  assert.equal(state.items.length, 500); assert.equal(state.nextCursor, null); assert.equal(state.error, 'account-updates-display-limit'); const count = f.calls.length;
  await f.controller.refreshAccountUpdates({ append: true, filter: 'unread' }); assert.equal(f.calls.length, count);
  await f.feed('unread'); f.hooks.feed = () => ({ items: [item('page-0')], nextCursor: null, unreadCount: 600 });
  state = await f.controller.refreshAccountUpdates({ append: true, filter: 'unread' }); assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.items.length, 20);
});

test('malformed/redaction-violating pages and mismatched preference receipts fail closed with sanitized errors', async t => {
  const f = fixture(t); await f.ready();
  f.hooks.feed = () => ({ items: [item('unsafe', { accessLost: true, type: 'member.removed' })], nextCursor: null, unreadCount: 1 }); assert.equal((await f.feed()).error, 'sync-response-invalid');
  f.hooks.feed = () => { throw fail('/private/workspace bearer-secret'); }; assert.equal((await f.feed()).error, 'account-updates-local-error');
  for (const mismatch of ['project', 'email', 'mode', 'version', 'hour', 'extra']) {
    f.hooks.save = input => ({ ...f.pref(input.projectId), version: 1, mode: input.mode, digestHourUtc: input.digestHourUtc, updatedAt: 3000,
      ...(mismatch === 'project' ? { projectId: 'different-project' } : {}), ...(mismatch === 'email' ? { accountEmail: 'other@example.test' } : {}),
      ...(mismatch === 'mode' ? { mode: 'off' } : {}), ...(mismatch === 'version' ? { version: 9 } : {}), ...(mismatch === 'hour' ? { digestHourUtc: 15 } : {}), ...(mismatch === 'extra' ? { token: 'secret-token' } : {}) });
    const result = await f.save(); assert.equal(result.preference.error, 'sync-response-invalid'); assert.equal(result.outcome, null);
  }
  assert.doesNotMatch(JSON.stringify(f.events), /bearer-secret|password-secret|secret-token|\/private\//);
});

test('dispose aborts and drains both lanes with no late receipts, and busy actions do not replace their work', async t => {
  const f = fixture(t); await f.select(); const enteredFeed = deferred(), enteredPref = deferred(), feedGate = deferred(), prefGate = deferred(), old = f.pref('project-1');
  f.hooks.feed = (_input, options) => { enteredFeed.resolve(options.signal); return feedGate.promise; }; f.hooks.load = (_pid, options) => { enteredPref.resolve(options.signal); return prefGate.promise; };
  const reading = f.feed(), loading = f.load(); const [feedSignal, prefSignal] = await Promise.all([enteredFeed.promise, enteredPref.promise]), count = f.calls.length;
  await f.feed(); await f.load(); assert.equal(f.calls.length, count);
  const closing = f.controller.dispose(); assert.equal(feedSignal.aborted, true); assert.equal(prefSignal.aborted, true); feedGate.resolve(f.page()); prefGate.resolve(old); await closing; await Promise.all([reading, loading]);
  const state = await f.controller.getState(); assert.equal(state.available, false); assert.equal(state.items.length, 0); assert.equal(state.preference.value, null); assert.equal(state.outcome, null); assert.equal(f.timers.size, 0);
});
