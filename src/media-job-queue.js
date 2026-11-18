const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

const KINDS = new Set(['hash', 'thumbnail', 'proxy', 'asset-check', 'timeline-preview']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const validLabel = label => label === null || typeof label === 'string' && label.trim().length > 0
  && label.length <= 160 && !/[\\/:\x00-\x1f\x7f]/.test(label);
const validOptions = options => options && typeof options === 'object' && !Array.isArray(options)
  && Object.keys(options).every(key => ['frame', 'width', 'height', 'rightsConfirmed'].includes(key))
  && Object.entries(options).every(([key, value]) => key === 'rightsConfirmed' ? typeof value === 'boolean'
    : Number.isSafeInteger(value) && value >= 0 && value <= 4096);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const nullableTimestamp = value => value === null || timestamp(value);
const errorCode = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
function fail(code) { const error = new Error(code); error.code = code; return error; }
async function atomicWrite(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
    const parent = await fs.open(path.dirname(filename), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

// A single-process durable queue. Jobs carry opaque IDs and bounded options;
// source paths and media bytes stay in the trusted worker, never in the index.
function createMediaJobQueue({ directory, handlers, now = () => Date.now(), maxAttempts = 3 } = {}) {
  if (!path.isAbsolute(directory || '') || !handlers || typeof handlers !== 'object' || typeof now !== 'function'
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw fail('media-job-queue-invalid');
  const filename = path.join(directory, 'media-jobs.json');
  let serial = Promise.resolve();
  let recovery = null;
  let workerRunning = false;
  const locked = action => { const next = serial.then(action); serial = next.catch(() => {}); return next; };
  const clock = () => { const value = now(); if (!timestamp(value)) throw fail('media-job-clock-invalid'); return value; };
  function reset(job, resetAttempts) {
    Object.assign(job, { status: 'queued', progress: 0, result: null, error: null,
      startedAt: null, completedAt: null, updatedAt: clock() });
    if (resetAttempts) job.attempts = 0;
  }
  async function readRaw() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let data;
    try { data = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, jobs: [] }; throw fail('media-job-queue-corrupt'); }
    if (data.version !== 1 || !Array.isArray(data.jobs) || new Set(data.jobs.map(job => job?.id)).size !== data.jobs.length
      || data.jobs.some(job => !job || !KINDS.has(job.kind)
      || !['queued', 'running', 'failed', 'completed', 'cancelled'].includes(job.status)
      || !ID.test(job.projectId || '') || !ID.test(job.sourceId || '')
      || job.label !== undefined && !validLabel(job.label)
      || !validOptions(job.options) || !Number.isSafeInteger(job.attempts) || job.attempts < 0
      || !Number.isSafeInteger(job.progress) || job.progress < 0 || job.progress > 100
      || !timestamp(job.createdAt) || !timestamp(job.updatedAt)
      || !nullableTimestamp(job.startedAt) || !nullableTimestamp(job.completedAt)
      || job.error !== null && !errorCode(job.error)
      || job.result !== null && (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)
        || JSON.stringify(job.result).length > 4096)
      || job.id !== `job:${fingerprint({ kind: job.kind, projectId: job.projectId,
        sourceId: job.sourceId, options: job.options })}`)) throw fail('media-job-queue-corrupt');
    return data;
  }
  async function read() {
    // All initial callers share recovery, so a late startup inspection cannot
    // replace a newly enqueued job with an older recovered snapshot.
    if (!recovery) recovery = (async () => {
      const data = await readRaw(); let changed = false;
      for (const job of data.jobs) if (job.status === 'running') { job.status = 'queued'; changed = true; }
      if (changed) await atomicWrite(filename, data);
    })();
    await recovery;
    return readRaw();
  }
  async function enqueue({ kind, projectId, sourceId, options = {}, label = null, restartTerminal = false }) {
    return locked(async () => {
      if (!KINDS.has(kind) || !ID.test(projectId || '') || !ID.test(sourceId || '') || !validLabel(label)
        || !validOptions(options) || typeof restartTerminal !== 'boolean') throw fail('media-job-invalid');
      const payload = { kind, projectId, sourceId, options: structuredClone(options) };
      const id = `job:${fingerprint(payload)}`; const data = await read();
      const existing = data.jobs.find(job => job.id === id);
      if (existing) {
        if (restartTerminal && ['completed', 'cancelled', 'failed'].includes(existing.status)) {
          reset(existing, true); await atomicWrite(filename, data);
        }
        return { id, created: false, status: existing.status };
      }
      data.jobs.push({ ...payload, id, label, status: 'queued', attempts: 0, progress: 0,
        createdAt: clock(), updatedAt: clock(), startedAt: null, completedAt: null, result: null, error: null });
      await atomicWrite(filename, data); return { id, created: true, status: 'queued' };
    });
  }
  async function inspect({ projectId = null } = {}) {
    const data = await read();
    return data.jobs.filter(job => projectId === null || job.projectId === projectId)
      .map(({ options, ...job }) => structuredClone(job));
  }
  async function runNext({ signal, jobId = null } = {}) {
    if (jobId !== null && !/^job:[a-f0-9]{64}$/.test(jobId)) throw fail('media-job-invalid');
    if (workerRunning) return null;
    workerRunning = true;
    try {
      const claimed = await locked(async () => {
        const data = await read(); const job = data.jobs.find(item => item.status === 'queued' && (jobId === null || item.id === jobId));
        if (!job) return null;
        if (signal?.aborted) throw fail('media-job-cancelled');
        if (typeof handlers[job.kind] !== 'function') {
          job.status = 'failed'; job.error = 'handler-unavailable'; job.updatedAt = clock();
          await atomicWrite(filename, data); return structuredClone(job);
        }
        job.status = 'running'; job.attempts++; job.startedAt = clock(); job.updatedAt = clock();
        await atomicWrite(filename, data); return structuredClone(job);
      });
      if (!claimed) return null;
      if (claimed.status === 'failed') return { id: claimed.id, status: claimed.status, error: claimed.error };
      let outcome;
      try {
        const result = await handlers[claimed.kind](structuredClone({ id: claimed.id, kind: claimed.kind, projectId: claimed.projectId,
          sourceId: claimed.sourceId, options: claimed.options }), { signal, progress: value => locked(async () => {
          if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw fail('media-job-progress-invalid');
          const data = await read(), job = data.jobs.find(item => item.id === claimed.id);
          if (!job || job.status !== 'running') throw fail('media-job-state-changed');
          job.progress = value; job.updatedAt = clock(); await atomicWrite(filename, data);
        }) });
        if (signal?.aborted) throw fail('media-job-cancelled');
        if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 4096) throw fail('media-job-result-invalid');
        outcome = { status: 'completed', progress: 100, result: structuredClone(result), error: null, completedAt: clock() };
      } catch (error) {
        outcome = { status: error?.code === 'media-job-cancelled' ? 'queued' : 'failed',
          error: errorCode(error?.code) ? error.code : 'media-job-failed' };
      }
      return await locked(async () => {
        const data = await read(), job = data.jobs.find(item => item.id === claimed.id);
        if (!job || job.status !== 'running') throw fail('media-job-state-changed');
        Object.assign(job, outcome, { updatedAt: clock() }); await atomicWrite(filename, data);
        return { id: job.id, status: job.status, attempts: job.attempts, error: job.error, result: structuredClone(job.result) };
      });
    } finally { workerRunning = false; }
  }
  async function retry(id) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.id === id);
      if (!job || job.status !== 'failed' || job.attempts >= maxAttempts) throw fail('media-job-retry-unavailable');
      reset(job, false); await atomicWrite(filename, data);
      return { id, status: 'queued' };
    });
  }
  async function restart(id) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.id === id);
      if (!job || !['completed', 'cancelled', 'failed'].includes(job.status)) throw fail('media-job-restart-unavailable');
      reset(job, true); await atomicWrite(filename, data);
      return { id, status: 'queued' };
    });
  }
  async function cancel(id) {
    return locked(async () => {
      const data = await read(); const job = data.jobs.find(item => item.id === id);
      if (!job || !['queued', 'failed'].includes(job.status)) throw fail('media-job-cancel-unavailable');
      job.status = 'cancelled'; job.updatedAt = clock(); await atomicWrite(filename, data);
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
  return { enqueue, inspect, runNext, retry, restart, cancel, metrics };
}

module.exports = { createMediaJobQueue, KINDS };
