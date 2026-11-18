const { validateTransferBundle } = require('./revision-transfer');
const { validateRevisionManifest } = require('./revision-manifest');
const { fingerprint } = require('./project-api-contracts');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const text = value => typeof value === 'string' && value.trim() && value.length <= 240
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
function fail(code) { return Object.assign(new Error(code), { code }); }
function checkSignal(signal) { if (signal?.aborted) throw fail('sync-cancelled'); }

// A separate async API keeps synchronous callers from accidentally acknowledging a Promise.
function createAsyncRevisionSyncService(remote, { cache = null, maxHistory = 10_000 } = {}) {
  if (!remote || !['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch',
    'getRevision', 'getManifest', 'findRevisionBySource'].every(name => typeof remote[name] === 'function')) throw fail('sync-remote-invalid');
  if (cache && (typeof cache.store !== 'function' || typeof cache.read !== 'function')) throw fail('sync-cache-invalid');
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1 || maxHistory > 10_000) throw fail('sync-history-limit-invalid');
  function options({ signal = null, onProgress = null } = {}) {
    if (signal !== null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) throw fail('sync-progress-invalid');
    if (onProgress !== null && typeof onProgress !== 'function') throw fail('sync-progress-invalid');
    return { signal, onProgress };
  }
  function input({ remoteProjectId, branch = 'main' }) {
    if (!validId(remoteProjectId) || !validId(branch)) throw fail('sync-branch-invalid');
    return { remoteProjectId, branch };
  }
  async function call(method, args, signal) {
    checkSignal(signal); const value = await remote[method](...args, { signal }); checkSignal(signal); return value;
  }
  async function head(projectId, branch, signal) {
    const value = await call('getBranch', [projectId, branch], signal);
    if (!value || value.projectId !== projectId || value.branch !== branch
      || (value.revisionId !== null && !validId(value.revisionId))) throw fail('sync-history-invalid');
    return value.revisionId;
  }
  function revision(value, projectId, id = null) {
    if (!value || !validId(value.id) || (id !== null && value.id !== id) || value.projectId !== projectId
      || !validId(value.manifestId) || (value.parentRevisionId !== null && !validId(value.parentRevisionId))
      || !validId(value.authorId) || !text(value.message)
      || (value.sourceRevisionId !== null && !validId(value.sourceRevisionId))
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw fail('sync-history-invalid');
    return Object.fromEntries(['id', 'projectId', 'manifestId', 'parentRevisionId', 'authorId', 'message',
      'sourceRevisionId', 'createdAt'].map(key => [key, value[key]]));
  }
  async function getRevision(projectId, id, signal) { return revision(await call('getRevision', [projectId, id], signal), projectId, id); }
  async function find(projectId, sourceId, signal) {
    const value = await call('findRevisionBySource', [projectId, sourceId], signal);
    if (value === null) return null;
    const checked = revision(value, projectId);
    if (checked.sourceRevisionId !== sourceId) throw fail('sync-history-invalid');
    return checked;
  }
  async function manifest(projectId, id, signal) {
    const value = await call('getManifest', [projectId, id], signal);
    if (!value || value.id !== id || value.projectId !== projectId || !value.document
      || typeof value.document !== 'object' || Array.isArray(value.document)
      || id !== `sha256:${fingerprint(value.document)}` || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))) throw fail('sync-history-invalid');
    try { validateRevisionManifest(value.document); } catch { throw fail('sync-history-invalid'); }
    return { id, projectId, document: structuredClone(value.document), createdAt: value.createdAt };
  }
  async function equivalent(projectId, stored, local, signal) {
    const value = await manifest(projectId, stored.manifestId, signal);
    if (stored.sourceRevisionId !== local.id || fingerprint(value.document) !== fingerprint(local.manifest)
      || stored.message !== local.message.trim()) throw fail('sync-history-invalid');
    const parent = stored.parentRevisionId ? await getRevision(projectId, stored.parentRevisionId, signal) : null;
    if ((parent?.sourceRevisionId || null) !== local.parentRevisionId) throw fail('sync-history-invalid');
  }
  function chain(records, id) {
    const result = []; const seen = new Set();
    while (id) {
      if (seen.has(id) || !records.has(id) || result.length >= maxHistory) throw fail('sync-history-invalid');
      seen.add(id); const record = records.get(id); result.push(record); id = record.parentRevisionId;
    }
    return result.reverse();
  }
  async function divergence(value, opts = {}) {
    const { signal } = options(opts); const { remoteProjectId, branch } = input(value);
    const records = validateTransferBundle(value.bundle); const localHead = value.bundle.branches[branch];
    if (localHead === undefined) throw fail('sync-branch-invalid');
    const localIds = new Set(chain(records, localHead).map(item => item.id));
    const remoteHead = await head(remoteProjectId, branch, signal);
    if (!localHead && !remoteHead) return { status: 'in-sync', localHead, remoteHead, actions: [] };
    const localRemote = localHead ? await find(remoteProjectId, localHead, signal) : null;
    if (localRemote) await equivalent(remoteProjectId, localRemote, records.get(localHead), signal);
    if (localRemote?.id === remoteHead) return { status: 'in-sync', localHead, remoteHead, actions: [] };
    let cursor = remoteHead ? await getRevision(remoteProjectId, remoteHead, signal) : null;
    if (!remoteHead || (cursor.sourceRevisionId && localIds.has(cursor.sourceRevisionId))) {
      if (cursor) await equivalent(remoteProjectId, cursor, records.get(cursor.sourceRevisionId), signal);
      return { status: 'local-ahead', localHead, remoteHead, actions: ['push'] };
    }
    if (!localHead) return { status: 'remote-ahead', localHead, remoteHead, actions: ['fetch'] };
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor.id) || seen.size >= maxHistory) throw fail('sync-history-invalid'); seen.add(cursor.id);
      if (cursor.sourceRevisionId === localHead) {
        await equivalent(remoteProjectId, cursor, records.get(localHead), signal);
        return { status: 'remote-ahead', localHead, remoteHead, actions: ['fetch'] };
      }
      cursor = cursor.parentRevisionId ? await getRevision(remoteProjectId, cursor.parentRevisionId, signal) : null;
    }
    return { status: 'diverged', localHead, remoteHead, actions: ['fetch', 'create-reconciliation-branch'] };
  }
  async function conflict(projectId, branch, expected, signal) {
    const error = fail('sync-branch-conflict'); error.recoverable = true;
    error.actions = ['fetch', 'create-reconciliation-branch']; error.expectedRemoteHead = expected;
    error.actualRemoteHead = await head(projectId, branch, signal); return error;
  }
  async function push(value, opts = {}) {
    const { signal, onProgress } = options(opts); const { remoteProjectId, branch } = input(value);
    if (!validId(value.authorId)) throw fail('sync-remote-invalid');
    const records = validateTransferBundle(value.bundle); const state = await divergence(value, { signal });
    if (!['in-sync', 'local-ahead'].includes(state.status)) throw fail('sync-reconciliation-required');
    if (state.status === 'in-sync') return { pushed: 0, remoteHead: state.remoteHead, status: 'in-sync' };
    const local = chain(records, value.bundle.branches[branch]); let expected = state.remoteHead; let pushed = 0;
    const remoteSource = expected ? (await getRevision(remoteProjectId, expected, signal)).sourceRevisionId : null;
    const start = remoteSource ? local.findIndex(item => item.id === remoteSource) + 1 : 0;
    if (remoteSource && start === 0) throw fail('sync-reconciliation-required');
    const pending = local.slice(start); const report = () => onProgress?.({ completed: pushed, total: pending.length }); report();
    for (const record of pending) {
      if (await head(remoteProjectId, branch, signal) !== expected) throw await conflict(remoteProjectId, branch, expected, signal);
      let next = await find(remoteProjectId, record.id, signal);
      if (next) {
        const stored = await manifest(remoteProjectId, next.manifestId, signal);
        if (fingerprint(stored.document) !== fingerprint(record.manifest) || next.message !== record.message.trim()) throw fail('sync-history-invalid');
        if (next.parentRevisionId !== expected) throw await conflict(remoteProjectId, branch, expected, signal);
      } else {
        const stored = await call('putManifest', [remoteProjectId, record.manifest], signal);
        if (!stored || stored.id !== `sha256:${fingerprint(record.manifest)}`) throw fail('sync-history-invalid');
        next = revision(await call('createRevision', [{ projectId: remoteProjectId, manifestId: stored.id,
          parentRevisionId: expected, authorId: value.authorId, message: record.message, sourceRevisionId: record.id,
          idempotencyKey: `sync:${fingerprint({ projectId: remoteProjectId, sourceRevisionId: record.id })}` }], signal), remoteProjectId);
        if (next.parentRevisionId !== expected || next.manifestId !== stored.id || next.sourceRevisionId !== record.id
          || next.authorId !== value.authorId || next.message !== record.message.trim()) throw fail('sync-history-invalid');
      }
      try {
        const ack = await call('compareAndSwapBranch', [{ projectId: remoteProjectId, branch,
          expectedRevisionId: expected, revisionId: next.id,
          idempotencyKey: `sync-branch:${fingerprint({ projectId: remoteProjectId, branch, sourceRevisionId: record.id })}` }], signal);
        if (!ack || ack.projectId !== remoteProjectId || ack.branch !== branch || ack.revisionId !== next.id) throw fail('sync-history-invalid');
      } catch (error) { if (error.code === 'branch-head-changed') throw await conflict(remoteProjectId, branch, expected, signal); throw error; }
      expected = next.id; pushed += 1; report();
    }
    return { pushed, remoteHead: expected, status: 'in-sync' };
  }
  async function fetch(value, opts = {}) {
    const { signal } = options(opts); const { remoteProjectId, branch } = input(value);
    const remoteHead = await head(remoteProjectId, branch, signal); const revisions = []; const manifests = new Map(); const seen = new Set(); let current = remoteHead;
    while (current) {
      if (seen.has(current) || seen.size >= maxHistory) throw fail('sync-history-invalid'); seen.add(current);
      const record = await getRevision(remoteProjectId, current, signal); revisions.push(record);
      if (!manifests.has(record.manifestId)) manifests.set(record.manifestId, await manifest(remoteProjectId, record.manifestId, signal));
      current = record.parentRevisionId;
    }
    const result = { schemaVersion: 1, remoteProjectId, branch, head: remoteHead, revisions: revisions.reverse(), manifests: [...manifests.values()], mediaFetched: false };
    checkSignal(signal); if (cache) await cache.store(result); return result;
  }
  async function fetchCached(value) { const { remoteProjectId, branch } = input(value); if (!cache) throw fail('sync-cache-unavailable'); return cache.read(remoteProjectId, branch); }
  return { divergence, push, fetch, fetchCached };
}

module.exports = { createAsyncRevisionSyncService };
