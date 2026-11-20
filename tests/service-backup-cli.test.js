'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { runServiceBackupCli, validateBackupRequest } = require('../src/service-backup-cli');
function capture() { let value = ''; return { stream: new Writable({ write(chunk, encoding, done) { value += chunk; done(); } }), text: () => value }; }
async function run(request, overrides = {}) {
  const output = capture(), errorOutput = capture();
  const result = await runServiceBackupCli({ argv: [], input: Readable.from([typeof request === 'string' ? request : JSON.stringify(request)]),
    output: output.stream, errorOutput: errorOutput.stream, ...overrides });
  return { result, output: output.text(), error: errorOutput.text() };
}
test('CLI sends exact owner backup, verify and reviewed restore requests without printing private paths or keys', async () => {
  const config = { directory: '/private/live-history', keyring: { decrypt() {} }, assets: { directory: '/private/live-assets', signingKey: Buffer.alloc(32) } };
  const calls = [], expected = { verified: true, sha256: 'a'.repeat(64), requiresSeparateKeys: true };
  const options = { loadConfig: async filename => { assert.equal(filename, '/private/service.json'); return config; }, operations: Object.fromEntries(['createServiceBackup', 'verifyServiceBackup', 'restoreServiceBackup']
    .map(method => [method, async input => { calls.push({ method, input }); return expected; }])) };
  for (const request of [
    { action: 'backup', configPath: '/private/service.json', destination: '/private/snapshot' },
    { action: 'verify', configPath: '/private/service.json', backupDirectory: '/private/snapshot' },
    { action: 'restore', configPath: '/private/service.json', backupDirectory: '/private/snapshot', destination: '/private/new-service', expectedSha256: 'a'.repeat(64), confirmed: true }
  ]) { const result = await run(request, options); assert.equal(result.result, 0); assert.deepEqual(JSON.parse(result.output), expected); assert.equal(result.error, ''); assert.equal(result.output.includes('/private'), false); }
  assert.equal(calls[0].input.directory, config.directory); assert.equal(calls[0].input.assetsDirectory, config.assets.directory);
  assert.equal(calls[2].input.confirmed, true); assert.equal(calls[2].input.expectedSha256, 'a'.repeat(64));
  assert.equal(calls.some(call => Object.hasOwn(call.input, 'signingKey')), false);
});
test('CLI rejects argument credentials, excessive input, unknown fields and an unconfirmed restore before storage access', async () => {
  let loaded = false; const options = { loadConfig: async () => { loaded = true; } };
  for (const request of [{ action: 'backup', configPath: '/private/service.json', destination: '/private/snapshot', accessToken: 'secret' },
    { action: 'restore', configPath: '/private/service.json', backupDirectory: '/private/snapshot', destination: '/private/new', expectedSha256: 'a'.repeat(64), confirmed: false },
    { action: 'backup', configPath: 'relative.json', destination: '/private/snapshot' }, 'x'.repeat(65537)]) {
    assert.equal((await run(request, options)).result, 1);
  }
  assert.equal((await run('{}', { ...options, argv: ['--password', 'secret'] })).result, 1); assert.equal(loaded, false);
  assert.throws(() => validateBackupRequest({ action: 'restore', configPath: '/private/service.json', backupDirectory: '/private/snapshot', destination: '/private/new', expectedSha256: 'bad', confirmed: true }), { code: 'backup-review-required' });
});
test('CLI offers private local incident intake and returns allowlisted failures without exception details', async () => {
  let recorded;
  const record = { category: 'security', severity: 'high', stage: 'opened', buildVersion: '0.1.0', errorCodes: ['forbidden'], backupSha256: null };
  const saved = await run({ action: 'record-incident', directory: '/private/incidents', record }, { operations: { recordOwnerIncident: async input => { recorded = input; return { saved: true }; } } });
  assert.equal(saved.result, 0); assert.deepEqual(recorded.record, record);
  for (const code of ['backup-source-changed', 'backup-storage-uncertain', '/private/secret']) {
    const result = await run({ action: 'verify', configPath: '/private/service.json', backupDirectory: '/private/snapshot' }, {
      loadConfig: async () => ({ keyring: {} }), operations: { verifyServiceBackup: async () => { throw Object.assign(new Error('/private/password Bearer secret'), { code }); } }
    });
    assert.equal(result.result, 1); assert.equal(result.output, ''); assert.equal(result.error.includes('private'), false); assert.equal(result.error.includes('Bearer'), false);
  }
});
