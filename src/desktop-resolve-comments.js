'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const { COMMENT_ERROR_CODES, normalizeReviewCommentBody, validateReviewCommentAnchor,
  validateReviewComment, validateReviewCommentsPage } = require('./review-comments-protocol');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SCOPE = ['originHash', 'accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch'];
const ERRORS = new Set([...COMMENT_ERROR_CODES, 'comments-unavailable', 'comments-busy', 'comments-selection-changed',
  'comments-refresh-required', 'comments-display-limit', 'comments-target-too-large', 'comments-local-error',
  'comparison-fetch-required', 'service-resolve-project-required', 'service-resolve-comparison-unsupported',
  'service-project-unavailable', 'service-selection-changed', 'forbidden', 'project-not-found', 'revision-not-found',
  'access-token-invalid', 'service-sign-in-required', 'sync-network-unavailable', 'sync-cancelled',
  'sync-response-invalid', 'sync-response-too-large', 'rate-limit-exceeded', 'service-credential-storage-unavailable']);
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const safeError = error => ERRORS.has(error?.code) ? error.code : 'comments-local-error';

// Only the main process can supply the source-bound fetched revision. Renderer
// commands contain comment intent; they cannot choose an account or revision.
function createDesktopResolveComments({ connection, getTarget, onChange = () => {}, now = Date.now } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof getTarget !== 'function' || typeof onChange !== 'function' || typeof now !== 'function') throw fail('comments-invalid');
  const empty = () => ({ scopeId: null, target: null, role: null, timelines: [], available: false, ready: false,
    busy: false, error: null, items: [], nextCursor: null, total: null, openCount: null, postingAvailable: false,
    outcome: null, lastUpdatedAt: null });
  let state = { version: 0, ...empty() }, key = null, epoch = 0, active = null, closed = false;
  let pendingPost = null, scopeQueue = Promise.resolve();
  const tasks = new Set();
  const track = task => { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; };
  function publish(update) {
    state = { ...state, ...update, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* The view cannot undo a receipt. */ }
    return clone(state);
  }
  function accountKey() {
    const value = connection.getState();
    return ['connected', 'offline'].includes(value.status) && value.origin && ID.test(value.account?.id || '')
      ? fingerprint([value.origin, value.account.id]) : null;
  }
  let previousAccount = accountKey();
  function reset(keepRetry = false) {
    epoch++; active?.controller.abort(); active = null; if (!keepRetry) pendingPost = null; key = null;
    publish(empty());
  }
  function selection() {
    const task = scopeQueue.then(async () => {
      const target = await getTarget(), account = connection.getState();
      if (!target || !['connected', 'offline'].includes(account.status) || !account.origin || !ID.test(account.account?.id || '')) return null;
      const scope = Object.fromEntries(SCOPE.map(field => [field, target.scope?.[field]]));
      if (!/^[a-f0-9]{64}$/.test(scope.originHash || '') || SCOPE.slice(1).some(field => !ID.test(scope[field] || ''))
        || scope.originHash !== fingerprint(account.origin) || scope.accountId !== account.account.id) throw fail('comments-selection-changed');
      const project = account.projects?.find(item => item.id === scope.remoteProjectId && item.branches.includes(scope.remoteBranch));
      if (!project || target.role !== project.role || !['owner', 'editor', 'viewer'].includes(project.role)) return null;
      validateResolveRevisionManifest(target.manifest);
      const manifestHash = fingerprint(target.manifest), revision = target.revision;
      if (!revision || revision.projectId !== scope.remoteProjectId || !ID.test(revision.id || '')
        || revision.manifestId !== `sha256:${manifestHash}` || typeof revision.message !== 'string'
        || !Number.isSafeInteger(target.checkedAt) || target.checkedAt < 0) throw fail('comments-selection-changed');
      const snapshot = target.manifest.snapshot;
      if (snapshot.timelines.length > 2000 || snapshot.timelines.reduce((sum, timeline) => sum + timeline.items.length, 0) > 20000) {
        throw fail('comments-target-too-large');
      }
      const timelines = snapshot.timelines.map(timeline => ({ id: timeline.id, name: timeline.name,
        startFrame: timeline.start_frame, endFrame: timeline.items.reduce((end, item) => Math.max(end, item.end_frame), timeline.start_frame),
        clips: timeline.items.map(item => ({ id: item.id, name: item.name, startFrame: item.start_frame, endFrame: item.end_frame })) }));
      const requestScope = fingerprint({ scope, revisionId: revision.id, manifestHash });
      return { scope, role: project.role, requestScope, key: fingerprint({ requestScope, role: project.role }),
        target: { serviceProjectId: scope.remoteProjectId, revisionId: revision.id, revisionMessage: revision.message,
          fetchedAt: target.checkedAt, manifestSha256: manifestHash }, timelines, connected: account.status === 'connected' };
    });
    scopeQueue = task.catch(() => {}); return task;
  }
  async function align() {
    let ctx = null, failure = null;
    try { ctx = await selection(); } catch (error) { failure = safeError(error); }
    if (closed) return null;
    if ((ctx?.key || null) !== key || failure && state.scopeId) {
      reset(!!ctx && pendingPost?.scope === ctx.requestScope); key = ctx?.key || null;
      publish({ scopeId: key, available: !!ctx, target: ctx?.target || null, role: ctx?.role || null,
        timelines: ctx?.timelines || [], error: failure });
    } else if (failure && failure !== state.error) publish({ error: failure });
    else if (ctx && (state.target.fetchedAt !== ctx.target.fetchedAt
      || state.postingAvailable !== (state.ready && ctx.connected && ctx.role !== 'viewer'))) {
      publish({ target: ctx.target, postingAvailable: state.ready && ctx.connected && ctx.role !== 'viewer' });
    }
    return ctx;
  }
  async function current(operation) {
    const ctx = await align();
    if (closed || !ctx || operation.key !== ctx.key || operation.epoch !== epoch
      || active !== operation || operation.controller.signal.aborted) throw fail('comments-selection-changed');
    return ctx;
  }
  function checkAnchor(ctx, value) {
    const anchor = validateReviewCommentAnchor(value), timeline = ctx.timelines.find(item => item.id === anchor.timelineId);
    if (!timeline || (anchor.kind === 'clip' ? !timeline.clips.some(item => item.id === anchor.clipId)
      : anchor.startFrame < timeline.startFrame || anchor.endFrame > timeline.endFrame)) throw fail('comment-anchor-unverified');
    return anchor;
  }
  function errorState(error) {
    const code = safeError(error);
    if (['forbidden', 'project-not-found', 'revision-not-found', 'access-token-invalid', 'service-sign-in-required'].includes(code)) {
      publish({ ready: false, items: [], total: null, openCount: null, nextCursor: null, postingAvailable: false, error: code });
    } else publish({ error: code });
  }
  async function firstPage(operation, client, ctx) {
    const page = validateReviewCommentsPage(await client.listReviewComments(ctx.scope.remoteProjectId, ctx.target.revisionId,
      { limit: 20, cursor: null }, { signal: operation.controller.signal }), ctx.scope.remoteProjectId, ctx.target.revisionId, { limit: 20 });
    for (const item of page.items) checkAnchor(ctx, item.anchor);
    const currentCtx = await current(operation), at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw fail('comments-local-error');
    publish({ items: page.items, nextCursor: page.nextCursor, total: page.total, openCount: page.openCount,
      ready: true, postingAvailable: currentCtx.connected && currentCtx.role !== 'viewer', lastUpdatedAt: at, error: null });
  }
  function run(action) {
    return track((async () => {
      let operation;
      try {
        if (closed) throw fail('comments-unavailable');
        const ctx = await align(); if (!ctx) throw fail('comments-unavailable');
        if (active) throw fail('comments-busy');
        operation = { key: ctx.key, epoch, controller: new AbortController() }; active = operation;
        publish({ busy: true, error: null, outcome: null });
        await action(operation, connection.getClient(), ctx);
      } catch (error) {
        if (operation && active === operation && operation.epoch === epoch && !closed) {
          try { await current(operation); errorState(error); } catch { /* New scope owns the view. */ }
        } else if (!operation && !active && !closed) errorState(error);
      } finally {
        if (operation && active === operation) { active = null; if (!closed) publish({ busy: false }); }
      }
      return clone(state);
    })());
  }
  function refresh(append = false) {
    return run(async (operation, client, ctx) => {
      if (typeof append !== 'boolean') throw fail('comments-invalid');
      if (!append) return firstPage(operation, client, ctx);
      const cursor = state.nextCursor, previous = clone(state.items);
      if (!state.ready || !cursor || previous.length >= 500) throw fail('comments-display-limit');
      const page = validateReviewCommentsPage(await client.listReviewComments(ctx.scope.remoteProjectId, ctx.target.revisionId,
        { limit: 20, cursor }, { signal: operation.controller.signal }), ctx.scope.remoteProjectId, ctx.target.revisionId, { limit: 20 });
      if (page.nextCursor === cursor || page.items.some(item => previous.some(old => old.id === item.id))) throw fail('sync-response-invalid');
      for (const item of page.items) checkAnchor(ctx, item.anchor);
      await current(operation);
      const capped = previous.length + page.items.length >= 500 && page.nextCursor !== null;
      publish({ items: [...previous, ...page.items].slice(0, 500), nextCursor: capped ? null : page.nextCursor,
        total: page.total, openCount: page.openCount, error: capped ? 'comments-display-limit' : null });
    });
  }
  function add(input) {
    return run(async (operation, client, ctx) => {
      if (!exact(input, ['scopeId', 'anchor', 'body'])) throw fail('comments-invalid');
      if (input.scopeId !== ctx.key) throw fail('comments-selection-changed');
      if (!state.ready) throw fail('comments-refresh-required');
      if (ctx.role === 'viewer') throw fail('forbidden');
      const anchor = checkAnchor(ctx, input.anchor), body = normalizeReviewCommentBody(input.body), requestHash = fingerprint({ anchor, body });
      if (!pendingPost || pendingPost.scope !== ctx.requestScope || pendingPost.requestHash !== requestHash) {
        pendingPost = { scope: ctx.requestScope, requestHash, idempotencyKey: `comment-${randomUUID()}` };
      }
      const posted = validateReviewComment(await client.addReviewComment({ projectId: ctx.scope.remoteProjectId,
        revisionId: ctx.target.revisionId, anchor, body, idempotencyKey: pendingPost.idempotencyKey }, { signal: operation.controller.signal }),
      { projectId: ctx.scope.remoteProjectId, revisionId: ctx.target.revisionId, anchor, body });
      if (posted.authorId !== ctx.scope.accountId) throw fail('sync-response-invalid');
      await current(operation); pendingPost = null;
      publish({ outcome: { kind: 'added', commentId: posted.id }, ready: false, postingAvailable: false,
        items: [posted, ...state.items.filter(item => item.id !== posted.id)].slice(0, 500), nextCursor: null, total: null, openCount: null });
      await firstPage(operation, client, ctx);
    });
  }
  function resolve(commentId) {
    return run(async (operation, client, ctx) => {
      const item = state.items.find(value => value.id === commentId);
      if (!state.ready || !ID.test(commentId || '') || !item || !item.canResolve) throw fail('comment-not-found');
      const resolved = validateReviewComment(await client.resolveReviewComment(ctx.scope.remoteProjectId, ctx.target.revisionId,
        commentId, { signal: operation.controller.signal }), { projectId: ctx.scope.remoteProjectId, revisionId: ctx.target.revisionId,
        commentId, anchor: item.anchor, body: item.body });
      checkAnchor(ctx, resolved.anchor);
      if (resolved.status !== 'resolved' || resolved.authorId !== item.authorId || resolved.createdAt !== item.createdAt) throw fail('sync-response-invalid');
      await current(operation);
      publish({ outcome: { kind: 'resolved', commentId }, ready: false, postingAvailable: false,
        items: state.items.map(value => value.id === commentId ? resolved : value), nextCursor: null, total: null, openCount: null });
      await firstPage(operation, client, ctx);
    });
  }
  function getState() { return track((async () => { if (!closed) await align(); return clone(state); })()); }
  function selectionChanged() { return getState(); }
  function connectionChanged() {
    const next = accountKey();
    if (!closed && next !== previousAccount) { previousAccount = next; reset(); }
    return getState();
  }
  async function dispose() {
    closed = true; epoch++; active?.controller.abort(); active = null; pendingPost = null;
    state = { version: state.version + 1, ...empty() };
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, refresh, add, resolve, selectionChanged, connectionChanged, dispose };
}
module.exports = { createDesktopResolveComments };
