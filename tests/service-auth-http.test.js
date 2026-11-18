'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { API_VERSION } = require('../src/project-api-contracts');

const fixtureDirectory = path.join(__dirname, 'fixtures/network-tls');
const token = () => randomBytes(32).toString('base64url');
const session = () => ({ sessionId: 'session-1', accessToken: token(), refreshToken: token(), accessExpiresAt: 100, refreshExpiresAt: 200 });
const service = Object.fromEntries(['putManifest', 'getManifest', 'createRevision', 'getRevision', 'findRevisionBySource', 'getBranch', 'updateBranch'].map(name => [name, () => ({})]));
function identity(overrides = {}) {
  return { signIn: () => session(), refresh: () => session(), signOut: () => ({ signedOut: true }), authenticate: () => ({ userId: 'user-1' }),
    getUser: () => ({ id: 'user-1', email: 'editor@example.test', status: 'active' }), ...overrides };
}
async function invoke(handler, { route = '/auth/sessions', body,
  method = 'POST', address = '203.0.113.1', headers = {}, socket = {} } = {}) {
  if (body === undefined && method !== 'GET') body = { email: 'editor@example.test', password: 'fixture password' };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { socket: { encrypted: true, remoteAddress: address, ...socket }, url: route, method, complete: true,
    headers: { 'x-api-version': API_VERSION, 'x-request-id': 'auth-request', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, rawHeaders: [] });
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, values) { this.status = status; Object.assign(this.headers, values); },
    end(bytes) { this.text = bytes.toString(); this.body = JSON.parse(bytes); this.writableEnded = true; } };
  await handler(req, res); return res;
}

test('anonymous authentication remains optional and rejects unsafe bodies, browser origins and plaintext before identity work', async () => {
  let calls = 0; const handler = createRevisionHttpHandler({ service, identity: identity({ signIn() { calls++; return session(); } }) });
  const cases = [
    { body: { email: 'editor@example.test', password: 'fixture password', userId: 'forged' }, expected: 400 },
    { body: { email: 'editor@example.test', password: 'x'.repeat(1025) }, expected: 400 },
    { body: { email: 'editor@example.test', password: 'x'.repeat(8192) }, expected: 413 },
    { headers: { origin: 'https://browser.example.test' }, expected: 403 },
    { headers: { 'content-type': 'text/plain' }, expected: 415 },
    { socket: { encrypted: false }, expected: 426 },
    { route: '/auth/sessions?password=private-secret', expected: 400 },
    { method: 'GET', body: undefined, expected: 405 },
    { route: '/auth/sessions/refresh', body: { refreshToken: 'malformed' }, expected: 400 }
  ];
  for (const { expected, ...input } of cases) {
    const response = await invoke(handler, input); assert.equal(response.status, expected); assert.doesNotMatch(response.text, /private-secret|forged|browser\.example/);
  }
  assert.equal(calls, 0);
  assert.equal((await invoke(createRevisionHttpHandler({ service }))).status, 404);
});

test('mandatory authentication throttling is global per actual peer across routes and ignores forwarded addresses', async () => {
  let calls = 0; const observed = [];
  const auth = identity({ signIn() { calls++; return session(); }, refresh() { calls++; return session(); }, signOut() { calls++; return { signedOut: true }; } });
  const handler = createRevisionHttpHandler({ service, identity: auth, authRateLimit: value => observed.push(value) });
  for (let index = 0; index < 60; index++) {
    const kind = index % 3; const response = await invoke(handler, { route: kind === 0 ? '/auth/sessions' : `/auth/sessions/${kind === 1 ? 'refresh' : 'sign-out'}`,
      body: kind === 0 ? { email: 'editor@example.test', password: 'fixture password' } : { refreshToken: token() }, headers: { 'x-forwarded-for': `198.51.100.${index}` } });
    assert.equal(response.status, 200);
  }
  assert.equal((await invoke(handler, { headers: { 'x-forwarded-for': 'different-peer' } })).status, 429);
  assert.equal(calls, 60); assert.equal(new Set(observed.map(value => value.addressHash)).size, 1);
  assert.ok(observed.every(value => /^[a-f0-9]{64}$/.test(value.addressHash)));
  assert.doesNotMatch(JSON.stringify(observed), /203\.0\.113|editor@example|fixture password/);
  assert.equal((await invoke(handler, { address: '203.0.113.2' })).status, 200);
});

