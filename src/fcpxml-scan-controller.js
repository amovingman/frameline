const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ScanError } = require('./fcpxml-scan-core');
const CODES = new Set(['unsupported-format', 'file-access-denied', 'file-busy', 'file-unavailable', 'file-too-large',
  'revision-source-changed', 'malformed-xml', 'unsupported-structure', 'unsupported-fcpxml-version', 'unsupported-timing', 'invalid-manifest', 'scan-failed']);
function createFcpXmlScanner({ maxCacheEntries = 4, maxCacheBytes = 64 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 16 || !Number.isSafeInteger(maxCacheBytes)
    || maxCacheBytes < 1024 || maxCacheBytes > 256 * 1024 * 1024) throw new ScanError('invalid-scan-options');
  let worker = null; let active = null; let nextId = 0; let disposed = false; let stopping = null; const queue = [];
  function finish(job, error, value) {
    if (job.done) return; job.done = true; job.signal?.removeEventListener('abort', job.abort);
    if (active === job) active = null;
    error ? job.reject(error) : job.resolve(value);
    if (!active) worker?.unref();
    void pump();
  }
  function stop() {
    if (!worker) return stopping || Promise.resolve();
    const previous = worker; worker = null;
    stopping = previous.terminate().catch(() => {}).finally(() => { stopping = null; });
    return stopping;
  }
  async function failActive(code, expectedJob = active, expectedWorker = worker) {
    if (active !== expectedJob || worker !== expectedWorker) return;
    await stop();
    if (expectedJob && active === expectedJob) finish(expectedJob, new ScanError(code));
  }
  function ensureWorker() {
    if (worker) return;
    const current = new Worker(path.join(__dirname, 'fcpxml-scan-worker.js'), {
      workerData: { maxCacheEntries, maxCacheBytes }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    worker = current;
    current.on('message', async message => {
      const job = active; if (worker !== current || !job || message.id !== job.id || job.done) return;
      if (message.type === 'progress') {
        try {
          if (job.onProgress) await job.onProgress(message.value);
          if (worker === current && active === job && !job.done && !job.signal?.aborted) current.postMessage({ type: 'ack', id: job.id, sequence: message.sequence });
        } catch { await failActive('scan-progress-failed', job, current); }
      } else if (message.type === 'result') finish(job, null, message.result === null ? undefined : message.result);
      else if (message.type === 'error') finish(job, new ScanError(CODES.has(message.code) ? message.code : 'scan-failed'));
    });
    current.on('error', () => { if (worker === current) void failActive('scan-worker-unavailable'); });
    current.on('exit', () => { if (worker === current) { worker = null; const job = active; if (job) finish(job, new ScanError('scan-worker-unavailable')); } });
  }
  async function pump() {
    if (active || disposed) return;
    if (stopping) { await stopping; if (active || disposed) return; }
    const job = queue.shift(); if (!job) return;
    if (job.done) { void pump(); return; }
    active = job;
    try { ensureWorker(); worker.ref(); worker.postMessage({ type: 'request', id: job.id, operation: job.operation, selectedPath: job.selectedPath, sourceHash: job.sourceHash }); }
    catch { await failActive('scan-worker-unavailable'); }
  }
  function request(operation, selectedPath, sourceHash, { signal, onProgress } = {}) {
    if (disposed) return Promise.reject(new ScanError('scan-disposed'));
    if (typeof selectedPath !== 'string' || !selectedPath.length || selectedPath.includes('\0')) return Promise.reject(new ScanError('file-unavailable'));
    const absolutePath = path.resolve(selectedPath);
    if (operation === 'verify' && (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash))) return Promise.reject(new ScanError('revision-source-changed'));
    if ((signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
      || (onProgress !== undefined && typeof onProgress !== 'function')) return Promise.reject(new ScanError('invalid-scan-options'));
    if (signal?.aborted) return Promise.reject(new ScanError('scan-cancelled'));
    if (queue.length >= 64) return Promise.reject(new ScanError('scan-queue-full'));
    return new Promise((resolve, reject) => {
      const job = { id: ++nextId, operation, selectedPath: absolutePath, sourceHash, signal, onProgress, resolve, reject, done: false };
      job.abort = () => { if (active === job) void failActive('scan-cancelled'); else { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); finish(job, new ScanError('scan-cancelled')); } };
      signal?.addEventListener('abort', job.abort, { once: true }); queue.push(job); void pump();
    });
  }
  async function dispose() {
    if (disposed) { if (stopping) await stopping; return; }
    disposed = true; const running = active;
    for (const job of queue.splice(0)) finish(job, new ScanError('scan-disposed'));
    await stop(); if (running) finish(running, new ScanError('scan-disposed'));
  }
  return { scan: (selectedPath, options) => request('scan', selectedPath, undefined, options),
    verifySource: (selectedPath, sourceHash, options) => request('verify', selectedPath, sourceHash, options), dispose };
}
module.exports = { createFcpXmlScanner };
