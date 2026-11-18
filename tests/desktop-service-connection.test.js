'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopServiceConnection } = require('../src/desktop-service-connection');

const password = 'private disposable password';
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const error = code => Object.assign(new Error('/private/token-secret'), { code });
function fixture(options = {}) {
  let encoded = null, clock = 1000000, serial = 0;
  const calls = { refresh: 0, signOut: 0, set: 0, remove: 0, used: [] }, instances = [], events = [];
  const control = { offline: false, beforeSet: null, failSet: false, signIn: null, refresh: null, extraAccount: false };
  const issued = () => ({ sessionId: `session-${++serial}`, accessToken: `access-token-${serial}-secret`, refreshToken: `refresh-token-${serial}-secret`,
    accessExpiresAt: clock + 100, refreshExpiresAt: clock + 100000 });
  const vault = {
    async get() { return encoded; },
    async set(_id, value) { calls.set++; if (control.beforeSet) await control.beforeSet(value); encoded = value;
      if (control.failSet) throw error('/private/credential-failure'); },
    async remove() { calls.remove++; encoded = null; }
  };
  const createClient = ({ origin, getAccessToken }) => {
    const who = origin.includes('second') ? 'second' : 'first';
    const check = async () => { if (control.offline) throw error('sync-network-unavailable');
      const token = await getAccessToken(); calls.used.push(token); return token; };
    const client = {
      async signIn(email, secret, opts) { assert.equal(secret, password); return control.signIn ? control.signIn({ origin, email, opts, issued }) : issued(); },
      async refreshSession(token, opts) { calls.refresh++; return control.refresh ? control.refresh({ token, opts, issued }) : issued(); },
      async signOut() { calls.signOut++; return { signedOut: true }; },
      async getAccount() { await check(); return { id: who, email: `${who}@disposable.example.test`, status: 'active', ...(control.extraAccount ? { privatePath: '/private/source' } : {}) }; },
      async listProjects() { await check(); return { projects: [{ id: 'film', name: 'Film', role: 'editor', branches: ['main'] }] }; },
      async getBranch(id, branch) { await check(); return { projectId: id, branch, revisionId: null }; }
    };
    if (options.clientMethods) Object.assign(client, options.clientMethods({ getAccessToken, origin }));
    instances.push(client); return client;
  };
  const make = () => createDesktopServiceConnection({ directory: '/private/tmp/frameline-connection-test', vault, createClient, createAssetClient: options.createAssetClient,
    onChange: value => { events.push(value); options.onChange?.(value); } });
  return { make, control, calls, instances, events, get encoded() { return encoded; }, get clock() { return clock; }, advance() { clock += 200; } };
}
async function connect(value, origin = 'https://first.example.test') {
  return value.connect({ origin, email: 'first@disposable.example.test', password });
}

test('connection persists one atomic private record and emits cloned allowlisted state', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make();
  assert.equal((await value.initialize()).status, 'not-configured');
  const state = await connect(value); assert.equal(state.status, 'connected');
  assert.deepEqual(state.account, { id: 'first', email: 'first@disposable.example.test' });
  assert.deepEqual(Object.keys(state).sort(), ['version', 'status', 'connected', 'busy', 'origin', 'account', 'projects', 'error'].sort());
  const saved = JSON.parse(f.encoded); assert.deepEqual(Object.keys(saved).sort(), ['schemaVersion', 'origin', 'session', 'account'].sort());
  assert(!f.encoded.includes(password)); assert.doesNotMatch(JSON.stringify(f.events), /access-token|refresh-token|private disposable|\/private\/|"status":"active"/);
  state.projects[0].name = 'Mutated'; f.events.at(-1).account.id = 'mutated';
  assert.equal(value.getState().projects[0].name, 'Film'); assert.equal(value.getAccount().id, 'first');
  const client = value.getClient(); await value.disconnect(); assert.equal(f.encoded, null); assert.equal(f.calls.signOut, 1);
  await assert.rejects(client.getBranch('film', 'main'), { code: 'service-sign-in-required' });
});