test('account and project listing authenticate before callbacks and never accept a requested user identity', async () => {
  let listed = 0; let authenticated = 0;
  const handler = createRevisionHttpHandler({ service, identity: identity({ authenticate(value) {
    authenticated++; if (value !== 'valid-token') throw Object.assign(new Error('invalid'), { code: 'access-token-invalid' }); return { userId: 'user-1' };
  } }), listProjects(context) { listed++; assert.equal(context.accessToken, 'valid-token'); return { projects: [] }; } });
  for (const route of ['/account', '/projects']) {
    assert.equal((await invoke(handler, { route, method: 'GET', body: undefined })).status, 401);
    assert.equal((await invoke(handler, { route, method: 'GET', body: undefined, headers: { authorization: 'Bearer invalid-token' } })).status, 401);
    const response = await invoke(handler, { route, method: 'GET', body: undefined, headers: { authorization: 'Bearer valid-token' } });
    assert.equal(response.status, 200);
  }
  assert.equal(listed, 1); assert.equal(authenticated, 4);
  assert.equal((await invoke(handler, { route: '/projects?userId=someone-else', method: 'GET', body: undefined, headers: { authorization: 'Bearer valid-token' } })).status, 400);
});

function mockClient(data, status = 200) {
  const seen = [];
  const client = createRevisionHttpClient({ origin: 'https://service.example.test', getAccessToken() { throw new Error('anonymous calls must not read credentials'); }, fetch: async (url, request) => {
    seen.push({ url, ...request }); return new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: request.headers['x-request-id'],
      ...(status === 200 ? { data } : { error: { code: data } }) }), { status, headers: { 'content-type': 'application/json' } });
  } }); return { client, seen };
}

test('client authentication sends secrets only in bounded JSON bodies and validates exact session responses', async () => {
  const valid = session(); const { client, seen } = mockClient(valid); const password = 'private fixture password';
  await client.signIn('EDITOR@example.test', password); await client.refreshSession(valid.refreshToken);
  assert.ok(seen.every(request => request.headers.authorization === undefined));
  assert.ok(seen.every(request => !request.url.includes(password) && !request.url.includes(valid.refreshToken)));
  assert.deepEqual(JSON.parse(seen[0].body), { email: 'editor@example.test', password });
  assert.deepEqual(JSON.parse(seen[1].body), { refreshToken: valid.refreshToken });
  const bad = [{ ...valid, privateField: 'secret' }, { ...valid, accessToken: 'raw-token' }, { ...valid, refreshExpiresAt: 1 },
    { ...valid, accessExpiresAt: Infinity }, { ...valid, refreshToken: valid.accessToken }];
  for (const value of bad) await assert.rejects(mockClient(value).client.signIn('editor@example.test', password), { code: 'sync-response-invalid' });
  await assert.rejects(mockClient('credentials-invalid', 401).client.signIn('editor@example.test', password), { code: 'credentials-invalid' });
  await assert.rejects(mockClient('rate-limit-exceeded', 429).client.signIn('editor@example.test', password), { code: 'rate-limit-exceeded' });
  await assert.rejects(mockClient('secret /Users/private', 401).client.signIn('editor@example.test', password), error => error.code === 'sync-service-failed' && !/private|secret/.test(error.message));
});

test('client rejects malformed account/project projections and honors authentication aborts', async () => {
  function protectedClient(data) { return createRevisionHttpClient({ origin: 'https://service.example.test', getAccessToken: token,
    fetch: async (_url, request) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: request.headers['x-request-id'], data }), { headers: { 'content-type': 'application/json' } }) }); }
  assert.deepEqual(await protectedClient({ id: 'user-1', email: 'editor@example.test', status: 'active' }).getAccount(), { id: 'user-1', email: 'editor@example.test', status: 'active' });
  const project = { id: 'film-1', name: 'Film', role: 'viewer', branches: ['main'] };
  assert.deepEqual(await protectedClient({ projects: [project] }).listProjects(), { projects: [project] });
  for (const value of [{ id: 'user-1', email: 'editor@example.test', status: 'deleted' }, { id: 'user-1', email: 'editor@example.test', status: 'active', token: 'secret' }])
    await assert.rejects(protectedClient(value).getAccount(), { code: 'sync-response-invalid' });
  for (const projects of [[{ ...project, name: '/Users/private' }], [{ ...project, role: 'admin' }], [project, project], [{ ...project, branches: ['main', 'main'] }], [{ ...project, refreshToken: token() }]])
    await assert.rejects(protectedClient({ projects }).listProjects(), { code: 'sync-response-invalid' });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(mockClient(session()).client.signIn('editor@example.test', 'fixture password', { signal: aborted.signal }), { code: 'sync-cancelled' });
});

