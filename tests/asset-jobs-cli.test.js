'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { runAssetJobsCli } = require('../src/asset-jobs-cli');
const base = { origin: 'https://jobs.example.test', accessToken: 'o'.repeat(43), projectId: 'film' };
async function run(value, createClient, argv = []) {
  let output = '', error = '';
  const code = await runAssetJobsCli({ argv, input: Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]),
    output: { write: text => output += text }, errorOutput: { write: text => error += text }, createClient }); return { code, output, error };
}
test('job CLI supports all six actions with credentials only on stdin', async () => {
  const aid = `sha256:${'a'.repeat(64)}`;
  for (const value of [{ action: 'submit', input: { assetId: aid, idempotencyKey: 'key' } }, { action: 'get', jobId: 'job-id' },
    { action: 'list', input: { afterJobId: null, limit: 100 } }, { action: 'cancel', jobId: 'job-id', input: { expectedRun: 1, idempotencyKey: 'cancel' } },
    { action: 'retry', jobId: 'job-id', input: { expectedRun: 1, idempotencyKey: 'retry' } }, { action: 'metrics' }]) {
    const calls = [];
    const result = await run({ ...base, ...value }, config => {
      assert.equal(config.getAccessToken(), base.accessToken);
      return Object.fromEntries(['submitVerificationJob', 'getVerificationJob', 'listVerificationJobs', 'cancelVerificationJob', 'retryVerificationJob', 'getVerificationMetrics']
        .map(method => [method, async (...args) => { calls.push({ method, args }); return { accepted: true }; }]));
    });
    assert.equal(result.code, 0); assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'film'); assert.equal(result.output.includes(base.accessToken), false);
  }
});
test('job CLI validates before service access and redacts private failures', async () => {
  let calls = 0;
  const factory = () => { calls++; return { getVerificationMetrics() { throw new Error('/private/media token-secret'); } }; };
  for (const value of ['bad json', 'x'.repeat(65537), { ...base, action: 'claim' }, { ...base, action: 'metrics', origin: 'http://unsafe.test' },
    { ...base, action: 'list', input: { afterJobId: null, limit: 101 } }, { ...base, action: 'cancel', jobId: 'job', input: { expectedRun: 0, idempotencyKey: 'bad' } }]) {
    assert.equal((await run(value, factory)).code, 1);
  }
  assert.equal((await run({ ...base, action: 'metrics' }, factory, ['--token', base.accessToken])).code, 1); assert.equal(calls, 0);
  const failed = await run({ ...base, action: 'metrics' }, factory); assert.equal(failed.error, 'asset-job-operation-failed\n'); assert.equal(failed.output, '');
});
