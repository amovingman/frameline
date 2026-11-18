'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { API_VERSION } = require('../src/project-api-contracts');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { validateBranchReview, validateBranchApprovalRequest } = require('../src/branch-review-protocol');
const at = '2026-11-18T12:00:00.000Z', expires = '2026-11-25T12:00:00.000Z';
const policy = () => ({ version: 1, requiredApprovals: 1, updatedAt: at, updatedBy: 'owner' });
const candidate = () => ({ revisionId: 'staged', parentRevisionId: 'head', authorId: 'author', message: 'Review audio/video change', manifestId: `sha256:${'a'.repeat(64)}`, createdAt: at });
const request = () => ({ id: 'request-1', projectId: 'film', branch: 'main', requesterId: 'publisher', revisionId: 'staged', expectedHead: 'head',
  policyVersion: 1, requiredApprovals: 1, createdAt: at, expiresAt: expires, status: 'pending', proposal: candidate(), approvals: [],
  recordedApprovals: 0, activeApprovals: 0, canApprove: true, applied: null });
const review = () => ({ projectId: 'film', branch: 'main', headRevisionId: 'head', policy: policy(),
  candidates: { items: [{ ...candidate(), canRequest: true }], total: 1, nextCursor: null },
  requests: { items: [request()], total: 1, nextCursor: null } });
const reply = (options, data, status = 200) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'],
  ...(status === 200 ? { data } : { error: { code: data } }) }), { status, headers: { 'content-type': 'application/json' } });

test('branch review DTO validation binds immutable proposals, counts, scope and independent approvers', () => {
  assert.deepEqual(validateBranchReview(review(), 'film', 'main'), review());
  for (const patch of [{ projectId: 'other' }, { branch: 'other' }, { proposal: { ...candidate(), revisionId: 'other' } },
    { proposal: { ...candidate(), parentRevisionId: 'other' } }, { privateKey: 'secret' },
    { approvals: [{ actorId: 'publisher', at, active: true }], recordedApprovals: 1, activeApprovals: 1, status: 'approved' },
    { approvals: [{ actorId: 'author', at, active: true }], recordedApprovals: 1, activeApprovals: 1, status: 'approved' },
    { activeApprovals: 1 }, { status: 'approved' }, { expiresAt: at }, { status: 'expired', canApprove: true },
    { status: 'applied', applied: { actorId: 'other', at, revisionId: 'staged' }, canApprove: false }]) {
    assert.throws(() => validateBranchApprovalRequest({ ...request(), ...patch }, 'film', 'main'), { code: 'sync-response-invalid' });
  }
  for (const input of [{ ...review(), candidates: { items: [{ ...candidate(), parentRevisionId: 'wrong', canRequest: true }], total: 1, nextCursor: null } },
    { ...review(), requests: { items: [request(), request()], total: 2, nextCursor: null } },
    { ...review(), policy: { ...policy(), requiredApprovals: 6 } }]) {
    assert.throws(() => validateBranchReview(input, 'film', 'main'), { code: 'sync-response-invalid' });
  }
});