const childScript = String.raw`
const assert = require('node:assert/strict');
const { createRevisionHttpClient } = require(process.argv[1]);
let text=''; process.stdin.on('data', chunk => { text+=chunk; }); process.stdin.on('end', async () => {
try {
  const input=JSON.parse(text); let accessToken=null;
  const client=createRevisionHttpClient({origin:input.origin,getAccessToken:()=>accessToken});
  let result;
  if(input.mode==='first') {
    await assert.rejects(client.signIn('owner@example.test','wrong password'),{code:'credentials-invalid'});
    const initial=await client.signIn('OWNER@example.test','owner fixture password'); accessToken=initial.accessToken;
    const account=await client.getAccount(); assert.equal(account.id,input.ownerId); assert.equal(account.status,'active');
    assert.deepEqual(await client.listProjects(),{projects:[{id:'auth-film',name:'Auth film',role:'owner',branches:['main']}]});
    assert.equal((await client.getBranch('auth-film','main')).revisionId,null);
    const outsider=await client.signIn('outsider@example.test','outsider fixture password'); accessToken=outsider.accessToken;
    assert.deepEqual(await client.listProjects(),{projects:[]}); await assert.rejects(client.getBranch('auth-film','main'),{code:'forbidden'});
    accessToken=initial.accessToken; result=await client.refreshSession(initial.refreshToken);
    await assert.rejects(client.getAccount(),{code:'access-token-invalid'});
    accessToken=result.accessToken; assert.equal((await client.getAccount()).id,input.ownerId);
    process.stdout.write(JSON.stringify({session:result}));
  } else {
    const rotated=await client.refreshSession(input.refreshToken); accessToken=rotated.accessToken;
    assert.equal((await client.getAccount()).id,input.ownerId); assert.equal((await client.listProjects()).projects.length,1);
    await client.signOut(rotated.refreshToken); await assert.rejects(client.getAccount(),{code:'access-token-invalid'});
    await assert.rejects(client.refreshSession(rotated.refreshToken),{code:'refresh-token-invalid'});
    process.stdout.write(JSON.stringify({restartRefreshAndSignOut:true}));
  }
} catch(error) { process.stderr.write(String(error.code || error.name)); process.exitCode=1; }
});`;
function runChild(input) {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[name];
  env.NODE_EXTRA_CA_CERTS = path.join(fixtureDirectory, 'ca.pem');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, path.resolve(__dirname, '../src/revision-http-client.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('auth fixture timeout')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer);
      if (code !== 0) { reject(new Error(`auth fixture failed (${code}): ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('invalid auth fixture receipt')); }
    }); child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}
async function serveTls(t, runtime) {
  const server = https.createServer({ key: fs.readFileSync(path.join(fixtureDirectory, 'server-key.pem')),
    cert: fs.readFileSync(path.join(fixtureDirectory, 'server.pem')), minVersion: 'TLSv1.2' }, createRevisionHttpHandler({
    service: runtime.service, identity: runtime.identity, listProjects: context => runtime.projects.list(context) }));
  server.headersTimeout = 5000; server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `https://127.0.0.1:${server.address().port}`;
}

test('actual HTTPS authentication, scoped project discovery and rotated refresh survive encrypted runtime restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-auth-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  let runtime = await createDurableCollaborationService({ directory, keyring, initialize: true });
  t.after(async () => runtime.close());
  const owner = await runtime.identity.createAccount('owner@example.test', 'owner fixture password');
  await runtime.identity.createAccount('outsider@example.test', 'outsider fixture password');
  const initial = await runtime.identity.signIn('owner@example.test', 'owner fixture password'); const context = { accessToken: initial.accessToken };
  const team = await runtime.teams.create(context, 'Fixture editors');
  await runtime.projects.create(context, { projectId: 'auth-film', name: 'Auth film', teamId: team.id });
  const first = await runChild({ origin: await serveTls(t, runtime), ownerId: owner.id, mode: 'first' });
  await runtime.close(); runtime = await createDurableCollaborationService({ directory, keyring });
  const receipt = await runChild({ origin: await serveTls(t, runtime), ownerId: owner.id, mode: 'second', refreshToken: first.session.refreshToken });
  assert.equal(receipt.restartRefreshAndSignOut, true);
  const persisted = fs.readFileSync(path.join(directory, 'collaboration.enc.json'), 'utf8');
  for (const secret of ['owner@example.test', 'owner fixture password', first.session.accessToken, first.session.refreshToken]) assert.equal(persisted.includes(secret), false);
});
