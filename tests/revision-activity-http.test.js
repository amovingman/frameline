'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createIdentityService } = require('../src/identity-service');
const { createAccessControl } = require('../src/access-control');
const { createProjectActivity } = require('../src/project-activity');
const { API_VERSION } = require('../src/project-api-contracts');

const required = ['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'];
class Reply extends EventEmitter {
  constructor() { super(); this.headers = {}; this.destroyed = false; this.writableEnded = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
  writeHead(status, headers) { this.status = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); }
  end(bytes) { this.bytes = Buffer.from(bytes); this.writableEnded = true; }
}
async function call(handler, method, url, token, body, supplied = {}) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(bytes === null ? [] : [bytes]);
  Object.assign(req, { method, url, complete: false, socket: { encrypted: true }, headers: {
    'x-api-version': API_VERSION, 'x-request-id': 'feed-request', authorization: `Bearer ${token}`,
    ...(bytes === null ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }), ...supplied
  } }); req.rawHeaders = Object.entries(req.headers).flat(); req.once('end', () => { req.complete = true; });
  const res = new Reply(); await handler(req, res);
  return { status: res.status, headers: res.headers, bytes: res.bytes, body: JSON.parse(res.bytes) };
}
function fixture() {
  const identity = createIdentityService(), access = createAccessControl();
  const users = Object.fromEntries(['owner', 'reader', 'visitor', 'outsider'].map(name => [name, identity.createAccount(`${name}@disposable.example.test`, 'disposable feed password')]));
  const tokens = Object.fromEntries(Object.keys(users).map(name => [name, identity.signIn(`${name}@disposable.example.test`, 'disposable feed password').accessToken]));
  const team = access.createTeam(users.owner.id, 'Feed fixture'); access.registerProject(users.owner.id, 'film', team.id);
  for (const name of ['reader', 'visitor']) {
    const invitation = access.inviteProject(users.owner.id, 'film', users[name].email, 'viewer'); access.acceptInvitation(invitation.token, users[name].id, users[name].email);
  }
  let now = 100;
  const activity = createProjectActivity({ access, now: () => now, paginationKey: 'disposable-feed-pagination-key-32-bytes' });
  const events = [];
  for (let index = 0; index < 5; index++) events.push(activity.record({ projectId: 'film', actorId: users.owner.id,
    type: 'branch.changed', subjectId: `branch-${index}`, recipientIds: [users.reader.id, users.owner.id] }));
  now = 50;
  events.push(activity.record({ projectId: 'film', actorId: users.owner.id, type: 'revision.created', subjectId: 'revision-rollback-clock', recipientIds: [users.reader.id] }));
  const actor = context => identity.authenticate(context.accessToken).userId;
  const service = { ...Object.fromEntries(required.map(name => [name, () => ({})])),
    listActivity: (context, pid, page) => activity.listPage(actor(context), pid, page),
    listNotifications: (context, pid, page) => activity.notificationPage(actor(context), pid, page),
    markNotificationRead: (context, pid, id) => activity.markRead(actor(context), pid, id) };
  const handler = createRevisionHttpHandler({ service });
  const client = name => createRevisionHttpClient({ origin: 'https://feed.example.test', getAccessToken: () => tokens[name],
    fetch: async (url, options) => {
      const parsed = new URL(url), result = await call(handler, options.method, parsed.pathname + parsed.search, tokens[name],
        options.body === undefined ? undefined : JSON.parse(options.body), options.headers);
      return new Response(result.bytes, { status: result.status, headers: result.headers });
    } });
  return { identity, access, users, tokens, activity, events, service, handler, client };
}

