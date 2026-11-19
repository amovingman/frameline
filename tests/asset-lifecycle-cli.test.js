'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { runAssetLifecycleCli, validateLifecycleCliRequest } = require('../src/asset-lifecycle-cli');
const token = 'o'.repeat(43), assetId = `sha256:${'a'.repeat(64)}`;
const base = { origin: 'https://studio.example.test', accessToken: token, projectId: 'film' };
async function run(request, factory, argv = []) {
  let output = '', error = '';
  const code = await runAssetLifecycleCli({ argv, input: Readable.from([typeof request === 'string' ? request : JSON.stringify(request)]),
    output: { write: value => output += value }, errorOutput: { write: value => error += value }, createClient: factory });
  return { code, output, error };
}
test('CLI sends all five explicit lifecycle operations and keeps credentials out of output', async () => {
  for (const request of [
    { action: 'hold-set', assetId, input: { expectedVersion: 0, reason: 'manual', until: null, idempotencyKey: 'hold' } },
    { action: 'hold-release', assetId, input: { expectedVersion: 1, idempotencyKey: 'release' } },
    { action: 'retention-set', input: { expectedVersion: 0, minimumArchiveAgeMs: 86400000, idempotencyKey: 'retention' } },
    { action: 'report', input: { afterAssetId: null, limit: 100 } },
    { action: 'plan', input: { assetIds: [assetId], expectedStateHash: 'b'.repeat(64) } }
  ]) {
    const calls = [];
    const result = await run({ ...base, ...request }, config => {
      assert.equal(config.getAccessToken(), token); assert.equal(config.origin, base.origin);
      return Object.fromEntries(['setHold', 'setRetentionPolicy', 'getLifecycleReport', 'planCleanup'].map(method => [method, async (...args) => {
        calls.push({ method, args }); return { accepted: true };
      }]));
    });
    assert.equal(result.code, 0); assert.equal(result.error, ''); assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'film');
    assert.doesNotMatch(result.output, new RegExp(token));
    if (request.action === 'hold-release') assert.deepEqual(calls[0].args[2], { expectedVersion: 1, held: false, reason: null, until: null, idempotencyKey: 'release' });
  }
});
test('CLI rejects unbounded/ambiguous input and argument credentials before touching the service', async () => {
  let calls = 0; const factory = () => { calls++; return {}; };
  for (const raw of ['bad json', 'x'.repeat(65537), { ...base, action: 'delete' },
    { ...base, origin: 'http://studio.example.test', action: 'retention-get' },
    { ...base, action: 'hold-release', assetId, input: { expectedVersion: 1, idempotencyKey: 'key', delete: true } },
    { ...base, action: 'report', input: { afterAssetId: null, limit: 1000 } }]) {
    assert.equal((await run(raw, factory)).code, 1);
  }
  assert.equal((await run({ ...base, action: 'retention-get' }, factory, ['--token', token])).code, 1); assert.equal(calls, 0);
});
test('CLI reports safe retry codes and redacts private exception text', async () => {
  const request = { ...base, action: 'retention-get' };
  for (const code of ['asset-lifecycle-plan-stale', 'unknown-private-code']) {
    const result = await run(request, () => ({ getRetentionPolicy() { throw Object.assign(new Error(`/private/camera ${token}`), { code }); } }));
    assert.equal(result.code, 1); assert.equal(result.output, '');
    assert.equal(result.error, code === 'unknown-private-code' ? 'asset-lifecycle-operation-failed\n' : `${code}\n`);
    assert.doesNotMatch(result.error, /private|camera|Bearer/);
  }
  assert.equal(validateLifecycleCliRequest({ ...base, action: 'retention-get' }).origin, base.origin);
});
