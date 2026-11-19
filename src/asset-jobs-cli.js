'use strict';
const { TextDecoder } = require('node:util');
const { createAssetHttpClient } = require('./asset-http-client');
const { exact, id, fail } = require('./asset-lifecycle-protocol');
const { validateJobSubmit, validateJobAction, validateJobPageInput } = require('./asset-jobs-protocol');
const SAFE = new Set(['asset-job-invalid', 'asset-job-not-found', 'asset-job-forbidden', 'asset-job-idempotency-conflict',
  'asset-job-run-stale', 'asset-job-state-conflict', 'asset-job-attempts-exhausted', 'asset-policy-excluded', 'asset-archived',
  'forbidden', 'access-token-invalid', 'asset-network-unavailable', 'asset-response-invalid', 'asset-not-found', 'asset-capacity-exceeded',
  'asset-storage-unavailable', 'asset-storage-uncertain']);
function validateJobCliRequest(value) {
  if (!value || !['submit', 'get', 'list', 'cancel', 'retry', 'metrics'].includes(value.action)) throw fail('asset-job-invalid');
  const withJob = ['get', 'cancel', 'retry'].includes(value.action), withInput = !['get', 'metrics'].includes(value.action);
  if (!exact(value, ['origin', 'accessToken', 'projectId', 'action', ...(withJob ? ['jobId'] : []), ...(withInput ? ['input'] : [])])
    || !id(value.projectId) || withJob && !id(value.jobId) || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken)
    || typeof value.origin !== 'string' || value.origin.length > 2048) throw fail('asset-job-invalid');
  let url; try { url = new URL(value.origin); } catch { throw fail('asset-job-invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('asset-job-invalid');
  if (value.action === 'submit') validateJobSubmit(value.input);
  else if (value.action === 'list') validateJobPageInput(value.input);
  else if (withInput) validateJobAction(value.input);
  return structuredClone({ ...value, origin: url.origin });
}
async function runAssetJobsCli({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, createClient = createAssetHttpClient } = {}) {
  try {
    if (argv.length) throw fail('asset-job-invalid'); const chunks = []; let size = 0;
    for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 64 * 1024) throw fail('asset-job-invalid'); chunks.push(bytes); }
    let raw; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { throw fail('asset-job-invalid'); }
    const value = validateJobCliRequest(raw), client = createClient({ origin: value.origin, getAccessToken: () => value.accessToken });
    const methods = { submit: 'submitVerificationJob', get: 'getVerificationJob', list: 'listVerificationJobs', cancel: 'cancelVerificationJob', retry: 'retryVerificationJob', metrics: 'getVerificationMetrics' };
    const args = [value.projectId, ...(['get', 'cancel', 'retry'].includes(value.action) ? [value.jobId] : []),
      ...(!['get', 'metrics'].includes(value.action) ? [value.input] : [])];
    output.write(`${JSON.stringify(await client[methods[value.action]](...args))}\n`); return 0;
  } catch (error) { errorOutput.write(`${SAFE.has(error?.code) ? error.code : 'asset-job-operation-failed'}\n`); return 1; }
}
if (require.main === module) runAssetJobsCli().then(code => { process.exitCode = code; }, () => { process.stderr.write('asset-job-operation-failed\n'); process.exitCode = 1; });
module.exports = { runAssetJobsCli, validateJobCliRequest };
