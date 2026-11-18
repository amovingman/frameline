'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { createRevisionHttpHandler, MAX_HTTP_BYTES } = require('../src/revision-http-transport');
const { API_VERSION } = require('../src/project-api-contracts');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');
const { createIdentityService } = require('../src/identity-service');
const { createAccessControl } = require('../src/access-control');

const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
  sourceHash: 'a'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 },
  clips: [], media: [], warnings: [] };
function fixture() {
  const history = createCloudHistoryStore();
  history.createProject({ projectId: 'film-1', name: 'Film' });
  const identity = createIdentityService();
  const owner = identity.createAccount('owner@example.test', 'a fixture password');
  const other = identity.createAccount('other@example.test', 'another fixture password');
  const access = createAccessControl(); const team = access.createTeam(owner.id, 'Editors');
  access.registerProject(owner.id, 'film-1', team.id);
  return { history, identity, access, owner, other,
    ownerToken: identity.signIn('owner@example.test', 'a fixture password').accessToken,
    otherToken: identity.signIn('other@example.test', 'another fixture password').accessToken,
    service: createAuthorizedProjectService({ history, identity, access }) };
}
async function serve(t, service, options = {}) {
  const server = http.createServer(createRevisionHttpHandler({ service, allowLoopbackHttp: true, ...options }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (method, path, token, body, headers = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'x-api-version': API_VERSION, 'x-request-id': 'request-test',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(bytes !== null ? { 'content-type': 'application/json' } : {}),
        connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text), text });
      });
    });
    request.on('error', reject); request.end(bytes);
  });
}
const pathFor = suffix => `/projects/film-1/${suffix}`;
async function seed(call, token) {
  const uploaded = await call('PUT', pathFor('manifests'), token, { manifest });
  assert.equal(uploaded.status, 200);
  const revision = await call('POST', pathFor('revisions'), token,
    { manifestId: uploaded.body.data.id, message: 'First cut', sourceRevisionId: 'local-1' },
    { 'idempotency-key': 'create-first' });
  assert.equal(revision.status, 200);
  return { manifestId: uploaded.body.data.id, revision: revision.body.data };
}

test('HTTP metadata round trip is versioned, idempotent and attributed to its authenticated account', async t => {
  const setup = fixture(); const call = await serve(t, setup.service);
  const { manifestId, revision } = await seed(call, setup.ownerToken);
  assert.equal(revision.authorId, setup.owner.id);
  const again = await call('POST', pathFor('revisions'), setup.ownerToken,
    { manifestId, message: 'First cut', sourceRevisionId: 'local-1' }, { 'idempotency-key': 'create-first' });
  assert.equal(again.body.data.id, revision.id);
  const updated = await call('PUT', pathFor('branches/main'), setup.ownerToken,
    { expectedRevisionId: null, revisionId: revision.id }, { 'idempotency-key': 'branch-first' });
  assert.equal(updated.status, 200);
  const branch = await call('GET', pathFor('branches/main'), setup.ownerToken);
  assert.equal(branch.body.data.revisionId, revision.id);
  assert.equal(branch.body.apiVersion, API_VERSION); assert.equal(branch.body.requestId, 'request-test');
  assert.equal(branch.headers['cache-control'], 'no-store');
  assert.equal(branch.headers['access-control-allow-origin'], undefined);
  assert.deepEqual((await call('GET', pathFor(`manifests/${encodeURIComponent(manifestId)}`), setup.ownerToken)).body.data.document, manifest);
  assert.equal((await call('GET', pathFor(`revisions/${revision.id}`), setup.ownerToken)).body.data.id, revision.id);
  assert.equal((await call('GET', pathFor('revisions/by-source/local-1'), setup.ownerToken)).body.data.id, revision.id);
  assert.equal((await call('GET', pathFor('revisions/by-source/missing'), setup.ownerToken)).body.data, null);
});

test('all resource routes authorize outsiders including source lookups and mutation routes', async t => {
  const setup = fixture(); const call = await serve(t, setup.service);
  const { manifestId, revision } = await seed(call, setup.ownerToken);
  const cases = [
    ['PUT', 'manifests', { manifest }], ['GET', `manifests/${encodeURIComponent(manifestId)}`],
    ['POST', 'revisions', { manifestId, message: 'Unauthorized' }], ['GET', `revisions/${revision.id}`],
    ['GET', 'revisions/by-source/local-1'], ['GET', 'revisions/by-source/not-present'],
    ['GET', 'branches/main'], ['PUT', 'branches/main', { expectedRevisionId: null, revisionId: revision.id }]
  ];
  for (const [method, suffix, body] of cases) {
    const denied = await call(method, pathFor(suffix), setup.otherToken, body);
    assert.equal(denied.status, 403, suffix); assert.equal(denied.body.error.code, 'forbidden');
    const anonymous = await call(method, pathFor(suffix), null, body);
    assert.equal(anonymous.status, 401, suffix);
  }
  assert.equal(setup.history.getBranch('film-1', 'main').revisionId, null);
  assert.equal(setup.history.listRevisions('film-1').items.length, 1);
});

test('viewer can fetch metadata but cannot write it, including after access is revoked', async t => {
  const setup = fixture();
  const invitation = setup.access.inviteProject(setup.owner.id, 'film-1', 'other@example.test', 'viewer');
  setup.access.acceptInvitation(invitation.token, setup.other.id, 'other@example.test');
  const call = await serve(t, setup.service); const { revision } = await seed(call, setup.ownerToken);
  assert.equal((await call('GET', pathFor(`revisions/${revision.id}`), setup.otherToken)).status, 200);
  assert.equal((await call('PUT', pathFor('manifests'), setup.otherToken, { manifest })).status, 403);
  setup.access.removeProjectMember(setup.owner.id, 'film-1', setup.other.id);
  assert.equal((await call('GET', pathFor('revisions/by-source/local-1'), setup.otherToken)).status, 403);
});

