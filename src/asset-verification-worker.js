'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./asset-lifecycle-protocol');
const { JOB_ERRORS } = require('./asset-jobs-protocol');
function createAssetVerificationWorker({ worker, intervalMs = 1000, leaseMs = 30000, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  if (!worker || !['claim', 'metadata', 'readChunk', 'progress', 'complete', 'fail'].every(key => typeof worker[key] === 'function')
    || !Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000 || !Number.isSafeInteger(leaseMs)
    || leaseMs < 1000 || leaseMs > 300000 || typeof now !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function' || typeof onChange !== 'function') throw fail('asset-job-invalid');
  let closed = false, timer = null, active = null, started = false;
  let state = { running: false, busy: false, completed: 0, failed: 0, interrupted: 0, lastCheckedAt: null, error: null };
  function publish(patch) { state = { ...state, ...patch }; try { Promise.resolve(onChange(structuredClone(state))).catch(() => {}); } catch { /* Status is not canonical data. */ } }
  function arm() {
    if (!closed && started && timer === null && !active) { timer = setTimer(() => { timer = null; void tick(); }, intervalMs); timer?.unref?.(); }
  }
  function tick() {
    if (closed) return Promise.resolve(structuredClone(state)); if (active) return active;
    if (timer !== null) { clearTimer(timer); timer = null; }
    publish({ busy: true, error: null });
    const task = Promise.resolve().then(async () => {
      let claim;
      try {
        claim = await worker.claim(leaseMs);
        if (claim) {
          const metadata = await worker.metadata(claim), hash = createHash('sha256'); let size = 0, lastProgress = now();
          for (let index = 0; index < metadata.chunks; index++) {
            if (closed) throw fail('asset-job-interrupted');
            const bytes = await worker.readChunk(claim, index);
            if (!Buffer.isBuffer(bytes)) throw fail('asset-chunk-corrupt'); hash.update(bytes); size += bytes.length;
            const at = now();
            if (at - lastProgress >= Math.min(1000, Math.floor(leaseMs / 3)) || index === metadata.chunks - 1) {
              await worker.progress(claim, size); lastProgress = at;
            }
          }
          if (closed) throw fail('asset-job-interrupted');
          await worker.complete(claim, { size, sha256: hash.digest('hex') }); publish({ completed: state.completed + 1 });
        }
      } catch (error) {
        const code = JOB_ERRORS.includes(error?.code) ? error.code : ['forbidden', 'asset-forbidden', 'access-token-invalid'].includes(error?.code)
          ? 'asset-job-access-denied' : 'asset-job-worker-failed';
        if (claim) try { await worker.fail(claim, code, closed); } catch { /* Cancellation/expiry fences late writes; uncertain storage needs reopening. */ }
        const interrupted = closed || ['asset-job-lease-stale', 'asset-job-lease-expired'].includes(error?.code);
        publish(interrupted ? { interrupted: state.interrupted + 1 } : { failed: state.failed + 1, error: code });
      }
      const at = now(); publish({ lastCheckedAt: Number.isSafeInteger(at) && at >= 0 ? at : state.lastCheckedAt });
    }).finally(() => { if (active === task) { active = null; publish({ busy: false }); arm(); } }).then(() => structuredClone(state));
    active = task; return task;
  }
  return {
    tick, getState: () => structuredClone(state),
    start() { if (!closed && !started) { started = true; publish({ running: true }); void tick(); } return structuredClone(state); },
    async stop() { closed = true; started = false; if (timer !== null) { clearTimer(timer); timer = null; }
      publish({ running: false }); if (active) await active; }
  };
}
module.exports = { createAssetVerificationWorker };
