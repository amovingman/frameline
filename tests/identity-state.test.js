const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityService, validateIdentityState } = require('../src/identity-service');

const password = 'private password for identity';
function fixture() {
  let clock = 0; let recoveryToken;
  const opts = { now: () => clock, accessTtlMs: 10, refreshTtlMs: 100, recoveryTtlMs: 50,
    deliverRecovery: async delivery => { recoveryToken = delivery.token; } };
  const identity = createIdentityService(opts); const user = identity.createAccount('Editor@example.com', password);
  return { identity, user, opts, setTime(value) { clock = value; }, recovery() { return recoveryToken; },
    restore(service = identity) { return createIdentityService({ ...opts, initialState: service.snapshot() }); } };
}

test('identity snapshots preserve sessions and rotating refresh across fresh instances without bearer tokens', () => {
  const { identity, user, restore } = fixture(); const first = identity.signIn('editor@example.com', password);
  const snapshot = identity.snapshot(); const serialized = JSON.stringify(snapshot);
  for (const secret of [password, first.accessToken, first.refreshToken]) assert.equal(serialized.includes(secret), false);
  const restarted = restore(); assert.equal(restarted.authenticate(first.accessToken).userId, user.id);
  const second = restarted.refresh(first.refreshToken); // revokedAt=0 must remain revoked.
  const again = restore(restarted);
  assert.throws(() => again.authenticate(first.accessToken), { code: 'access-token-invalid' });
  assert.throws(() => again.refresh(first.refreshToken), { code: 'refresh-token-invalid' });
  assert.equal(again.authenticate(second.accessToken).userId, user.id);
  again.signOut(second.refreshToken); const signedOut = restore(again);
  assert.throws(() => signedOut.authenticate(second.accessToken), { code: 'access-token-invalid' });
  assert.throws(() => signedOut.refresh(second.refreshToken), { code: 'refresh-token-invalid' });
});

test('pending recovery survives restart and a recovery consumed at time zero remains single-use', async () => {
  const state = fixture(); const first = state.identity.signIn('editor@example.com', password);
  await state.identity.beginRecovery('EDITOR@example.com'); const token = state.recovery();
  assert.equal(JSON.stringify(state.identity.snapshot()).includes(token), false);
  const restored = state.restore(); restored.completeRecovery(token, 'a changed private password');
  const consumed = state.restore(restored);
  assert.throws(() => consumed.completeRecovery(token, 'another changed password'), { code: 'recovery-token-invalid' });
  assert.throws(() => consumed.authenticate(first.accessToken), { code: 'access-token-invalid' });
  assert.throws(() => consumed.signIn('editor@example.com', password), { code: 'credentials-invalid' });
  assert.ok(consumed.signIn('editor@example.com', 'a changed private password').accessToken);
});

test('access, refresh and recovery expiration retain exact boundary behavior after restart', async () => {
  const state = fixture(); const session = state.identity.signIn('editor@example.com', password);
  await state.identity.beginRecovery('editor@example.com'); state.setTime(10);
  assert.throws(() => state.restore().authenticate(session.accessToken), { code: 'access-token-invalid' });
  state.setTime(50);
  assert.throws(() => state.restore().completeRecovery(state.recovery(), 'changed private password'), { code: 'recovery-token-invalid' });
  state.setTime(100);
  assert.throws(() => state.restore().refresh(session.refreshToken), { code: 'refresh-token-invalid' });
});

test('deletion erases password and email, revokes credentials and permits consistent email reuse', async () => {
  const state = fixture(); const session = state.identity.signIn('editor@example.com', password);
  await state.identity.beginRecovery('editor@example.com'); state.identity.deleteAccount(state.user.id, password);
  const snapshot = state.identity.snapshot(); assert.equal(JSON.stringify(snapshot).includes('editor@example.com'), false);
  assert.deepEqual(snapshot.users[0], { id: state.user.id, email: null, password: null, status: 'deleted', createdAt: 0, deletedAt: 0 });
  const liveReplacement = state.identity.createAccount('editor@example.com', password); assert.notEqual(liveReplacement.id, state.user.id);
  const restarted = createIdentityService({ ...state.opts, initialState: snapshot });
  const restartedReplacement = restarted.createAccount('editor@example.com', password); assert.notEqual(restartedReplacement.id, state.user.id);
  assert.throws(() => restarted.authenticate(session.accessToken), { code: 'access-token-invalid' });
  assert.throws(() => restarted.refresh(session.refreshToken), { code: 'refresh-token-invalid' });
  assert.throws(() => restarted.completeRecovery(state.recovery(), 'changed private password'), { code: 'recovery-token-invalid' });
});

