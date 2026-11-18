const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateTransferBundle } = require('./revision-transfer');

const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const RETRYABLE = new Set(['sync-network-unavailable', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(error.code) ? error.code : 'sync-failed';
}
function emptyState() { return { schemaVersion: 1, items: [] }; }
function readBounded(filename) {
  const handle = fs.openSync(filename, FLAGS);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_QUEUE_BYTES) throw fail('sync-queue-corrupt');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) throw fail('sync-queue-corrupt');
    return bytes;
  } finally { fs.closeSync(handle); }
}
function atomicWrite(directory, filename, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_QUEUE_BYTES) throw fail('sync-queue-too-large');
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function createSyncQueue({ directory, now = () => Date.now(), baseDelayMs = 1_000, maxDelayMs = 60_000 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !Number.isSafeInteger(baseDelayMs)
    || baseDelayMs < 1 || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw fail('sync-queue-invalid');
  const filename = path.join(directory, 'sync-queue.json');
  let processing = false;
  let active = null;
  function read() {
    try {
      const state = JSON.parse(readBounded(filename).toString('utf8'));
      if (state.schemaVersion !== 1 || !Array.isArray(state.items)) throw fail('sync-queue-corrupt');
      const ids = new Set();
      for (const item of state.items) {
        if (!item || item.operation !== 'push' || item.id !== `sync:${fingerprint(item.payload)}`
          || ids.has(item.id)
          || !['queued', 'retry-wait', 'blocked'].includes(item.status)
          || !Number.isSafeInteger(item.attempts) || item.attempts < 0
          || !Number.isSafeInteger(item.nextAttemptAt) || item.nextAttemptAt < 0
          || !item.payload || !validId(item.payload.remoteProjectId) || !validId(item.payload.branch)
          || !validId(item.payload.authorId)
          || Object.keys(item.payload).sort().join('|') !== 'authorId|branch|bundle|remoteProjectId'
          || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
          || (item.lastError !== null && (typeof item.lastError !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.lastError)))) throw fail('sync-queue-corrupt');
        ids.add(item.id);
        validateTransferBundle(item.payload.bundle);
        if (item.progress === undefined) item.progress = { completed: 0, total: item.payload.bundle.records.length };
        if (!Number.isSafeInteger(item.progress?.completed) || item.progress.completed < 0
          || !Number.isSafeInteger(item.progress?.total) || item.progress.total < item.progress.completed) throw fail('sync-queue-corrupt');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      if (error.code?.startsWith('sync-queue-') || error.code === 'revision-transfer-invalid') throw fail('sync-queue-corrupt');
      throw fail('sync-queue-corrupt');
    }
  }
  function write(state) { atomicWrite(directory, filename, state); }
  function enqueuePush({ remoteProjectId, branch = 'main', bundle, authorId }) {
    validateTransferBundle(bundle);
    if (!validId(remoteProjectId) || !validId(branch) || !validId(authorId)) throw fail('sync-queue-invalid');
    const payload = structuredClone({ remoteProjectId, branch, bundle, authorId });
    const id = `sync:${fingerprint(payload)}`; const state = read();
    const existing = state.items.find(item => item.id === id);
    if (existing) return { id, queued: false, status: existing.status };
    state.items.push({ id, operation: 'push', payload, status: 'queued', attempts: 0,
      nextAttemptAt: 0, createdAt: new Date(now()).toISOString(), lastError: null,
      progress: { completed: 0, total: bundle.records.length } });
    write(state); return { id, queued: true, status: 'queued' };
  }
  function process({ online, sync, onProgress = null, signal = null }) {
    if (processing) throw fail('sync-process-busy');
    processing = true;
    try { return processSync({ online, sync, onProgress, signal }); }
    finally { processing = false; }
  }
  function processSync({ online, sync, onProgress = null, signal = null }) {
    if (typeof online !== 'boolean' || !sync || typeof sync.push !== 'function') throw fail('sync-queue-invalid');
    if (onProgress !== null && typeof onProgress !== 'function') throw fail('sync-queue-invalid');
    if (signal !== null && typeof signal?.aborted !== 'boolean') throw fail('sync-queue-invalid');
    const state = read(); const result = { processed: 0, completed: 0, retrying: 0, blocked: 0, pending: state.items.length };
    if (!online) return result;
    for (const item of [...state.items]) {
      if (item.status === 'blocked' || item.nextAttemptAt > now()) continue;
      if (signal?.aborted) break;
      result.processed += 1; item.attempts += 1; item.status = 'queued'; item.lastError = null;
      try {
        const acknowledgment = sync.push(item.payload, { signal, onProgress: progress => {
          if (!progress || !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)
            || progress.completed < 0 || progress.total < progress.completed) throw fail('sync-progress-invalid');
          item.progress = { completed: progress.completed, total: progress.total };
          write(state); onProgress?.({ id: item.id, ...item.progress });
        } });
        if (acknowledgment && typeof acknowledgment.then === 'function') {
          Promise.resolve(acknowledgment).catch(() => {});
          throw fail('sync-async-required');
        }
        state.items = state.items.filter(candidate => candidate.id !== item.id);
        result.completed += 1;
      } catch (error) {
        item.lastError = safeErrorCode(error);
        if (RETRYABLE.has(item.lastError)) {
          item.status = 'retry-wait';
          item.nextAttemptAt = now() + Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(item.attempts - 1, 16)));
          result.retrying += 1;
        } else { item.status = 'blocked'; item.nextAttemptAt = 0; result.blocked += 1; }
      }
      write(state);
    }
    result.pending = state.items.length; return result;
  }
  async function processAsync({ online, sync, onProgress = null, signal = null }) {
    if (processing) throw fail('sync-process-busy');
    if (typeof online !== 'boolean' || !sync || typeof sync.push !== 'function'
      || (onProgress !== null && typeof onProgress !== 'function')
      || (signal !== null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))) throw fail('sync-queue-invalid');
    processing = true;
    const result = { processed: 0, completed: 0, retrying: 0, blocked: 0, pending: 0 };
    try {
      const ids = read().items.map(item => item.id);
      if (!online) { result.pending = ids.length; return result; }
      for (const id of ids) {
        if (signal?.aborted) break;
        let state = read(); let item = state.items.find(candidate => candidate.id === id);
        if (!item || item.status === 'blocked' || item.nextAttemptAt > now()) continue;
        const run = { id, controller: new AbortController(), cancelled: false }; active = run;
        const abort = () => run.controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        result.processed += 1; item.attempts += 1; item.status = 'queued'; item.lastError = null;
        const payload = structuredClone(item.payload);
        try {
          write(state);
          const acknowledgment = await sync.push(payload, { signal: run.controller.signal, onProgress: progress => {
            if (active !== run || run.cancelled || run.controller.signal.aborted) return;
            if (!progress || !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)
              || progress.completed < 0 || progress.total < progress.completed) throw fail('sync-progress-invalid');
            const latest = read(); const current = latest.items.find(candidate => candidate.id === id);
            if (!current) return;
            current.progress = { completed: progress.completed, total: progress.total }; write(latest);
            onProgress?.({ id, ...current.progress });
          } });
          if (!acknowledgment || acknowledgment.status !== 'in-sync' || !Number.isSafeInteger(acknowledgment.pushed)
            || acknowledgment.pushed < 0 || acknowledgment.pushed > payload.bundle.records.length
            || (acknowledgment.remoteHead !== null && !validId(acknowledgment.remoteHead))
            || (payload.bundle.branches[payload.branch] && acknowledgment.remoteHead === null)) throw fail('sync-ack-invalid');
          state = read(); item = state.items.find(candidate => candidate.id === id);
          if (!run.cancelled && item) {
            // Only an awaited, validated server acknowledgement can remove this intent.
            state.items = state.items.filter(candidate => candidate.id !== id); write(state); result.completed += 1;
          }
        } catch (error) {
          state = read(); item = state.items.find(candidate => candidate.id === id);
          if (!run.cancelled && item) {
            const code = safeErrorCode(error);
            item.lastError = code;
            if (run.controller.signal.aborted || code === 'sync-cancelled') {
              item.status = 'queued'; item.nextAttemptAt = 0;
            } else if (RETRYABLE.has(code)) {
              item.status = 'retry-wait';
              item.nextAttemptAt = now() + Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(item.attempts - 1, 16))); result.retrying += 1;
            } else { item.status = 'blocked'; item.nextAttemptAt = 0; result.blocked += 1; }
            write(state);
          }
        } finally { signal?.removeEventListener('abort', abort); if (active === run) active = null; }
      }
      result.pending = read().items.length; return result;
    } finally { active = null; processing = false; }
  }
  function inspect() {
    return read().items.map(({ id, status, attempts, nextAttemptAt, createdAt, lastError, progress, payload }) =>
      ({ id, operation: 'push', branch: payload.branch, status, attempts, nextAttemptAt, createdAt,
        lastError, progress: structuredClone(progress), recoverable: status === 'retry-wait' || status === 'blocked',
        actions: status === 'blocked' ? ['retry', 'cancel', 'fetch'] : ['retry', 'cancel'] }));
  }
  function retry(id) {
    const state = read(); const item = state.items.find(candidate => candidate.id === id);
    if (!item || !['retry-wait', 'blocked'].includes(item.status)) throw fail('sync-operation-unavailable');
    item.status = 'queued'; item.nextAttemptAt = 0; item.lastError = null;
    write(state); return { id, status: item.status, attempts: item.attempts };
  }
  function cancel(id) {
    const state = read(); const item = state.items.find(candidate => candidate.id === id);
    if (!item) throw fail('sync-operation-unavailable');
    state.items = state.items.filter(candidate => candidate.id !== id); write(state);
    if (active?.id === id) { active.cancelled = true; active.controller.abort(); }
    return { id, canceled: true };
  }
  return { enqueuePush, process, processAsync, inspect, retry, cancel };
}

module.exports = { createSyncQueue, MAX_QUEUE_BYTES };
