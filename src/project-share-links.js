const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { requireSecureTransport } = require('./security-controls');

function fail(code) { const error = new Error(code); error.code = code; return error; }
const digest = token => createHash('sha256').update(token).digest('hex');

// A link grants access only to one immutable revision. The token is returned once;
// listings and exported state contain its digest, never the bearer secret.
function createProjectShareLinks({ history, access, origin, now = () => Date.now(),
  maxTtlMs = 30 * 24 * 60 * 60_000 } = {}) {
  if (!history || !access || !Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1) throw fail('share-config-invalid');
  const { origin: secureOrigin } = requireSecureTransport(origin);
  const links = new Map();
  function create(actorId, projectId, revisionId, ttlMs) {
    access.authorize(actorId, { projectId, resource: 'members', action: 'write' });
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs) throw fail('share-expiration-invalid');
    const revision = history.getRevision(projectId, revisionId);
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(16).toString('hex');
    const record = { id, projectId, revisionId, manifestId: revision.manifestId,
      permission: 'read', expiresAt: now() + ttlMs, revokedAt: null, tokenHash: digest(token) };
    links.set(id, record);
    return { id, url: `${secureOrigin}/share#token=${token}`, permission: 'read', expiresAt: record.expiresAt };
  }
  function list(actorId, projectId) {
    access.authorize(actorId, { projectId, resource: 'members', action: 'write' });
    return [...links.values()].filter(item => item.projectId === projectId)
      .map(({ tokenHash, ...item }) => ({ ...item, status: item.revokedAt !== null ? 'revoked'
        : item.expiresAt <= now() ? 'expired' : 'active' }));
  }
  function revoke(actorId, projectId, id) {
    access.authorize(actorId, { projectId, resource: 'members', action: 'write' });
    const link = links.get(id);
    if (!link || link.projectId !== projectId) throw fail('share-link-not-found');
    link.revokedAt ||= now(); return { id, revoked: true };
  }
  function read(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('share-link-invalid');
    const supplied = Buffer.from(digest(token), 'hex');
    const link = [...links.values()].find(item => timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), supplied));
    if (!link || link.revokedAt !== null || link.expiresAt <= now()) throw fail('share-link-invalid');
    // Recheck the authoritative record. Project deletion invalidates links.
    if (access.isProjectDeleted?.(link.projectId)) throw fail('share-link-invalid');
    const revision = history.getRevision(link.projectId, link.revisionId);
    const manifest = history.getManifest(link.projectId, link.manifestId);
    return { permission: 'read', projectId: link.projectId, revision, manifest };
  }
  async function copy(actorId, projectId, revisionId, ttlMs, writeText) {
    if (typeof writeText !== 'function') throw fail('clipboard-unavailable');
    const link = create(actorId, projectId, revisionId, ttlMs);
    try { await writeText(link.url); } catch { revoke(actorId, projectId, link.id); throw fail('clipboard-unavailable'); }
    return { id: link.id, permission: link.permission, expiresAt: link.expiresAt, copied: true };
  }
  return { create, list, revoke, read, copy };
}

module.exports = { createProjectShareLinks };
