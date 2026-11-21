'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCloudBackupArgs, runCloudBackupCli } = require('../src/cloud-backup-cli');
const { loadCloudBackupConfig, validateCloudBackupConfig } = require('../src/cloud-backup-config');
const hash = 'a'.repeat(64);
const config = { version: 1, provider: 'aws-s3', region: 'us-east-1', bucket: 'portfolio-fixture-backups' };

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cloud-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function invoke(options) {
  let stdout = '', stderr = '';
  const code = await runCloudBackupCli({ ...options,
    output: { write: text => { stdout += text; } }, errorOutput: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}

test('cloud CLI refuses credential flags, duplicate flags and ambiguous paths before loading configuration or making requests', async () => {
  for (const argv of [[], ['upload'], ['inspect', '--file', 'relative.json'],
    ['inspect', '--file', '/tmp/a', '--file', '/tmp/b'], ['list', '--config', '/tmp/config', '--access-key', 'PRIVATE'],
    ['download', '--config', '/tmp/config', '--sha256', hash, '--destination', '/tmp/a', '--force', 'true']]) {
    const result = await invoke({ argv, loadConfig: () => { throw Error('must not read config'); } });
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'cloud-backup-options-invalid\n');
  }
  assert.equal(parseCloudBackupArgs(['upload', '--file', '/bundle.json', '--config', '/config.json', '--sha256', hash]).sha256, hash);
});

test('private configuration accepts only a bounded AWS bucket/region, never embedded credentials or endpoints', async t => {
  const directory = await temporary(t), filename = path.join(directory, 'config.json');
  await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadCloudBackupConfig(filename), config);
  for (const value of [{ ...config, secretAccessKey: 'SECRET' }, { ...config, endpoint: 'http://elsewhere' },
    { ...config, region: 'cn-north-1' }, { ...config, region: 'us-gov-west-1' }, { ...config, bucket: 'dotted.bucket' },
    { ...config, bucket: 'https://elsewhere' }, { ...config, provider: 'other' }]) {
    assert.throws(() => validateCloudBackupConfig(value), { code: 'cloud-backup-config-invalid' });
  }
  if (process.platform !== 'win32') {
    await fs.chmod(filename, 0o644);
    await assert.rejects(loadCloudBackupConfig(filename), { code: 'cloud-backup-config-invalid' });
    await fs.chmod(filename, 0o600);
  }
  await fs.symlink(filename, path.join(directory, 'link.json'));
  await assert.rejects(loadCloudBackupConfig(path.join(directory, 'link.json')), { code: 'cloud-backup-config-invalid' });
  await fs.writeFile(filename, 'x'.repeat(4097));
  await assert.rejects(loadCloudBackupConfig(filename), { code: 'cloud-backup-config-invalid' });
});

test('inspect stays local; explicit upload/list/download pass only reviewed inputs and always close the transport', async () => {
  const summary = { sha256: hash, revisionCount: 2 };
  assert.deepEqual(await invoke({ argv: ['inspect', '--file', '/backup.json'],
    operations: { inspectBackup: async filename => { assert.equal(filename, '/backup.json'); return summary; } },
    loadConfig: () => assert.fail('local inspect must not load AWS configuration'),
    createTransport: () => assert.fail('local inspect must not create an AWS client') }),
  { code: 0, stdout: JSON.stringify(summary) + '\n', stderr: '' });
  const cases = [
    { action: 'upload', method: 'uploadBackup', args: ['--file', '/backup.json', '--sha256', hash], check: value => assert.equal(value.expectedSha256, hash) },
    { action: 'list', method: 'listBackups', args: ['--cursor', 'page-two'], check: value => assert.equal(value.continuationToken, 'page-two') },
    { action: 'download', method: 'downloadBackup', args: ['--sha256', hash, '--destination', '/new.json'], check: value => assert.equal(value.destination, '/new.json') }
  ];
  for (const entry of cases) {
    let closed = 0;
    const transport = { close: () => { closed++; } };
    const result = await invoke({ argv: [entry.action, '--config', '/config.json', ...entry.args],
      loadConfig: async filename => { assert.equal(filename, '/config.json'); return config; },
      createTransport: actual => { assert.deepEqual(actual, config); return transport; },
      operations: { [entry.method]: async value => { entry.check(value); assert.equal(value.transport, transport); assert(value.signal instanceof AbortSignal); return summary; } } });
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(closed, 1);
  }
});

test('provider exceptions never expose keys, signed requests, filenames or raw stacks', async () => {
  let closed = 0;
  const result = await invoke({ argv: ['list', '--config', '/config.json'], loadConfig: async () => config,
    createTransport: () => ({ close: () => { closed++; } }), operations: { listBackups: async () => {
      throw Object.assign(Error('PRIVATE /Users/private AWS_SECRET_ACCESS_KEY signed-url'), { code: 'Unknown PRIVATE' });
    } } });
  assert.deepEqual(result, { code: 1, stdout: '', stderr: 'cloud-backup-failed\n' });
  assert.equal(closed, 1);
});

test('timeout and cancellation abort the operation and release the owned client without a success result', async () => {
  for (const reason of ['timeout', 'cancel']) {
    const controller = new AbortController(); let aborted = false, closed = 0;
    const pending = invoke({ argv: ['list', '--config', '/config.json'], loadConfig: async () => config,
      createTransport: () => ({ close: () => { closed++; } }), signal: controller.signal, timeoutMs: reason === 'timeout' ? 10 : 1000,
      operations: { listBackups: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(Error('private cancellation cause')); }, { once: true });
      }) } });
    if (reason === 'cancel') setTimeout(() => controller.abort(), 10);
    const result = await pending;
    assert.equal(result.stderr, `cloud-backup-${reason === 'timeout' ? 'timeout' : 'cancelled'}\n`);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert(aborted); assert.equal(closed, 1);
  }
});

test('standalone help and refusal run without cloud credentials or reading private configuration', () => {
  const file = path.join(__dirname, '../src/cloud-backup-cli.js');
  const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /inspect.*--file/); assert.equal(help.stderr, '');
  const refused = spawnSync(process.execPath, [file, 'upload', '--access-key', 'PRIVATE'], { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(refused.stderr, 'cloud-backup-options-invalid\n'); assert.equal(refused.stdout, '');
});
