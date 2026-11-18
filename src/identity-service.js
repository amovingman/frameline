const { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } = require('node:crypto');

function fail(code) { const error = new Error(code); error.code = code; return error; }
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_TIME = 8_640_000_000_000_000;
const MAX_TTL_MS = 366 * 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const normalizedEmail = value => typeof value === 'string' && value.length <= 254
  && value === value.trim().toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  && !/[\x00-\x1f\x7f]/.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const canonicalBase64 = (value, length) => typeof value === 'string' && Buffer.from(value, 'base64').length === length
  && Buffer.from(value, 'base64').toString('base64') === value;

function validateIdentityState(value) {
  const invalid = () => { throw fail('identity-state-invalid'); };
  if (!exact(value, ['schemaVersion', 'users', 'sessions', 'recoveries']) || value.schemaVersion !== 1
    || !Array.isArray(value.users) || value.users.length > 10_000
    || !Array.isArray(value.sessions) || value.sessions.length > 100_000
    || !Array.isArray(value.recoveries) || value.recoveries.length > 100_000) invalid();
  const users = new Map(); const emails = new Set(); const sessionIds = new Set(); const hashes = new Set();
  const uniqueHash = hash => {
    if (typeof hash !== 'string' || !HASH.test(hash) || hashes.has(hash)) invalid(); hashes.add(hash);
  };
  for (const user of value.users) {
    if (!exact(user, ['id', 'email', 'password', 'status', 'createdAt', 'deletedAt'])
      || typeof user.id !== 'string' || !UUID.test(user.id) || users.has(user.id) || !timestamp(user.createdAt)) invalid();
    if (user.status === 'active') {
      if (!normalizedEmail(user.email) || emails.has(user.email) || user.deletedAt !== null
        || !exact(user.password, ['salt', 'hash']) || !canonicalBase64(user.password.salt, 16)
        || !canonicalBase64(user.password.hash, 32)) invalid();
      emails.add(user.email);
    } else if (user.status !== 'deleted' || user.email !== null || user.password !== null
      || !timestamp(user.deletedAt) || user.deletedAt < user.createdAt) invalid();
    users.set(user.id, user);
  }
  for (const session of value.sessions) {
    if (!exact(session, ['id', 'userId', 'accessHash', 'refreshHash', 'accessExpiresAt', 'refreshExpiresAt', 'revokedAt'])
      || typeof session.id !== 'string' || !UUID.test(session.id) || sessionIds.has(session.id)
      || !users.has(session.userId) || !timestamp(session.accessExpiresAt) || !timestamp(session.refreshExpiresAt)
      || session.accessExpiresAt > session.refreshExpiresAt
      || session.accessExpiresAt <= users.get(session.userId).createdAt
      || (session.revokedAt !== null && (!timestamp(session.revokedAt) || session.revokedAt < users.get(session.userId).createdAt))
      || (users.get(session.userId).status === 'deleted' && (session.revokedAt === null
        || session.revokedAt > users.get(session.userId).deletedAt))) invalid();
    sessionIds.add(session.id); uniqueHash(session.accessHash); uniqueHash(session.refreshHash);
  }
  for (const recovery of value.recoveries) {
    if (!exact(recovery, ['tokenHash', 'userId', 'expiresAt', 'usedAt']) || !users.has(recovery.userId)
      || !timestamp(recovery.expiresAt) || recovery.expiresAt <= users.get(recovery.userId).createdAt
      || (recovery.usedAt !== null && (!timestamp(recovery.usedAt) || recovery.usedAt < users.get(recovery.userId).createdAt))
      || (users.get(recovery.userId).status === 'active' && recovery.usedAt !== null && recovery.usedAt >= recovery.expiresAt)
      || (users.get(recovery.userId).status === 'deleted' && (recovery.usedAt === null
        || recovery.usedAt > users.get(recovery.userId).deletedAt))) invalid();
    uniqueHash(recovery.tokenHash);
  }
  return structuredClone(value);
}
function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw fail('password-invalid');
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: scryptSync(password, salt, 32).toString('base64') };
}
function passwordMatches(password, record) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || !record) return false;
  try {
    const actual = scryptSync(password, Buffer.from(record.salt, 'base64'), 32);
    const expected = Buffer.from(record.hash, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function createIdentityService({ now = () => Date.now(), accessTtlMs = 15 * 60_000,
  refreshTtlMs = 30 * 24 * 60 * 60_000, recoveryTtlMs = 30 * 60_000,
  deliverRecovery = async () => {}, initialState = null } = {}) {
  if (typeof now !== 'function' || typeof deliverRecovery !== 'function'
    || ![accessTtlMs, refreshTtlMs, recoveryTtlMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TTL_MS)
    || accessTtlMs > refreshTtlMs) throw fail('identity-options-invalid');
  function time() { const value = now(); if (!timestamp(value) || value > MAX_TIME - Math.max(accessTtlMs, refreshTtlMs, recoveryTtlMs)) throw fail('identity-clock-invalid'); return value; }
  time();
  const state = initialState === null ? { schemaVersion: 1, users: [], sessions: [], recoveries: [] } : validateIdentityState(initialState);
  const users = new Map(state.users.map(user => [user.id, user]));
  const byEmail = new Map(state.users.filter(user => user.status === 'active').map(user => [user.email, user.id]));
  const sessions = new Map(state.sessions.map(session => [session.id, session]));
  const recoveries = new Map(state.recoveries.map(({ tokenHash, ...recovery }) => [tokenHash, recovery]));
  function createAccount(email, password) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail(normalized)) throw fail('account-invalid');
    if (byEmail.has(normalized)) throw fail('account-exists');
    if (users.size >= 10_000) throw fail('identity-capacity-exceeded');
    const user = { id: randomUUID(), email: normalized, password: passwordRecord(password), status: 'active', createdAt: time(), deletedAt: null };
    users.set(user.id, user); byEmail.set(normalized, user.id);
    return { id: user.id, email: user.email };
  }
  function issueSession(userId) {
    if (sessions.size >= 100_000) throw fail('identity-capacity-exceeded');
    const accessToken = token(); const refreshToken = token(); const sessionId = randomUUID(); const issuedAt = time();
    sessions.set(sessionId, { id: sessionId, userId, accessHash: digest(accessToken), refreshHash: digest(refreshToken),
      accessExpiresAt: issuedAt + accessTtlMs, refreshExpiresAt: issuedAt + refreshTtlMs, revokedAt: null });
    return { sessionId, accessToken, refreshToken, accessExpiresAt: issuedAt + accessTtlMs,
      refreshExpiresAt: issuedAt + refreshTtlMs };
  }
  function signIn(email, password) {
    const user = users.get(byEmail.get(String(email || '').trim().toLowerCase()));
    if (!user || user.status !== 'active' || !passwordMatches(password, user.password)) throw fail('credentials-invalid');
    return issueSession(user.id);
  }
  function authenticate(accessToken) {
    const hash = digest(String(accessToken || ''));
    const session = [...sessions.values()].find(item => item.accessHash === hash);
    if (!session || session.revokedAt !== null || session.accessExpiresAt <= time() || users.get(session.userId)?.status !== 'active') throw fail('access-token-invalid');
    return { userId: session.userId, sessionId: session.id, expiresAt: session.accessExpiresAt };
  }
  function refresh(refreshToken) {
    const hash = digest(String(refreshToken || ''));
    const session = [...sessions.values()].find(item => item.refreshHash === hash);
    if (!session || session.revokedAt !== null || session.refreshExpiresAt <= time() || users.get(session.userId)?.status !== 'active') throw fail('refresh-token-invalid');
    if (sessions.size >= 100_000) throw fail('identity-capacity-exceeded');
    session.revokedAt = time();
    return issueSession(session.userId);
  }
  function signOut(refreshToken) {
    const hash = digest(String(refreshToken || ''));
    const session = [...sessions.values()].find(item => item.refreshHash === hash);
    if (session && session.revokedAt === null) session.revokedAt = time();
    return { signedOut: true };
  }
  async function beginRecovery(email) {
    const user = users.get(byEmail.get(String(email || '').trim().toLowerCase()));
    if (user?.status === 'active') {
      if (recoveries.size >= 100_000) throw fail('identity-capacity-exceeded');
      const recoveryToken = token();
      recoveries.set(digest(recoveryToken), { userId: user.id, expiresAt: time() + recoveryTtlMs, usedAt: null });
      await deliverRecovery({ userId: user.id, email: user.email, token: recoveryToken });
    }
    return { accepted: true };
  }
  function completeRecovery(recoveryToken, newPassword) {
    const recovery = recoveries.get(digest(String(recoveryToken || '')));
    if (!recovery || recovery.usedAt !== null || recovery.expiresAt <= time()) throw fail('recovery-token-invalid');
    const user = users.get(recovery.userId); if (!user || user.status !== 'active') throw fail('recovery-token-invalid');
    const changedAt = time(); user.password = passwordRecord(newPassword); recovery.usedAt = changedAt;
    for (const session of sessions.values()) if (session.userId === user.id && session.revokedAt === null) session.revokedAt = changedAt;
    return { recovered: true };
  }
  function deleteAccount(userId, password) {
    const user = users.get(userId);
    if (!user || user.status !== 'active' || !passwordMatches(password, user.password)) throw fail('credentials-invalid');
    const deletedAt = time(); byEmail.delete(user.email);
    user.status = 'deleted'; user.deletedAt = deletedAt; user.email = null; user.password = null;
    for (const session of sessions.values()) if (session.userId === userId && session.revokedAt === null) session.revokedAt = deletedAt;
    for (const recovery of recoveries.values()) if (recovery.userId === userId && recovery.usedAt === null) recovery.usedAt = deletedAt;
    return { deleted: true, userId };
  }
  function getUser(userId) {
    const user = users.get(userId); return user ? { id: user.id, email: user.email, status: user.status } : null;
  }
  function snapshot() {
    return validateIdentityState({ schemaVersion: 1, users: [...users.values()], sessions: [...sessions.values()],
      recoveries: [...recoveries].map(([tokenHash, recovery]) => ({ tokenHash, ...recovery })) });
  }
  return { createAccount, signIn, authenticate, refresh, signOut, beginRecovery, completeRecovery, deleteAccount, getUser, snapshot };
}

module.exports = { createIdentityService, validateIdentityState };
