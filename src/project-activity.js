const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

const TYPES = new Set(['revision.created', 'branch.changed', 'pull.completed',
  'member.invited', 'member.joined', 'member.role-changed', 'member.removed',
  'owner.transferred', 'project.deleted']);
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Serializable append-only activity and recipient-scoped inbox. No addresses,
// project paths, tokens or media names are accepted in event details.
function createProjectActivity({ access, now = () => Date.now(), initialState = null } = {}) {
  if (!access) throw fail('activity-config-invalid');
  const state = initialState ? structuredClone(initialState) : { version: 1, events: [], receipts: {} };
  if (state.version !== 1 || !Array.isArray(state.events) || !state.receipts || typeof state.receipts !== 'object') throw fail('activity-state-invalid');
  const listeners = new Set();
  function record({ projectId, actorId, type, subjectId = null, recipientIds = [] }) {
    if (!TYPES.has(type) || typeof projectId !== 'string' || !projectId || typeof actorId !== 'string' || !actorId
      || (subjectId !== null && (typeof subjectId !== 'string' || !subjectId))
      || !Array.isArray(recipientIds) || recipientIds.some(id => typeof id !== 'string' || !id)) throw fail('activity-event-invalid');
    const previousHash = state.events.at(-1)?.hash || '0'.repeat(64);
    const event = { id: randomUUID(), projectId, actorId, type, subjectId,
      recipientIds: [...new Set(recipientIds)].filter(id => id !== actorId), at: now(), previousHash };
    event.hash = fingerprint(event);
    state.events.push(event);
    for (const listener of listeners) listener(structuredClone(event));
    return structuredClone(event);
  }
  function list(actorId, projectId, { limit = 50, before = null } = {}) {
    access.authorize(actorId, { projectId, resource: 'project', action: 'read' });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (before !== null && (!Number.isSafeInteger(before) || before < 0))) throw fail('activity-page-invalid');
    const events = state.events.filter(item => item.projectId === projectId && (before === null || item.at < before));
    return events.slice(-limit).reverse().map(({ recipientIds, previousHash, hash, ...item }) => structuredClone(item));
  }
  function notifications(actorId, projectId) {
    access.authorize(actorId, { projectId, resource: 'project', action: 'read' });
    return state.events.filter(item => item.projectId === projectId && item.recipientIds.includes(actorId))
      .map(({ recipientIds, previousHash, hash, ...item }) => ({ ...structuredClone(item), read: !!state.receipts[`${actorId}:${item.id}`] }));
  }
  function markRead(actorId, projectId, eventId) {
    access.authorize(actorId, { projectId, resource: 'project', action: 'read' });
    const event = state.events.find(item => item.id === eventId && item.projectId === projectId && item.recipientIds.includes(actorId));
    if (!event) throw fail('notification-not-found');
    state.receipts[`${actorId}:${eventId}`] = true;
    return { eventId, read: true };
  }
  function subscribe(listener) { if (typeof listener !== 'function') throw fail('activity-listener-invalid'); listeners.add(listener); return () => listeners.delete(listener); }
  function snapshot() { return structuredClone(state); }
  function verify() { return state.events.every((event, index) => event.previousHash === (state.events[index - 1]?.hash || '0'.repeat(64))
    && event.hash === fingerprint(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')))); }
  if (!verify()) throw fail('activity-state-invalid');
  return { record, list, notifications, markRead, subscribe, snapshot, verify };
}

module.exports = { createProjectActivity, TYPES };
