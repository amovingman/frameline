'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { API_VERSION, PROJECT_API_CONTRACTS } = require('../src/project-api-contracts');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const protocol = require('../src/project-presets-protocol');
const preset = () => ({ id: 'preset-1', teamId: 'team-1', name: 'Documentary', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'], version: 1, createdAt: 0, updatedAt: 0 });
const context = () => ({ teamId: 'team-1', presetId: 'preset-1', expectedVersion: 1, projectName: 'Disposable film' });
const plan = () => ({ planId: 'a'.repeat(64), teamId: 'team-1', presetId: 'preset-1', presetVersion: 1, projectName: 'Disposable film', branches: ['main', 'edit', 'review'], syncClasses: ['audio', 'proxy'], mediaAvailable: false });
const creation = () => ({ projectId: 'created-project', teamId: 'team-1', presetId: 'preset-1', presetVersion: 1, projectName: 'Disposable film', branches: ['main', 'edit', 'review'], syncClasses: ['audio', 'proxy'], createdAt: 1000 });
const catalog = () => ({ teams: [{ id: 'team-1', name: 'Editing / team', role: 'owner' }], mediaAvailable: false });
const base = () => Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(name => [name, async () => ({})]));
function incoming(method, url, body, headers = {}) {
  let reads = 0; const bytes = Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  const req = new Readable({ read() { reads++; this.push(bytes); this.push(null); } });
  headers = { 'x-api-version': API_VERSION, authorization: 'Bearer fixture-owner', ...headers,
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }) };
  Object.assign(req, { method, url, headers, rawHeaders: Object.entries(headers).flat(), socket: { encrypted: true, remoteAddress: '127.0.0.1' } });
  const result = { reads: () => reads, headers: {} }, res = { setHeader(key, value) { result.headers[key] = value; },
    writeHead(status, values) { result.status = status; Object.assign(result.headers, values); }, end(bytes) { result.body = JSON.parse(bytes); } };
  return { req, res, result };
}
async function call(handler, method, url, body, headers) { const v = incoming(method, url, body, headers); await handler(v.req, v.res); return v.result; }
const envelope = (options, data, status = 200) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], ...(status === 200 ? { data } : { error: { code: data } }) }), { status, headers: { 'content-type': 'application/json' } });
const saveInput = () => ({ teamId: 'team-1', presetId: null, expectedVersion: 0, name: 'Documentary', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'], idempotencyKey: 'save-intent' });

test('preset protocol validates bounded canonical templates and exact team, preview and historical creation scope', () => {
  assert.deepEqual(protocol.validatePresetTeamCatalog(catalog()), catalog());
  assert.deepEqual(protocol.validateProjectPresetCatalog({ teamId: 'team-1', items: [preset()] }, 'team-1').items[0], preset());
  assert.deepEqual(protocol.validateProjectPresetPlan(plan(), context()), plan());
  assert.deepEqual(protocol.validateProjectPresetCreation(creation(), context()), creation());
  const checked = protocol.validateProjectPreset(preset()); checked.branches.push('extra'); assert.equal(preset().branches.length, 2);
  for (const patch of [{ branches: ['main'] }, { branches: ['review', 'edit'] }, { branches: ['edit', 'edit'] },
    { branches: Array.from({ length: 21 }, (_, i) => 'x' + String(i).padStart(2, '0')) }, { branches: ['UPPER'] },
    { syncClasses: ['proxy', 'audio'] }, { syncClasses: ['unknown'] }, { name: '/private/film' }, { name: 'name\n' },
    { version: 0 }, { updatedAt: -1 }, { updatedAt: 8_640_000_000_000_001 }, { createdAt: 2, updatedAt: 1 }, { secret: 'hidden' }]) {
    assert.throws(() => protocol.validateProjectPreset({ ...preset(), ...patch }), { code: 'sync-response-invalid' });
  }
  assert.throws(() => protocol.validateProjectPresetCatalog({ teamId: 'team-1', items: [preset(), preset()] }, 'team-1'));
  assert.throws(() => protocol.validateProjectPresetCatalog({ teamId: 'team-1', items: Array(1001).fill(preset()) }, 'team-1'));
  assert.throws(() => protocol.validatePresetTeamCatalog({ ...catalog(), teams: [catalog().teams[0], catalog().teams[0]] }));
  for (const patch of [{ teamId: 'other' }, { presetId: 'other' }, { presetVersion: 2 }, { projectName: 'Other film' },
    { branches: ['edit', 'main'] }, { branches: ['main', 'main'] }, { planId: 'A'.repeat(64) }, { accessToken: 'secret' }]) {
    assert.throws(() => protocol.validateProjectPresetPlan({ ...plan(), ...patch }, context()), { code: 'sync-response-invalid' });
  }
  assert.throws(() => protocol.validateProjectPresetCreation({ ...creation(), presetVersion: 2 }, context()));
  assert.throws(() => protocol.validateProjectPresetCreation({ ...creation(), syncClasses: ['original', 'audio'] }, context()));
});

test('preset HTTP binds authenticated intents, requires idempotency, and rejects duplicate/unknown bodies before mutation', async () => {
  const calls = []; const service = { ...base(), listPresetTeams: async ctx => { calls.push(['teams', ctx]); return catalog(); },
    listProjectPresets: async (ctx, teamId) => { calls.push(['list', ctx, teamId]); return { teamId, items: [preset()] }; },
    saveProjectPreset: async (ctx, input) => { calls.push(['save', ctx, input]); return preset(); },
    previewProjectFromPreset: async (ctx, input) => { calls.push(['preview', ctx, input]); return plan(); },
    createProjectFromPreset: async (ctx, input) => { calls.push(['create', ctx, input]); return creation(); } };
  const handler = createRevisionHttpHandler({ service });
  assert.equal((await call(handler, 'GET', '/account/preset-teams')).status, 200);
  assert.equal((await call(handler, 'GET', '/teams/team-1/project-presets')).status, 200);
  const { teamId, idempotencyKey, ...save } = saveInput();
  assert.equal((await call(handler, 'PUT', '/teams/team-1/project-presets', save, { 'idempotency-key': idempotencyKey })).status, 200);
  assert.deepEqual(calls.at(-1)[2], saveInput()); assert.equal(calls.at(-1)[1].accessToken, 'fixture-owner');
  assert.equal((await call(handler, 'POST', '/teams/team-1/project-presets/preset-1/preview', { expectedVersion: 1, projectName: 'Disposable film' })).status, 200);
  assert.equal((await call(handler, 'POST', '/teams/team-1/project-presets/preset-1/projects', { expectedVersion: 1, projectName: 'Disposable film', planId: plan().planId }, { 'idempotency-key': 'create-intent' })).status, 200);
  const before = calls.length;
  for (const body of [{ ...save, actorId: 'other' }, { ...save, teamId: 'other' }, { ...save, branches: ['main'] },
    { ...save, syncClasses: ['proxy', 'audio'] }, { ...save, presetId: 'preset-1', expectedVersion: 0 },
    '{"presetId":null,"expectedVersion":0,"name":"Ignored","name":"Documentary","branches":[],"syncClasses":[]}',
    '{"presetId":null,"expectedVersion":0,"name":"Ignored","\\u006eame":"Documentary","branches":[],"syncClasses":[]}']) {
    assert.equal((await call(handler, 'PUT', '/teams/team-1/project-presets', body, { 'idempotency-key': 'intent' })).status, 400);
  }
  assert.equal((await call(handler, 'PUT', '/teams/team-1/project-presets', save)).status, 400);
  assert.equal(calls.length, before);
  for (const url of ['/account/preset-teams?', '/teams/team-1/project-presets?limit=20', '/teams/team-1/project-presets/preset-1/preview?actorId=other']) {
    assert.equal((await call(handler, 'GET', url)).status, 400);
  }
  assert.equal((await call(handler, 'POST', '/teams/team-1/project-presets', save)).status, 405);
  assert.equal((await call(handler, 'GET', '/account/preset-teams', undefined, { authorization: undefined })).status, 401);
  assert.equal((await call(handler, 'GET', '/account/preset-teams', undefined, { origin: 'https://browser.example.test' })).status, 403);
  const plain = incoming('GET', '/account/preset-teams'); plain.req.socket.encrypted = false; await handler(plain.req, plain.res); assert.equal(plain.result.status, 426);
  assert.equal((await call(createRevisionHttpHandler({ service: base() }), 'GET', '/account/preset-teams')).status, 404);
  const large = await call(handler, 'PUT', '/teams/team-1/project-presets', 'x'.repeat(8193)); assert.equal(large.status, 413); assert.equal(large.reads(), 0);
  assert(PROJECT_API_CONTRACTS.some(v => v.path === '/teams/:teamId/project-presets/:presetId/projects' && v.method === 'POST'));
});

test('preset HTTP and SDK preserve finite errors and reject mismatched or secret-bearing responses', async () => {
  const statuses = [400, 403, 404, 409, 409, 409, 409, 409, 503];
  for (const [index, code] of protocol.PRESET_ERROR_CODES.entries()) {
    const handler = createRevisionHttpHandler({ service: { ...base(), listPresetTeams: async () => { throw Object.assign(new Error('/private/secret'), { code }); } } });
    const response = await call(handler, 'GET', '/account/preset-teams'); assert.equal(response.status, statuses[index]);
    assert.deepEqual(response.body.error, { code }); assert(!JSON.stringify(response).includes('/private/secret'));
    const client = createRevisionHttpClient({ origin: 'https://preset.example.test', getAccessToken: () => 'fixture-bearer-123456789', fetch: async (_url, options) => envelope(options, code, statuses[index]) });
    await assert.rejects(client.listPresetTeams(), { code });
  }
  const handler = createRevisionHttpHandler({ service: { ...base(), listProjectPresets: async () => ({ teamId: 'other', items: [] }) } });
  const response = await call(handler, 'GET', '/teams/team-1/project-presets'); assert.equal(response.status, 500); assert.deepEqual(response.body.error, { code: 'service-unavailable' });
  let result = plan();
  const client = createRevisionHttpClient({ origin: 'https://preset.example.test', getAccessToken: () => 'fixture-bearer-123456789', fetch: async (_url, options) => envelope(options, result) });
  for (const patch of [{ presetVersion: 2 }, { teamId: 'other' }, { projectName: 'Other film' }, { mediaAvailable: false, password: 'secret' }]) {
    result = { ...plan(), ...patch }; await assert.rejects(client.previewProjectFromPreset(context()), { code: 'sync-response-invalid' });
  }
});

test('preset SDK validates intent before auth, uses correct methods/header-only retry keys, and retains historical ACK semantics', async () => {
  const calls = []; let tokens = 0;
  const client = createRevisionHttpClient({ origin: 'https://preset.example.test', getAccessToken: () => { tokens++; return 'fixture-bearer-123456789'; }, fetch: async (url, options) => {
    calls.push({ url, options });
    return envelope(options, url.endsWith('/preset-teams') ? catalog() : url.endsWith('/preview') ? plan()
      : url.endsWith('/projects') ? creation() : options.method === 'PUT' ? preset() : { teamId: 'team-1', items: [preset()] });
  } });
  await client.listPresetTeams(); await client.listProjectPresets('team-1'); await client.saveProjectPreset(saveInput());
  await client.previewProjectFromPreset(context()); await client.createProjectFromPreset({ ...context(), planId: plan().planId, idempotencyKey: 'create-intent' });
  assert.deepEqual(calls.map(v => v.options.method), ['GET', 'GET', 'PUT', 'POST', 'POST']);
  assert.equal(calls[2].options.headers['idempotency-key'], 'save-intent');
  assert.deepEqual(JSON.parse(calls[2].options.body), { presetId: null, expectedVersion: 0, name: 'Documentary', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'] });
  assert.equal(calls[4].options.headers['idempotency-key'], 'create-intent');
  assert(!calls.some(v => v.url.includes('create-intent') || v.options.body?.includes('idempotencyKey')));
  assert(calls.every(v => v.options.redirect === 'error' && v.options.credentials === 'omit' && v.options.cache === 'no-store'));
  const count = tokens;
  for (const value of [{ ...saveInput(), expectedVersion: 1 }, { ...saveInput(), name: ' bad ' }, { ...saveInput(), userId: 'other' }, { ...saveInput(), branches: ['main'] }]) await assert.rejects(client.saveProjectPreset(value), { code: 'preset-invalid' });
  await assert.rejects(client.previewProjectFromPreset({ ...context(), projectName: '/private/film' }), { code: 'preset-invalid' });
  await assert.rejects(client.createProjectFromPreset({ ...context(), planId: 'invalid', idempotencyKey: 'create' }), { code: 'preset-invalid' });
  assert.equal(tokens, count);
  assert.equal(protocol.validateProjectPresetSaveResponse(preset(), { ...saveInput(), presetId: 'preset-1', expectedVersion: 1 }).version, 1);
  assert.equal(protocol.validateProjectPresetSaveResponse({ ...preset(), version: 2 }, { ...saveInput(), presetId: 'preset-1', expectedVersion: 1 }).version, 2);
  assert.throws(() => protocol.validateProjectPresetSaveResponse({ ...preset(), version: 3 }, { ...saveInput(), presetId: 'preset-1', expectedVersion: 1 }));
});

test('preset SDK propagates abort without exposing token or response details', async () => {
  const controller = new AbortController(); let dispatched;
  const entered = new Promise(resolve => { dispatched = resolve; });
  const client = createRevisionHttpClient({ origin: 'https://preset.example.test', getAccessToken: () => 'private-fixture-token', fetch: async (_url, options) => {
    dispatched(options); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private-fixture-token')), { once: true }));
  } });
  const pending = client.listPresetTeams({ signal: controller.signal }); await entered; controller.abort();
  await assert.rejects(pending, error => error.code === 'sync-cancelled' && error.message === 'sync-cancelled');
  const before = new AbortController(); before.abort(); await assert.rejects(client.listProjectPresets('team-1', { signal: before.signal }), { code: 'sync-cancelled' });
});
