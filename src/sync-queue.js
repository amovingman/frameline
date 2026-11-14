const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateTransferBundle } = require('./revision-transfer');

const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const RETRYABLE = new Set(['sync-network-unavailable', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
function fail(code) { const error = new Error(code); error.code = code; return error; }
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
  function read() {
    try {
      const state = JSON.parse(readBounded(filename).toString('utf8'));
      if (state.schemaVersion !== 1 || !Array.isArray(state.items)) throw fail('sync-queue-corrupt');
      for (const item of state.items) {
        if (!item || item.operation !== 'push' || item.id !== `sync:${fingerprint(item.payload)}`
          || !['queued', 'retry-wait', 'blocked'].includes(item.status)
          || !Number.isSafeInteger(item.attempts) || item.attempts < 0
          || !Number.isSafeInteger(item.nextAttemptAt) || item.nextAttemptAt < 0
          || !item.payload || !ID.test(item.payload.remoteProjectId) || !ID.test(item.payload.branch)
          || !ID.test(item.payload.authorId)) throw fail('sync-queue-corrupt');
        validateTransferBundle(item.payload.bundle);
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
    if (!ID.test(remoteProjectId) || !ID.test(branch) || !ID.test(authorId)) throw fail('sync-queue-invalid');
    const payload = structuredClone({ remoteProjectId, branch, bundle, authorId });
    const id = `sync:${fingerprint(payload)}`; const state = read();
    const existing = state.items.find(item => item.id === id);
    if (existing) return { id, queued: false, status: existing.status };
    state.items.push({ id, operation: 'push', payload, status: 'queued', attempts: 0,
      nextAttemptAt: 0, createdAt: new Date(now()).toISOString(), lastError: null });
    write(state); return { id, queued: true, status: 'queued' };
  }
  function process({ online, sync }) {
    if (typeof online !== 'boolean' || !sync || typeof sync.push !== 'function') throw fail('sync-queue-invalid');
    const state = read(); const result = { processed: 0, completed: 0, retrying: 0, blocked: 0, pending: state.items.length };
    if (!online) return result;
    for (const item of [...state.items]) {
      if (item.status === 'blocked' || item.nextAttemptAt > now()) continue;
      result.processed += 1; item.attempts += 1;
      try {
        sync.push(item.payload);
        state.items = state.items.filter(candidate => candidate.id !== item.id);
        result.completed += 1;
      } catch (error) {
        item.lastError = typeof error.code === 'string' ? error.code : 'sync-failed';
        if (RETRYABLE.has(error.code)) {
          item.status = 'retry-wait';
          item.nextAttemptAt = now() + Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(item.attempts - 1, 16)));
          result.retrying += 1;
        } else { item.status = 'blocked'; item.nextAttemptAt = 0; result.blocked += 1; }
      }
      write(state);
    }
    result.pending = state.items.length; return result;
  }
  function inspect() {
    return read().items.map(({ id, status, attempts, nextAttemptAt, createdAt, lastError }) =>
      ({ id, status, attempts, nextAttemptAt, createdAt, lastError }));
  }
  return { enqueuePush, process, inspect };
}

module.exports = { createSyncQueue, MAX_QUEUE_BYTES };
