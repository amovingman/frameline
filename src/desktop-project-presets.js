'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { PRESET_ERROR_CODES, validatePresetTeamCatalog, validateProjectPresetCatalog, validateProjectPresetSaveResponse,
  validateProjectPresetSaveInput, validateProjectPresetPlan, validateProjectPresetCreation } = require('./project-presets-protocol');

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERRORS = new Set([...PRESET_ERROR_CODES, 'project-presets-selection-changed', 'project-presets-refresh-required',
  'project-presets-busy', 'project-presets-local-error', 'project-presets-intent-invalid',
  'project-presets-intent-storage-unavailable', 'project-presets-intent-storage-uncertain', 'project-presets-retry-required',
  'forbidden', 'access-token-invalid', 'service-sign-in-required', 'service-credential-storage-unavailable',
  'service-offline', 'sync-network-unavailable', 'sync-cancelled', 'sync-response-invalid', 'sync-response-too-large',
  'service-connection-failed', 'rate-limit-exceeded']);
const DEFINITE = new Set(['preset-invalid', 'preset-forbidden', 'preset-not-found', 'preset-version-conflict',
  'preset-idempotency-conflict', 'preset-capacity', 'preset-plan-stale', 'preset-media-unavailable']);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const safeError = error => ERRORS.has(error?.code) ? error.code : 'project-presets-local-error';
function publicIntent(record) {
  if (!record) return null;
  const { input, plan } = record;
  return { id: record.id, kind: record.kind, teamId: input.teamId, presetId: input.presetId,
    expectedVersion: input.expectedVersion, ...(record.kind === 'save' ? { name: input.name } : { projectName: input.projectName }),
    branches: clone(record.kind === 'save' ? input.branches : plan.branches),
    syncClasses: clone(record.kind === 'save' ? input.syncClasses : plan.syncClasses), createdAt: record.createdAt };
}