test('offline startup preserves encrypted credentials and private binding for an explicit retry', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const first = f.make(); await connect(first); await first.dispose();
  const saved = f.encoded; f.control.offline = true; const restored = f.make();
  const state = await restored.initialize(); assert.equal(state.status, 'offline'); assert.equal(state.error, 'service-offline');
  assert.equal(state.connected, false); assert.equal(f.encoded, saved); assert.equal(restored.getAccount().id, 'first');
  f.control.offline = false; assert.equal((await restored.refreshProjects()).status, 'connected');
});

test('expired access refresh is single flight and newly rotated tokens are saved before use', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); f.advance();
  const started = defer(), release = defer();
  f.control.beforeSet = async () => { started.resolve(); await release.promise; };
  const client = value.getClient(), one = client.getBranch('film', 'main'), two = client.getBranch('film', 'main');
  await started.promise; assert.equal(f.calls.refresh, 1); assert.equal(f.calls.used.filter(token => token.includes('-2-')).length, 0);
  release.resolve(); await Promise.all([one, two]);
  assert.equal(f.calls.refresh, 1); assert.equal(JSON.parse(f.encoded).session.sessionId, 'session-2');
  assert.equal(f.calls.used.filter(token => token.includes('-2-')).length, 2);
});

test('disconnect drains a pending vault write before removing credentials', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make();
  const started = defer(), release = defer(); f.control.beforeSet = async () => { started.resolve(); await release.promise; };
  const connecting = connect(value); await started.promise; const disconnecting = value.disconnect();
  release.resolve(); await Promise.all([connecting, disconnecting]);
  assert.equal(value.getState().status, 'not-configured'); assert.equal(f.encoded, null);
  assert.equal(f.calls.set, 1); assert.equal(f.calls.remove, 1);
});

test('replacement drains stale sign-in work and captured clients never acquire the new identity', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value);
  const oldClient = value.getClient(); const started = defer(), release = defer();
  f.control.signIn = async ({ origin, issued }) => { if (origin.includes('first')) { started.resolve(); await release.promise; } return issued(); };
  const old = connect(value); await started.promise; const replacement = connect(value, 'https://second.example.test'); release.resolve();
  await Promise.all([old, replacement]);
  assert.equal(value.getAccount().id, 'second'); assert.equal(JSON.parse(f.encoded).origin, 'https://second.example.test');
  await assert.rejects(oldClient.getBranch('film', 'main'), { code: 'service-sign-in-required' });
  assert.equal(f.calls.set, 2);
});

test('ambiguous rotated-session vault failure requires sign-in and never retries the old refresh token', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); const client = value.getClient();
  f.advance(); f.control.failSet = true;
  await assert.rejects(client.getBranch('film', 'main'), { code: 'service-credential-storage-unavailable' });
  assert.equal(value.getState().status, 'sign-in-required'); assert.equal(f.encoded, null);
  await assert.rejects(client.getBranch('film', 'main'), { code: 'service-sign-in-required' }); assert.equal(f.calls.refresh, 1);
  assert.doesNotMatch(JSON.stringify(value.getState()), /\/private\/|access-token|refresh-token/);
});

test('disposing aborts and drains activity while retaining the vault for the next launch', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); const client = value.getClient(), saved = f.encoded;
  await value.dispose(); assert.equal(f.encoded, saved); assert.equal(f.calls.signOut, 0); assert.equal(f.calls.remove, 0);
  assert.throws(() => value.getClient(), { code: 'service-sign-in-required' });
  await assert.rejects(client.getBranch('film', 'main'), { code: 'service-sign-in-required' });
  const next = f.make(); assert.equal((await next.initialize()).status, 'connected');
});

