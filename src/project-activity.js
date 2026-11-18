const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

const TYPES = new Set(['revision.created', 'branch.changed', 'pull.completed', 'branch.protection-changed', 'approval.requested', 'approval.recorded', 'approval.applied', 'share.created', 'share.revoked',
  'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'owner.transferred', 'project.deleted']);
const MAX_EVENTS = 20_000, MAX_RECIPIENTS = 100_000, MAX_RECEIPTS = 100_000, MAX_BYTES = 16 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fail(code) { return Object.assign(new Error(code), { code }); }
const publicEvent = event => Object.fromEntries(['id', 'projectId', 'actorId', 'type', 'subjectId', 'at'].map(key => [key, event[key]]));
function validateActivityState(input) {
  if (input?.version > 1) throw fail('activity-state-newer-version');
  const invalid = () => { throw fail('activity-state-invalid'); };
  if (!exact(input, ['version', 'events', 'receipts']) || input.version !== 1 || !Array.isArray(input.events)
    || input.events.length > MAX_EVENTS || !input.receipts || typeof input.receipts !== 'object' || Array.isArray(input.receipts)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input.receipts)) || Reflect.ownKeys(input.receipts).length > MAX_RECEIPTS) invalid();
  const ids = new Set(), receiptKeys = new Set(); let previous = '0'.repeat(64), recipients = 0;
  for (const event of input.events) {
    if (!exact(event, ['id', 'projectId', 'actorId', 'type', 'subjectId', 'recipientIds', 'at', 'previousHash', 'hash'])
      || typeof event.id !== 'string' || !UUID.test(event.id) || ids.has(event.id) || !validId(event.projectId) || !validId(event.actorId)
      || !TYPES.has(event.type) || (event.type === 'project.deleted' ? event.subjectId !== null : !validId(event.subjectId))
      || !time(event.at) || !Array.isArray(event.recipientIds) || event.recipientIds.length > 10000
      || event.recipientIds.some(id => !validId(id) || id === event.actorId) || new Set(event.recipientIds).size !== event.recipientIds.length
      || event.previousHash !== previous || typeof event.hash !== 'string' || !SHA.test(event.hash)
      || event.hash !== fingerprint(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')))) invalid();
    ids.add(event.id); previous = event.hash; recipients += event.recipientIds.length;
    if (recipients > MAX_RECIPIENTS) invalid();
    for (const actorId of event.recipientIds) receiptKeys.add(`${actorId}:${event.id}`);
  }
  for (const key of Reflect.ownKeys(input.receipts)) if (typeof key !== 'string' || !receiptKeys.has(key) || input.receipts[key] !== true) invalid();
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { invalid(); }
  if (bytes > MAX_BYTES) invalid(); return structuredClone(input);
}

// Hydration validates immutable records and receipts directly; it never replays
// events or invokes listeners. Only new domain mutations may append activity.
function createProjectActivity({ access, now = () => Date.now(), initialState = null, paginationKey = null } = {}) {
  if (!access || typeof access.authorize !== 'function' || typeof now !== 'function'
    || paginationKey !== null && (typeof paginationKey !== 'string' || paginationKey.length < 32 || paginationKey.length > 256)) throw fail('activity-config-invalid');
  let state = initialState === null ? { version: 1, events: [], receipts: {} } : validateActivityState(initialState);
  const listeners = new Set(); let recipientCount = state.events.reduce((sum, event) => sum + event.recipientIds.length, 0);
  function record({ projectId, actorId, type, subjectId = null, recipientIds = [] }) {
    if (!TYPES.has(type) || !validId(projectId) || !validId(actorId)
      || (type === 'project.deleted' ? subjectId !== null : !validId(subjectId)) || !Array.isArray(recipientIds)
      || recipientIds.length > 10000 || recipientIds.some(id => !validId(id))) throw fail('activity-event-invalid');
    const at = now(); if (!time(at)) throw fail('activity-event-invalid');
    const recipients = [...new Set(recipientIds)].filter(id => id !== actorId).sort();
    if (state.events.length >= MAX_EVENTS || recipientCount + recipients.length > MAX_RECIPIENTS) throw fail('activity-capacity-exceeded');
    const event = { id: randomUUID(), projectId, actorId, type, subjectId, recipientIds: recipients, at, previousHash: state.events.at(-1)?.hash || '0'.repeat(64) };
    event.hash = fingerprint(event);
    if (Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(event)) + 1 > MAX_BYTES) throw fail('activity-capacity-exceeded');
    state.events.push(event); recipientCount += recipients.length;
    for (const listener of listeners) { try { listener(structuredClone(event)); } catch { /* Observer failures cannot undo an immutable event. */ } }
    return structuredClone(event);
  }
  function authorize(actorId, projectId) {
    if (!validId(actorId) || !validId(projectId)) throw fail('activity-page-invalid');
    access.authorize(actorId, { projectId, resource: 'project', action: 'read' });
  }
  const received = (event, actorId, projectId) => event.projectId === projectId && event.recipientIds.includes(actorId);
  function list(actorId, projectId, { limit = 50, before = null } = {}) {
    authorize(actorId, projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== null && !time(before)) throw fail('activity-page-invalid');
    return state.events.filter(item => item.projectId === projectId && (before === null || item.at < before)).slice(-limit).reverse().map(publicEvent);
  }
  function notifications(actorId, projectId) {
    authorize(actorId, projectId);
    return state.events.filter(event => received(event, actorId, projectId)).map(event => ({ ...publicEvent(event), read: Object.hasOwn(state.receipts, `${actorId}:${event.id}`) }));
  }
  function markRead(actorId, projectId, eventId) {
    authorize(actorId, projectId);
    const event = state.events.find(event => event.id === eventId && received(event, actorId, projectId));
    if (!event) throw fail('notification-not-found');
    const key = `${actorId}:${eventId}`;
    if (!Object.hasOwn(state.receipts, key)) {
      if (Object.keys(state.receipts).length >= MAX_RECEIPTS) throw fail('activity-capacity-exceeded');
      const next = { ...state, receipts: { ...state.receipts, [key]: true } };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('activity-capacity-exceeded'); state = next;
    }
    return { eventId, read: true };
  }
  function sign(value) {
    if (!paginationKey) throw fail('activity-config-invalid'); const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', paginationKey).update(payload).digest('base64url')}`;
  }
  function cursorValue(cursor, kind, actorId, projectId) {
    if (!paginationKey || typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw fail('activity-cursor-invalid');
    const [payload, signature] = cursor.split('.'); const expected = createHmac('sha256', paginationKey).update(payload).digest('base64url');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw fail('activity-cursor-invalid');
    let value;
    try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) throw fail('activity-cursor-invalid'); value = JSON.parse(bytes.toString('utf8')); }
    catch { throw fail('activity-cursor-invalid'); }
    if (!exact(value, ['v', 'kind', 'actorId', 'projectId', 'anchor', 'before']) || value.v !== 1 || value.kind !== kind
      || value.actorId !== actorId || value.projectId !== projectId || typeof value.anchor !== 'string' || !UUID.test(value.anchor)
      || typeof value.before !== 'string' || !UUID.test(value.before)) throw fail('activity-cursor-invalid'); return value;
  }
  function page(kind, actorId, projectId, options = {}) {
    authorize(actorId, projectId);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'cursor'].includes(key))) throw fail('activity-page-invalid');
    const { limit = 20, cursor = null } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== null && typeof cursor !== 'string') throw fail('activity-page-invalid');
    const indexes = [];
    for (let index = 0; index < state.events.length; index++) {
      const event = state.events[index]; if (kind === 'activity' ? event.projectId === projectId : received(event, actorId, projectId)) indexes.push(index);
    }
    const unreadCount = kind === 'activity' ? null : indexes.filter(index => !Object.hasOwn(state.receipts, `${actorId}:${state.events[index].id}`)).length;
    let anchor = indexes.at(-1), before = state.events.length;
    if (cursor !== null) {
      const value = cursorValue(cursor, kind, actorId, projectId);
      anchor = indexes.find(index => state.events[index].id === value.anchor); before = indexes.find(index => state.events[index].id === value.before);
      if (anchor === undefined || before === undefined || before > anchor) throw fail('activity-cursor-invalid');
    }
    const positions = indexes.filter(index => index <= anchor && index < before).reverse(); const selected = positions.slice(0, limit);
    const items = selected.map(index => kind === 'activity' ? publicEvent(state.events[index]) : { ...publicEvent(state.events[index]), read: Object.hasOwn(state.receipts, `${actorId}:${state.events[index].id}`) });
    const nextCursor = positions.length > limit ? sign({ v: 1, kind, actorId, projectId, anchor: state.events[anchor].id, before: state.events[selected.at(-1)].id }) : null;
    return { projectId, items, nextCursor, unreadCount };
  }
  function subscribe(listener) { if (typeof listener !== 'function') throw fail('activity-listener-invalid'); listeners.add(listener); return () => listeners.delete(listener); }
  return { record, list, notifications, markRead, subscribe, snapshot: () => structuredClone(state), verify: () => { validateActivityState(state); return true; },
    listPage: (actorId, projectId, options) => page('activity', actorId, projectId, options),
    notificationPage: (actorId, projectId, options) => page('notifications', actorId, projectId, options) };
}
module.exports = { createProjectActivity, validateActivityState, TYPES, MAX_EVENTS, MAX_RECIPIENTS, MAX_RECEIPTS };
