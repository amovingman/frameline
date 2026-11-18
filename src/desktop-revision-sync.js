'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { acquireMetadataLock } = require('./metadata-lock');
const { createSyncQueue } = require('./sync-queue');
const { createRevisionCache } = require('./revision-cache');
const { createAsyncRevisionSyncService } = require('./revision-sync-async');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const safeName = value => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\\/\x00-\x1f\x7f]/.test(value);
const ERRORS = new Set(['service-sign-in-required', 'service-project-required', 'service-project-unavailable', 'service-viewer-read-only',
  'service-selection-changed', 'service-sync-busy', 'service-binding-invalid', 'service-storage-unavailable', 'sync-network-unavailable',
  'sync-branch-conflict', 'sync-reconciliation-required', 'sync-history-invalid', 'sync-cancelled', 'forbidden', 'access-token-invalid',
  'branch-not-found', 'project-not-found', 'revision-corrupt', 'revision-transfer-invalid', 'metadata-project-missing', 'sync-operation-unavailable']);
function fail(code) { return Object.assign(new Error(code), { code }); }
const safeError = error => ERRORS.has(error?.code) ? error.code : 'service-sync-failed';
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|'); }

// Each queue/cache is scoped to both identities and both branch destinations.
// Nothing here imports fetched revisions, changes a sync base, or applies edits.
function createDesktopRevisionSync({ directory, connection, store, getSelection, onChange = () => {} } = {}) {
  if (!path.isAbsolute(directory || '') || !connection || !store || typeof store.exportRevisions !== 'function'
    || typeof getSelection !== 'function' || typeof onChange !== 'function') throw fail('service-binding-invalid');
  const bindingDirectory = path.join(directory, 'bindings'), filename = path.join(bindingDirectory, 'bindings.json');
  let active = null, generation = 0, version = 0, closed = false, error = null, outcome = null;
  const scopes = new Map(), notifications = new Set(), controls = new Set();
  let connectionKey = null;
  function selection() {
    const value = getSelection();
    return value && validId(value.localProjectId) && validId(value.branch)
      ? { localProjectId: value.localProjectId, branch: value.branch } : null;
  }
  async function bindings() {
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail('service-binding-invalid');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!exact(value, ['version', 'bindings']) || value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 10000) throw fail('service-binding-invalid');
      const seen = new Set();
      for (const item of value.bindings) {
        if (!exact(item, ['originHash', 'accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch', 'remoteProjectName', 'role'])
          || !HASH.test(item.originHash) || !['accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch'].every(key => validId(item[key]))
          || !safeName(item.remoteProjectName) || !['owner', 'editor', 'viewer'].includes(item.role)) throw fail('service-binding-invalid');
        const key = fingerprint([item.originHash, item.accountId, item.localProjectId, item.localBranch]);
        if (seen.has(key)) throw fail('service-binding-invalid'); seen.add(key);
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, bindings: [] }; throw fail('service-binding-invalid'); }
    finally { await handle?.close(); }
  }
  async function editBindings(edit) {
    let release;
    try {
      release = await acquireMetadataLock(bindingDirectory);
      const value = await bindings(); edit(value);
      if (value.bindings.length > 10000) throw fail('service-binding-invalid');
      const temporary = path.join(bindingDirectory, `.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, filename);
        const parent = await fs.open(bindingDirectory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    } catch (error) { throw fail(error.code === 'service-binding-invalid' ? error.code : 'service-storage-unavailable'); }
    finally { await release?.(); }
  }
  function matches(item, account, selected) {
    return item.originHash === fingerprint(account.origin) && item.accountId === account.account.id
      && item.localProjectId === selected.localProjectId && item.localBranch === selected.branch;
  }
  function identity() {
    const state = connection.getState(); return ['connected', 'offline'].includes(state.status) && state.origin && state.account?.id ? state : null;
  }
  async function context() {
    const selected = selection(), account = identity();
    if (!selected) throw fail('service-project-required');
    if (!account) throw fail('service-sign-in-required');
    const binding = (await bindings()).bindings.find(item => matches(item, account, selected));
    if (!binding) throw fail('service-project-unavailable');
    const id = fingerprint({ originHash: binding.originHash, accountId: binding.accountId, localProjectId: binding.localProjectId,
      localBranch: binding.localBranch, remoteProjectId: binding.remoteProjectId, remoteBranch: binding.remoteBranch });
    if (!scopes.has(id)) scopes.set(id, { queue: createSyncQueue({ directory: path.join(directory, 'scopes', id, 'queue') }),
      cache: createRevisionCache({ directory: path.join(directory, 'scopes', id, 'cache') }) });
    return { selected, account, binding, id, ...scopes.get(id) };
  }
  function stillCurrent(ctx, epoch) {
    const selected = selection(), account = identity();
    return !closed && epoch === generation && selected && account && matches(ctx.binding, account, selected);
  }
  function publicFetched(ctx) {
    try {
      const value = ctx.cache.read(ctx.binding.remoteProjectId, ctx.selected.branch);
      return { checkedAt: Number.isSafeInteger(value.checkedAt) ? value.checkedAt : null, head: value.head, revisionCount: value.revisions.length,
        manifestCount: value.manifests.length, total: value.revisions.length, shown: Math.min(100, value.revisions.length),
        revisions: value.revisions.slice(-100).reverse().map(item => Object.fromEntries(['id', 'authorId', 'message', 'createdAt'].map(key => [key, item[key]]))) };
    } catch { return null; }
  }
  async function getState() {
    const account = connection.getState(), selected = selection(); let ctx = null, readError = null;
    try { if (selected && identity()) ctx = await context(); } catch (failure) { if (failure.code === 'service-binding-invalid') readError = failure.code; }
    const currentOutcome = ctx && outcome?.scope === ctx.id ? outcome : null; let operations = [];
    try { if (ctx) operations = ctx.queue.inspect(); } catch { readError = 'service-storage-unavailable'; }
    return { ...account, version: ++version, busy: account.busy || !!active, error: error || readError || account.error,
      selection: selected, binding: ctx ? { remoteProjectId: ctx.binding.remoteProjectId, remoteProjectName: ctx.binding.remoteProjectName,
        remoteBranch: ctx.binding.remoteBranch, role: account.projects.find(item => item.id === ctx.binding.remoteProjectId)?.role || ctx.binding.role } : null,
      operations,
      sync: currentOutcome ? { status: currentOutcome.status, localHead: currentOutcome.localHead, remoteHead: currentOutcome.remoteHead,
        actions: currentOutcome.actions || [], error: currentOutcome.error || null }
        : { status: ctx ? account.status === 'offline' ? 'offline' : 'checking' : 'unbound', localHead: null, remoteHead: null, actions: [], error: null },
      fetched: ctx ? publicFetched(ctx) : null };
  }
  function notify() {
    if (closed) return;
    const task = getState().then(onChange).catch(() => {}).finally(() => notifications.delete(task)); notifications.add(task);
  }
  function selectionChanged() { if (closed) return; generation++; active?.controller.abort(); error = null; outcome = null; notify(); }
  function connectionChanged() {
    const account = identity(), key = account ? fingerprint([account.origin, account.account.id]) : null;
    if (key !== connectionKey) { connectionKey = key; selectionChanged(); } else notify();
  }
  function remoteFor(ctx, client) {
    return { ...client,
      getBranch: async (projectId, branch, options) => {
        const value = await client.getBranch(projectId, ctx.binding.remoteBranch, options);
        if (value.branch !== ctx.binding.remoteBranch) throw fail('sync-history-invalid');
        return { ...value, branch };
      },
      compareAndSwapBranch: async (input, options) => {
        const value = await client.compareAndSwapBranch({ ...input, branch: ctx.binding.remoteBranch,
          idempotencyKey: `desktop-branch:${fingerprint({ input: input.idempotencyKey, branch: ctx.binding.remoteBranch })}` }, options);
        if (value.branch !== ctx.binding.remoteBranch) throw fail('sync-history-invalid');
        return { ...value, branch: input.branch };
      } };
  }
  async function run(action) {
    if (closed) throw fail('service-sync-failed');
    if (active) { error = 'service-sync-busy'; return getState(); }
    const epoch = generation, current = { controller: new AbortController(), promise: null }; active = current;
    current.promise = (async () => {
      try {
        error = null; const ctx = await context();
        if (!stillCurrent(ctx, epoch)) throw fail('service-selection-changed');
        const client = connection.getClient(), sync = createAsyncRevisionSyncService(remoteFor(ctx, client), { cache: ctx.cache });
        await action(ctx, sync, current.controller.signal, epoch);
      } catch (failure) {
        if (epoch === generation && !closed) { error = safeError(failure); outcome = null; }
      } finally { if (active === current) active = null; notify(); }
    })();
    notify(); await current.promise; return getState();
  }
  async function checkContext(ctx, sync, signal, epoch) {
    const bundle = await store.exportRevisions(ctx.selected.localProjectId);
    const result = await sync.divergence({ remoteProjectId: ctx.binding.remoteProjectId, branch: ctx.selected.branch, bundle }, { signal });
    if (!stillCurrent(ctx, epoch)) throw fail('service-selection-changed');
    outcome = { scope: ctx.id, ...result }; return result;
  }
  async function bindAction({ remoteProjectId, remoteBranch } = {}) {
    if (active) { error = 'service-sync-busy'; return getState(); }
    try {
      const selected = selection(), account = identity(), epoch = generation;
      if (!selected) throw fail('service-project-required'); if (!account?.connected) throw fail('service-sign-in-required');
      const project = account.projects.find(item => item.id === remoteProjectId);
      if (!project || !project.branches.includes(remoteBranch)) throw fail('service-project-unavailable');
      const item = { originHash: fingerprint(account.origin), accountId: account.account.id, localProjectId: selected.localProjectId,
        localBranch: selected.branch, remoteProjectId, remoteBranch, remoteProjectName: project.name, role: project.role };
      await editBindings(value => {
        if (closed || epoch !== generation || !identity() || !matches(item, identity(), selection() || {})) throw fail('service-selection-changed');
        value.bindings = value.bindings.filter(existing => !matches(existing, account, selected)); value.bindings.push(item);
      });
      selectionChanged(); return check();
    } catch (failure) { error = safeError(failure); return getState(); }
  }
  async function unlinkAction() {
    const selected = selection(), account = identity(); selectionChanged(); const epoch = generation;
    if (active) await active.promise;
    try {
      if (selected && account) await editBindings(value => {
        const current = identity(), picked = selection();
        if (closed || generation !== epoch || !current || !picked || current.origin !== account.origin
          || current.account.id !== account.account.id || picked.localProjectId !== selected.localProjectId || picked.branch !== selected.branch) throw fail('service-selection-changed');
        value.bindings = value.bindings.filter(item => !matches(item, account, selected));
      });
    } catch (failure) { error = safeError(failure); }
    return getState();
  }
  const check = () => run(checkContext);
  const push = () => run(async (ctx, sync, signal, epoch) => {
    const project = ctx.account.projects.find(project => project.id === ctx.binding.remoteProjectId);
    if (ctx.account.connected && !project) throw fail('service-project-unavailable');
    const role = project?.role || ctx.binding.role;
    if (role === 'viewer') throw fail('service-viewer-read-only');
    const bundle = await store.exportRevisions(ctx.selected.localProjectId);
    if (!bundle.branches[ctx.selected.branch]) throw fail('service-project-required');
    if (!stillCurrent(ctx, epoch)) throw fail('service-selection-changed');
    ctx.queue.enqueuePush({ remoteProjectId: ctx.binding.remoteProjectId, branch: ctx.selected.branch, bundle, authorId: ctx.account.account.id });
    await processQueue(ctx, sync, signal, epoch);
  });
  async function processQueue(ctx, sync, signal, epoch) {
    await ctx.queue.processAsync({ online: true, sync, signal, onProgress: notify });
    if (!stillCurrent(ctx, epoch)) throw fail('service-selection-changed');
    const pending = ctx.queue.inspect();
    if (pending.length) throw fail(pending.find(item => item.lastError)?.lastError || 'sync-network-unavailable');
    await checkContext(ctx, sync, signal, epoch);
  }
  const fetch = () => run(async (ctx, sync, signal, epoch) => {
    const result = await sync.fetch({ remoteProjectId: ctx.binding.remoteProjectId, branch: ctx.selected.branch }, { signal });
    if (!stillCurrent(ctx, epoch)) throw fail('service-selection-changed');
    ctx.cache.store({ ...result, checkedAt: Date.now() });
    await checkContext(ctx, sync, signal, epoch);
  });
  const retry = id => run(async (ctx, sync, signal, epoch) => {
    const job = ctx.queue.inspect().find(item => item.id === id); if (!job) throw fail('sync-operation-unavailable');
    if (job.status !== 'queued') ctx.queue.retry(id); await processQueue(ctx, sync, signal, epoch);
  });
  async function cancelAction(id) {
    try {
      const ctx = await context(); ctx.queue.cancel(id); error = null;
    } catch (failure) { error = safeError(failure); }
    notify(); return getState();
  }
  async function dispose() {
    closed = true; generation++; active?.controller.abort(); await active?.promise;
    await Promise.allSettled([...controls]); await Promise.allSettled([...notifications]);
  }
  function control(action, args) {
    if (closed) return Promise.reject(fail('service-sync-failed'));
    const task = Promise.resolve().then(() => action(...args)).finally(() => controls.delete(task)); controls.add(task); return task;
  }
  return { getState, bind: (...args) => control(bindAction, args), unlink: (...args) => control(unlinkAction, args),
    check, push, fetch, retry, cancel: (...args) => control(cancelAction, args), selectionChanged, connectionChanged, dispose };
}
module.exports = { createDesktopRevisionSync };
