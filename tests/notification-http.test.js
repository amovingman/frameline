'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { API_VERSION } = require('../src/project-api-contracts');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { validateAccountNotifications, validateNotificationPreferences } = require('../src/notification-protocol');
const { createUnsubscribeViewerHandler } = require('../src/unsubscribe-viewer');
const token = Buffer.alloc(32, 13).toString('base64url');
const event = () => ({ id: 'event-1', projectId: 'film', projectName: 'Film', actorId: 'other', subjectId: 'revision-1', type: 'revision.created', at: 1000, read: false, accessLost: false });
const page = () => ({ items: [event()], unreadCount: 1, nextCursor: null });
const preferences = () => ({ projectId: 'film', version: 0, mode: 'off', digestHourUtc: 9, updatedAt: null, deliveryAvailable: true, accountEmail: 'self@example.test' });
const base = () => Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(name => [name, async () => ({})]));
const reply = (options, data) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data }), { headers: { 'content-type': 'application/json' } });
function incoming(method, url, input, headers = {}) {
  let reads = 0; const bytes = Buffer.from(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
  const req = new Readable({ read() { reads++; this.push(bytes); this.push(null); } });
  headers = { 'x-api-version': API_VERSION, host: 'notify.example.test', ...headers,
    ...(input === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }) };
  Object.assign(req, { method, url, headers, rawHeaders: Object.entries(headers).flat(), socket: { encrypted: true, remoteAddress: '127.0.0.1' } });
  const result = { headers: {}, reads: () => reads }, res = { setHeader(k, v) { result.headers[k.toLowerCase()] = v; },
    writeHead(status, values) { result.status = status; Object.assign(result.headers, Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))); },
    end(value) { result.bytes = Buffer.from(value); try { result.body = JSON.parse(value); } catch {} } };
  return { req, res, result };
}
async function call(handler, method, url, input, headers) { const value = incoming(method, url, input, headers); await handler(value.req, value.res); return value.result; }

test('account feed protocol rejects disclosure on access-loss notices and keeps unread counts and preferences scoped', () => {
  assert.deepEqual(validateAccountNotifications(page()), page());
  const lost = { ...event(), type: 'member.removed', projectId: null, projectName: null, actorId: null, subjectId: null, accessLost: true };
  assert.equal(validateAccountNotifications({ items: [lost], unreadCount: 1, nextCursor: null }).items[0].accessLost, true);
  for (const item of [{ ...lost, projectName: 'Private former project' }, { ...lost, actorId: 'owner' },
    { ...lost, type: 'revision.created' }, { ...event(), recipientIds: ['secret'] }, { ...event(), projectId: null }]) {
    assert.throws(() => validateAccountNotifications({ items: [item], unreadCount: 1, nextCursor: null }), { code: 'sync-response-invalid' });
  }
  assert.throws(() => validateAccountNotifications({ ...page(), unreadCount: 0 }), { code: 'sync-response-invalid' });
  assert.throws(() => validateAccountNotifications({ ...page(), items: [{ ...event(), read: true }] }, { filter: 'unread' }), { code: 'sync-response-invalid' });
  assert.throws(() => validateNotificationPreferences({ ...preferences(), accountEmail: 'other@example.test', actorId: 'other' }, 'film'), { code: 'sync-response-invalid' });
  assert.throws(() => validateNotificationPreferences(preferences(), 'other'), { code: 'sync-response-invalid' });
});

