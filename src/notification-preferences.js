const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MODES = new Set(['immediate', 'daily', 'off']);
const { TYPES } = require('./project-activity');
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Delivery planning only. Activity remains in the authorized inbox regardless
// of preference; no network sender or scheduler is bundled.
function createNotificationPreferences({ authorize, now = () => Date.now(), initialState = null } = {}) {
  if (typeof authorize !== 'function') throw fail('notification-preferences-invalid');
  const state = initialState ? structuredClone(initialState) : { version: 1, entries: {} };
  if (state.version !== 1 || !state.entries || typeof state.entries !== 'object'
    || Array.isArray(state.entries) || Object.entries(state.entries).some(([key, value]) => {
      try {
        const pair = JSON.parse(key);
        return !Array.isArray(pair) || pair.length !== 2 || pair.some(id => !ID.test(id || ''))
          || !MODES.has(value?.mode) || !Number.isSafeInteger(value.digestHourUtc)
          || value.digestHourUtc < 0 || value.digestHourUtc > 23
          || value.lastDeliveredAt !== null && (!Number.isSafeInteger(value.lastDeliveredAt) || value.lastDeliveredAt < 0
            || !Number.isFinite(new Date(value.lastDeliveredAt).getTime()));
      } catch { return true; }
    })) throw fail('notification-preferences-invalid');
  const key = (actorId, projectId) => JSON.stringify([actorId, projectId]);
  function allowed(actorId, projectId) {
    if (!ID.test(actorId || '') || !ID.test(projectId || '')
      || authorize(actorId, projectId, 'read') !== true) throw fail('notification-preferences-forbidden');
  }
  function get(actorId, projectId) {
    allowed(actorId, projectId);
    return structuredClone(state.entries[key(actorId, projectId)] || { mode: 'off', digestHourUtc: 12, lastDeliveredAt: null });
  }
  function set(actorId, projectId, { mode, digestHourUtc = 12 }) {
    allowed(actorId, projectId);
    if (!MODES.has(mode) || !Number.isSafeInteger(digestHourUtc) || digestHourUtc < 0 || digestHourUtc > 23) throw fail('notification-preferences-invalid');
    const previous = get(actorId, projectId);
    state.entries[key(actorId, projectId)] = { mode, digestHourUtc, lastDeliveredAt: previous.lastDeliveredAt };
    return get(actorId, projectId);
  }
  function plan(actorId, projectId, notifications) {
    allowed(actorId, projectId);
    if (!Array.isArray(notifications) || notifications.some(item => item?.projectId !== projectId
      || !ID.test(item.id || '') || !TYPES.has(item.type) || !Number.isSafeInteger(item.at) || item.at < 0
      || typeof item.read !== 'boolean')) throw fail('notification-input-invalid');
    const preference = get(actorId, projectId);
    const time = now();
    const pending = notifications.filter(item => !item.read && item.at <= time
      && (preference.lastDeliveredAt === null || item.at > preference.lastDeliveredAt));
    const sameDay = preference.lastDeliveredAt !== null
      && new Date(preference.lastDeliveredAt).toISOString().slice(0, 10) === new Date(time).toISOString().slice(0, 10);
    const due = preference.mode === 'immediate' || preference.mode === 'daily'
      && new Date(time).getUTCHours() >= preference.digestHourUtc && !sameDay;
    const counts = Object.fromEntries([...new Set(pending.map(item => item.type))].sort()
      .map(type => [type, pending.filter(item => item.type === type).length]));
    return { mode: preference.mode, ready: due && pending.length > 0, count: pending.length,
      counts, through: pending.length ? Math.max(...pending.map(item => item.at)) : null };
  }
  function markDelivered(actorId, projectId, through) {
    allowed(actorId, projectId);
    if (!Number.isSafeInteger(through) || through < 0 || through > now()) throw fail('notification-delivery-invalid');
    const previous = get(actorId, projectId);
    if (previous.lastDeliveredAt !== null && through < previous.lastDeliveredAt) throw fail('notification-delivery-invalid');
    state.entries[key(actorId, projectId)] = { ...previous, lastDeliveredAt: through };
    return get(actorId, projectId);
  }
  return { get, set, plan, markDelivered, snapshot: () => structuredClone(state) };
}

module.exports = { createNotificationPreferences };