test('replacement aborts and drains an existing private request before publishing the new connection', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value);
  const started = defer(), release = defer(), underlying = f.instances[0], original = underlying.getBranch;
  let signal;
  underlying.getBranch = async (...args) => { signal = args[2].signal; started.resolve(); await release.promise; return original(...args); };
  const request = value.getClient().getBranch('film', 'main'); await started.promise;
  const replacement = connect(value, 'https://second.example.test'); assert.equal(signal.aborted, true);
  assert.equal(f.calls.set, 1); release.resolve();
  await assert.rejects(request, { code: 'service-sign-in-required' }); await replacement;
  assert.equal(value.getAccount().id, 'second'); assert.equal(f.calls.set, 2);
});

test('a failed initial credential save never exposes a usable connection or retained password', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); f.control.failSet = true;
  const state = await connect(value); assert.equal(state.status, 'sign-in-required');
  assert.equal(state.error, 'service-credential-storage-unavailable'); assert.equal(f.encoded, null);
  assert.throws(() => value.getClient(), { code: 'service-sign-in-required' });
  assert.doesNotMatch(JSON.stringify(f.events), /access-token|refresh-token|private disposable|\/private\//);
});

test('invalid service origins and unrecognized private response fields never enter display state', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make();
  for (const origin of ['http://localhost', 'https://user:secret@example.test', 'https://example.test/private/path', 'https://example.test/?token=secret']) {
    assert.equal((await connect(value, origin)).error, 'service-origin-invalid');
  }
  assert.equal(f.instances.length, 0); f.control.extraAccount = true;
  assert.equal((await connect(value)).status, 'sign-in-required'); assert.equal(f.encoded, null);
  assert.doesNotMatch(JSON.stringify(value.getState()), /\/private\/|privatePath|secret/);
});

test('a revoked protected request invalidates the private session and publishes sign-in recovery', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value);
  const client = value.getClient(), saved = f.encoded;
  f.instances[0].getBranch = async () => { throw error('access-token-invalid'); };
  await assert.rejects(client.getBranch('film', 'main'), { code: 'access-token-invalid', message: 'access-token-invalid' });
  assert.equal(value.getState().status, 'sign-in-required'); assert.equal(value.getState().connected, false);
  assert.equal(value.getState().error, 'service-sign-in-required'); assert.equal(value.getState().busy, false);
  assert.throws(() => value.getClient(), { code: 'service-sign-in-required' });
  await assert.rejects(client.getBranch('film', 'main'), { code: 'service-sign-in-required' });
  assert.equal(f.encoded, saved); assert.equal(f.calls.refresh, 0);
  assert.doesNotMatch(JSON.stringify(f.events), /\/private\/|token-secret/);
});

test('a protected network failure publishes offline and retains the bound client and credentials for retry', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value);
  const client = value.getClient(), saved = f.encoded; f.control.offline = true;
  await assert.rejects(client.getBranch('film', 'main'), { code: 'sync-network-unavailable', message: 'sync-network-unavailable' });
  assert.equal(value.getState().status, 'offline'); assert.equal(value.getState().connected, false);
  assert.equal(value.getClient(), client); assert.equal(f.encoded, saved);
  f.control.offline = false; await client.getBranch('film', 'main'); assert.equal(value.getState().status, 'connected');
});

test('private request failures discard unknown error codes and messages', async t => {
  const f = fixture(); t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value);
  f.instances[0].getBranch = async () => { throw error('/private/access-token-secret'); };
  await assert.rejects(value.getClient().getBranch('film', 'main'), { code: 'service-connection-failed', message: 'service-connection-failed' });
  assert.equal(value.getState().status, 'connected');
});

