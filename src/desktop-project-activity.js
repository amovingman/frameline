'use strict';
const { fingerprint } = require('./project-api-contracts');
const { TYPES } = require('./project-activity');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SCOPE = ['originHash', 'accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch'];
const ERRORS = new Set(['activity-input-invalid', 'activity-unavailable', 'activity-busy', 'activity-selection-changed',
  'activity-display-limit', 'activity-local-error', 'activity-page-invalid', 'activity-cursor-invalid',
  'notification-not-found', 'forbidden', 'project-not-found', 'access-token-invalid', 'service-sign-in-required',
  'service-credential-storage-unavailable', 'service-offline', 'sync-network-unavailable', 'sync-cancelled',
  'sync-response-invalid', 'sync-response-too-large', 'sync-service-failed', 'rate-limit-exceeded']);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const safeActivityError = error => ERRORS.has(error?.code) ? error.code : 'activity-local-error';
function validCursor(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  const pair = value.split('.');
  return pair.length === 2 && pair[1].length === 43 && pair.every(part => /^[A-Za-z0-9_-]+$/.test(part)
    && Buffer.from(part, 'base64url').toString('base64url') === part);
}
function checkedPage(value, projectId, view, limit) {
  if (!exact(value, ['projectId', 'items', 'nextCursor', 'unreadCount']) || value.projectId !== projectId
    || !Array.isArray(value.items) || value.items.length > limit || !validCursor(value.nextCursor)
    || value.nextCursor !== null && value.items.length !== limit
    || (view === 'activity' ? value.unreadCount !== null : !Number.isSafeInteger(value.unreadCount) || value.unreadCount < 0)) {
    throw fail('sync-response-invalid');
  }
  const seen = new Set();
  for (const item of value.items) {
    if (!exact(item, ['id', 'projectId', 'actorId', 'type', 'subjectId', 'at', ...(view === 'inbox' ? ['read'] : [])])
      || !ID.test(item.id || '') || seen.has(item.id) || item.projectId !== projectId || !ID.test(item.actorId || '')
      || !TYPES.has(item.type) || item.subjectId !== null && !ID.test(item.subjectId || '')
      || !Number.isSafeInteger(item.at) || item.at < 0 || item.at > 8_640_000_000_000_000
      || view === 'inbox' && typeof item.read !== 'boolean') throw fail('sync-response-invalid');
    seen.add(item.id);
  }
  if (view === 'inbox' && value.items.filter(item => !item.read).length > value.unreadCount) throw fail('sync-response-invalid');
  return clone(value);
}

