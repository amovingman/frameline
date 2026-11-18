'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopProjectActivity, safeActivityError } = require('../src/desktop-project-activity');
const { fingerprint } = require('../src/project-api-contracts');
const fail = code => Object.assign(new Error('/private/credential-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cursor = suffix => `${Buffer.from(`cursor-${suffix}`).toString('base64url')}.${Buffer.alloc(32, 7).toString('base64url')}`;
function fixture(t) {
  const service = { status: 'connected', connected: true, origin: 'https://service.example.test', account: { id: 'viewer' },
    projects: [{ id: 'remote', role: 'viewer', branches: ['main', 'review'] }] };
  let selected = { originHash: fingerprint(service.origin), accountId: 'viewer', localProjectId: 'local', localBranch: 'main',
    remoteProjectId: 'remote', remoteBranch: 'main' };
  const calls = [], events = [], timers = new Map(), hooks = {}; let clock = 1000, timerId = 0;
  const item = (id, read = false) => ({ id: `event-${id}`, projectId: 'remote', actorId: 'other', type: 'revision.created',
    subjectId: `revision-${id}`, at: id % 2 ? 1000 : 999, read });
  const all = Array.from({ length: 25 }, (_, index) => item(25 - index));
  const client = {
    async listNotifications(pid, page, options) {
      calls.push({ kind: 'inbox', pid, page, signal: options.signal });
      if (hooks.inbox) return hooks.inbox(pid, page, options);
      const offset = page.cursor ? 20 : 0, items = structuredClone(all.slice(offset, offset + page.limit));
      return { projectId: pid, items, nextCursor: offset + items.length < all.length ? cursor('older') : null,
        unreadCount: all.filter(value => !value.read).length };
    },
    async listActivity(pid, page, options) {
      calls.push({ kind: 'activity', pid, page, signal: options.signal });
      return { projectId: pid, items: all.slice(0, page.limit).map(({ read, ...value }) => structuredClone(value)),
        nextCursor: cursor('activity'), unreadCount: null };
    },
    async markNotificationRead(pid, id, input, options) {
      calls.push({ kind: 'read', pid, id, input, signal: options.signal });
      if (hooks.read) return hooks.read(pid, id, input, options);
      const value = all.find(value => value.id === id); if (!value) throw fail('notification-not-found'); value.read = true;
      return { eventId: id, read: true };
    }
  };
  const controller = createDesktopProjectActivity({ connection: { getState: () => structuredClone(service), getClient: () => client },
    getSelection: async () => { if (hooks.selectionError) throw fail('local-metadata-unavailable'); return structuredClone(selected); },
    onChange: state => events.push(state), now: () => clock,
    setTimer: (callback, milliseconds) => { assert.equal(milliseconds, 30000); const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id) });
  t.after(() => controller.dispose());
  return { controller, service, calls, events, timers, hooks, all, item,
    select: value => { selected = value; }, selection: () => selected, tick: () => { clock += 30000;
      const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); } };
}
async function settle(controller) {
  for (let n = 0; n < 100; n++) { const state = await controller.getState(); if (!state.busy) return state;
    await new Promise(resolve => setImmediate(resolve)); }
  throw Error('activity did not settle');
}
test('state reads are offline and scoped, while explicit refresh pages same-time and rollback-time events', async t => {
  const f = fixture(t); const initial = await f.controller.getState(); assert.equal(initial.available, true);
  assert.equal(initial.watch, false); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  const first = await f.controller.refresh({ view: 'inbox' }); assert.equal(first.items.length, 20); assert.equal(first.unreadCount, 25);
  assert.equal(first.lastUpdatedAt, 1000); assert.equal(first.status, 'ready');
  const older = await f.controller.loadOlder(); assert.equal(older.items.length, 25); assert.equal(older.nextCursor, null);
  assert.equal(new Set(older.items.map(item => item.id)).size, 25);
  assert.doesNotMatch(JSON.stringify(f.events), /credential-secret|Bearer |https:|accessToken|recipientIds|previousHash/);
  assert.equal(safeActivityError(fail('/private/credential-secret')), 'activity-local-error');
});
test('opening inbox does not mark read; explicit acknowledgment updates one receipt once', async t => {
  const f = fixture(t); await f.controller.refresh({ view: 'inbox' }); assert.equal(f.calls.filter(value => value.kind === 'read').length, 0);
  const read = await f.controller.markRead('event-25'); assert.equal(read.items[0].read, true); assert.equal(read.unreadCount, 24);
  assert.deepEqual(f.calls.at(-1).input, { read: true });
  await f.controller.markRead('event-25'); assert.equal(f.calls.filter(value => value.kind === 'read').length, 1);
  const invalid = await f.controller.markRead('event-hidden'); assert.equal(invalid.error, 'notification-not-found');
});
test('all activity retrieves a separate recipient-scoped unread count without exposing recipients', async t => {
  const f = fixture(t); const state = await f.controller.refresh({ view: 'activity' });
  assert.equal(state.view, 'activity'); assert.equal(state.unreadCount, 25); assert.equal(state.items.length, 20);
  assert.equal(Object.hasOwn(state.items[0], 'read'), false); assert.deepEqual(f.calls.map(value => value.kind), ['activity', 'inbox']);
});
test('late responses cannot repopulate feed after account or branch changes', async t => {
  const f = fixture(t), entered = deferred(), response = deferred();
  f.hooks.inbox = async (_pid, _page, options) => { entered.resolve(options.signal); return response.promise; };
  const reading = f.controller.refresh({ view: 'inbox' }), signal = await entered.promise;
  f.selection().remoteBranch = 'review'; const changed = await f.controller.selectionChanged();
  assert.equal(signal.aborted, true); assert.equal(changed.items.length, 0); assert.equal(changed.busy, false);
  response.resolve({ projectId: 'remote', items: [f.item(1)], nextCursor: null, unreadCount: 1 }); await reading;
  assert.equal((await f.controller.getState()).items.length, 0);
  f.service.account.id = 'replacement'; await f.controller.connectionChanged(); assert.equal((await f.controller.getState()).scope, null);
});
test('scope loss during mark-read hides private data and ignores the late acknowledgment', async t => {
  const f = fixture(t), entered = deferred(), ack = deferred(); await f.controller.refresh({ view: 'inbox' });
  f.hooks.read = async () => { entered.resolve(); return ack.promise; };
  const reading = f.controller.markRead('event-25'); await entered.promise; f.select(null); await f.controller.selectionChanged();
  ack.resolve({ eventId: 'event-25', read: true }); await reading;
  const state = await f.controller.getState(); assert.equal(state.items.length, 0); assert.equal(state.unreadCount, 0); assert.equal(state.scope, null);
});
test('unreadable selection fails closed instead of retaining private feed or its watch', async t => {
  const f = fixture(t); await f.controller.refresh({ view: 'inbox' }); await f.controller.setWatch(true);
  f.hooks.selectionError = true; f.service.account.id = 'replacement';
  const state = await f.controller.getState(); assert.equal(state.scope, null); assert.equal(state.items.length, 0);
  assert.equal(state.unreadCount, 0); assert.equal(state.watch, false); assert.equal(state.error, 'activity-unavailable');
  assert.equal(f.timers.size, 0); assert.doesNotMatch(JSON.stringify(state), /credential-secret|local-metadata/);
});
test('access loss clears private feed and watch while offline refresh can recover', async t => {
  const f = fixture(t); await f.controller.refresh({ view: 'inbox' }); await f.controller.setWatch(true);
  f.hooks.inbox = async () => { throw fail('sync-network-unavailable'); }; f.service.status = 'offline'; f.service.connected = false;
  const offline = await f.controller.refresh({ view: 'inbox' }); assert.equal(offline.status, 'offline'); assert.equal(offline.available, true);
  assert.equal(offline.items.length, 20); assert.equal(offline.watch, true); assert.equal(f.timers.size, 1);
  delete f.hooks.inbox; assert.equal((await f.controller.refresh({ view: 'inbox' })).status, 'ready');
  f.hooks.inbox = async () => { throw fail('forbidden'); };
  const denied = await f.controller.refresh({ view: 'inbox' }); assert.equal(denied.status, 'access-changed'); assert.equal(denied.items.length, 0);
  assert.equal(denied.unreadCount, 0); assert.equal(denied.watch, false); assert.equal(f.timers.size, 0);
});
test('watch is off by default, polls only after opt-in, and same-scope notifications do not postpone it', async t => {
  const f = fixture(t); await f.controller.getState(); f.tick(); assert.equal(f.calls.length, 0);
  await f.controller.setWatch(true); assert.equal(f.timers.size, 1); const timerId = [...f.timers.keys()][0];
  await f.controller.selectionChanged(); await f.controller.connectionChanged(); assert.equal([...f.timers.keys()][0], timerId);
  f.tick(); const state = await settle(f.controller); assert.equal(state.items.length, 20); assert.equal(f.timers.size, 1);
  await f.controller.setWatch(false); assert.equal(f.timers.size, 0); const calls = f.calls.length; f.tick(); assert.equal(f.calls.length, calls);
  await f.controller.setWatch(true); f.selection().localBranch = 'other'; await f.controller.selectionChanged();
  assert.equal((await f.controller.getState()).watch, false); assert.equal(f.timers.size, 0);
});
test('malformed or repeated older-page responses cannot corrupt retained rows', async t => {
  const f = fixture(t); await f.controller.refresh({ view: 'inbox' });
  f.hooks.inbox = async () => ({ projectId: 'remote', items: [f.item(25)], nextCursor: null, unreadCount: 25 });
  const duplicate = await f.controller.loadOlder(); assert.equal(duplicate.error, 'sync-response-invalid'); assert.equal(duplicate.items.length, 20);
  f.hooks.inbox = async () => ({ projectId: 'other', items: [], nextCursor: null, unreadCount: 0 });
  assert.equal((await f.controller.refresh({ view: 'inbox' })).error, 'sync-response-invalid');
  f.hooks.inbox = async () => ({ projectId: 'remote', items: [{ ...f.item(1), recipientIds: ['private'] }], nextCursor: null, unreadCount: 1 });
  assert.equal((await f.controller.refresh({ view: 'inbox' })).error, 'sync-response-invalid');
});
test('parallel refresh is refused without clobbering the active read or its acknowledgment', async t => {
  const f = fixture(t), entered = deferred(), response = deferred();
  f.hooks.inbox = async () => { entered.resolve(); return response.promise; };
  const reading = f.controller.refresh({ view: 'inbox' }); await entered.promise;
  assert.equal((await f.controller.refresh({ view: 'activity' })).busy, true);
  response.resolve({ projectId: 'remote', items: [f.item(1)], nextCursor: null, unreadCount: 1 });
  const state = await reading; assert.equal(state.status, 'ready'); assert.equal(state.view, 'inbox'); assert.equal(state.items.length, 1);
});
test('dispose aborts requests, clears watch, waits for completion, and rejects late publication', async t => {
  const f = fixture(t), entered = deferred(), response = deferred(); await f.controller.setWatch(true);
  f.hooks.inbox = async (_pid, _page, options) => { entered.resolve(options.signal); return response.promise; };
  const reading = f.controller.refresh({ view: 'inbox' }), signal = await entered.promise;
  let disposed = false; const closing = f.controller.dispose().then(() => { disposed = true; });
  assert.equal(signal.aborted, true); assert.equal(f.timers.size, 0); await Promise.resolve(); assert.equal(disposed, false);
  response.resolve({ projectId: 'remote', items: [f.item(1)], nextCursor: null, unreadCount: 1 }); await Promise.all([reading, closing]);
  const state = await f.controller.getState(); assert.equal(state.items.length, 0); assert.equal(state.watch, false); assert.equal(state.available, false);
});