test('asset clients share persisted single-flight refresh and remain generation bound across disconnect', async t => {
  const used = []; let waiting = null, capturedSignal;
  const f = fixture({ createAssetClient: ({ getAccessToken }) => ({
    async getAsset(_project, _asset, options) {
      capturedSignal = options.signal; if (waiting) { waiting.started.resolve(); await waiting.release.promise; }
      used.push(await getAccessToken()); return { assetId: 'asset-fixture' };
    }
  }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); f.advance();
  const assets = value.getAssetClient();
  await Promise.all([assets.getAsset('film', 'asset-fixture'), value.getClient().getBranch('film', 'main')]);
  assert.equal(f.calls.refresh, 1); assert.equal(used[0], JSON.parse(f.encoded).session.accessToken);
  waiting = { started: defer(), release: defer() }; const request = assets.getAsset('film', 'asset-fixture'); await waiting.started.promise;
  const disconnect = value.disconnect(); assert.equal(capturedSignal.aborted, true); waiting.release.resolve();
  await assert.rejects(request, { code: 'service-sign-in-required' }); await disconnect;
  assert.throws(() => value.getAssetClient(), { code: 'service-sign-in-required' });
  await assert.rejects(assets.getAsset('film', 'asset-fixture'), { code: 'service-sign-in-required' });
});

test('asset request errors preserve safe protocol codes and update shared offline and revoked state', async t => {
  let code = 'asset-network-unavailable';
  const f = fixture({ createAssetClient: () => ({ async getAsset() { throw error(code); } }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); const assets = value.getAssetClient();
  await assert.rejects(assets.getAsset('film', 'asset'), { code: 'asset-network-unavailable', message: 'asset-network-unavailable' });
  assert.equal(value.getState().status, 'offline'); assert.equal(value.getAssetClient(), assets);
  code = 'asset-chunk-corrupt'; await assert.rejects(assets.getAsset('film', 'asset'), { code, message: code });
  code = 'access-token-invalid'; await assert.rejects(assets.getAsset('film', 'asset'), { code, message: code });
  assert.equal(value.getState().status, 'sign-in-required'); assert.throws(() => value.getAssetClient(), { code: 'service-sign-in-required' });
  assert.doesNotMatch(JSON.stringify(f.events), /\/private\/|access-token-secret/);
});

test('policy and archive private client methods preserve input positions, bound signals and safe permission errors', async t => {
  const calls = [];
  const f = fixture({ createAssetClient: ({ getAccessToken }) => ({
    async getPolicy(pid, options) { await getAccessToken(); calls.push([pid, options.signal]); return { projectId: pid, version: 0, syncClasses: [] }; },
    async setPolicy(pid, input, options) { calls.push([pid, input, options.signal]); throw error('asset-policy-forbidden'); },
    async setArchived(pid, aid, input, options) { calls.push([pid, aid, input, options.signal]); return { archived: input.archived }; }
  }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); const assets = value.getAssetClient();
  await assets.getPolicy('film'); const input = { expectedVersion: 0, syncClasses: ['original'] };
  await assert.rejects(assets.setPolicy('film', input), { code: 'asset-policy-forbidden', message: 'asset-policy-forbidden' });
  const archive = { expectedArchived: false, archived: true }; await assets.setArchived('film', 'asset', archive);
  assert.deepEqual(calls[1].slice(0, 2), ['film', input]); assert.deepEqual(calls[2].slice(0, 3), ['film', 'asset', archive]);
  assert(calls[0][1] instanceof AbortSignal); assert(calls[1][2] instanceof AbortSignal); assert(calls[2][3] instanceof AbortSignal);
  assert.equal(value.getState().status, 'connected'); await value.disconnect(); assert.equal(calls[2][3].aborted, true);
});

test('activity SDK methods bind page/input positions and abort captured feed clients on disconnect', async t => {
  const calls = []; let waiting = null;
  const f = fixture({ clientMethods: ({ getAccessToken }) => ({
    async listActivity(pid, page, options) { calls.push([pid, page, options.signal]);
      if (waiting) { waiting.started.resolve(); await waiting.release.promise; } await getAccessToken();
      return { projectId: pid, items: [], nextCursor: null, unreadCount: null }; },
    async listNotifications(pid, page, options) { calls.push([pid, page, options.signal]); return { projectId: pid, items: [], nextCursor: null, unreadCount: 0 }; },
    async markNotificationRead(pid, id, input, options) { calls.push([pid, id, input, options.signal]); throw error('notification-not-found'); }
  }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); await connect(value); const client = value.getClient();
  const page = { limit: 20, cursor: null }; await client.listActivity('film', page); await client.listNotifications('film', page);
  await assert.rejects(client.markNotificationRead('film', 'event-1', { read: true }), { code: 'notification-not-found', message: 'notification-not-found' });
  assert.deepEqual(calls[0].slice(0, 2), ['film', page]); assert.deepEqual(calls[2].slice(0, 3), ['film', 'event-1', { read: true }]);
  assert(calls[0][2] instanceof AbortSignal); assert(calls[2][3] instanceof AbortSignal);
  waiting = { started: defer(), release: defer() }; const pending = client.listActivity('film', page); await waiting.started.promise;
  const signingOut = value.disconnect(); assert.equal(calls.at(-1)[2].aborted, true); waiting.release.resolve();
  await assert.rejects(pending, { code: 'service-sign-in-required' }); await signingOut;
  await assert.rejects(client.listNotifications('film', page), { code: 'service-sign-in-required' });
  assert.doesNotMatch(JSON.stringify(f.events), /\/private\/|access-token-secret|refresh-token/);
});

test('branch review SDK wrappers preserve 3/1/1/3 input arities and combine external and connection aborts', async t => {
  const calls = []; let waiting = null;
  const f = fixture({ clientMethods: ({ getAccessToken }) => Object.fromEntries([
    ['getBranchReview', 3], ['setBranchProtection', 1], ['requestBranchApproval', 1], ['approveBranchRequest', 3]
  ].map(([name, arity]) => [name, async (...args) => {
    const options = args[arity]; calls.push({ name, args: args.slice(0, arity), signal: options.signal });
    if (waiting) {
      waiting.started.resolve(options.signal);
      if (waiting.external) await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(error('sync-cancelled')), { once: true }));
      else await waiting.release.promise;
    }
    await getAccessToken(); return { valid: true };
  }])) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); t.after(() => value.dispose()); await connect(value); const client = value.getClient();
  const page = { limit: 20 }, policy = { projectId: 'film', branch: 'main', expectedVersion: 0, requiredApprovals: 1, idempotencyKey: 'p' },
    proposal = { projectId: 'film', branch: 'main', expectedHead: null, revisionId: 'candidate', policyVersion: 1, idempotencyKey: 'r' };
  await client.getBranchReview('film', 'main', page); await client.setBranchProtection(policy);
  await client.requestBranchApproval(proposal); await client.approveBranchRequest('film', 'main', 'request');
  assert.deepEqual(calls.map(value => value.args), [['film', 'main', page], [policy], [proposal], ['film', 'main', 'request']]);
  assert(calls.every(value => value.signal instanceof AbortSignal));
  waiting = { started: defer(), external: true }; const external = new AbortController(), pending = client.getBranchReview('film', 'main', page, { signal: external.signal });
  const signal = await waiting.started.promise; external.abort(); assert.equal(signal.aborted, true); await assert.rejects(pending, { code: 'sync-cancelled' });
  assert.equal(value.getState().status, 'connected');
  waiting = { started: defer(), release: defer() }; const approving = client.approveBranchRequest('film', 'main', 'request');
  const connectionSignal = await waiting.started.promise, disconnect = value.disconnect(); assert.equal(connectionSignal.aborted, true); waiting.release.resolve();
  await assert.rejects(approving, { code: 'service-sign-in-required' }); await disconnect;
  await assert.rejects(client.requestBranchApproval(proposal), { code: 'service-sign-in-required' });
  assert.doesNotMatch(JSON.stringify(f.events), /token-secret|access-token-secret|\/private\//);
});

test('branch review wrapper preserves only the finite safe branch error catalog', async t => {
  const { BRANCH_REVIEW_ERROR_CODES } = require('../src/branch-review-protocol'); let code;
  const f = fixture({ clientMethods: () => ({ async getBranchReview() { throw error(code); } }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); t.after(() => value.dispose()); await connect(value); const client = value.getClient();
  for (code of BRANCH_REVIEW_ERROR_CODES) await assert.rejects(client.getBranchReview('film', 'main', {}), { code, message: code });
  code = 'branch-review-private-credential-secret';
  await assert.rejects(client.getBranchReview('film', 'main', {}), { code: 'service-connection-failed', message: 'service-connection-failed' });
  assert.equal(value.getState().status, 'connected'); assert.doesNotMatch(JSON.stringify(f.events), /token-secret|credential-secret|\/private\//);
});

test('share SDK wrappers bind 3/1/2 arguments, combine signals and retire captured clients without exposing anonymous redemption', async t => {
  const calls = []; let waiting = null;
  const f = fixture({ clientMethods: ({ getAccessToken }) => ({
    ...Object.fromEntries([['getShareReview', 3], ['createShareLink', 1], ['revokeShareLink', 2]].map(([name, arity]) => [name, async (...args) => {
      const options = args[arity]; calls.push({ name, args: args.slice(0, arity), signal: options.signal });
      if (waiting) {
        waiting.started.resolve(options.signal);
        if (waiting.external) await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(error('sync-cancelled')), { once: true }));
        else await waiting.release.promise;
      }
      await getAccessToken(); return { valid: true };
    }])),
    async redeemShareLink() { throw Error('Anonymous redemption must not join the desktop authenticated facade'); }
  }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); t.after(() => value.dispose()); await connect(value); const client = value.getClient();
  const page = { limit: 20, cursor: null }, input = { projectId: 'film', branch: 'main', expectedHead: 'revision', ttlMs: 3600000, idempotencyKey: 'retry-share' };
  await client.getShareReview('film', 'main', page); await client.createShareLink(input); await client.revokeShareLink('film', 'link');
  assert.deepEqual(calls.map(value => value.args), [['film', 'main', page], [input], ['film', 'link']]);
  assert(calls.every(value => value.signal instanceof AbortSignal)); assert.equal(client.redeemShareLink, undefined);
  waiting = { started: defer(), external: true }; const abort = new AbortController(), listing = client.getShareReview('film', 'main', page, { signal: abort.signal });
  const signal = await waiting.started.promise; abort.abort(); assert.equal(signal.aborted, true); await assert.rejects(listing, { code: 'sync-cancelled' });
  waiting = { started: defer(), release: defer() }; const revoking = client.revokeShareLink('film', 'link');
  const disconnectSignal = await waiting.started.promise, disconnect = value.disconnect(); assert.equal(disconnectSignal.aborted, true); waiting.release.resolve();
  await assert.rejects(revoking, { code: 'service-sign-in-required' }); await disconnect;
  await assert.rejects(client.createShareLink(input), { code: 'service-sign-in-required' });
  assert.doesNotMatch(JSON.stringify(f.events), /token-secret|idempotencyKey|access-token-secret|\/private\//);
});

test('share SDK failures expose only the finite share error catalog and preserve credential privacy', async t => {
  const { SHARE_ERROR_CODES } = require('../src/share-links-protocol'); let code;
  const f = fixture({ clientMethods: () => ({ async getShareReview() { throw error(code); } }) });
  t.mock.method(Date, 'now', () => f.clock); const value = f.make(); t.after(() => value.dispose()); await connect(value); const client = value.getClient();
  for (code of SHARE_ERROR_CODES) await assert.rejects(client.getShareReview('film', 'main', {}), { code, message: code });
  code = 'share-private-token-secret'; await assert.rejects(client.getShareReview('film', 'main', {}), { code: 'service-connection-failed', message: 'service-connection-failed' });
  assert.equal(value.getState().status, 'connected'); assert.doesNotMatch(JSON.stringify(f.events), /token-secret|\/private\//);
});
