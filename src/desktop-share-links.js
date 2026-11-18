'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { SHARE_ERROR_CODES, MIN_SHARE_TTL_MS, MAX_SHARE_TTL_MS, validateShareReview,
  validateShareCreation, validateShareLink } = require('./share-links-protocol');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const ERRORS = new Set([...SHARE_ERROR_CODES, 'share-selection-changed', 'share-refresh-required', 'share-links-busy',
  'share-display-limit', 'share-local-error', 'share-clipboard-unavailable', 'share-copy-revoke-required',
  'forbidden', 'project-not-found', 'branch-not-found', 'access-token-invalid', 'service-sign-in-required',
  'service-credential-storage-unavailable', 'sync-network-unavailable', 'service-offline', 'sync-cancelled',
  'sync-response-invalid', 'sync-response-too-large', 'rate-limit-exceeded', 'service-connection-failed']);
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const safeError = error => ERRORS.has(error?.code) ? error.code : 'share-local-error';

// Bearer URLs exist only in this main-process operation and the system clipboard.
// Neither renderer state nor events expose a token or a recoverable copy of one.
function createDesktopShareLinks({ connection, writeClipboard, onChange = () => {}, now = Date.now } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof writeClipboard !== 'function' || typeof onChange !== 'function' || typeof now !== 'function') throw fail('share-links-invalid');
  const empty = () => ({ scopeId: null, selection: null, available: false, ready: false, busy: false, error: null,
    role: null, headRevisionId: null, revision: null, links: [], nextCursor: null, total: null, checkedAt: null, outcome: null });
  let state = { version: 0, ...empty() }, selected = null, identity = null, accessKey = null;
  let epoch = 0, active = null, closed = false, nonce = randomUUID(), pendingCopy = null;
  const tasks = new Set();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* A view failure cannot undo a service receipt. */ }
    return clone(state);
  }
  function context() {
    const account = connection.getState();
    if (!selected || !['connected', 'offline'].includes(account.status) || !account.origin || !ID.test(account.account?.id || '')) return null;
    const project = account.projects?.find(item => item.id === selected.projectId && item.branches?.includes(selected.branch));
    if (!project || !['owner', 'editor', 'viewer'].includes(project.role)) return null;
    let url; try { url = new URL(account.origin); } catch { return null; }
    if (url.protocol !== 'https:' || url.origin !== account.origin || url.username || url.password) return null;
    const id = fingerprint([url.origin, account.account.id, selected.projectId, selected.branch]);
    return { identity: id, key: fingerprint([id, project.role]), actorId: account.account.id,
      origin: url.origin, role: project.role, connected: account.status === 'connected', ...selected };
  }
  function scope(ctx, head = null) { return fingerprint([nonce, ctx.key, head]); }
  function align() {
    const ctx = context();
    if (closed) return null;
    if ((ctx?.key || null) !== accessKey) {
      epoch++; active?.controller.abort(); active = null; nonce = randomUUID();
      if ((ctx?.identity || null) !== identity) pendingCopy = null;
      identity = ctx?.identity || null; accessKey = ctx?.key || null;
      publish({ ...empty(), selection: selected ? clone(selected) : null, available: ctx?.role === 'owner',
        role: ctx?.role || null, scopeId: ctx ? scope(ctx) : null });
    }
    return ctx;
  }
  function current(operation) {
    const ctx = align();
    if (closed || !ctx || ctx.key !== operation.key || epoch !== operation.epoch || active !== operation
      || operation.controller.signal.aborted) throw fail('share-selection-changed');
    return ctx;
  }
  function errorState(error) {
    const code = safeError(error);
    if (['forbidden', 'project-not-found', 'branch-not-found', 'access-token-invalid', 'service-sign-in-required',
      'share-selection-changed', 'share-head-stale', 'share-cursor-invalid'].includes(code)) {
      nonce = randomUUID(); const ctx = context();
      publish({ ready: false, headRevisionId: null, revision: null, links: [], nextCursor: null, total: null,
        checkedAt: null, scopeId: ctx ? scope(ctx) : null, error: code });
    } else publish({ error: code });
  }
  async function page(operation, client, ctx, append = false) {
    const cursor = append ? state.nextCursor : null, previous = append ? clone(state.links) : [];
    if (append && (!state.ready || !cursor || previous.length >= 500)) throw fail('share-display-limit');
    const result = validateShareReview(await client.getShareReview(ctx.projectId, ctx.branch, { limit: 20, cursor },
      { signal: operation.controller.signal }), ctx.projectId, ctx.branch, { limit: 20 });
    current(operation);
    if (append && result.headRevisionId !== state.headRevisionId) throw fail('share-selection-changed');
    if (append && (result.links.nextCursor === cursor || result.links.items.some(item => previous.some(old => old.id === item.id)))) throw fail('sync-response-invalid');
    const items = [...previous, ...result.links.items], capped = items.length >= 500 && result.links.nextCursor !== null;
    const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('share-local-error');
    publish({ ready: true, headRevisionId: result.headRevisionId, revision: result.revision, links: items.slice(0, 500),
      nextCursor: capped ? null : result.links.nextCursor, total: result.links.total, checkedAt: at,
      scopeId: scope(ctx, result.headRevisionId), error: capped ? 'share-display-limit' : null });
  }
  function run(action) { return track((async () => {
    let operation;
    try {
      if (closed) throw fail('share-links-unavailable');
      const ctx = align(); if (!ctx) throw fail('share-links-unavailable');
      if (ctx.role !== 'owner') throw fail('forbidden');
      if (active) throw fail('share-links-busy');
      operation = { key: ctx.key, epoch, controller: new AbortController() }; active = operation;
      publish({ busy: true, error: null, outcome: null });
      await action(operation, connection.getClient(), ctx);
    } catch (error) {
      if (operation && active === operation && epoch === operation.epoch && !closed) {
        try { current(operation); errorState(error); } catch { /* A newer account/selection owns the view. */ }
      } else if (!operation && !active && !closed) errorState(error);
    } finally {
      if (operation && active === operation) { active = null; if (!closed) publish({ busy: false }); }
    }
    return clone(state);
  })()); }
  function intent(ctx, input, fields) {
    if (!exact(input, ['scopeId', ...fields])) throw fail('share-links-invalid');
    if (!state.ready) throw fail('share-refresh-required');
    if (typeof input.scopeId !== 'string' || input.scopeId !== state.scopeId) throw fail('share-selection-changed');
    if (!ctx.connected) throw fail('service-offline');
  }
  function receipt(ctx, outcome) {
    nonce = randomUUID(); publish({ outcome, ready: false, scopeId: scope(ctx, state.headRevisionId) });
  }
  function copyShareLink(input) { return run(async (operation, client, ctx) => {
    intent(ctx, input, ['ttlMs']);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < MIN_SHARE_TTL_MS || input.ttlMs > MAX_SHARE_TTL_MS) throw fail('share-links-invalid');
    const revision = clone(state.revision);
    if (!revision || state.headRevisionId !== revision.id) throw fail('share-revision-unavailable');
    const value = { projectId: ctx.projectId, branch: ctx.branch, expectedHead: revision.id, ttlMs: input.ttlMs };
    const hash = fingerprint({ identity, value });
    if (pendingCopy?.hash !== hash) pendingCopy = { hash, key: randomUUID() };
    const result = validateShareCreation(await client.createShareLink({ ...value, idempotencyKey: pendingCopy.key },
      { signal: operation.controller.signal }), ctx.projectId, { branch: ctx.branch, revisionId: revision.id });
    current(operation);
    const link = result.link;
    if (link.issuerId !== ctx.actorId || link.manifestId !== revision.manifestId || link.revisionMessage !== revision.message
      || link.expiresAt - link.createdAt !== input.ttlMs) throw fail('sync-response-invalid');
    if (link.status !== 'active' || link.expiresAt <= now()) { pendingCopy = null; throw fail('share-link-unavailable'); }
    try {
      // Electron's callback writes synchronously. The awaited adapter also lets
      // tests model a rejected clipboard write without exposing a bearer URL.
      await writeClipboard(`${ctx.origin}/share#${result.token}`);
    } catch {
      pendingCopy = null;
      let revoked = false;
      try {
        const reply = validateShareLink(await client.revokeShareLink(ctx.projectId, link.id,
          { signal: operation.controller.signal }), ctx.projectId, { branch: ctx.branch, linkId: link.id, revisionId: revision.id });
        revoked = reply.status === 'revoked' && reply.revokedAt !== null
          && ['manifestId', 'issuerId', 'createdAt', 'expiresAt', 'revisionMessage'].every(field => reply[field] === link[field]);
      } catch { /* The owner must see that cleanup needs an explicit retry. */ }
      current(operation);
      receipt(ctx, { kind: 'copy-failed', linkId: link.id, revisionId: revision.id, revoked });
      throw fail(revoked ? 'share-clipboard-unavailable' : 'share-copy-revoke-required');
    }
    current(operation); pendingCopy = null;
    receipt(ctx, { kind: 'copied', linkId: link.id, revisionId: revision.id, expiresAt: link.expiresAt });
    await page(operation, client, ctx);
  }); }
  function revokeShareLink(input) { return run(async (operation, client, ctx) => {
    intent(ctx, input, ['linkId']);
    const link = state.links.find(item => item.id === input.linkId);
    if (!ID.test(input.linkId || '') || !link) throw fail('share-link-not-found');
    const result = validateShareLink(await client.revokeShareLink(ctx.projectId, link.id,
      { signal: operation.controller.signal }), ctx.projectId, { branch: ctx.branch, linkId: link.id, revisionId: link.revisionId });
    current(operation);
    if (result.status !== 'revoked' || result.revokedAt === null || ['manifestId', 'issuerId', 'createdAt', 'expiresAt', 'revisionMessage']
      .some(field => result[field] !== link[field])) throw fail('sync-response-invalid');
    receipt(ctx, { kind: 'revoked', linkId: result.id });
    await page(operation, client, ctx);
  }); }
  function selectShareLinks(input) { return track((async () => {
    if (closed) return clone(state);
    if (input !== null && (!exact(input, ['projectId', 'branch']) || !ID.test(input.projectId || '') || !ID.test(input.branch || ''))) {
      errorState(fail('share-links-invalid')); return clone(state);
    }
    const previousIdentity = identity;
    epoch++; active?.controller.abort(); active = null; nonce = randomUUID(); selected = input ? clone(input) : null;
    const next = context(); if (next?.identity !== previousIdentity) pendingCopy = null;
    identity = next?.identity || null; accessKey = null; publish({ ...empty(), selection: selected ? clone(selected) : null }); align();
    return clone(state);
  })()); }
  function getState() { if (!closed) align(); return Promise.resolve(clone(state)); }
  async function dispose() {
    if (closed) return; closed = true; epoch++; active?.controller.abort(); active = null; pendingCopy = null;
    state = { version: state.version + 1, ...empty() };
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, selectShareLinks, copyShareLink, revokeShareLink,
    refreshShareLinks: (input = { append: false }) => run((operation, client, ctx) => {
      if (!exact(input, ['append']) || typeof input.append !== 'boolean') throw fail('share-links-invalid');
      return page(operation, client, ctx, input.append);
    }), connectionChanged: getState, dispose };
}
module.exports = { createDesktopShareLinks };
