const { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } = require('node:crypto');

function fail(code) { const error = new Error(code); error.code = code; return error; }
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw fail('password-invalid');
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: scryptSync(password, salt, 32).toString('base64') };
}
function passwordMatches(password, record) {
  if (typeof password !== 'string' || !record) return false;
  try {
    const actual = scryptSync(password, Buffer.from(record.salt, 'base64'), 32);
    const expected = Buffer.from(record.hash, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function createIdentityService({ now = () => Date.now(), accessTtlMs = 15 * 60_000,
  refreshTtlMs = 30 * 24 * 60 * 60_000, recoveryTtlMs = 30 * 60_000,
  deliverRecovery = async () => {} } = {}) {
  const users = new Map(); const byEmail = new Map(); const sessions = new Map(); const recoveries = new Map();
  function createAccount(email, password) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw fail('account-invalid');
    if (byEmail.has(normalized)) throw fail('account-exists');
    const user = { id: randomUUID(), email: normalized, password: passwordRecord(password), status: 'active', createdAt: now() };
    users.set(user.id, user); byEmail.set(normalized, user.id);
    return { id: user.id, email: user.email };
  }
  function issueSession(userId) {
    const accessToken = token(); const refreshToken = token(); const sessionId = randomUUID(); const issuedAt = now();
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
    if (!session || session.revokedAt || session.accessExpiresAt <= now() || users.get(session.userId)?.status !== 'active') throw fail('access-token-invalid');
    return { userId: session.userId, sessionId: session.id, expiresAt: session.accessExpiresAt };
  }
  function refresh(refreshToken) {
    const hash = digest(String(refreshToken || ''));
    const session = [...sessions.values()].find(item => item.refreshHash === hash);
    if (!session || session.revokedAt || session.refreshExpiresAt <= now() || users.get(session.userId)?.status !== 'active') throw fail('refresh-token-invalid');
    session.revokedAt = now();
    return issueSession(session.userId);
  }
  function signOut(refreshToken) {
    const hash = digest(String(refreshToken || ''));
    const session = [...sessions.values()].find(item => item.refreshHash === hash);
    if (session && !session.revokedAt) session.revokedAt = now();
    return { signedOut: true };
  }
  async function beginRecovery(email) {
    const user = users.get(byEmail.get(String(email || '').trim().toLowerCase()));
    if (user?.status === 'active') {
      const recoveryToken = token();
      recoveries.set(digest(recoveryToken), { userId: user.id, expiresAt: now() + recoveryTtlMs, usedAt: null });
      await deliverRecovery({ userId: user.id, email: user.email, token: recoveryToken });
    }
    return { accepted: true };
  }
  function completeRecovery(recoveryToken, newPassword) {
    const recovery = recoveries.get(digest(String(recoveryToken || '')));
    if (!recovery || recovery.usedAt || recovery.expiresAt <= now()) throw fail('recovery-token-invalid');
    const user = users.get(recovery.userId); if (!user || user.status !== 'active') throw fail('recovery-token-invalid');
    user.password = passwordRecord(newPassword); recovery.usedAt = now();
    for (const session of sessions.values()) if (session.userId === user.id && !session.revokedAt) session.revokedAt = now();
    return { recovered: true };
  }
  function deleteAccount(userId, password) {
    const user = users.get(userId);
    if (!user || user.status !== 'active' || !passwordMatches(password, user.password)) throw fail('credentials-invalid');
    user.status = 'deleted'; user.deletedAt = now(); user.email = null; user.password = null;
    for (const session of sessions.values()) if (session.userId === userId && !session.revokedAt) session.revokedAt = now();
    return { deleted: true, userId };
  }
  function getUser(userId) {
    const user = users.get(userId); return user ? { id: user.id, email: user.email, status: user.status } : null;
  }
  return { createAccount, signIn, authenticate, refresh, signOut, beginRecovery, completeRecovery, deleteAccount, getUser };
}

module.exports = { createIdentityService };
