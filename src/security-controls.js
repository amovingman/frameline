const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

function fail(code) { const error = new Error(code); error.code = code; return error; }
function requireSecureTransport(url) {
  let parsed; try { parsed = new URL(url); } catch { throw fail('secure-transport-required'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw fail('secure-transport-required');
  return { secure: true, origin: parsed.origin };
}
function createKeyring(keys, activeKeyId) {
  const map = new Map(Object.entries(keys || {}));
  if (!map.size || !map.has(activeKeyId) || [...map.values()].some(key => !Buffer.isBuffer(key) || key.length !== 32)) throw fail('keyring-invalid');
  function encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', map.get(activeKeyId), iv);
    const bytes = Buffer.from(JSON.stringify(value)); const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { version: 1, keyId: activeKeyId, algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  }
  function decrypt(record) {
    if (!record || record.version !== 1 || record.algorithm !== 'aes-256-gcm' || !map.has(record.keyId)) throw fail('encrypted-record-invalid');
    try {
      const decipher = createDecipheriv('aes-256-gcm', map.get(record.keyId), Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw fail('encrypted-record-invalid'); }
  }
  function rotate(record) { const value = decrypt(record); return record.keyId === activeKeyId ? structuredClone(record) : encrypt(value); }
  return { activeKeyId, encrypt, decrypt, rotate };
}
function createRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw fail('rate-limit-invalid');
  const buckets = new Map();
  return function check(key) {
    if (typeof key !== 'string' || !key) throw fail('rate-limit-key-invalid');
    const at = now(); let bucket = buckets.get(key);
    if (!bucket || at >= bucket.resetAt) { bucket = { count: 0, resetAt: at + windowMs }; buckets.set(key, bucket); }
    bucket.count += 1;
    if (bucket.count > limit) throw fail('rate-limit-exceeded');
    return { remaining: limit - bucket.count, resetAt: bucket.resetAt };
  };
}
function createAuditTrail({ now = () => Date.now() } = {}) {
  const events = [];
  function record({ actorId, action, projectId = null, outcome, requestId }) {
    if (![actorId, action, outcome, requestId].every(value => typeof value === 'string' && value)) throw fail('audit-event-invalid');
    const previousHash = events.at(-1)?.hash || '0'.repeat(64);
    const event = { sequence: events.length + 1, at: now(), actorId: createHash('sha256').update(actorId).digest('hex'),
      action, projectId, outcome, requestId, previousHash };
    event.hash = fingerprint(event); events.push(Object.freeze(event)); return structuredClone(event);
  }
  function list() { return events.map(event => structuredClone(event)); }
  function verify() { return events.every((event, index) => event.previousHash === (events[index - 1]?.hash || '0'.repeat(64))
    && event.hash === fingerprint(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')))); }
  return { record, list, verify };
}
async function deleteAccountFlow({ userId, password, identity, access, audit, requestId }) {
  const plan = access.accountRemovalPlan(userId);
  if (!plan.ready) throw fail('ownership-transfer-required');
  const result = identity.deleteAccount(userId, password); access.removeUser(userId);
  audit.record({ actorId: userId, action: 'account.delete', outcome: 'success', requestId });
  return result;
}

module.exports = { requireSecureTransport, createKeyring, createRateLimiter, createAuditTrail, deleteAccountFlow };
