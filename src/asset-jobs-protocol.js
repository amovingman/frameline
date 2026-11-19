'use strict';
const { exact, id, asset, hash, integer, time, fail } = require('./asset-lifecycle-protocol');
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const JOB_ERRORS = ['asset-job-interrupted', 'asset-job-attempts-exhausted', 'asset-job-access-denied', 'asset-job-worker-failed',
  'asset-chunk-corrupt', 'asset-content-mismatch', 'asset-policy-excluded', 'asset-archived', 'asset-not-found'];
const MAX_ATTEMPTS = 3, MAX_JOBS = 10000, MAX_RECEIPTS = 20000;
const check = (value, code = 'asset-job-invalid') => { if (!value) throw fail(code); };
function validateJobSubmit(value) {
  check(exact(value, ['assetId', 'idempotencyKey']) && asset(value.assetId) && id(value.idempotencyKey)); return structuredClone(value);
}
function validateJobAction(value) {
  check(exact(value, ['expectedRun', 'idempotencyKey']) && integer(value.expectedRun) && value.expectedRun > 0 && id(value.idempotencyKey)); return structuredClone(value);
}
function validateJobPageInput(value) {
  check(exact(value, ['afterJobId', 'limit']) && (value.afterJobId === null || id(value.afterJobId))
    && integer(value.limit, 100) && value.limit > 0); return structuredClone(value);
}
const PUBLIC_FIELDS = ['id', 'projectId', 'actorId', 'assetId', 'type', 'assetClass', 'size', 'status', 'run', 'attempts',
  'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'progressBytes', 'leaseExpiresAt', 'elapsedMs', 'result', 'error'];
function validateAssetJob(value) {
  check(exact(value, PUBLIC_FIELDS) && ['id', 'projectId', 'actorId'].every(key => id(value[key])) && asset(value.assetId)
    && value.type === 'asset-verify' && ['original', 'proxy', 'audio', 'graphics', 'other'].includes(value.assetClass)
    && integer(value.size, 64 * 1024 ** 3) && STATUSES.includes(value.status) && integer(value.run, MAX_RECEIPTS) && value.run > 0
    && integer(value.attempts, MAX_ATTEMPTS) && time(value.createdAt) && time(value.updatedAt) && value.updatedAt >= value.createdAt
    && (value.startedAt === null || time(value.startedAt)) && (value.finishedAt === null || time(value.finishedAt))
    && integer(value.progressBytes, value.size) && integer(value.elapsedMs), 'asset-response-invalid');
  check(value.status === 'running' ? time(value.leaseExpiresAt) && value.leaseExpiresAt > value.updatedAt
    && time(value.startedAt) && value.attempts > 0 && value.finishedAt === null
    : value.leaseExpiresAt === null, 'asset-response-invalid');
  check(['queued', 'running'].includes(value.status) ? value.finishedAt === null && value.error === null && value.result === null
    : time(value.finishedAt), 'asset-response-invalid');
  if (value.status === 'succeeded') {
    check(exact(value.result, ['verified', 'sha256', 'size', 'checkedAt']) && value.result.verified === true
      && hash(value.result.sha256) && `sha256:${value.result.sha256}` === value.assetId && value.result.size === value.size
      && value.result.checkedAt === value.finishedAt && value.progressBytes === value.size && value.error === null && value.attempts > 0, 'asset-response-invalid');
  } else check(value.result === null && (value.status === 'failed' ? JOB_ERRORS.includes(value.error) : value.error === null), 'asset-response-invalid');
  return structuredClone(value);
}
function validateJobPage(value) {
  check(exact(value, ['projectId', 'items', 'nextJobId']) && id(value.projectId) && Array.isArray(value.items) && value.items.length <= 100
    && (value.nextJobId === null || id(value.nextJobId)), 'asset-response-invalid');
  let previous = '';
  for (const job of value.items) { validateAssetJob(job); check(job.projectId === value.projectId && job.id > previous, 'asset-response-invalid'); previous = job.id; }
  check(value.nextJobId === null || value.items.length > 0 && value.nextJobId === previous, 'asset-response-invalid'); return structuredClone(value);
}
function validateJobMetrics(value) {
  check(exact(value, ['projectId', 'totalJobs', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'attempts', 'verifiedBytes', 'processingMs'])
    && id(value.projectId) && Object.keys(value).filter(key => key !== 'projectId').every(key => integer(value[key]))
    && value.totalJobs <= MAX_JOBS && STATUSES.reduce((sum, key) => sum + value[key], 0) === value.totalJobs
    && value.attempts <= value.totalJobs * MAX_ATTEMPTS, 'asset-response-invalid'); return structuredClone(value);
}
module.exports = { STATUSES, JOB_ERRORS, MAX_ATTEMPTS, MAX_JOBS, MAX_RECEIPTS, PUBLIC_FIELDS,
  validateJobSubmit, validateJobAction, validateJobPageInput, validateAssetJob, validateJobPage, validateJobMetrics };
