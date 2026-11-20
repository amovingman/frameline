'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { runRevisionMediaCli, validateRevisionMediaCliRequest } = require('../src/revision-media-cli');
const token = 'o'.repeat(43), base = { origin: 'https://personal.example.test', accessToken: token, projectId: 'film' };
async function run(value, options = {}) {
  let output = '', error = ''; const calls = [];
  const createClient = settings => { assert.equal(settings.getAccessToken(), token); assert.equal(settings.origin, base.origin); return {}; };
  const code = await runRevisionMediaCli({ argv: [], input: Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]),
    output: { write: value => output += value }, errorOutput: { write: value => error += value },
    createRevisionClient: createClient, createAssetClient: createClient,
    createWorkflow: () => Object.fromEntries(['inspect', 'publish', 'availability', 'download', 'getPolicy', 'setPolicy'].map(method => [method, async (...args) => {
      calls.push({ method, args }); return { accepted: true };
    }])), ...options });
  return { code, output, error, calls };
}
test('CLI exposes the complete owner media workflow and explicit separate policy consent without argument credentials', async () => {
  const cases = [
    ['inspect', { exportPath: '/private/selected.fcpxml', branch: 'main', expectedHead: null, message: 'Media bound revision', uploadMedia: true }, 'inspect'],
    ['publish', { exportPath: '/private/selected.fcpxml', branch: 'main', expectedHead: null, message: 'Media bound revision', idempotencyKey: 'publish-one', uploadMedia: true, reviewHash: 'a'.repeat(64) }, 'publish'],
    ['availability', { revisionId: 'selected-revision', localFiles: ['/private/original.mov'] }, 'availability'],
    ['download', { revisionId: 'selected-revision', destinationDirectory: '/private/downloads', workDirectory: '/private/work', maxBytesPerSecond: 1024 }, 'download'],
    ['policy-get', {}, 'getPolicy'], ['policy-set', { expectedVersion: 0, syncClasses: ['original'] }, 'setPolicy']
  ];
  for (const [action, input, method] of cases) {
    const result = await run({ ...base, action, input }); assert.equal(result.code, 0); assert.equal(result.error, '');
    assert.equal(result.calls.length, 1); assert.equal(result.calls[0].method, method);
    assert.equal(result.calls[0].args[0].projectId, 'film'); assert.doesNotMatch(result.output, /private|accessToken|Bearer/);
    assert.doesNotMatch(result.output, new RegExp(token));
  }
});
test('CLI refuses arbitrary selected asset IDs, unbounded input, protocols and invalid consent before creating clients', async () => {
  let clients = 0; const createRevisionClient = () => { clients++; return {}; };
  for (const value of [
    'bad json', 'x'.repeat(256 * 1024 + 1), { ...base, action: 'download', input: { revisionId: 'revision', destinationDirectory: '/private/out', workDirectory: '/private/work', assetIds: ['arbitrary'] } },
    { ...base, origin: 'http://personal.example.test', action: 'policy-get', input: {} },
    { ...base, action: 'publish', input: { exportPath: '/private/source.fcpxml', branch: 'main', expectedHead: null, message: 'Capture', idempotencyKey: 'id', uploadMedia: 'yes' } },
    { ...base, action: 'availability', input: { revisionId: 'revision', localFiles: ['https://host/media.mov'] } },
    { ...base, action: 'policy-set', input: { expectedVersion: 0, syncClasses: ['original', 'original'] } }
  ]) assert.equal((await run(value, { createRevisionClient })).code, 1);
  assert.equal(clients, 0);
  assert.throws(() => validateRevisionMediaCliRequest({ ...base, action: 'policy-get', input: {}, tokenOnArgs: token }), { code: 'revision-media-input-invalid' });
});
test('CLI emits only bounded counters in progress and allowlisted failure codes', async () => {
  for (const code of ['asset-revision-media-missing', 'asset-revision-identity-mismatch', 'asset-revision-unavailable', '/private/secret-code']) {
    const result = await run({ ...base, action: 'publish', input: { exportPath: '/private/source.fcpxml', branch: 'main', expectedHead: null,
      message: 'Capture', idempotencyKey: 'id', uploadMedia: true, reviewHash: 'a'.repeat(64) } }, { createWorkflow: () => ({ async publish(_input, controls) {
      controls.onProgress({ phase: 'hashing', bytes: 4, totalBytes: 100, sourcePath: '/private/camera.mov', accessToken: token });
      throw Object.assign(new Error(`Bearer ${token} /private/camera.mov`), { code });
    } }) });
    assert.equal(result.code, 1); assert.equal(result.output, ''); assert.doesNotMatch(result.error, /private|accessToken|Bearer/); assert.doesNotMatch(result.error, new RegExp(token));
    assert.match(result.error, /"phase":"hashing","bytes":4,"totalBytes":100/);
    assert.ok(result.error.endsWith(code.startsWith('asset-') ? `${code}\n` : 'revision-media-operation-failed\n'));
  }
});
test('pre-cancelled CLI input never contacts a service and reports a safe cancellation code', async () => {
  const controller = new AbortController(); controller.abort(); let clients = 0;
  const result = await run({ ...base, action: 'policy-get', input: {} }, { signal: controller.signal, createRevisionClient: () => { clients++; return {}; } });
  assert.equal(result.code, 1); assert.equal(result.error, 'revision-media-cancelled\n'); assert.equal(clients, 0);
});

test('CLI inspect needs explicit upload choice and publish requires the exact review hash before client creation', async () => {
  const input = { exportPath: '/private/source.fcpxml', branch: 'main', expectedHead: null, message: 'Owner reviewed capture', uploadMedia: false };
  assert.equal((await run({ ...base, action: 'inspect', input })).calls[0].method, 'inspect');
  let clients = 0;
  for (const patch of [{}, { reviewHash: 'bad' }, { reviewHash: 'b'.repeat(64), message: '/private/secret' }]) {
    const result = await run({ ...base, action: 'publish', input: { ...input, idempotencyKey: 'publish', ...patch } }, { createRevisionClient: () => { clients++; return {}; } });
    assert.equal(result.code, 1);
  }
  assert.equal(clients, 0);
  for (const code of ['revision-media-review-required', 'revision-media-review-changed']) {
    const result = await run({ ...base, action: 'publish', input: { ...input, idempotencyKey: 'publish', reviewHash: 'b'.repeat(64) } },
      { createWorkflow: () => ({ async publish() { throw Object.assign(new Error('/private/secret'), { code }); } }) });
    assert.equal(result.error, `${code}\n`);
  }
});