test('notification SDK binds only self intent and anonymous unsubscribe never obtains a bearer', async () => {
  let bearerReads = 0; const calls = [], client = createRevisionHttpClient({ origin: 'https://notify.example.test', getAccessToken: () => { bearerReads++; return 'fixture-bearer-123456789'; },
    fetch: async (url, options) => { calls.push({ url, options }); return reply(options, url.endsWith('/unsubscribe') ? { unsubscribed: true }
      : url.endsWith('/disable-delivery') ? { disabled: true } : url.includes('/event-1/read') ? { eventId: 'event-1', read: true }
        : url.includes('/notification-preferences') ? options.method === 'GET' ? preferences() : { ...preferences(), version: 1, mode: 'daily', digestHourUtc: 15, updatedAt: 1000 } : page()); } });
  await client.unsubscribeNotifications({ token }); assert.equal(bearerReads, 0); assert.equal(calls[0].options.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { token }); assert(!calls[0].url.includes(token));
  assert.deepEqual(await client.unsubscribeNotifications({ token: 'invalid' }), { unsubscribed: true }); assert.equal(calls.length, 1);
  await client.getAccountNotifications({ filter: 'unread', limit: 20 }); await client.markAccountNotificationRead('event-1');
  await client.getNotificationPreferences('film'); await client.setNotificationPreferences({ projectId: 'film', expectedVersion: 0, mode: 'daily', digestHourUtc: 15, idempotencyKey: 'preference-retry' });
  await client.disableNotificationDelivery(); assert.equal(bearerReads, 5);
  assert.equal(calls[1].url, 'https://notify.example.test/account/notifications?limit=20&filter=unread');
  assert.deepEqual(JSON.parse(calls[4].options.body), { expectedVersion: 0, mode: 'daily', digestHourUtc: 15 });
  const count = calls.length;
  await assert.rejects(client.getAccountNotifications({ actorId: 'other' }));
  await assert.rejects(client.setNotificationPreferences({ projectId: 'film', expectedVersion: 0, mode: 'immediate', digestHourUtc: 9, idempotencyKey: 'p', recipientId: 'other' }));
  assert.equal(calls.length, count);
});

test('notification HTTP rejects query and actor ambiguity while unsubscribe returns the same bounded generic receipt', async () => {
  let unsubscribed = 0, changed = 0;
  const handler = createRevisionHttpHandler({ service: { ...base(), getAccountNotifications: async () => page(), getNotificationPreferences: async () => preferences(),
    setNotificationPreferences: async () => { changed++; return preferences(); }, disableNotificationDelivery: async () => ({ disabled: true }),
    markAccountNotificationRead: async (_ctx, eventId) => ({ eventId, read: true }), unsubscribeNotifications: async () => { unsubscribed++; return { unsubscribed: true }; } } });
  const auth = { authorization: 'Bearer fixture-token' };
  assert.equal((await call(handler, 'GET', '/account/notifications?limit=20&filter=all', undefined, auth)).status, 200);
  for (const query of ['?limit=20&limit=20', '?filter=other', '?filter=all&filter=unread', '?recipientId=other', '?cursor=bad']) assert.equal((await call(handler, 'GET', '/account/notifications' + query, undefined, auth)).status, 400);
  assert.equal((await call(handler, 'PUT', '/projects/film/notification-preferences', { expectedVersion: 0, mode: 'daily', digestHourUtc: 9, actorId: 'other' }, { ...auth, 'idempotency-key': 'p' })).status, 400);
  assert.equal(changed, 0);
  for (const body of [{ token }, { token: 'invalid' }, { token, actorId: 'other' }, {}, '{malformed']) {
    const result = await call(handler, 'POST', '/notifications/unsubscribe', body, { origin: 'https://notify.example.test' });
    assert.equal(result.status, 200); assert.deepEqual(result.body.data, { unsubscribed: true }); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(unsubscribed, 1);
  const large = await call(handler, 'POST', '/notifications/unsubscribe', { token: 'x'.repeat(513) }); assert.equal(large.status, 413); assert.equal(large.reads(), 0);
  assert.equal((await call(handler, 'POST', '/notifications/unsubscribe', { token }, { origin: 'https://other.example.test' })).status, 403);
  assert.equal((await call(createRevisionHttpHandler({ service: base() }), 'GET', '/account/notifications', undefined, auth)).status, 404);
});

test('unsubscribe admission is bounded and the public page is a bundled TLS-only no-referrer surface', async () => {
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  const handler = createRevisionHttpHandler({ service: { ...base(), unsubscribeNotifications: async () => { entered++; await gate; return { unsubscribed: true }; } } });
  const requests = Array.from({ length: 8 }, () => call(handler, 'POST', '/notifications/unsubscribe', { token }));
  for (let i = 0; i < 100 && entered < 8; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, 8);
  const blocked = await call(handler, 'POST', '/notifications/unsubscribe', { token }); assert.equal(blocked.status, 503); assert.equal(blocked.reads(), 0);
  release(); assert((await Promise.all(requests)).every(result => result.status === 200));
  const viewer = createUnsubscribeViewerHandler(), page = await call(viewer, 'GET', '/unsubscribe');
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  const leaked = await call(viewer, 'GET', `/unsubscribe?token=${token}`); assert.equal(leaked.status, 404); assert(!leaked.bytes.toString().includes(token));
  const plain = incoming('GET', '/unsubscribe'); plain.req.socket.encrypted = false; await viewer(plain.req, plain.res); assert.equal(plain.result.status, 426);
});