test('activity and actor-scoped inbox pages remain bounded and preserve tied and rolled-back timestamps', async () => {
  const f = fixture(), client = f.client('reader'), ids = []; let cursor = null;
  do {
    const page = await client.listActivity('film', { limit: 2, cursor });
    assert.equal(page.projectId, 'film'); assert.equal(page.unreadCount, null); assert(page.items.length <= 2);
    ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, f.events.map(item => item.id).reverse());
  const inbox = await client.listNotifications('film', { limit: 2 }); assert.equal(inbox.unreadCount, 6); assert.equal(inbox.items[0].at, 50);
  assert.deepEqual(Object.keys(inbox.items[0]).sort(), ['id', 'projectId', 'actorId', 'type', 'subjectId', 'at', 'read'].sort());
  assert.doesNotMatch(JSON.stringify(inbox), /recipientIds|previousHash|"hash"|email|password|accessToken|\/private\//);
  assert.equal((await f.client('owner').listNotifications('film')).items.length, 0);
  assert.equal((await f.client('visitor').listNotifications('film')).unreadCount, 0);
});

test('mark-read is recipient-owned, idempotent and immediately revokes with project access', async () => {
  const f = fixture(), reader = f.client('reader'), id = f.events[0].id;
  assert.deepEqual(await reader.markNotificationRead('film', id, { read: true }), { eventId: id, read: true });
  assert.deepEqual(await reader.markNotificationRead('film', id, { read: true }), { eventId: id, read: true });
  assert.equal((await reader.listNotifications('film')).unreadCount, 5);
  await assert.rejects(f.client('visitor').markNotificationRead('film', id, { read: true }), { code: 'notification-not-found' });
  for (const method of ['listActivity', 'listNotifications']) await assert.rejects(f.client('outsider')[method]('film'), { code: 'forbidden' });
  const wrongBody = await call(f.handler, 'PUT', `/projects/film/notifications/${id}/read`, f.tokens.reader, { read: true, userId: f.users.owner.id });
  assert.equal(wrongBody.status, 400);
  f.access.removeProjectMember(f.users.owner.id, 'film', f.users.reader.id);
  await assert.rejects(reader.listActivity('film'), { code: 'forbidden' });
  await assert.rejects(reader.listNotifications('film'), { code: 'forbidden' });
  await assert.rejects(reader.markNotificationRead('film', id, { read: true }), { code: 'forbidden' });
});

test('feed query grammar rejects duplicate, unknown and noncanonical values without relaxing other routes', async () => {
  const f = fixture();
  for (const suffix of ['?', '?limit=0', '?limit=101', '?limit=01', '?limit=2&limit=3', '?userId=owner', '?limit=2&cursor=', '?cursor=not-canonical', '?limit=2&cursor=a.b&cursor=a.b']) {
    const result = await call(f.handler, 'GET', `/projects/film/activity${suffix}`, f.tokens.reader);
    assert.equal(result.status, 400, suffix);
  }
  assert.equal((await call(f.handler, 'GET', '/projects/film/branches/main?limit=20', f.tokens.reader)).status, 400);
  assert.equal((await call(f.handler, 'PUT', '/projects/film/activity', f.tokens.reader, {})).status, 405);
  const page = await f.client('reader').listNotifications('film', { limit: 2 });
  await assert.rejects(f.client('visitor').listNotifications('film', { limit: 2, cursor: page.nextCursor }), { code: 'activity-cursor-invalid' });
  await assert.rejects(f.client('reader').listActivity('film', { limit: 2, cursor: page.nextCursor }), { code: 'activity-cursor-invalid' });
});

test('optional feed routes fail closed and server projection refuses accidental private event fields', async () => {
  const f = fixture(), bare = createRevisionHttpHandler({ service: Object.fromEntries(required.map(name => [name, () => ({})])) });
  assert.equal((await call(bare, 'GET', '/projects/film/activity', f.tokens.reader)).status, 404);
  const original = f.service.listActivity;
  f.service.listActivity = (context, pid, page) => { const result = original(context, pid, page); result.items[0].privatePath = '/private/secret'; return result; };
  const invalid = await call(f.handler, 'GET', '/projects/film/activity', f.tokens.reader);
  assert.equal(invalid.status, 500); assert.equal(invalid.body.error.code, 'service-unavailable'); assert.doesNotMatch(invalid.bytes.toString(), /private|secret/);
});

test('client request and page validators reject unknown fields, wrong projects, duplicate events and inconsistent totals', async () => {
  const f = fixture(), event = { id: f.events[0].id, projectId: 'film', actorId: f.users.owner.id, type: 'branch.changed', subjectId: 'main', at: 0 };
  const page = { projectId: 'film', items: [event], nextCursor: null, unreadCount: null };
  const client = value => createRevisionHttpClient({ origin: 'https://feed.example.test', getAccessToken: () => f.tokens.reader,
    fetch: async (_url, options) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data: value }), { headers: { 'content-type': 'application/json' } }) });
  for (const value of [{ ...page, projectId: 'other' }, { ...page, items: [event, event] },
    { ...page, items: [{ ...event, actorId: '/private/owner' }] }, { ...page, items: [{ ...event, at: -1 }] },
    { ...page, items: [{ ...event, rawToken: 'private' }] }, { ...page, items: [{ ...event, type: 'secret.type' }] }]) {
    await assert.rejects(client(value).listActivity('film'), { code: 'sync-response-invalid' });
  }
  await assert.rejects(client({ ...page, unreadCount: 0, items: [{ ...event, read: false }] }).listNotifications('film'), { code: 'sync-response-invalid' });
  let calls = 0;
  const invalid = createRevisionHttpClient({ origin: 'https://feed.example.test', getAccessToken: () => f.tokens.reader, fetch: async () => { calls++; throw new Error('must not send'); } });
  for (const input of [{ limit: null }, { limit: 101 }, { cursor: 'not-canonical' }, { userId: 'other' }]) await assert.rejects(invalid.listActivity('film', input));
  await assert.rejects(invalid.markNotificationRead('film', event.id, { read: false }), { code: 'sync-request-invalid' });
  await assert.rejects(invalid.markNotificationRead('film', event.id, { read: true, userId: 'other' }), { code: 'sync-request-invalid' }); assert.equal(calls, 0);
});
