const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

const KINDS = new Set(['hash', 'thumbnail', 'proxy', 'asset-check', 'timeline-preview']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }
async function atomicWrite(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

// A single-process durable queue. Jobs carry opaque IDs and bounded options;
// source paths and media bytes stay in the trusted worker, never in the index.
function createMediaJobQueue({ directory, handlers, now = () => Date.now(), maxAttempts = 3 } = {}) {
  if (!path.isAbsolute(directory || '') || !handlers || typeof handlers !== 'object'
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw fail('media-job-queue-invalid');
  const filename = path.join(directory, 'media-jobs.json');
  let serial = Promise.resolve();
  let recovered = false;
  const locked = action => { const next = serial.then(action); serial = next.catch(() => {}); return next; };
  async function read() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let data;
    try { data = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, jobs: [] }; throw fail('media-job-queue-corrupt'); }
    if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.some(job => !job || !KINDS.has(job.kind)
      || !['queued', 'running', 'failed', 'completed', 'cancelled'].includes(job.status)
      || !ID.test(job.projectId || '') || !ID.test(job.sourceId || '')
      || job.id !== `job:${fingerprint({ kind: job.kind, projectId: job.projectId,
        sourceId: job.sourceId, options: job.options })}`)) throw fail('media-job-queue-corrupt');
    // A fresh process resumes interrupted work once; subsequent inspections
    // preserve the current worker's running state.
    if (!recovered) {
      let changed = false;
      for (const job of data.jobs) if (job.status === 'running') { job.status = 'queued'; changed = true; }
      if (changed) await atomicWrite(filename, data);
      recovered = true;
    }
    return data;
  }
  async function enqueue({ kind, projectId, sourceId, options = {} }) {
    return locked(async () => {
      if (!KINDS.has(kind) || !ID.test(projectId || '') || !ID.test(sourceId || '')
        || !options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['frame', 'width', 'height', 'rightsConfirmed'].includes(key))
        || Object.entries(options).some(([key, value]) => key === 'rightsConfirmed' ? typeof value !== 'boolean'
          : !Number.isSafeInteger(value) || value < 0 || value > 4096)) throw fail('media-job-invalid');
      const payload = { kind, projectId, sourceId, options: structuredClone(options) };
      const id = `job:${fingerprint(payload)}`; const data = await read();
      const existing = data.jobs.find(job => job.id === id);
      if (existing) return { id, created: false, status: existing.status };
      data.jobs.push({ ...payload, id, status: 'queued', attempts: 0, progress: 0,
        createdAt: now(), updatedAt: now(), startedAt: null, completedAt: null, result: null, error: null });
      await atomicWrite(filename, data); return { id, created: true, status: 'queued' };
    });
  }
  async function inspect({ projectId = null } = {}) {
    const data = await read();
    return data.jobs.filter(job => projectId === null || job.projectId === projectId)
      .map(({ options, ...job }) => structuredClone(job));
  }
  async function runNext({ signal } = {}) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.status === 'queued');
      if (!job) return null;
      if (signal?.aborted) throw fail('media-job-cancelled');
      const handler = handlers[job.kind];
      if (typeof handler !== 'function') {
        job.status = 'failed'; job.error = 'handler-unavailable'; job.updatedAt = now();
        await atomicWrite(filename, data); return { id: job.id, status: job.status, error: job.error };
      }
      job.status = 'running'; job.attempts++; job.startedAt = now(); job.updatedAt = now(); await atomicWrite(filename, data);
      try {
        const result = await handler(structuredClone({ kind: job.kind, projectId: job.projectId,
          sourceId: job.sourceId, options: job.options }), { signal, progress: async value => {
          if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw fail('media-job-progress-invalid');
          job.progress = value; job.updatedAt = now(); await atomicWrite(filename, data);
        } });
        if (signal?.aborted) throw fail('media-job-cancelled');
        if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 4096) throw fail('media-job-result-invalid');
        job.status = 'completed'; job.progress = 100; job.result = structuredClone(result); job.error = null;
        job.completedAt = now();
      } catch (error) {
        job.status = error.code === 'media-job-cancelled' ? 'queued' : 'failed';
        job.error = typeof error.code === 'string' ? error.code : 'media-job-failed';
      }
      job.updatedAt = now(); await atomicWrite(filename, data);
      return { id: job.id, status: job.status, attempts: job.attempts, error: job.error,
        result: structuredClone(job.result) };
    });
  }
  async function retry(id) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.id === id);
      if (!job || job.status !== 'failed' || job.attempts >= maxAttempts) throw fail('media-job-retry-unavailable');
      job.status = 'queued'; job.error = null; job.updatedAt = now(); await atomicWrite(filename, data);
      return { id, status: 'queued' };
    });
  }
  async function cancel(id) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.id === id);
      if (!job || !['queued', 'failed'].includes(job.status)) throw fail('media-job-cancel-unavailable');
      job.status = 'cancelled'; job.updatedAt = now(); await atomicWrite(filename, data);
      return { id, status: 'cancelled' };
    });
  }
  async function metrics({ storedBytes = 0, costPerGbMonth = 0 } = {}) {
    if (!Number.isSafeInteger(storedBytes) || storedBytes < 0 || !Number.isFinite(costPerGbMonth) || costPerGbMonth < 0) throw fail('media-job-metrics-invalid');
    const jobs = (await read()).jobs;
    const counts = { queued: 0, running: 0, failed: 0, completed: 0, cancelled: 0 };
    for (const job of jobs) counts[job.status]++;
    const durations = jobs.filter(job => Number.isSafeInteger(job.startedAt) && Number.isSafeInteger(job.completedAt))
      .map(job => job.completedAt - job.startedAt);
    return { counts, backlog: counts.queued + counts.running, failureCount: counts.failed,
      averageProcessingMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      storedBytes, estimatedMonthlyStorageCost: Number((storedBytes / (1024 ** 3) * costPerGbMonth).toFixed(4)) };
  }
  return { enqueue, inspect, runNext, retry, cancel, metrics };
}

module.exports = { createMediaJobQueue, KINDS };
