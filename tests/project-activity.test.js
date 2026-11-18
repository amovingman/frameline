const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createProjectActivity, validateActivityState, MAX_EVENTS } = require('../src/project-activity');
const { fingerprint } = require('../src/project-api-contracts');
const key = 'a private pagination key long enough';
function fixture() {
  let clock = 1000; const removed = new Set();
  const access = { authorize(actorId, { projectId }) { if (!['owner', 'editor', 'viewer'].includes(actorId) || projectId !== 'film' || removed.has(actorId)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } };
  const opts = { access, now: () => clock, paginationKey: key }; const activity = createProjectActivity(opts);
  return { activity, opts, removed, time(value) { clock = value; } };
}
const event = (activity, subjectId, extra = {}) => activity.record({ projectId: 'film', actorId: 'owner', type: 'revision.created', subjectId, recipientIds: ['viewer', 'editor'], ...extra });

test('signed append-position pages survive equal and decreasing clocks and exclude events newer than their immutable anchor', () => {
  const f = fixture(); const ids = [];
  for (let index = 0; index < 5; index++) ids.push(event(f.activity, `revision-${index}`).id);
  const first = f.activity.listPage('editor', 'film', { limit: 2 }); assert.deepEqual(first.items.map(item => item.id), ids.slice(3).reverse()); assert.equal(first.unreadCount, null);
  f.time(0); const latest = event(f.activity, 'newer-append-with-earlier-clock');
  const second = f.activity.listPage('editor', 'film', { limit: 2, cursor: first.nextCursor });
  const third = f.activity.listPage('editor', 'film', { limit: 2, cursor: second.nextCursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), ids.slice().reverse()); assert.equal(third.nextCursor, null);
  assert.equal(f.activity.listPage('editor', 'film').items[0].id, latest.id);
  assert.ok(first.nextCursor.length <= 2048); assert.match(first.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const restored = createProjectActivity({ ...f.opts, initialState: f.activity.snapshot() });
  assert.deepEqual(restored.listPage('editor', 'film', { limit: 2, cursor: first.nextCursor }), second);
});

test('cursor scope binds reader, feed kind and project while read receipts remain private and recipient-bound', () => {
  const f = fixture(); const first = event(f.activity, 'revision-1'); event(f.activity, 'revision-2');
  const inbox = f.activity.notificationPage('editor', 'film', { limit: 1 }); assert.equal(inbox.unreadCount, 2); assert.equal(inbox.items[0].read, false);
  for (const operation of [() => f.activity.notificationPage('viewer', 'film', { cursor: inbox.nextCursor }),
    () => f.activity.listPage('editor', 'film', { cursor: inbox.nextCursor }),
    () => f.activity.notificationPage('editor', 'film', { cursor: `${inbox.nextCursor}a` })]) assert.throws(operation, { code: 'activity-cursor-invalid' });
  f.activity.markRead('editor', 'film', first.id); f.activity.markRead('editor', 'film', first.id);
  const snapshot = f.activity.snapshot(); let replayed = 0; const restored = createProjectActivity({ ...f.opts, initialState: snapshot }); restored.subscribe(() => replayed++);
  assert.equal(restored.notificationPage('editor', 'film').unreadCount, 1); assert.equal(restored.notificationPage('viewer', 'film').unreadCount, 2); assert.equal(replayed, 0);
  assert.equal(restored.notificationPage('owner', 'film').items.length, 0);
  assert.throws(() => restored.markRead('owner', 'film', first.id), { code: 'notification-not-found' });
  f.removed.add('editor'); assert.throws(() => restored.notificationPage('editor', 'film'), { code: 'forbidden' });
  const publicData = JSON.stringify(restored.listPage('viewer', 'film'));
  assert.doesNotMatch(publicData, /recipientIds|previousHash|receipts/);
});

test('strict activity imports reject hash-valid private fields, forged receipts and malformed identity/timestamp state', () => {
  const f = fixture(); const recorded = event(f.activity, 'revision-1'); const original = f.activity.snapshot();
  const changes = [value => { value.version = 2; }, value => { value.secret = '/Users/private'; }, value => { value.events[0].privatePath = '/Users/private'; },
    value => { value.events[0].actorId = 'actor/private'; }, value => { value.events[0].subjectId = '/Users/private'; }, value => { value.events[0].at = -1; },
    value => { value.events[0].recipientIds.push('editor'); }, value => { value.receipts[`owner:${recorded.id}`] = true; },
    value => { value.receipts[`editor:${recorded.id}`] = 1; }, value => { value.receipts[`editor:${randomUUID()}`] = true; }];
  for (const change of changes) {
    const value = structuredClone(original); change(value);
    if (value.events[0]) value.events[0].hash = fingerprint(Object.fromEntries(Object.entries(value.events[0]).filter(([key]) => key !== 'hash')));
    assert.throws(() => validateActivityState(value), error => ['activity-state-invalid', 'activity-state-newer-version'].includes(error.code));
  }
  const restored = createProjectActivity({ ...f.opts, initialState: original }); original.events[0].recipientIds.length = 0;
  assert.equal(restored.notificationPage('editor', 'film').items.length, 1);
  assert.throws(() => event(restored, '../private'), { code: 'activity-event-invalid' });
});

test('bounded activity capacity refuses append without altering the existing immutable chain', () => {
  const f = fixture(); const events = []; let previousHash = '0'.repeat(64);
  for (let index = 0; index < MAX_EVENTS; index++) {
    const value = { id: randomUUID(), projectId: 'film', actorId: 'owner', type: 'branch.changed', subjectId: 'main', recipientIds: [], at: 0, previousHash };
    value.hash = fingerprint(value); events.push(value); previousHash = value.hash;
  }
  const activity = createProjectActivity({ ...f.opts, initialState: { version: 1, events, receipts: {} } });
  assert.throws(() => event(activity, 'revision-next'), { code: 'activity-capacity-exceeded' }); assert.equal(activity.snapshot().events.length, MAX_EVENTS); assert.equal(activity.verify(), true);
});