// Main-process only. Reading state never performs network I/O. The opt-in watch
// is scoped to this open app session; receipts live on the authenticated service.
function createDesktopProjectActivity({ connection, getSelection, onChange = () => {}, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 30_000 } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof getSelection !== 'function' || typeof onChange !== 'function' || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function' || intervalMs !== 30_000) throw fail('activity-input-invalid');
  let state = { version: 0, scope: null, available: false, status: 'idle', view: 'inbox', items: [], unreadCount: 0,
    nextCursor: null, lastUpdatedAt: null, error: null, watch: false, busy: false };
  let key = null, epoch = 0, active = null, timer = null, closed = false, scopeQueue = Promise.resolve();
  const tasks = new Set();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function publish(update = {}) {
    state = { ...state, ...update, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* The observer cannot undo state. */ }
    return clone(state);
  }
  function stopTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function armTimer() {
    if (closed || !state.watch || !state.scope || !state.available || active) { stopTimer(); return; }
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (!closed && state.watch) void refresh({ view: state.view });
    }, intervalMs);
    timer?.unref?.();
  }
  function selection() { const task = scopeQueue.then(async () => {
    const selected = await getSelection(), value = connection.getState();
    if (!selected || !value.origin || !ID.test(value.account?.id || '') || !['connected', 'offline'].includes(value.status)) return null;
    const scope = Object.fromEntries(SCOPE.map(field => [field, selected[field]]));
    if (!/^[a-f0-9]{64}$/.test(scope.originHash || '') || SCOPE.slice(1).some(field => !ID.test(scope[field] || ''))
      || scope.originHash !== fingerprint(value.origin) || scope.accountId !== value.account.id) return null;
    const project = value.projects?.find(item => item.id === scope.remoteProjectId && item.branches?.includes(scope.remoteBranch));
    return project ? { scope, key: fingerprint(scope), offline: value.status === 'offline' } : null;
  }); scopeQueue = task.catch(() => {}); return task; }
  async function align() {
    let ctx = null, unavailable = false;
    try { ctx = await selection(); } catch { unavailable = true; }
    if (closed) return null;
    if ((ctx?.key || null) !== key || unavailable) {
      epoch++; active?.controller.abort(); active = null; stopTimer(); key = ctx?.key || null;
      publish({ scope: ctx?.scope || null, available: !!ctx, status: unavailable ? 'error' : ctx?.offline ? 'offline' : 'idle', view: 'inbox', items: [],
        unreadCount: 0, nextCursor: null, lastUpdatedAt: null, error: unavailable ? 'activity-unavailable' : null, watch: false, busy: false });
    } else if (!!ctx !== state.available) publish({ available: !!ctx });
    return ctx;
  }
  async function current(operation) {
    const ctx = await align();
    if (closed || !ctx || ctx.key !== operation.key || operation.epoch !== epoch || active !== operation
      || operation.controller.signal.aborted) throw fail('activity-selection-changed');
    return ctx;
  }
  function errorState(error) {
    const code = safeActivityError(error);
    if (['forbidden', 'project-not-found'].includes(code)) {
      stopTimer(); publish({ status: 'access-changed', items: [], unreadCount: 0, nextCursor: null,
        lastUpdatedAt: null, watch: false, error: code });
    } else if (['access-token-invalid', 'service-sign-in-required', 'service-credential-storage-unavailable'].includes(code)) {
      stopTimer(); publish({ status: 'error', items: [], unreadCount: 0, nextCursor: null, lastUpdatedAt: null, watch: false, error: code });
    } else publish({ status: ['service-offline', 'sync-network-unavailable'].includes(code) ? 'offline' : 'error', error: code });
  }
  function run(action) { return track((async () => {
    let operation;
    try {
      if (closed) throw fail('activity-unavailable');
      const ctx = await align(); if (!ctx) throw fail('activity-unavailable');
      if (active) throw fail('activity-busy');
      operation = { key: ctx.key, epoch, controller: new AbortController() }; active = operation; stopTimer();
      publish({ busy: true, status: 'loading', error: null });
      await action(operation, connection.getClient(), ctx);
    } catch (error) {
      if (operation && active === operation && operation.epoch === epoch && !closed) {
        try { await current(operation); errorState(error); } catch { /* Changed scope owns the replacement state. */ }
      } else if (!operation && !active && !closed && safeActivityError(error) !== 'activity-selection-changed') errorState(error);
    } finally {
      if (active === operation && operation) { active = null; if (!closed) publish({ busy: false }); armTimer(); }
    }
    return clone(state);
  })()); }
  function refresh(input = { view: state.view }) {
    return run(async (operation, client, ctx) => {
      if (!exact(input, ['view']) || !['inbox', 'activity'].includes(input.view)) throw fail('activity-input-invalid');
      const view = input.view, options = { signal: operation.controller.signal };
      const page = checkedPage(await client[view === 'inbox' ? 'listNotifications' : 'listActivity'](
        ctx.scope.remoteProjectId, { limit: 20, cursor: null }, options), ctx.scope.remoteProjectId, view, 20);
      let unreadCount = page.unreadCount;
      if (view === 'activity') unreadCount = checkedPage(await client.listNotifications(ctx.scope.remoteProjectId,
        { limit: 1, cursor: null }, options), ctx.scope.remoteProjectId, 'inbox', 1).unreadCount;
      await current(operation);
      const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('activity-local-error');
      publish({ view, items: page.items, nextCursor: page.nextCursor, unreadCount, lastUpdatedAt: at, status: 'ready', error: null });
    });
  }
  function loadOlder() {
    return run(async (operation, client, ctx) => {
      const cursor = state.nextCursor, view = state.view, previous = clone(state.items);
      if (!cursor || previous.length >= 500) throw fail('activity-display-limit');
      const page = checkedPage(await client[view === 'inbox' ? 'listNotifications' : 'listActivity'](
        ctx.scope.remoteProjectId, { limit: 20, cursor }, { signal: operation.controller.signal }), ctx.scope.remoteProjectId, view, 20);
      if (page.nextCursor === cursor || page.items.some(item => previous.some(old => old.id === item.id))) throw fail('sync-response-invalid');
      await current(operation);
      const items = [...previous, ...page.items], capped = items.length >= 500 && page.nextCursor !== null;
      publish({ items: items.slice(0, 500), nextCursor: capped ? null : page.nextCursor,
        unreadCount: view === 'inbox' ? page.unreadCount : state.unreadCount,
        status: 'ready', error: capped ? 'activity-display-limit' : null });
    });
  }
  function markRead(eventId) {
    return run(async (operation, client, ctx) => {
      if (!ID.test(eventId || '') || state.view !== 'inbox') throw fail('activity-input-invalid');
      const item = state.items.find(value => value.id === eventId); if (!item) throw fail('notification-not-found');
      if (!item.read) {
        const result = await client.markNotificationRead(ctx.scope.remoteProjectId, eventId, { read: true }, { signal: operation.controller.signal });
        if (!exact(result, ['eventId', 'read']) || result.eventId !== eventId || result.read !== true) throw fail('sync-response-invalid');
        await current(operation);
        publish({ items: state.items.map(value => value.id === eventId ? { ...value, read: true } : value),
          unreadCount: Math.max(0, state.unreadCount - 1), status: 'ready', error: null });
      } else publish({ status: 'ready', error: null });
    });
  }
  function getState() { return track((async () => {
    if (!closed) try { await align(); } catch { /* A more recent scope read takes priority. */ }
    return clone(state);
  })()); }
  function setWatch(enabled) { return track((async () => {
    if (closed) return clone(state);
    try {
      if (typeof enabled !== 'boolean') throw fail('activity-input-invalid');
      const ctx = await align(); if (!ctx) throw fail('activity-unavailable');
      publish({ watch: enabled }); armTimer();
    } catch (error) { errorState(error); }
    return clone(state);
  })()); }
  function selectionChanged() { return track((async () => {
    if (!closed) try { await align(); armTimer(); } catch { /* Superseded selection read. */ }
    return clone(state);
  })()); }
  async function dispose() {
    if (closed) return;
    closed = true; epoch++; stopTimer(); active?.controller.abort(); active = null;
    state = { ...state, version: state.version + 1, scope: null, available: false, items: [], unreadCount: 0,
      nextCursor: null, lastUpdatedAt: null, busy: false, watch: false, status: 'idle', error: null };
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, refresh, loadOlder, markRead, setWatch, selectionChanged, connectionChanged: selectionChanged, dispose };
}
module.exports = { createDesktopProjectActivity, safeActivityError };
