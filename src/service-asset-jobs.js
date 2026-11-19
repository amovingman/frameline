'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { exact, id, asset, hash, integer, time, MAX_TIME, fail } = require('./asset-lifecycle-protocol');
const { STATUSES, JOB_ERRORS, MAX_ATTEMPTS, MAX_JOBS, MAX_RECEIPTS, PUBLIC_FIELDS, validateJobSubmit,
  validateJobAction, validateJobPageInput, validateAssetJob, validateJobPage, validateJobMetrics } = require('./asset-jobs-protocol');
const emptyAssetJobs = () => ({ version: 1, jobs: [], receipts: [] });
const publicJob = job => Object.fromEntries(PUBLIC_FIELDS.map(key => [key, key === 'leaseExpiresAt' ? job.lease?.until ?? null : structuredClone(job[key])]));
function validateAssetJobsState(value, assets, uploads) {
  try {
    if (!exact(value, ['version', 'jobs', 'receipts']) || value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > MAX_JOBS
      || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) throw fail('invalid');
    const byId = new Map(), keys = new Set(), submitted = new Set(), uploaded = new Map(uploads.map(item => [item.id, item]));
    const published = new Map(assets.map(item => [JSON.stringify([item.projectId, item.assetId]), item]));
    for (const job of value.jobs) {
      if (!exact(job, [...PUBLIC_FIELDS.filter(key => key !== 'leaseExpiresAt'), 'lease']) || byId.has(job.id)) throw fail('invalid');
      validateAssetJob(publicJob(job));
      const known = uploaded.get(published.get(JSON.stringify([job.projectId, job.assetId]))?.uploadId);
      if (!known || known.identity.size !== job.size || known.identity.assetClass !== job.assetClass
        || (job.status === 'running' ? !exact(job.lease, ['token', 'until']) || !id(job.lease.token) : job.lease !== null)
        || job.startedAt !== null && (job.startedAt < job.createdAt || job.startedAt > job.updatedAt)
        || job.finishedAt !== null && (job.finishedAt < job.createdAt || job.finishedAt > job.updatedAt)
        || job.status === 'queued' && job.progressBytes !== 0) throw fail('invalid');
      byId.set(job.id, job);
    }
    for (const receipt of value.receipts) {
      if (!exact(receipt, ['keyHash', 'requestHash', 'actorId', 'projectId', 'kind', 'input', 'jobId'])
        || !hash(receipt.keyHash) || keys.has(receipt.keyHash) || !hash(receipt.requestHash) || !id(receipt.actorId) || !id(receipt.projectId)
        || !['submit', 'cancel', 'retry'].includes(receipt.kind) || !byId.has(receipt.jobId)) throw fail('invalid');
      const target = byId.get(receipt.jobId), input = receipt.input;
      if (receipt.kind === 'submit') {
        if (!exact(input, ['assetId']) || !asset(input.assetId) || target.assetId !== input.assetId || target.actorId !== receipt.actorId) throw fail('invalid');
        submitted.add(receipt.jobId);
      } else {
        if (!exact(input, ['jobId', 'expectedRun']) || input.jobId !== receipt.jobId || !integer(input.expectedRun) || input.expectedRun < 1
          || input.expectedRun > target.run) throw fail('invalid');
      }
      if (target.projectId !== receipt.projectId || receipt.requestHash !== fingerprint({ actorId: receipt.actorId,
        projectId: receipt.projectId, kind: receipt.kind, input })) throw fail('invalid');
      keys.add(receipt.keyHash);
    }
    if (value.jobs.some(job => !submitted.has(job.id))) throw fail('invalid');
    return structuredClone(value);
  } catch { throw fail('asset-state-invalid'); }
}
function createAssetJobOperations({ now = Date.now } = {}) {
  function clock() { const at = now(); if (!time(at) || at > MAX_TIME - 300000) throw fail('asset-job-invalid'); return at; }
  function get(state, projectId, jobId) {
    if (!id(jobId)) throw fail('asset-job-invalid');
    const job = state.jobs.jobs.find(item => item.id === jobId && item.projectId === projectId);
    if (!job) throw fail('asset-job-not-found'); return job;
  }
  function elapsed(job, at) {
    if (job.status === 'running') job.elapsedMs = Math.min(Number.MAX_SAFE_INTEGER, job.elapsedMs + Math.max(0, at - job.startedAt));
  }
  function finish(job, at, status, error = null, result = null) {
    elapsed(job, at); Object.assign(job, { status, error, result, finishedAt: at, updatedAt: at, lease: null });
  }
  function receipt(state, actorId, projectId, kind, input, key) {
    if (!id(actorId) || !id(projectId)) throw fail('asset-job-invalid');
    const keyHash = fingerprint({ domain: 'asset-job-request-v1', actorId, projectId, key });
    const requestHash = fingerprint({ actorId, projectId, kind, input }), existing = state.jobs.receipts.find(item => item.keyHash === keyHash);
    if (existing && existing.requestHash !== requestHash) throw fail('asset-job-idempotency-conflict');
    return { keyHash, requestHash, actorId, projectId, kind, input, existing };
  }
  function saveReceipt(state, proof, job) {
    const { existing: _old, ...record } = proof;
    if (state.jobs.receipts.length >= MAX_RECEIPTS) throw fail('asset-capacity-exceeded');
    state.jobs.receipts.push({ ...record, jobId: job.id }); return publicJob(job);
  }
  function assertLease(state, claim) {
    if (!claim || !id(claim.jobId) || !id(claim.projectId) || !id(claim.actorId) || !id(claim.token)) throw fail('asset-job-lease-stale');
    const job = get(state, claim.projectId, claim.jobId);
    if (job.actorId !== claim.actorId || job.status !== 'running' || job.lease.token !== claim.token) throw fail('asset-job-lease-stale');
    if (job.lease.until <= clock()) throw fail('asset-job-lease-expired'); return job;
  }
  return {
    clock, get, publicJob, assertLease,
    submit(state, actorId, projectId, raw, verifyPublished) {
      const input = validateJobSubmit(raw), proof = receipt(state, actorId, projectId, 'submit', { assetId: input.assetId }, input.idempotencyKey);
      if (proof.existing) return publicJob(get(state, projectId, proof.existing.jobId));
      const upload = verifyPublished(input.assetId);
      let job = state.jobs.jobs.find(item => item.projectId === projectId && item.actorId === actorId && item.assetId === input.assetId && ['queued', 'running'].includes(item.status));
      if (!job) {
        if (state.jobs.jobs.length >= MAX_JOBS) throw fail('asset-capacity-exceeded'); const at = clock();
        job = { id: randomUUID(), projectId, actorId, assetId: input.assetId, type: 'asset-verify', assetClass: upload.identity.assetClass,
          size: upload.identity.size, status: 'queued', run: 1, attempts: 0, createdAt: at, updatedAt: at, startedAt: null,
          finishedAt: null, progressBytes: 0, elapsedMs: 0, lease: null, result: null, error: null };
        state.jobs.jobs.push(job);
      }
      return saveReceipt(state, proof, job);
    },
    action(state, actorId, projectId, jobId, kind, raw, verifyPublished) {
      const input = validateJobAction(raw), proof = receipt(state, actorId, projectId, kind, { jobId, expectedRun: input.expectedRun }, input.idempotencyKey);
      if (proof.existing) return publicJob(get(state, projectId, proof.existing.jobId));
      const job = get(state, projectId, jobId);
      if (job.run !== input.expectedRun) throw fail('asset-job-run-stale');
      const at = Math.max(clock(), job.updatedAt);
      if (kind === 'cancel') {
        if (!['queued', 'running'].includes(job.status)) throw fail('asset-job-state-conflict'); finish(job, at, 'cancelled');
      } else {
        if (!['failed', 'cancelled'].includes(job.status)) throw fail('asset-job-state-conflict');
        if (job.attempts >= MAX_ATTEMPTS || job.run >= MAX_RECEIPTS) throw fail('asset-job-attempts-exhausted');
        verifyPublished(job.assetId); Object.assign(job, { status: 'queued', run: job.run + 1, updatedAt: at,
          progressBytes: 0, finishedAt: null, startedAt: null, error: null, result: null, lease: null });
      }
      return saveReceipt(state, proof, job);
    },
    list(state, projectId, raw) {
      const input = validateJobPageInput(raw), jobs = state.jobs.jobs.filter(item => item.projectId === projectId
        && (input.afterJobId === null || item.id > input.afterJobId)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const selected = jobs.slice(0, input.limit);
      return validateJobPage({ projectId, items: selected.map(publicJob), nextJobId: jobs.length > selected.length ? selected.at(-1).id : null });
    },
    metrics(state, projectId) {
      const result = { projectId, totalJobs: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, attempts: 0, verifiedBytes: 0, processingMs: 0 };
      for (const job of state.jobs.jobs) if (job.projectId === projectId) {
        result.totalJobs++; result[job.status]++; result.attempts += job.attempts;
        if (job.status === 'succeeded') result.verifiedBytes += job.size;
        result.processingMs = Math.min(Number.MAX_SAFE_INTEGER, result.processingMs + job.elapsedMs);
      }
      return validateJobMetrics(result);
    },
    async claim(state, leaseMs, authorizeActor) {
      if (!integer(leaseMs, 300000) || leaseMs < 1000) throw fail('asset-job-invalid'); const at = clock();
      for (const job of state.jobs.jobs) if (job.status === 'running' && job.lease.until <= at) {
        // Time after the last lease deadline is downtime, not processing time.
        elapsed(job, Math.max(job.startedAt, job.lease.until));
        Object.assign(job, { status: job.attempts < MAX_ATTEMPTS ? 'queued' : 'failed', progressBytes: 0, lease: null,
          updatedAt: Math.max(at, job.updatedAt), finishedAt: job.attempts < MAX_ATTEMPTS ? null : Math.max(at, job.updatedAt),
          error: job.attempts < MAX_ATTEMPTS ? null : 'asset-job-attempts-exhausted', result: null });
      }
      // Stable sort retains submission order when the clock returns equal times.
      const job = state.jobs.jobs.filter(item => item.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!job) return null;
      const atJob = Math.max(at, job.updatedAt);
      try { await authorizeActor(job.actorId, job.projectId); }
      catch { finish(job, atJob, 'failed', 'asset-job-access-denied'); return null; }
      job.attempts++; Object.assign(job, { status: 'running', startedAt: atJob, finishedAt: null, updatedAt: atJob,
        progressBytes: 0, error: null, lease: { token: randomUUID(), until: atJob + leaseMs } });
      return { jobId: job.id, projectId: job.projectId, actorId: job.actorId, token: job.lease.token, leaseMs };
    },
    progress(state, claim, bytes) {
      const job = assertLease(state, claim); if (!integer(bytes, job.size) || bytes < job.progressBytes
        || !integer(claim.leaseMs, 300000) || claim.leaseMs < 1000) throw fail('asset-job-invalid');
      const at = Math.max(clock(), job.updatedAt); job.progressBytes = bytes; job.updatedAt = at; job.lease.until = Math.max(job.lease.until, at + claim.leaseMs);
      return publicJob(job);
    },
    complete(state, claim, result) {
      const job = assertLease(state, claim), at = Math.max(clock(), job.updatedAt);
      if (!exact(result, ['size', 'sha256']) || result.size !== job.size || `sha256:${result.sha256}` !== job.assetId) throw fail('asset-content-mismatch');
      job.progressBytes = job.size; finish(job, at, 'succeeded', null, { verified: true, ...result, checkedAt: at }); return publicJob(job);
    },
    fail(state, claim, code, interrupted = false) {
      const job = assertLease(state, claim), at = Math.max(clock(), job.updatedAt);
      if (interrupted && job.attempts < MAX_ATTEMPTS) {
        elapsed(job, at); Object.assign(job, { status: 'queued', updatedAt: at, progressBytes: 0, lease: null, startedAt: null });
      } else finish(job, at, 'failed', JOB_ERRORS.includes(code) ? code : 'asset-job-worker-failed');
      return publicJob(job);
    }
  };
}
module.exports = { emptyAssetJobs, validateAssetJobsState, createAssetJobOperations };
