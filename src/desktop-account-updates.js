'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { NOTIFICATION_ERROR_CODES, validateAccountNotifications, validateNotificationPreferences } = require('./notification-protocol');

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERRORS = new Set([...NOTIFICATION_ERROR_CODES, 'account-updates-selection-changed', 'account-updates-refresh-required',
  'account-updates-busy', 'account-updates-display-limit', 'account-updates-local-error', 'forbidden', 'project-not-found',
  'access-token-invalid', 'service-sign-in-required', 'service-credential-storage-unavailable', 'sync-network-unavailable',
  'service-offline', 'sync-cancelled', 'sync-response-invalid', 'sync-response-too-large', 'rate-limit-exceeded', 'service-connection-failed']);
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const safeError = error => ERRORS.has(error?.code) ? error.code : 'account-updates-local-error';

// Account notifications are independent of local media and editor selection.
// Feed polling and preference drafts have separate epochs: a background feed
// refresh cannot invalidate a user's pending preference mutation or its receipt.
function createDesktopAccountUpdates({ connection, onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 30_000 } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof onChange !== 'function' || typeof now !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function' || intervalMs !== 30_000) throw fail('notification-invalid');
  const emptyPreference = () => ({ scopeId: null, projectId: null, role: null, ready: false, busy: false, error: null, value: null });
  const emptyFeed = () => ({ scopeId: null, available: false, ready: false, busy: false, error: null,
    items: [], nextCursor: null, unreadCount: 0, filter: 'all', checkedAt: null, watch: false, outcome: null });
  let state = { version: 0, ...emptyFeed(), preference: emptyPreference() };
  let accountKey = null, catalogKey = null, preferenceKey = null, selected = null, pendingSave = null;
  let feedEpoch = 0, preferenceEpoch = 0, feedNonce = randomUUID(), preferenceNonce = randomUUID();
  let activeFeed = null, activePreference = null, timer = null, closed = false;
  const tasks = new Set();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* A view cannot undo a durable receipt. */ }
    return clone(state);
  }
  function prefPublish(patch) { return publish({ preference: { ...state.preference, ...patch } }); }
  function stopTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function armTimer() {
    if (closed || !state.watch || !state.available || activeFeed || timer !== null) return;
    timer = setTimer(() => { timer = null; if (!closed && state.watch) void refreshAccountUpdates({ append: false, filter: state.filter }); }, intervalMs);
    timer?.unref?.();
  }
  function context() {
    const value = connection.getState();
    if (!['connected', 'offline'].includes(value.status) || !ID.test(value.account?.id || '')
      || typeof value.account?.email !== 'string' || !Array.isArray(value.projects)) return null;
    let url; try { url = new URL(value.origin); } catch { return null; }
    if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password) return null;
    const key = fingerprint([value.origin, value.account.id, value.account.email]);
    const catalog = value.projects.map(project => [project.id, project.name, project.role]).sort(([a], [b]) => a.localeCompare(b));
    const project = value.projects.find(item => item.id === selected && ['owner', 'editor', 'viewer'].includes(item.role));
    return { key, catalog: fingerprint(catalog), connected: value.status === 'connected', accountEmail: value.account.email,
      project: project ? { id: project.id, role: project.role } : null,
      preferenceKey: project ? fingerprint([key, project.id, project.role]) : null };
  }
  function feedScope(ctx) { return fingerprint([ctx.key, ctx.catalog, feedNonce]); }
  function prefScope(ctx, version = null) { return ctx.preferenceKey ? fingerprint([ctx.preferenceKey, preferenceNonce, version]) : null; }
  function align() {
    if (closed) return null;
    let ctx = context();
    if ((ctx?.key || null) !== accountKey) {
      feedEpoch++; preferenceEpoch++; activeFeed?.controller.abort(); activePreference?.controller.abort();
      activeFeed = activePreference = null; stopTimer(); pendingSave = null; selected = null;
      accountKey = ctx?.key || null; catalogKey = ctx?.catalog || null; preferenceKey = null;
      feedNonce = randomUUID(); preferenceNonce = randomUUID(); ctx = context();
      publish({ ...emptyFeed(), available: !!ctx, scopeId: ctx ? feedScope(ctx) : null, preference: emptyPreference() });
    } else if ((ctx?.catalog || null) !== catalogKey) {
      feedEpoch++; activeFeed?.controller.abort(); activeFeed = null; stopTimer();
      catalogKey = ctx?.catalog || null; feedNonce = randomUUID();
      publish({ scopeId: ctx ? feedScope(ctx) : null, ready: false, busy: false, error: null,
        items: [], nextCursor: null, unreadCount: 0, checkedAt: null, outcome: null });
    }
    if ((ctx?.preferenceKey || null) !== preferenceKey) {
      preferenceEpoch++; activePreference?.controller.abort(); activePreference = null;
      if (pendingSave?.projectId !== ctx?.project?.id) pendingSave = null;
      preferenceKey = ctx?.preferenceKey || null; preferenceNonce = randomUUID();
      prefPublish({ ...emptyPreference(), projectId: ctx?.project?.id || null, role: ctx?.project?.role || null,
        scopeId: ctx ? prefScope(ctx) : null });
    }
    return ctx;
  }
  function current(operation, preference = false) {
    const ctx = align();
    if (closed || !ctx || operation.key !== ctx.key || operation.controller.signal.aborted
      || (preference ? activePreference !== operation || operation.epoch !== preferenceEpoch
        || operation.preferenceKey !== ctx.preferenceKey : activeFeed !== operation || operation.epoch !== feedEpoch)) throw fail('account-updates-selection-changed');
    return ctx;
  }
  function errorState(error, preference) {
    const code = safeError(error);
    const invalidate = ['forbidden', 'project-not-found', 'access-token-invalid', 'service-sign-in-required',
      'service-credential-storage-unavailable', 'notification-preference-version-conflict', 'notification-cursor-invalid'].includes(code);
    if (preference) prefPublish({ error: code, ...(invalidate ? { ready: false, value: null } : {}) });
    else publish({ error: code, ...(invalidate ? { ready: false, items: [], nextCursor: null, unreadCount: 0, checkedAt: null } : {}) });
  }
  function run(preference, action, mutation = false) { return track((async () => {
    let operation;
    try {
      if (closed) throw fail('notification-unavailable');
      const ctx = align(); if (!ctx) throw fail('notification-unavailable');
      if (preference ? activePreference : activeFeed) throw fail('account-updates-busy');
      operation = { key: ctx.key, epoch: preference ? preferenceEpoch : feedEpoch,
        preferenceKey: ctx.preferenceKey, controller: new AbortController() };
      if (preference) { activePreference = operation; publish({ ...(mutation ? { outcome: null } : {}), preference: { ...state.preference, busy: true, error: null } }); }
      else { activeFeed = operation; stopTimer(); publish({ busy: true, error: null, ...(mutation ? { outcome: null } : {}) }); }
      await action(operation, connection.getClient(), ctx);
    } catch (error) {
      if (operation && (preference ? activePreference : activeFeed) === operation && !closed) {
        try { current(operation, preference); errorState(error, preference); } catch { /* New account/target owns the view. */ }
      } else if (!operation && !(preference ? activePreference : activeFeed) && !closed) errorState(error, preference);
    } finally {
      if (operation && (preference ? activePreference : activeFeed) === operation) {
        if (preference) { activePreference = null; if (!closed) prefPublish({ busy: false }); }
        else { activeFeed = null; if (!closed) publish({ busy: false }); }
      }
      armTimer();
    }
    return clone(state);
  })()); }
  function refreshAccountUpdates(input = { append: false, filter: state.filter }) { return run(false, async (operation, client) => {
    if (!exact(input, ['append', 'filter']) || typeof input.append !== 'boolean' || !['all', 'unread'].includes(input.filter)) throw fail('notification-invalid');
    const previous = input.append ? clone(state.items) : [], cursor = input.append ? state.nextCursor : null;
    if (input.append && (!state.ready || input.filter !== state.filter || !cursor || previous.length >= 500)) throw fail('account-updates-display-limit');
    const page = validateAccountNotifications(await client.getAccountNotifications({ limit: 20, cursor, filter: input.filter },
      { signal: operation.controller.signal }), { limit: 20, filter: input.filter });
    current(operation);
    if (input.append && (page.nextCursor === cursor || page.items.some(item => previous.some(old => old.id === item.id)))) throw fail('sync-response-invalid');
    const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('account-updates-local-error');
    const items = [...previous, ...page.items], capped = items.length >= 500 && page.nextCursor !== null;
    publish({ ready: true, items: items.slice(0, 500), nextCursor: capped ? null : page.nextCursor, unreadCount: page.unreadCount,
      filter: input.filter, checkedAt: at, error: capped ? 'account-updates-display-limit' : null });
  }); }
  function markAccountUpdateRead(input) { return run(false, async (operation, client, ctx) => {
    if (!exact(input, ['scopeId', 'eventId']) || !ID.test(input.eventId || '')) throw fail('notification-invalid');
    if (input.scopeId !== state.scopeId) throw fail('account-updates-selection-changed');
    const item = state.items.find(value => value.id === input.eventId); if (!state.ready || !item) throw fail('notification-not-found');
    if (!ctx.connected) throw fail('service-offline');
    const result = await client.markAccountNotificationRead(item.id, { signal: operation.controller.signal });
    if (!exact(result, ['eventId', 'read']) || result.eventId !== item.id || result.read !== true) throw fail('sync-response-invalid');
    current(operation);
    publish({ items: state.filter === 'unread' ? state.items.filter(value => value.id !== item.id)
      : state.items.map(value => value.id === item.id ? { ...value, read: true } : value),
      unreadCount: Math.max(0, state.unreadCount - (item.read ? 0 : 1)), outcome: { kind: 'read', eventId: item.id } });
  }, true); }
  async function loadPreference(operation, client, ctx) {
    if (!ctx.project) throw fail('project-not-found');
    const value = validateNotificationPreferences(await client.getNotificationPreferences(ctx.project.id,
      { signal: operation.controller.signal }), ctx.project.id);
    current(operation, true);
    if (value.accountEmail !== ctx.accountEmail) throw fail('sync-response-invalid');
    preferenceNonce = randomUUID();
    prefPublish({ ready: true, value, scopeId: prefScope(ctx, value.version), error: null });
  }
  function selectNotificationProject(projectId) { return track((async () => {
    if (closed) return clone(state);
    const ctx = align();
    if (projectId !== null && (typeof projectId !== 'string' || !ID.test(projectId)
      || !connection.getState().projects?.some(item => item.id === projectId))) {
      errorState(fail('notification-invalid'), true); return clone(state);
    }
    if (!ctx) return clone(state);
    selected = projectId; align(); return clone(state);
  })()); }
  function refreshNotificationPreferences() { return run(true, loadPreference); }
  function saveNotificationPreferences(input) { return run(true, async (operation, client, ctx) => {
    if (!exact(input, ['scopeId', 'mode', 'digestHourUtc']) || !['off', 'immediate', 'daily'].includes(input.mode)
      || !Number.isSafeInteger(input.digestHourUtc) || input.digestHourUtc < 0 || input.digestHourUtc > 23) throw fail('notification-invalid');
    if (!ctx.project || !state.preference.ready || !state.preference.value) throw fail('account-updates-refresh-required');
    if (input.scopeId !== state.preference.scopeId) throw fail('account-updates-selection-changed');
    if (!ctx.connected) throw fail('service-offline');
    const previous = clone(state.preference.value);
    if (input.mode !== 'off' && !previous.deliveryAvailable) throw fail('notification-delivery-unavailable');
    const value = { projectId: ctx.project.id, expectedVersion: previous.version, mode: input.mode, digestHourUtc: input.digestHourUtc };
    const hash = fingerprint([ctx.key, ctx.project.id, value]);
    if (pendingSave?.hash !== hash) pendingSave = { hash, key: randomUUID(), projectId: ctx.project.id };
    const result = validateNotificationPreferences(await client.setNotificationPreferences({ ...value, idempotencyKey: pendingSave.key },
      { signal: operation.controller.signal }), ctx.project.id);
    current(operation, true);
    const version = previous.version + (previous.mode === input.mode && previous.digestHourUtc === input.digestHourUtc ? 0 : 1);
    if (result.version !== version || result.mode !== input.mode || result.digestHourUtc !== input.digestHourUtc
      || result.accountEmail !== ctx.accountEmail) throw fail('sync-response-invalid');
    pendingSave = null; preferenceNonce = randomUUID();
    publish({ outcome: { kind: 'preferences-saved', projectId: ctx.project.id, version: result.version },
      preference: { ...state.preference, value: result, ready: false, scopeId: prefScope(ctx, result.version), error: null } });
    await loadPreference(operation, client, ctx);
  }, true); }
  function disableNotificationDelivery(input) { return run(true, async (operation, client, ctx) => {
    if (!exact(input, ['scopeId']) || input.scopeId !== state.scopeId) throw fail('account-updates-selection-changed');
    if (!ctx.connected) throw fail('service-offline');
    const result = await client.disableNotificationDelivery({ signal: operation.controller.signal });
    if (!exact(result, ['disabled']) || result.disabled !== true) throw fail('sync-response-invalid');
    current(operation, true); pendingSave = null; preferenceNonce = randomUUID();
    publish({ outcome: { kind: 'delivery-disabled' }, preference: { ...state.preference, ready: false, value: null,
      scopeId: prefScope(ctx), error: null } });
    if (ctx.project) await loadPreference(operation, client, ctx);
  }, true); }
  function setAccountUpdatesWatch(enabled) { return track((async () => {
    if (closed) return clone(state);
    const ctx = align();
    if (typeof enabled !== 'boolean') errorState(fail('notification-invalid'), false);
    else if (!ctx) errorState(fail('notification-unavailable'), false);
    else { publish({ watch: enabled }); if (!enabled) stopTimer(); else armTimer(); }
    return clone(state);
  })()); }
  function getState() { if (!closed) { align(); armTimer(); } return Promise.resolve(clone(state)); }
  async function dispose() {
    if (closed) return; closed = true; feedEpoch++; preferenceEpoch++; stopTimer();
    activeFeed?.controller.abort(); activePreference?.controller.abort(); activeFeed = activePreference = null;
    pendingSave = null; selected = null; state = { version: state.version + 1, ...emptyFeed(), preference: emptyPreference() };
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, refreshAccountUpdates, markAccountUpdateRead, setAccountUpdatesWatch,
    selectNotificationProject, refreshNotificationPreferences, saveNotificationPreferences, disableNotificationDelivery,
    connectionChanged: getState, dispose };
}
module.exports = { createDesktopAccountUpdates };