test('stale branch writes return a recoverable conflict without changing the branch', async t => {
  const setup = fixture(); const call = await serve(t, setup.service); const { revision } = await seed(call, setup.ownerToken);
  const body = { expectedRevisionId: null, revisionId: revision.id };
  assert.equal((await call('PUT', pathFor('branches/main'), setup.ownerToken, body)).status, 200);
  const conflict = await call('PUT', pathFor('branches/main'), setup.ownerToken, body);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'branch-head-changed');
  assert.equal(setup.history.getBranch('film-1', 'main').revisionId, revision.id);
});

test('requests fail closed for versions, methods, content types, unsafe paths and unknown body fields', async t => {
  const setup = fixture(); const call = await serve(t, setup.service);
  const cases = [
    ['GET', pathFor('branches/main'), undefined, { 'x-api-version': 'old' }, 400, 'api-version-unsupported'],
    ['GET', pathFor('branches/main'), undefined, { origin: 'https://evil.test' }, 403, 'browser-request-forbidden'],
    ['OPTIONS', pathFor('branches/main'), undefined, {}, 405, 'method-not-allowed'],
    ['PUT', pathFor('manifests'), { manifest }, { 'content-type': 'text/plain' }, 415, 'content-type-invalid'],
    ['PUT', pathFor('manifests'), '{bad', {}, 400, 'body-invalid'],
    ['PUT', pathFor('manifests'), { manifest, token: 'hidden-secret' }, {}, 400, 'body-invalid'],
    ['PUT', pathFor('manifests'), { manifest: { ...manifest, localPath: '/private/path' } }, {}, 400, 'manifest-invalid'],
    ['POST', pathFor('revisions'), { manifestId: 'm1', message: 'Cut', authorId: 'forged' }, {}, 400, 'body-invalid'],
    ['GET', pathFor('branches/a%2Fb'), undefined, {}, 400, 'request-invalid'],
    ['GET', pathFor('branches/%2e%2e'), undefined, {}, 400, 'request-invalid'],
    ['GET', `${pathFor('branches/main')}?access_token=hidden-secret`, undefined, {}, 400, 'request-invalid'],
    ['GET', pathFor('branches/main'), undefined, { 'x-request-id': '/private/path' }, 400, 'invalid-request-headers']
  ];
  for (const [method, url, body, headers, status, code] of cases) {
    const response = await call(method, url, setup.ownerToken, body, headers);
    assert.equal(response.status, status, url); assert.equal(response.body.error.code, code);
    assert.doesNotMatch(response.text, /hidden-secret|private\/path|evil\.test/);
  }
  assert.equal(setup.history.listRevisions('film-1').items.length, 0);
});

test('8 MiB bounds apply to advertised and chunked bodies and service responses', async t => {
  const setup = fixture(); const call = await serve(t, setup.service);
  const advertised = await call('PUT', pathFor('manifests'), setup.ownerToken, '{}',
    { 'content-length': String(MAX_HTTP_BYTES + 1) });
  assert.equal(advertised.status, 413);
  const chunked = await call('PUT', pathFor('manifests'), setup.ownerToken, 'x'.repeat(MAX_HTTP_BYTES + 1),
    { 'transfer-encoding': 'chunked' });
  assert.equal(chunked.status, 413);
  const tooLarge = await serve(t, { ...setup.service, getBranch: () => ({ value: 'x'.repeat(MAX_HTTP_BYTES) }) });
  const response = await tooLarge('GET', pathFor('branches/main'), setup.ownerToken);
  assert.equal(response.status, 502); assert.equal(response.body.error.code, 'response-too-large');
});

test('plaintext is rejected by default regardless of proxy headers', async t => {
  const setup = fixture(); const call = await serve(t, setup.service, { allowLoopbackHttp: false });
  const response = await call('GET', pathFor('branches/main'), setup.ownerToken, undefined,
    { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
  assert.equal(response.status, 426); assert.equal(response.body.error.code, 'secure-transport-required');
});

async function invokeSocket(service, socket, options = {}) {
  const req = Readable.from([]);
  Object.assign(req, { socket, url: pathFor('branches/main'), method: 'GET', complete: true,
    headers: { 'x-api-version': API_VERSION, authorization: 'Bearer fixture-token' }, rawHeaders: [] });
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(bytes) { this.body = JSON.parse(bytes); this.writableEnded = true; } };
  await createRevisionHttpHandler({ service, ...options })(req, res); return res;
}
test('transport trusts encrypted sockets or explicit exact loopback peers only', async () => {
  const setup = fixture(); const service = { ...setup.service, getBranch: () => ({ revisionId: null }) };
  assert.equal((await invokeSocket(service, { encrypted: true, remoteAddress: '203.0.113.1' })).status, 200);
  for (const address of ['203.0.113.1', '::ffff:127.0.0.1', '127.0.0.2', undefined]) {
    assert.equal((await invokeSocket(service, { remoteAddress: address }, { allowLoopbackHttp: true })).status, 426);
  }
  assert.equal((await invokeSocket(service, { remoteAddress: '::1' }, { allowLoopbackHttp: true })).status, 200);
});

test('unrecognized failures expose only a generic code and no exception details', async t => {
  const setup = fixture(); const call = await serve(t, { ...setup.service, getBranch() {
    const error = new Error('/private/path Bearer private-token'); error.code = '/private/path'; throw error;
  } });
  const response = await call('GET', pathFor('branches/main'), setup.ownerToken);
  assert.equal(response.status, 500); assert.equal(response.body.error.code, 'service-unavailable');
  assert.doesNotMatch(response.text, /private|Bearer/);
});
