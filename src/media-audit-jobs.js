'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createMediaJobQueue } = require('./media-job-queue');
const { auditFcpxmlMedia } = require('./fcpxml-media-audit');
const { fingerprint } = require('./project-api-contracts');
const SOURCE = /^(source|copy):([a-f0-9]{64})$/;
const JOB = /^job:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT = 20 * 1024 * 1024;
const STATES = ['local', 'missing', 'offline-volume', 'proxy-only', 'excluded', 'external', 'unknown'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; return error; }
function fields(value, names) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === names.slice().sort().join('|'); }
function validateReport(report, sourceHash) {
  if (!fields(report, ['schemaVersion', 'readOnly', 'sourceFormat', 'sourceVersion', 'sourceHash', 'counts', 'assets'])
    || report.schemaVersion !== 1 || report.readOnly !== true || report.sourceFormat !== 'fcpxml'
    || report.sourceVersion !== '1.10' || report.sourceHash !== sourceHash || !Array.isArray(report.assets)
    || report.assets.length > 100000 || !fields(report.counts, ['total', ...STATES, 'fingerprinted'])) throw fail('media-audit-report-invalid');
  const counts = Object.fromEntries(['total', ...STATES, 'fingerprinted'].map(key => [key, 0]));
  for (const [index, asset] of report.assets.entries()) {
    if (!fields(asset, ['id', 'displayNames', 'status', 'reason', 'fingerprintAvailable', 'fingerprint'])
      || asset.id !== `media-${index + 1}` || !STATES.includes(asset.status) || typeof asset.reason !== 'string'
      || !/^[a-z0-9-]{1,80}$/.test(asset.reason) || typeof asset.fingerprintAvailable !== 'boolean'
      || !Array.isArray(asset.displayNames) || !asset.displayNames.length || asset.displayNames.some(name =>
        typeof name !== 'string' || !name.trim() || name.length > 240 || /[\\/:\x00-\x1f\x7f]/.test(name))
      || asset.fingerprintAvailable !== (asset.fingerprint !== null)
      || asset.fingerprintAvailable !== (asset.status === 'local')
      || asset.fingerprint !== null && (!fields(asset.fingerprint, ['size', 'sha256'])
        || !Number.isSafeInteger(asset.fingerprint.size) || asset.fingerprint.size < 0 || !SHA.test(asset.fingerprint.sha256))) {
      throw fail('media-audit-report-invalid');
    }
    counts.total++; counts[asset.status]++; if (asset.fingerprintAvailable) counts.fingerprinted++;
  }
  if (Object.keys(counts).some(key => report.counts[key] !== counts[key])) throw fail('media-audit-report-invalid');
  return report;
}