test('both imported and exported state are deep copies', () => {
  const state = fixture(); const session = state.identity.signIn('editor@example.com', password); const snapshot = state.identity.snapshot();
  const restarted = createIdentityService({ ...state.opts, initialState: snapshot }); snapshot.users[0].status = 'deleted'; snapshot.sessions[0].accessHash = '0'.repeat(64);
  assert.equal(restarted.authenticate(session.accessToken).userId, state.user.id);
  const checked = validateIdentityState(restarted.snapshot()); checked.users[0].password.hash = 'tampered';
  assert.ok(restarted.signIn('editor@example.com', password).accessToken);
});

test('schema validation rejects future versions, raw secrets, collisions, broken references and invalid invariants', async () => {
  const state = fixture(); state.identity.signIn('editor@example.com', password); await state.identity.beginRecovery('editor@example.com');
  const original = state.identity.snapshot();
  const mutations = [
    value => { value.schemaVersion = 2; }, value => { value.accessToken = 'raw-secret'; },
    value => { value.users[0].password.rawPassword = password; }, value => { value.sessions[0].refreshToken = 'raw-secret'; },
    value => { value.recoveries[0].token = 'raw-secret'; }, value => { value.users.push(structuredClone(value.users[0])); },
    value => { value.users.push({ ...structuredClone(value.users[0]), id: '00000000-0000-0000-0000-000000000001' }); },
    value => { value.users[0].email = 'Editor@example.com'; }, value => { value.users[0].password.salt = 'bad base64'; },
    value => { value.users[0].createdAt = -1; }, value => { value.users[0].deletedAt = 0; },
    value => { value.sessions.push(structuredClone(value.sessions[0])); }, value => { value.sessions[0].userId = 'unknown'; },
    value => { value.sessions[0].refreshHash = value.sessions[0].accessHash; }, value => { value.sessions[0].accessHash = 'bad hash'; },
    value => { value.sessions[0].revokedAt = -1; }, value => { value.sessions[0].accessExpiresAt = 101; },
    value => { value.recoveries[0].tokenHash = value.sessions[0].accessHash; }, value => { value.recoveries[0].userId = 'unknown'; },
    value => { value.recoveries[0].usedAt = -1; }, value => { value.recoveries[0].usedAt = value.recoveries[0].expiresAt; },
    value => { value.users[0].status = 'deleted'; value.users[0].email = null; value.users[0].password = null; value.users[0].deletedAt = 0; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => createIdentityService({ ...state.opts, initialState: value }), { code: 'identity-state-invalid' });
  }
});

test('deleted-state imports reject sessions and recovery consumption dated after deletion', async () => {
  const state = fixture(); state.identity.signIn('editor@example.com', password); await state.identity.beginRecovery('editor@example.com');
  state.identity.deleteAccount(state.user.id, password); const original = state.identity.snapshot();
  for (const mutate of [value => { value.sessions[0].revokedAt = 1; }, value => { value.recoveries[0].usedAt = 1; }]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => validateIdentityState(value), { code: 'identity-state-invalid' });
  }
});

test('invalid clocks, TTLs and bounded arrays are rejected before import or issuance', () => {
  for (const opts of [{ now: 1 }, { now: () => -1 }, { now: () => NaN }, { accessTtlMs: 0 },
    { refreshTtlMs: Number.MAX_SAFE_INTEGER }, { accessTtlMs: 200, refreshTtlMs: 100 }, { deliverRecovery: null }]) {
    assert.throws(() => createIdentityService(opts));
  }
  assert.throws(() => validateIdentityState({ schemaVersion: 1, users: Array(10001).fill(null), sessions: [], recoveries: [] }), { code: 'identity-state-invalid' });
  const state = fixture(); state.setTime(NaN);
  assert.throws(() => state.identity.signIn('editor@example.com', password), { code: 'identity-clock-invalid' });
});
