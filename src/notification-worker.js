'use strict';
const SAFE_ERRORS = new Set(['smtp-config-invalid', 'smtp-message-invalid', 'smtp-cancelled', 'smtp-protocol-invalid',
  'smtp-transient-failure', 'smtp-auth-failed', 'smtp-auth-unavailable', 'smtp-rejected', 'smtp-tls-unavailable',
  'smtp-delivery-uncertain', 'smtp-network-unavailable', 'smtp-timeout', 'smtp-preparation-unavailable',
  'notification-capacity', 'notification-delivery-unavailable', 'notification-job-unavailable', 'notification-lease-invalid', 'notification-lease-expired',
  'collaboration-storage-unavailable', 'collaboration-storage-uncertain', 'collaboration-service-busy', 'collaboration-service-closed']);
const safeError = value => SAFE_ERRORS.has(value?.code) ? value.code : 'notification-worker-unavailable';
const fail = code => Object.assign(new Error(code), { code });

// One host tick schedules durable work and submits bounded leases. SMTP awaits
// never hold the collaboration transaction queue or its filesystem lock.
function createNotificationWorker({ notifications, sender, onChange = () => {}, intervalMs = 30_000,
  leaseMs = 60_000, maxPerTick = 10, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  if (!notifications || !['schedule', 'claim', 'prepare', 'acknowledge', 'fail'].every(key => typeof notifications[key] === 'function')
    || !sender || typeof sender.send !== 'function' || typeof sender.close !== 'function' || typeof onChange !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000
    || !Number.isSafeInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > 100
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function' || typeof now !== 'function') throw fail('notification-worker-invalid');
  let state = { version: 0, running: false, busy: false, lastCheckedAt: null, accepted: 0, failed: 0, cancelled: 0, error: null };
  let closed = false, timer = null, active = null, controller = null;
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { Promise.resolve(onChange(structuredClone(state))).catch(() => {}); } catch { /* Observability cannot undo a delivery receipt. */ }
  }
  function arm() {
    if (closed || !state.running || active || timer !== null) return;
    timer = setTimer(() => { timer = null; void tick(); }, intervalMs); timer?.unref?.();
  }
  function tick() {
    if (closed) return Promise.resolve(structuredClone(state));
    if (active) return active;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const operation = new AbortController(); controller = operation;
    publish({ busy: true, error: null });
    const task = Promise.resolve().then(async () => {
      try {
        await notifications.schedule({ limit: 100 });
        for (let count = 0; count < maxPerTick && !closed; count++) {
          const claim = await notifications.claim({ leaseMs });
          if (claim === null) break;
          if (!claim || typeof claim.jobId !== 'string' || typeof claim.claimToken !== 'string') throw fail('notification-worker-unavailable');
          const proof = { jobId: claim.jobId, claimToken: claim.claimToken };
          try {
            const prepared = await notifications.prepare(proof);
            if (prepared === null || closed) { publish({ cancelled: state.cancelled + 1 }); continue; }
            const result = await sender.send(prepared, { signal: operation.signal, beforeData: () => notifications.prepare(proof) });
            if (result === null) { publish({ cancelled: state.cancelled + 1 }); continue; }
            if (result?.accepted !== true) throw fail('notification-worker-unavailable');
            await notifications.acknowledge(proof);
            publish({ accepted: state.accepted + 1 });
          } catch (error) {
            // A lost DATA acknowledgment may have been accepted. Keep the stable
            // message ID and bounded retry policy; do not claim exactly-once SMTP.
            try { await notifications.fail({ ...proof, retryable: error?.retryable !== false }); } catch { /* Uncertain storage needs validated reopen. */ }
            publish({ failed: state.failed + 1, error: safeError(error) });
          }
        }
      } catch (error) { publish({ error: safeError(error) }); }
      const at = now();
      publish({ lastCheckedAt: Number.isSafeInteger(at) && at >= 0 ? at : state.lastCheckedAt });
    }).finally(() => {
      if (active === task) { active = null; controller = null; publish({ busy: false }); arm(); }
    }).then(() => structuredClone(state));
    active = task; return task;
  }
  function start() { if (!closed && !state.running) { publish({ running: true }); void tick(); } return structuredClone(state); }
  async function stop() {
    if (closed) { if (active) await active; return; }
    closed = true; if (timer !== null) { clearTimer(timer); timer = null; }
    publish({ running: false }); controller?.abort(); sender.close(); if (active) await active;
  }
  return { start, tick, stop, getState: () => structuredClone(state) };
}
module.exports = { createNotificationWorker };