// This service stays in the main process. The durable queue contains IDs only;
// paths must be rebound to a freshly selected, matching export after restart.
function createMediaAuditJobs({ directory, getSelection, verifyCopy, onChange = () => {}, audit = auditFcpxmlMedia } = {}) {
  if (!path.isAbsolute(directory || '') || typeof getSelection !== 'function' || typeof onChange !== 'function'
    || typeof audit !== 'function') throw fail('media-audit-jobs-invalid');
  const reportsDirectory = path.join(directory, 'reports');
  let active = null, error = null, version = 0;
  const pending = new Set();
  const notifications = new Set(), pumps = new Set(), controls = new Set();
  let closed = false, selectionGeneration = 0;
  function selectionFor(job, selection = getSelection()) {
    const source = SOURCE.exec(job.sourceId);
    return source && selection && job.projectId === selection.projectId && source[2] === selection.sourceHash
      && (source[1] !== 'copy' || selection.copyPath) ? { ...selection, target: source[1] } : null;
  }
  async function saveReport(report) {
    const bytes = Buffer.from(JSON.stringify(report));
    if (bytes.length > LIMIT) throw fail('media-audit-report-too-large');
    const reportHash = hash(bytes), filename = path.join(reportsDirectory, `${reportHash}.json`);
    await fs.mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(reportsDirectory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST' || hash(await fs.readFile(filename)) !== reportHash) throw error; }
      const parent = await fs.open(reportsDirectory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await fs.rm(temporary, { force: true }); }
    return reportHash;
  }
  async function readReport(job) {
    const result = job.result, hasRunId = result && Object.hasOwn(result, 'runId');
    if (job.status !== 'completed' || !fields(result, ['sourceHash', 'reportHash', 'assetCount', ...(hasRunId ? ['runId'] : [])])
      || !SHA.test(result.reportHash || '') || result.sourceHash !== SOURCE.exec(job.sourceId)[2]
      || !Number.isSafeInteger(result.assetCount) || result.assetCount < 0 || result.assetCount > 100000
      || !Number.isSafeInteger(job.completedAt) || job.completedAt < 0 || hasRunId && !RUN.test(result.runId || '')) return null;
    const filename = path.join(reportsDirectory, `${job.result.reportHash}.json`);
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMIT) throw fail('media-audit-report-invalid');
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size || hash(bytes) !== job.result.reportHash) throw fail('media-audit-report-invalid');
      const report = validateReport(JSON.parse(bytes), SOURCE.exec(job.sourceId)[2]);
      if (report.assets.length !== result.assetCount) throw fail('media-audit-report-invalid');
      return report;
    } finally { await handle.close(); }
  }
  const queue = createMediaJobQueue({ directory, handlers: { 'asset-check': async (job, context) => {
    const selection = selectionFor(job);
    if (!selection) throw fail('media-job-cancelled');
    if (selection.target === 'copy' && (typeof verifyCopy !== 'function' || await verifyCopy(selection) !== true)) throw fail('media-audit-copy-unverified');
    let lastPercent = -1, lastNotification = 0;
    const report = await audit({ exportPath: selection.target === 'copy' ? selection.copyPath : selection.sourcePath,
      expectedSourceHash: selection.sourceHash, signal: context.signal, onProgress: async progress => {
        if (!progress || !['checking', 'hashing'].includes(progress.phase)
          || !Number.isSafeInteger(progress.checked) || !Number.isSafeInteger(progress.total)
          || progress.checked < 0 || progress.total < progress.checked || progress.total > 100000
          || !Number.isSafeInteger(progress.bytesRead) || progress.bytesRead < 0
          || progress.totalBytes !== null && (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < progress.bytesRead)) {
          throw fail('media-job-progress-invalid');
        }
        if (!selectionFor(job) || context.signal?.aborted) {
          active?.controller.abort(); throw fail('media-job-cancelled');
        }
        const fraction = progress.phase === 'hashing' && progress.totalBytes > 0 ? progress.bytesRead / progress.totalBytes : 0;
        const percent = progress.total ? Math.min(99, Math.floor((progress.checked + fraction) / progress.total * 100)) : 0;
        if (active?.id === job.id) active.progress = Object.fromEntries(['phase', 'checked', 'total', 'bytesRead', 'totalBytes'].map(key => [key, progress[key]]));
        if (percent !== lastPercent) { await context.progress(percent); lastPercent = percent; }
        if (Date.now() - lastNotification > 200 || percent === 99) { lastNotification = Date.now(); notify(); }
      } });
    if (!selectionFor(job) || context.signal?.aborted) throw fail('media-job-cancelled');
    if (selection.target === 'copy' && await verifyCopy(selection) !== true) throw fail('stale-export');
    if (!selectionFor(job) || context.signal?.aborted) throw fail('media-job-cancelled');
    validateReport(report, selection.sourceHash);
    const reportHash = await saveReport(report);
    if (!selectionFor(job) || context.signal?.aborted) throw fail('media-job-cancelled');
    return { sourceHash: selection.sourceHash, reportHash, assetCount: report.assets.length, runId: randomUUID() };
  } } });
  const owned = job => job.kind === 'asset-check' && SOURCE.test(job.sourceId)
    && job.id === `job:${fingerprint({ kind: job.kind, projectId: job.projectId, sourceId: job.sourceId, options: {} })}`;
  async function getState() {
    const stateVersion = ++version;
    const selection = getSelection();
    const jobs = (await queue.inspect()).filter(owned).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const reports = {}, unavailable = new Set();
    for (const job of jobs) if (job.status === 'completed' && selectionFor(job, selection)) {
      try {
        const report = await readReport(job);
        if (report) reports[SOURCE.exec(job.sourceId)[1]] = { report, completedAt: job.completedAt, runId: job.result.runId || job.completedAt };
        else unavailable.add(job.id);
      } catch { unavailable.add(job.id); }
    }
    const safeError = code => ['stale-export', 'media-audit-copy-unverified', 'media-job-progress-failed',
      'media-job-retry-unavailable', 'handler-unavailable'].includes(code) ? code : code ? 'media-audit-failed' : null;
    return { version: stateVersion, busy: active !== null || pending.size > 0, error,
      selection: selection ? { projectId: selection.projectId, sourceHash: selection.sourceHash } : null,
      total: jobs.length, reports, jobs: jobs.map(job => {
        const source = SOURCE.exec(job.sourceId), bound = !!selectionFor(job, selection), running = active?.id === job.id;
        return { id: job.id, label: job.label || null, projectId: job.projectId, sourceHash: source[2], target: source[1], status: job.status,
          progress: Number.isSafeInteger(job.progress) ? job.progress : 0, attempts: job.attempts,
          updatedAt: job.updatedAt, completedAt: job.completedAt, bound, reportUnavailable: unavailable.has(job.id),
          error: safeError(job.error), detail: running ? active.progress : null,
          scheduled: pending.has(job.id),
          canCancel: ['queued', 'running', 'failed'].includes(job.status), canResume: bound && job.status === 'queued' && !pending.has(job.id),
          canRetry: bound && job.status === 'failed' && job.attempts < 3,
          canRestart: bound && ['completed', 'cancelled', 'failed'].includes(job.status) };
      }) };
  }
  function notify() {
    if (closed) return;
    const task = Promise.resolve().then(getState).then(state => { if (!closed) return onChange(state); })
      .catch(() => {}).finally(() => notifications.delete(task));
    notifications.add(task);
  }
  function requestPump() {
    if (closed) return;
    const task = pump().catch(() => { error = 'media-audit-queue-failed'; notify(); }).finally(() => pumps.delete(task));
    pumps.add(task);
  }
  async function pump() {
    if (closed || active || !pending.size) return;
    const requested = [...pending], generation = selectionGeneration;
    const jobs = (await queue.inspect()).filter(owned);
    if (closed || active || generation !== selectionGeneration) return;
    const id = requested.find(id => pending.has(id) && jobs.some(job => job.id === id && job.status === 'queued' && selectionFor(job)));
    if (!id) { for (const requestedId of requested) pending.delete(requestedId); notify(); return; }
    active = { id, controller: new AbortController(), progress: null, promise: null };
    const current = active;
    current.promise = (async () => {
      try { notify(); await queue.runNext({ jobId: id, signal: current.controller.signal }); }
      catch (failure) { if (failure.code !== 'media-job-cancelled') error = 'media-audit-queue-failed'; }
      finally { pending.delete(id); if (active === current) active = null; notify(); requestPump(); }
    })();
  }
  async function requireJob(id) {
    if (!JOB.test(id || '')) throw fail('media-audit-job-unavailable');
    const job = (await queue.inspect()).find(job => job.id === id && owned(job));
    if (!job) throw fail('media-audit-job-unavailable');
    return job;
  }
  async function start(target) {
    if (closed) throw fail('media-audit-unavailable');
    const generation = selectionGeneration;
    const selection = getSelection();
    if (!['source', 'copy'].includes(target) || !selection || target === 'copy' && !selection.copyPath) throw fail('media-audit-unavailable');
    const result = await queue.enqueue({ kind: 'asset-check', projectId: selection.projectId,
      sourceId: `${target}:${selection.sourceHash}`, restartTerminal: true, label: typeof selection.displayName === 'string'
        ? selection.displayName.replace(/[\\/:\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || null : null });
    if (closed || generation !== selectionGeneration) return getState();
    pending.add(result.id); error = null; requestPump();
    return getState();
  }
  async function resume(id, retry = false) {
    if (closed) throw fail('media-audit-unavailable');
    const generation = selectionGeneration;
    const job = await requireJob(id);
    if (!selectionFor(job)) throw fail('media-audit-source-required');
    if (retry) await queue.retry(id);
    else if (job.status !== 'queued') throw fail('media-audit-resume-unavailable');
    if (closed || generation !== selectionGeneration) return getState();
    pending.add(id); error = null; requestPump();
    return getState();
  }
  async function cancel(id) {
    if (closed) throw fail('media-audit-unavailable');
    await requireJob(id); pending.delete(id);
    if (active?.id === id) { const current = active; current.controller.abort(); await current.promise; }
    const job = await requireJob(id);
    if (['queued', 'failed'].includes(job.status)) await queue.cancel(id);
    error = null; notify(); return getState();
  }
  async function restart(id) {
    if (closed) throw fail('media-audit-unavailable');
    const generation = selectionGeneration;
    const job = await requireJob(id);
    if (!selectionFor(job)) throw fail('media-audit-source-required');
    await queue.restart(id);
    if (closed || generation !== selectionGeneration) return getState();
    pending.add(id); error = null; requestPump(); return getState();
  }
  function selectionChanged() { selectionGeneration++; pending.clear(); active?.controller.abort(); notify(); }
  async function waitForIdle() {
    while (active || pending.size || controls.size || pumps.size) {
      if (controls.size) await Promise.allSettled([...controls]);
      else if (active?.promise) await active.promise;
      else if (pumps.size) await Promise.allSettled([...pumps]);
      else await new Promise(resolve => setImmediate(resolve));
    }
  }
  async function dispose() {
    closed = true; selectionGeneration++; pending.clear(); active?.controller.abort();
    await Promise.allSettled([...controls]);
    if (active?.promise) await active.promise;
    await Promise.allSettled([...pumps, ...notifications]);
  }
  function control(action) {
    const task = action(); controls.add(task);
    task.finally(() => controls.delete(task)).catch(() => {}); return task;
  }
  return { start: target => control(() => start(target)), getState, resume: id => control(() => resume(id)),
    restart: id => control(() => restart(id)), retry: id => control(() => resume(id, true)),
    cancel: id => control(() => cancel(id)), selectionChanged, waitForIdle, dispose,
    isBusy: () => active !== null || pending.size > 0 || controls.size > 0 };
}
module.exports = { createMediaAuditJobs, validateReport };