// The journal retains retry identity across quit and sign-out, partitioned by
// service/account. State reads neither load it nor contact the service. Recovery
// is explicit, and never silently replays a project-creation request.
function createDesktopProjectPresets({ connection, intents, onChange = () => {}, now = Date.now } = {}) {
  if (!connection || typeof connection.getState !== 'function' || typeof connection.getClient !== 'function'
    || typeof connection.refreshProjects !== 'function' || !intents || !['load', 'begin', 'complete'].every(key => typeof intents[key] === 'function')
    || typeof onChange !== 'function' || typeof now !== 'function') throw fail('preset-invalid');
  const empty = () => ({ scopeId: null, available: false, busy: false, error: null, teamsReady: false,
    teams: [], mediaAvailable: false, teamId: null, role: null, ready: false, items: [], selectedPresetId: null,
    checkedAt: null, preview: null, pending: null, outcome: null });
  let state = { version: 0, ...empty() }, key = null, epoch = 0, nonce = randomUUID(), active = null, closed = false;
  let pendingRecord = null, loadedKey = null;
  const tasks = new Set();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function context() {
    const value = connection.getState();
    if (!['connected', 'offline'].includes(value.status) || typeof value.account?.id !== 'string'
      || !ID.test(value.account.id)) return null;
    let url; try { url = new URL(value.origin); } catch { return null; }
    if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password) return null;
    return { key: fingerprint([url.origin, value.account.id]), connected: value.status === 'connected' };
  }
  function scope(ctx, patch = {}) {
    const value = { ...state, ...patch }, preset = value.items.find(item => item.id === value.selectedPresetId);
    return fingerprint([nonce, ctx.key, value.teamId, value.role, value.selectedPresetId, preset?.version ?? null]);
  }
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* A view cannot undo an acknowledged mutation. */ }
    return clone(state);
  }
  function align() {
    if (closed) return null;
    const ctx = context();
    if ((ctx?.key || null) !== key) {
      epoch++; active?.controller.abort(); active = null; nonce = randomUUID();
      key = ctx?.key || null; loadedKey = null; pendingRecord = null;
      const base = empty(); publish({ ...base, available: !!ctx, scopeId: ctx ? scope(ctx, base) : null });
    }
    return ctx;
  }
  function current(operation) {
    const ctx = align();
    if (closed || !ctx || ctx.key !== operation.key || operation.epoch !== epoch || active !== operation
      || operation.controller.signal.aborted) throw fail('project-presets-selection-changed');
    return ctx;
  }
  function errorState(error) {
    const code = safeError(error), patch = { error: code };
    if (['preset-forbidden', 'forbidden'].includes(code)) Object.assign(patch, {
      teamsReady: false, teams: [], teamId: null, role: null, items: [], selectedPresetId: null, ready: false, checkedAt: null, preview: null });
    else if (['preset-version-conflict', 'preset-not-found', 'sync-response-invalid'].includes(code)) Object.assign(patch, { ready: false, preview: null });
    else if (code === 'preset-plan-stale') patch.preview = null;
    if (patch.ready === false || patch.teamsReady === false) { nonce = randomUUID(); const ctx = context(); patch.scopeId = ctx ? scope(ctx, patch) : null; }
    publish(patch);
  }
  function run(action, mutation = false) { return track((async () => {
    let operation;
    try {
      if (closed) throw fail('preset-unavailable');
      const ctx = align(); if (!ctx) throw fail('preset-unavailable');
      if (active) throw fail('project-presets-busy');
      operation = { key: ctx.key, epoch, controller: new AbortController() }; active = operation;
      publish({ busy: true, error: null, ...(mutation ? { outcome: null } : {}) });
      await action(operation, connection.getClient(), ctx);
    } catch (error) {
      if (operation && active === operation && !closed) {
        try { current(operation); errorState(error); } catch { /* The next account or selection owns the replacement state. */ }
      } else if (!operation && !active && !closed) errorState(error);
    } finally { if (operation && active === operation) { active = null; if (!closed) publish({ busy: false }); } }
    return clone(state);
  })()); }
  async function loadPending(operation, ctx) {
    const record = await intents.load(ctx.key); current(operation);
    pendingRecord = record; loadedKey = ctx.key; publish({ pending: publicIntent(record) });
  }
  function intent(input, fields, ctx, owner = false) {
    if (!exact(input, ['scopeId', ...fields])) throw fail('preset-invalid');
    if (input.scopeId !== state.scopeId) throw fail('project-presets-selection-changed');
    if (!ctx.connected) throw fail('service-offline');
    if (owner && (!state.ready || !state.teamsReady || !state.teamId)) throw fail('project-presets-refresh-required');
    if (owner && state.role !== 'owner') throw fail('preset-forbidden');
  }
  async function catalog(operation, client, ctx) {
    if (!state.teamId || !state.teamsReady) throw fail('project-presets-refresh-required');
    const teamId = state.teamId, previous = state.items.find(item => item.id === state.selectedPresetId);
    const result = validateProjectPresetCatalog(await client.listProjectPresets(teamId,
      { signal: operation.controller.signal }), teamId); current(operation);
    const selected = result.items.find(item => item.id === state.selectedPresetId) || null;
    if (fingerprint(previous || null) !== fingerprint(selected)) nonce = randomUUID();
    const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('project-presets-local-error');
    const patch = { ready: true, items: result.items, selectedPresetId: selected?.id || null, checkedAt: at, error: null,
      ...(fingerprint(previous || null) !== fingerprint(selected) ? { preview: null } : {}) };
    publish({ ...patch, scopeId: scope(ctx, patch) });
  }
  async function teams(operation, client, ctx) {
    const result = validatePresetTeamCatalog(await client.listPresetTeams({ signal: operation.controller.signal })); current(operation);
    const team = result.teams.find(item => item.id === state.teamId), changed = (team?.role || null) !== state.role;
    if (changed) nonce = randomUUID();
    const patch = { teamsReady: true, teams: result.teams, mediaAvailable: result.mediaAvailable,
      teamId: team?.id || null, role: team?.role || null,
      ...(!team ? { ready: false, items: [], selectedPresetId: null, checkedAt: null } : {}),
      ...(changed || result.mediaAvailable !== state.mediaAvailable ? { preview: null } : {}) };
    publish({ ...patch, scopeId: scope(ctx, patch) });
  }
  function refreshProjectPresets() { return run(async (operation, client, ctx) => {
    await loadPending(operation, ctx); await teams(operation, client, ctx);
    if (state.teamId) await catalog(operation, client, ctx);
  }); }
  function loadProjectPresets() { return run(async (operation, client, ctx) => {
    await loadPending(operation, ctx); await teams(operation, client, ctx); await catalog(operation, client, ctx);
  }); }
  function select(field, value) { return track((async () => {
    if (closed) return clone(state); const ctx = align(); if (!ctx) return clone(state);
    const team = field === 'teamId' && value !== null ? state.teams.find(item => item.id === value) : null;
    if (value !== null && (typeof value !== 'string' || !ID.test(value)
      || field === 'teamId' && (!state.teamsReady || !team) || field === 'selectedPresetId' && (!state.ready || !state.items.some(item => item.id === value)))) {
      errorState(fail('preset-invalid')); return clone(state);
    }
    epoch++; active?.controller.abort(); active = null; nonce = randomUUID();
    const patch = field === 'teamId' ? { teamId: value, role: team?.role || null, ready: false, items: [], selectedPresetId: null, checkedAt: null }
      : { selectedPresetId: value };
    Object.assign(patch, { preview: null, outcome: null, error: null, busy: false });
    publish({ ...patch, scopeId: scope(ctx, patch) }); return clone(state);
  })()); }
  async function sendRecord(operation, client, ctx, record, created = false) {
    let result;
    try {
      result = record.kind === 'save'
        ? validateProjectPresetSaveResponse(await client.saveProjectPreset(record.input, { signal: operation.controller.signal }), record.input)
        : validateProjectPresetCreation(await client.createProjectFromPreset(record.input, { signal: operation.controller.signal }), record.input);
      if (record.kind === 'create' && (fingerprint(result.branches) !== fingerprint(record.plan.branches)
        || fingerprint(result.syncClasses) !== fingerprint(record.plan.syncClasses))) throw fail('sync-response-invalid');
    } catch (error) {
      // Only a first attempt's definite rejection proves this local request was
      // never committed. An older ambiguous request must remain recoverable.
      if (created && DEFINITE.has(error?.code)) {
        await intents.complete(ctx.key, record.id); current(operation); pendingRecord = null; publish({ pending: null });
      }
      throw error;
    }
    current(operation); nonce = randomUUID();
    if (record.kind === 'save') {
      const patch = { outcome: { kind: 'preset-saved', presetId: result.id, version: result.version, teamId: result.teamId,
        name: result.name, branches: clone(result.branches), syncClasses: clone(result.syncClasses) }, preview: null };
      if (state.teamId === result.teamId) Object.assign(patch, { ready: false, selectedPresetId: result.id,
        items: [...state.items.filter(item => item.id !== result.id), result] });
      publish({ ...patch, scopeId: scope(ctx, patch) });
    } else publish({ outcome: { kind: 'project-created', ...result }, preview: null, scopeId: scope(ctx) });
    // Publish a verified service receipt before local cleanup or follow-up reads.
    // If cleanup fails, explicit Retry still uses the same durable request key.
    await intents.complete(ctx.key, record.id); current(operation); pendingRecord = null; publish({ pending: null });
    if (record.kind === 'save') {
      await teams(operation, client, ctx); if (state.teamId) await catalog(operation, client, ctx);
    } else {
      const connectionState = await connection.refreshProjects(); current(operation);
      if (connectionState?.error || connectionState?.status !== 'connected') throw fail(connectionState?.error || 'service-offline');
    }
  }
  async function begin(operation, ctx, kind, input, plan) {
    let started;
    try { started = await intents.begin(ctx.key, { kind, input, plan }); }
    catch (error) {
      if (error?.code === 'project-presets-retry-required') await loadPending(operation, ctx);
      throw error;
    }
    current(operation);
    pendingRecord = started.record; loadedKey = ctx.key; publish({ pending: publicIntent(started.record) }); return started;
  }
  function saveProjectPreset(input) { return run(async (operation, client, ctx) => {
    intent(input, ['name', 'branches', 'syncClasses'], ctx, true);
    const selected = state.items.find(item => item.id === state.selectedPresetId);
    const value = { teamId: state.teamId, presetId: selected?.id || null, expectedVersion: selected?.version || 0,
      name: input.name, branches: clone(input.branches), syncClasses: clone(input.syncClasses) };
    validateProjectPresetSaveInput({ ...value, idempotencyKey: 'validate-intent' });
    const started = await begin(operation, ctx, 'save', value, null);
    await sendRecord(operation, client, ctx, started.record, started.created);
  }, true); }
  function previewProjectFromPreset(input) { return run(async (operation, client, ctx) => {
    intent(input, ['projectName'], ctx, true);
    if (state.pending) throw fail('project-presets-retry-required');
    const selected = state.items.find(item => item.id === state.selectedPresetId); if (!selected) throw fail('preset-not-found');
    const value = { teamId: state.teamId, presetId: selected.id, expectedVersion: selected.version, projectName: input.projectName };
    const plan = validateProjectPresetPlan(await client.previewProjectFromPreset(value, { signal: operation.controller.signal }), value);
    current(operation);
    if (fingerprint(plan.branches) !== fingerprint(['main', ...selected.branches]) || fingerprint(plan.syncClasses) !== fingerprint(selected.syncClasses)) throw fail('sync-response-invalid');
    publish({ preview: plan, mediaAvailable: plan.mediaAvailable });
  }); }
  function createProjectFromPreset(input) { return run(async (operation, client, ctx) => {
    intent(input, ['planId'], ctx, true);
    const plan = state.preview, selected = state.items.find(item => item.id === state.selectedPresetId);
    if (!plan || plan.planId !== input.planId || plan.teamId !== state.teamId || plan.presetId !== selected?.id
      || plan.presetVersion !== selected?.version) throw fail('preset-plan-stale');
    if (plan.syncClasses.length && !plan.mediaAvailable) throw fail('preset-media-unavailable');
    const value = { teamId: plan.teamId, presetId: plan.presetId, expectedVersion: plan.presetVersion,
      projectName: plan.projectName, planId: plan.planId };
    const started = await begin(operation, ctx, 'create', value, plan);
    await sendRecord(operation, client, ctx, started.record, started.created);
  }, true); }
  function pendingIntent(input, fields, ctx) {
    intent(input, ['pendingId', ...fields], ctx);
    if (!pendingRecord || state.pending?.id !== input.pendingId || pendingRecord.id !== input.pendingId) throw fail('project-presets-selection-changed');
  }
  function retryProjectPresetIntent(input) { return run(async (operation, client, ctx) => {
    pendingIntent(input, [], ctx); await sendRecord(operation, client, ctx, pendingRecord);
  }, true); }
  function dismissProjectPresetIntent(input) { return run(async (operation, _client, ctx) => {
    pendingIntent(input, ['reviewed'], ctx); if (input.reviewed !== true) throw fail('preset-invalid');
    const id = pendingRecord.id; await intents.complete(ctx.key, id); current(operation);
    pendingRecord = null; publish({ pending: null, preview: null, outcome: { kind: 'intent-dismissed', pendingId: id } });
  }, true); }
  function initialize() { return run((operation, _client, ctx) => loadPending(operation, ctx)); }
  function getState() { if (!closed) align(); return Promise.resolve(clone(state)); }
  function connectionChanged() {
    const ctx = align(); if (ctx && loadedKey !== ctx.key && !active) return initialize(); return Promise.resolve(clone(state));
  }
  async function dispose() {
    if (closed) return; closed = true; epoch++; active?.controller.abort(); active = null; pendingRecord = null;
    state = { version: state.version + 1, ...empty() }; while (tasks.size) await Promise.allSettled([...tasks]);
  }
  return { getState, initialize, connectionChanged, refreshProjectPresets, loadProjectPresets,
    selectPresetTeam: value => select('teamId', value), selectProjectPreset: value => select('selectedPresetId', value),
    saveProjectPreset, previewProjectFromPreset, createProjectFromPreset, retryProjectPresetIntent, dismissProjectPresetIntent, dispose };
}
module.exports = { createDesktopProjectPresets };
