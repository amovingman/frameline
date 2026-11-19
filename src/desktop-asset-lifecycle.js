'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { noLinks } = require('./shared-storage-volume');
const { fail, exact, id, asset, validateHoldInput, validateRetentionInput, validateHold,
  validateRetention, validateReport, validatePlan } = require('./asset-lifecycle-protocol');
const clone = value => structuredClone(value);
const ERRORS = new Set(['asset-lifecycle-invalid', 'asset-lifecycle-version-conflict', 'asset-lifecycle-idempotency-conflict',
  'asset-lifecycle-plan-stale', 'asset-policy-forbidden', 'asset-forbidden', 'asset-not-found', 'asset-capacity-exceeded',
  'forbidden', 'access-token-invalid', 'service-offline', 'asset-network-unavailable', 'asset-response-invalid',
  'lifecycle-selection-changed', 'lifecycle-owner-required', 'lifecycle-refresh-required', 'lifecycle-report-changed',
  'lifecycle-busy', 'lifecycle-export-stale', 'lifecycle-destination-exists', 'lifecycle-export-failed',
  'asset-lifecycle-intent-invalid', 'asset-lifecycle-intent-storage-unavailable', 'asset-lifecycle-intent-storage-uncertain',
  'asset-lifecycle-retry-required', 'asset-lifecycle-selection-changed']);
const DEFINITE = new Set(['asset-lifecycle-invalid', 'asset-lifecycle-version-conflict', 'asset-lifecycle-idempotency-conflict',
  'asset-policy-forbidden', 'asset-forbidden', 'asset-not-found', 'asset-capacity-exceeded', 'forbidden', 'access-token-invalid']);