test('branch review SDK validates intent and sends exact revision, policy and idempotency bindings', async () => {
  const calls = [], client = createRevisionHttpClient({ origin: 'https://review.example.test', getAccessToken: () => 'fixture-token-123456789', fetch: async (url, options) => {
    calls.push({ url, options }); return reply(options, url.includes('/protection') ? policy() : options.method === 'GET' ? review() : request());
  } });
  await client.getBranchReview('film', 'main', { limit: 20 });
  await client.setBranchProtection({ projectId: 'film', branch: 'main', expectedVersion: 0, requiredApprovals: 1, idempotencyKey: 'policy-1' });
  await client.requestBranchApproval({ projectId: 'film', branch: 'main', expectedHead: 'head', revisionId: 'staged', policyVersion: 1, idempotencyKey: 'request-1' });
  await client.approveBranchRequest('film', 'main', 'request-1');
  assert.equal(calls[0].url, 'https://review.example.test/projects/film/branches/main/review?limit=20');
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedVersion: 0, requiredApprovals: 1 });
  assert.equal(calls[2].options.headers['idempotency-key'], 'request-1');
  assert.deepEqual(JSON.parse(calls[2].options.body), { expectedHead: 'head', revisionId: 'staged', policyVersion: 1 });
  assert.deepEqual(JSON.parse(calls[3].options.body), { approved: true });
  const count = calls.length;
  for (const page of [{ limit: 0 }, { requestCursor: 'bad' }, { candidateCursor: 'bad' }, { authorId: 'spoof' }]) await assert.rejects(client.getBranchReview('film', 'main', page));
  await assert.rejects(client.setBranchProtection({ projectId: 'film', branch: 'main', expectedVersion: 0, requiredApprovals: 6, idempotencyKey: 'bad' }));
  await assert.rejects(client.requestBranchApproval({ projectId: 'film', branch: 'main', expectedHead: 'head', revisionId: 'staged', policyVersion: 1, idempotencyKey: 'x', actorId: 'spoof' }));
  assert.equal(calls.length, count);
  const mismatch = createRevisionHttpClient({ origin: 'https://review.example.test', getAccessToken: () => 'fixture-token-123456789', fetch: async (_url, options) => reply(options, { ...request(), revisionId: 'substituted' }) });
  await assert.rejects(mismatch.requestBranchApproval({ projectId: 'film', branch: 'main', expectedHead: 'head', revisionId: 'staged', policyVersion: 1, idempotencyKey: 'x' }), { code: 'sync-response-invalid' });
});

const baseService = () => Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(name => [name, async () => ({})]));
async function call(service, method, url, input, headers = {}) {
  const bytes = input === undefined ? null : Buffer.from(JSON.stringify(input));
  headers = { authorization: 'Bearer fixture-token', 'x-api-version': API_VERSION, ...headers,
    ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) };
  const req = Readable.from(bytes ? [bytes] : []); Object.assign(req, { url, method, headers, rawHeaders: Object.entries(headers).flat(), socket: { encrypted: true } });
  let status, result;
  await createRevisionHttpHandler({ service })(req, { setHeader() {}, writeHead(value) { status = value; }, end(bytes) { result = JSON.parse(bytes); } });
  return { status, result };
}
test('branch routes retain optional-service compatibility and reject query or body ambiguity before mutations', async () => {
  let writes = 0;
  const service = { ...baseService(), getBranchReview: async () => review(), setBranchProtection: async () => { writes++; return policy(); },
    requestBranchApproval: async () => { writes++; return request(); }, approveBranchRequest: async () => { writes++; return request(); } };
  const path = '/projects/film/branches/main';
  assert.equal((await call(baseService(), 'GET', `${path}/review`)).status, 404);
  assert.equal((await call(service, 'GET', `${path}/review?limit=20`)).status, 200);
  for (const query of ['limit=101', 'limit=20&limit=20', 'requestCursor=bad', 'candidateCursor=bad', 'unknown=x', '']) assert.equal((await call(service, 'GET', `${path}/review?${query}`)).status, 400);
  assert.equal((await call(service, 'PUT', `${path}/protection`, { expectedVersion: 0, requiredApprovals: 1 })).status, 400);
  for (const body of [{ expectedVersion: -1, requiredApprovals: 1 }, { expectedVersion: 0, requiredApprovals: 6 }, { expectedVersion: 0, requiredApprovals: 1, actorId: 'spoof' }]) {
    assert.equal((await call(service, 'PUT', `${path}/protection`, body, { 'idempotency-key': 'p' })).status, 400);
  }
  assert.equal((await call(service, 'PUT', `${path}/approval-requests/request-1/approval`, { approved: false })).status, 400);
  assert.equal((await call(service, 'POST', `${path}/approval-requests?limit=20`, { expectedHead: 'head', revisionId: 'staged', policyVersion: 1 }, { 'idempotency-key': 'r' })).status, 400);
  assert.equal(writes, 0);
});
