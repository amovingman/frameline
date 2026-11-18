'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { API_VERSION } = require('../src/project-api-contracts');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { validateReviewComment, validateReviewCommentsPage, normalizeReviewCommentBody } = require('../src/review-comments-protocol');

const anchor = { kind: 'clip', timelineId: 'Timeline 夜 1', clipId: 'Clip "Été"' };
const body = '<b>Cut "夜"</b>\n\tReview this frame.';
const item = () => ({ id: 'comment-1', projectId: 'film-1', revisionId: 'revision-1', authorId: 'editor-1',
  anchor: structuredClone(anchor), body, status: 'open', createdAt: '2026-11-18T12:00:00.000Z',
  resolvedAt: null, resolvedBy: null, canResolve: true });
const page = () => ({ projectId: 'film-1', revisionId: 'revision-1', items: [item()], nextCursor: null, total: 1, openCount: 1 });
const reply = (options, data) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data }),
  { headers: { 'content-type': 'application/json' } });

test('comment protocol preserves plain text and opaque anchors while rejecting scope and shape substitutions', () => {
  assert.equal(normalizeReviewCommentBody(`  ${body}  `), body);
  assert.deepEqual(validateReviewComment(item(), { projectId: 'film-1', revisionId: 'revision-1' }), item());
  for (const patch of [{ projectId: 'other' }, { revisionId: 'other' }, { localPath: '/Users/private' },
    { body: 'bad\rcontrol' }, { body: 'bad\u0000control' }, { body: ' x ' }, { status: 'resolved' },
    { createdAt: 'yesterday' }, { canResolve: 'yes' }, { anchor: { ...anchor, sourcePath: '/private' } },
    { anchor: { ...anchor, clipId: '../private' } }]) {
    assert.throws(() => validateReviewComment({ ...item(), ...patch }, { projectId: 'film-1', revisionId: 'revision-1' }), { code: 'sync-response-invalid' });
  }
  for (const patch of [{ items: [item(), item()], total: 2, openCount: 2 }, { openCount: 0 }, { total: 0 },
    { nextCursor: 'not-a-cursor' }, { projectId: 'other' }, { filePath: '/private' }]) {
    assert.throws(() => validateReviewCommentsPage({ ...page(), ...patch }, 'film-1', 'revision-1'), { code: 'sync-response-invalid' });
  }
});

test('comment SDK sends only exact revision-scoped fields and validates mutation acknowledgments', async () => {
  const calls = [], client = createRevisionHttpClient({ origin: 'https://comments.example.test', getAccessToken: () => 'fixture-token-123456789',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return reply(options, options.method === 'GET' ? page() : options.method === 'PUT'
        ? { ...item(), status: 'resolved', resolvedAt: '2026-11-18T12:00:01.000Z', resolvedBy: 'editor-1', canResolve: false } : item());
    } });
  await client.listReviewComments('film-1', 'revision-1', { limit: 20 });
  await client.addReviewComment({ projectId: 'film-1', revisionId: 'revision-1', anchor, body: ` ${body} `, idempotencyKey: 'comment-retry' });
  await client.resolveReviewComment('film-1', 'revision-1', 'comment-1');
  assert.equal(calls[0].url, 'https://comments.example.test/projects/film-1/revisions/revision-1/comments?limit=20');
  assert.deepEqual(JSON.parse(calls[1].options.body), { anchor, body });
  assert.equal(calls[1].options.headers['idempotency-key'], 'comment-retry');
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[2].options.body), { resolved: true });
  const count = calls.length;
  for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: 'bad' }, { origin: 'https://other.test' }]) {
    await assert.rejects(client.listReviewComments('film-1', 'revision-1', input));
  }
  await assert.rejects(client.addReviewComment({ projectId: 'film-1', revisionId: 'revision-1', anchor, body, idempotencyKey: 'ok', authorId: 'spoof' }));
  assert.equal(calls.length, count);
  const foreign = createRevisionHttpClient({ origin: 'https://comments.example.test', getAccessToken: () => 'fixture-token-123456789',
    fetch: async (_url, options) => reply(options, { ...item(), revisionId: 'foreign' }) });
  await assert.rejects(foreign.addReviewComment({ projectId: 'film-1', revisionId: 'revision-1', anchor, body, idempotencyKey: 'ok' }), { code: 'sync-response-invalid' });
});

const baseService = () => Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(key => [key, async () => ({})]));
async function call(service, method, url, input, extraHeaders = {}) {
  const headers = { 'x-api-version': API_VERSION, authorization: 'Bearer fixture-token', ...extraHeaders };
  const bytes = input === undefined ? null : Buffer.from(JSON.stringify(input));
  if (bytes) { headers['content-type'] = 'application/json'; headers['content-length'] = String(bytes.length); }
  const request = Readable.from(bytes ? [bytes] : []);
  Object.assign(request, { method, url, headers, rawHeaders: Object.entries(headers).flat(), socket: { encrypted: true } });
  let status, output;
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(bytes) { output = JSON.parse(bytes); } };
  await createRevisionHttpHandler({ service })(request, response);
  return { status, output };
}
test('comment HTTP routes reject query/body/header ambiguity before domain mutation and fail closed when unavailable', async () => {
  let mutations = 0;
  const service = { ...baseService(), listReviewComments: async () => page(), addReviewComment: async () => { mutations++; return item(); },
    resolveReviewComment: async () => { mutations++; return { ...item(), status: 'resolved', resolvedAt: item().createdAt, resolvedBy: 'editor-1' }; } };
  const route = '/projects/film-1/revisions/revision-1/comments';
  assert.equal((await call(service, 'GET', `${route}?limit=20`)).status, 200);
  for (const suffix of ['?limit=0', '?limit=101', '?limit=20&limit=20', '?cursor=bad', '?unknown=yes', '?']) {
    assert.equal((await call(service, 'GET', route + suffix)).status, 400);
  }
  for (const input of [{ anchor, body, authorId: 'spoof' }, { anchor, body: '\u0000bad' }, { anchor: { ...anchor, clipId: '/private' }, body }]) {
    assert.equal((await call(service, 'POST', route, input, { 'idempotency-key': 'retry' })).status, 400);
  }
  assert.equal((await call(service, 'POST', route, { anchor, body })).status, 400);
  assert.equal((await call(service, 'PUT', `${route}/comment-1/resolve`, { resolved: false })).status, 400);
  assert.equal((await call(service, 'POST', `${route}?limit=20`, { anchor, body }, { 'idempotency-key': 'retry' })).status, 400);
  assert.equal(mutations, 0);
  assert.equal((await call(baseService(), 'GET', route)).status, 404);
});