function createDesktopAssetLifecycle({ connection, intents, onChange = () => {} } = {}) {
  if (!connection || !['getState', 'getAssetClient', 'refreshProjects'].every(key => typeof connection[key] === 'function')
    || !intents || !['load', 'begin', 'complete'].every(key => typeof intents[key] === 'function')) throw fail('asset-lifecycle-invalid');
  const empty = () => ({ scopeId: null, available: false, connected: false, projects: [], projectId: null, busy: false,
    ready: false, report: null, items: [], selectedAssetId: null, selectedIds: [], plan: null, exportReview: null,
    pending: null, outcome: null, error: null });
  let state = { version: 0, ...empty() }, signature = null, accountKey = null, epoch = 0, active = null, closed = false;
  let pendingRecord = null, loadedKey = null, pages = [], exportArtifact = null;
  const tasks = new Set();
  function context() {
    const value = connection.getState(); let url;
    try { url = new URL(value.origin); } catch { return null; }
    if (!['connected', 'offline'].includes(value.status) || url.protocol !== 'https:' || url.origin !== value.origin
      || !id(value.account?.id) || !Array.isArray(value.projects)) return null;
    const projects = value.projects.filter(item => id(item.id) && item.role === 'owner').map(item => ({ id: item.id, name: item.name, role: 'owner' }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(projects.map(item => item.id)).size !== projects.length) return null;
    return { key: fingerprint([url.origin, value.account.id]), connected: value.status === 'connected', projects };
  }
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(clone(state))).catch(() => {}); } catch { /* Rendering cannot undo a service receipt. */ }
    return clone(state);
  }
  function clearReport() {
    pages = []; exportArtifact = null;
    return { ready: false, report: null, items: [], selectedAssetId: null, selectedIds: [], plan: null, exportReview: null, scopeId: randomUUID() };
  }
  function align() {
    if (closed) return null;
    const ctx = context(), next = ctx ? fingerprint([ctx.key, ctx.connected, ctx.projects]) : null;
    if (signature !== next) {
      const projectId = ctx?.key === accountKey && ctx?.projects.some(item => item.id === state.projectId) ? state.projectId : null;
      epoch++; active?.controller.abort(); active = null; signature = next; accountKey = ctx?.key || null;
      loadedKey = null; pendingRecord = null; pages = []; exportArtifact = null;
      publish({ ...empty(), available: !!ctx, connected: !!ctx?.connected, projects: ctx?.projects || [], projectId, scopeId: ctx ? randomUUID() : null });
    }
    return ctx;
  }
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function current(op) {
    const ctx = align();
    if (!ctx || closed || active !== op || op.epoch !== epoch || ctx.key !== op.key || op.controller.signal.aborted) throw fail('lifecycle-selection-changed');
    return ctx;
  }
  function run(action, online = true) { return track((async () => {
    let op;
    try {
      const ctx = align(); if (!ctx || closed) throw fail('lifecycle-owner-required');
      if (active) throw fail('lifecycle-busy');
      if (online && !ctx.connected) throw fail('service-offline');
      op = { key: ctx.key, epoch, controller: new AbortController() }; active = op;
      publish({ busy: true, error: null, outcome: null }); await action(op, ctx);
    } catch (error) {
      if (op && active === op && !closed) {
        try {
          current(op); const code = ERRORS.has(error?.code) ? error.code : 'lifecycle-operation-failed';
          const invalid = ['forbidden', 'access-token-invalid', 'asset-policy-forbidden', 'asset-forbidden', 'asset-response-invalid',
            'lifecycle-report-changed', 'asset-lifecycle-plan-stale', 'asset-lifecycle-version-conflict'].includes(code);
          exportArtifact = null; publish({ ...(invalid ? clearReport() : { plan: null, exportReview: null }), error: code });
        } catch { /* Another account owns the new state. */ }
      } else if (!op && !active && !closed) publish({ error: ERRORS.has(error?.code) ? error.code : 'lifecycle-operation-failed' });
    } finally { if (op && active === op) { active = null; if (!closed) publish({ busy: false }); } }
    return clone(state);
  })()); }
  function owner(ctx, pid = state.projectId) {
    if (!pid || !ctx.projects.some(item => item.id === pid)) throw fail('lifecycle-owner-required'); return pid;
  }
  function intent(input, fields, ctx, ready = true) {
    if (!exact(input, ['scopeId', ...fields])) throw fail('asset-lifecycle-invalid');
    if (input.scopeId !== state.scopeId) throw fail('lifecycle-selection-changed');
    owner(ctx); if (ready && !state.ready) throw fail('lifecycle-refresh-required');
  }
  function publicPending(record) {
    if (!record) return null;
    const { id, kind, projectId, assetId, createdAt, input } = record;
    const { idempotencyKey: _private, ...settings } = input;
    return { id, kind, projectId, assetId, createdAt, settings };
  }
  async function loadPending(op, ctx) {
    const record = await intents.load(ctx.key); current(op);
    pendingRecord = record; loadedKey = ctx.key; publish({ pending: publicPending(record) });
  }
  async function report(op, ctx, append) {
    const pid = owner(ctx), prior = state.report;
    if (append && (!state.ready || !prior?.nextAssetId)) throw fail('lifecycle-refresh-required');
    const cursor = append ? prior.nextAssetId : null;
    const result = validateReport(await connection.getAssetClient().getLifecycleReport(pid, { afterAssetId: cursor, limit: 100 }, { signal: op.controller.signal }));
    current(op);
    if (result.projectId !== pid || result.items.some(item => cursor !== null && item.assetId <= cursor)
      || append && (prior.stateHash !== result.stateHash || prior.totalAssets !== result.totalAssets)) throw fail(append ? 'lifecycle-report-changed' : 'asset-response-invalid');
    const items = [...(append ? state.items : []), ...result.items];
    if (new Set(items.map(item => item.assetId)).size !== items.length || items.length > result.totalAssets
      || result.nextAssetId === null && items.length !== result.totalAssets) throw fail('asset-response-invalid');
    pages = [...(append ? pages : []), result]; exportArtifact = null;
    publish({ ...(append ? {} : clearReportKeepingPages()), ready: true, report: result, items, plan: null, exportReview: null });
  }
  function clearReportKeepingPages() {
    return { selectedAssetId: null, selectedIds: [], plan: null, exportReview: null, scopeId: randomUUID() };
  }
  function selectProject(pid) { return track((async () => {
    const ctx = align(); if (!ctx || closed) return clone(state);
    if (pid !== null && (!id(pid) || !ctx.projects.some(item => item.id === pid))) return publish({ error: 'lifecycle-owner-required' });
    epoch++; active?.controller.abort(); active = null;
    return publish({ ...clearReport(), projectId: pid, busy: false, error: null, outcome: null });
  })()); }
  async function send(op, ctx, record, created = false) {
    owner(ctx, record.projectId); const client = connection.getAssetClient(); let result;
    try {
      result = record.kind === 'hold' ? validateHold(await client.setHold(record.projectId, record.assetId, record.input, { signal: op.controller.signal }))
        : validateRetention(await client.setRetentionPolicy(record.projectId, record.input, { signal: op.controller.signal }));
      const fields = record.kind === 'hold' ? ['held', 'reason', 'until'] : ['minimumArchiveAgeMs'];
      if (result.projectId !== record.projectId || record.kind === 'hold' && result.assetId !== record.assetId
        || result.version !== record.input.expectedVersion + 1 || fields.some(key => result[key] !== record.input[key])) throw fail('asset-response-invalid');
    } catch (error) {
      if (created && DEFINITE.has(error?.code)) {
        await intents.complete(ctx.key, record.id); current(op); pendingRecord = null; publish({ pending: null });
      }
      throw error;
    }
    current(op);
    publish({ ...(state.projectId === record.projectId ? clearReport() : {}), outcome: { kind: record.kind, projectId: record.projectId, assetId: record.assetId, result } });
    await intents.complete(ctx.key, record.id); current(op); pendingRecord = null; publish({ pending: null });
  }
  async function begin(op, ctx, value) {
    await loadPending(op, ctx); if (pendingRecord) throw fail('asset-lifecycle-retry-required');
    const started = await intents.begin(ctx.key, value); current(op);
    pendingRecord = started.record; publish({ pending: publicPending(started.record) });
    await send(op, ctx, started.record, started.created);
  }
  const api = {
    getState: async () => { align(); return clone(state); },
    initialize: () => run((op, ctx) => loadPending(op, ctx), false),
    connectionChanged() { const ctx = align(); return ctx && !active && loadedKey !== ctx.key ? api.initialize() : Promise.resolve(clone(state)); },
    refreshProjects: () => run(async (op, ctx) => {
      await connection.refreshProjects(); current(op); await loadPending(op, ctx);
    }),
    selectProject,
    refreshReport: () => run(async (op, ctx) => { await loadPending(op, ctx); await report(op, ctx, false); }),
    loadMore: () => run((op, ctx) => report(op, ctx, true)),
    selectAsset: input => run(async (_op, ctx) => {
      intent(input, ['assetId'], ctx);
      if (input.assetId !== null && !state.items.some(item => item.assetId === input.assetId)) throw fail('asset-lifecycle-invalid');
      publish({ selectedAssetId: input.assetId });
    }),
    selectForPlan: input => run(async (_op, ctx) => {
      intent(input, ['assetIds'], ctx);
      if (!Array.isArray(input.assetIds) || input.assetIds.length > 100 || new Set(input.assetIds).size !== input.assetIds.length
        || input.assetIds.some(aid => !state.items.some(item => item.assetId === aid))) throw fail('asset-lifecycle-invalid');
      exportArtifact = null; publish({ selectedIds: [...input.assetIds].sort(), plan: null, exportReview: null });
    }),
    setHold: input => run(async (op, ctx) => {
      intent(input, ['assetId', 'expectedVersion', 'held', 'reason', 'until'], ctx);
      const row = state.items.find(item => item.assetId === input.assetId);
      if (!row || row.assetId !== state.selectedAssetId || row.hold.version !== input.expectedVersion) throw fail('lifecycle-selection-changed');
      const { scopeId: _scope, assetId, ...settings } = input;
      validateHoldInput({ ...settings, idempotencyKey: 'validation-only' });
      await begin(op, ctx, { kind: 'hold', projectId: state.projectId, assetId, input: settings });
    }),
    setRetention: input => run(async (op, ctx) => {
      intent(input, ['expectedVersion', 'minimumArchiveAgeMs'], ctx);
      if (input.expectedVersion !== state.report.retentionPolicy.version) throw fail('lifecycle-selection-changed');
      const settings = { expectedVersion: input.expectedVersion, minimumArchiveAgeMs: input.minimumArchiveAgeMs };
      validateRetentionInput({ ...settings, idempotencyKey: 'validation-only' });
      await begin(op, ctx, { kind: 'retention', projectId: state.projectId, assetId: null, input: settings });
    }),
    preparePlan: input => run(async (op, ctx) => {
      intent(input, [], ctx); if (!state.selectedIds.length || state.pending) throw fail('lifecycle-refresh-required');
      const ids = clone(state.selectedIds), stateHash = state.report.stateHash, pid = state.projectId;
      const result = validatePlan(await connection.getAssetClient().planCleanup(pid,
        { assetIds: ids, expectedStateHash: stateHash }, { signal: op.controller.signal })); current(op);
      if (result.projectId !== pid || result.stateHash !== stateHash || fingerprint(result.items.map(item => item.assetId)) !== fingerprint(ids)) throw fail('asset-response-invalid');
      exportArtifact = null; publish({ plan: result, exportReview: null });
    }),
    retry: input => run(async (op, ctx) => {
      if (!exact(input, ['scopeId', 'pendingId']) || input.scopeId !== state.scopeId || !pendingRecord || pendingRecord.id !== input.pendingId) throw fail('lifecycle-selection-changed');
      await send(op, ctx, pendingRecord);
    }),
    dismiss: input => run(async (op, ctx) => {
      if (!exact(input, ['scopeId', 'pendingId', 'reviewed']) || input.reviewed !== true || input.scopeId !== state.scopeId
        || !pendingRecord || pendingRecord.id !== input.pendingId) throw fail('lifecycle-selection-changed');
      await intents.complete(ctx.key, pendingRecord.id); current(op); pendingRecord = null;
      publish({ pending: null, outcome: { kind: 'dismissed' } });
    }),
    prepareExport: input => run(async (_op, ctx) => {
      intent(input, ['kind'], ctx); if (!['report', 'plan'].includes(input.kind) || state.pending) throw fail('lifecycle-refresh-required');
      if (input.kind === 'plan' && !state.plan) throw fail('lifecycle-refresh-required');
      const content = input.kind === 'plan' ? validatePlan(state.plan) : { pages: pages.map(validateReport), complete: state.report.nextAssetId === null };
      exportArtifact = { schemaVersion: 1, kind: `frameline-lifecycle-${input.kind}`, projectId: state.projectId, content };
      publish({ exportReview: { kind: input.kind, hash: fingerprint(exportArtifact), assetCount: input.kind === 'plan' ? state.plan.items.length : state.items.length,
        complete: input.kind === 'plan' || content.complete, projectId: state.projectId } });
    }),
    saveExport: (input, destination) => run(async (op, ctx) => {
      intent(input, ['hash'], ctx);
      if (!exportArtifact || input.hash !== state.exportReview?.hash || input.hash !== fingerprint(exportArtifact)) throw fail('lifecycle-export-stale');
      const artifact = clone(exportArtifact), pid = state.projectId, expected = state.report.stateHash;
      const latest = validateReport(await connection.getAssetClient().getLifecycleReport(pid, { afterAssetId: null, limit: 1 }, { signal: op.controller.signal }));
      current(op); if (latest.projectId !== pid || latest.stateHash !== expected) throw fail('lifecycle-export-stale');
      await noLinks(path.dirname(destination)); current(op);
      let handle;
      try { handle = await fs.open(destination, 'wx', 0o600); }
      catch (error) { throw fail(error.code === 'EEXIST' ? 'lifecycle-destination-exists' : 'lifecycle-export-failed'); }
      try { current(op); await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`); await handle.sync(); current(op); }
      catch { await handle.close(); await fs.rm(destination, { force: true }).catch(() => {}); throw fail('lifecycle-export-failed'); }
      await handle.close(); current(op); publish({ outcome: { kind: 'exported', hash: input.hash } });
    }),
    async dispose() { closed = true; epoch++; active?.controller.abort(); active = null; pendingRecord = null; exportArtifact = null;
      state = { version: state.version + 1, ...empty() }; while (tasks.size) await Promise.allSettled([...tasks]); }
  };
  return api;
}
module.exports = { createDesktopAssetLifecycle };
