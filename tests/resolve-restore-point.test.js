const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRestorePoint } = require('../src/resolve-restore-point');

const hash = (data) => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  // Resolve the temp root because some platforms expose it through a symlink.
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'restore-point-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'project.xml');
  const destinationDir = path.join(root, 'copies');
  await fs.mkdir(destinationDir);
  await fs.writeFile(sourcePath, 'original project');
  return { root, sourcePath, destinationDir, expectedHash: hash('original project'), now: new Date('2024-01-01T00:00:00Z') };
}

test('creates a verified copy and leaves the source unchanged; collisions never overwrite', async (t) => {
  const options = await fixture(t);
  const first = await createRestorePoint(options);
  const second = await createRestorePoint(options);
  assert.notEqual(first.restorePointPath, second.restorePointPath);
  assert.equal(await fs.readFile(first.restorePointPath, 'utf8'), 'original project');
  assert.equal(await fs.readFile(second.restorePointPath, 'utf8'), 'original project');
  assert.equal(await fs.readFile(options.sourcePath, 'utf8'), 'original project');
  assert.equal(first.sha256, options.expectedHash);
  assert.equal(first.size, Buffer.byteLength('original project'));
});

test('rejects a stale expected hash without creating a copy', async (t) => {
  const options = await fixture(t);
  await assert.rejects(createRestorePoint({ ...options, expectedHash: hash('stale') }), /source-hash-mismatch/);
  assert.deepEqual(await fs.readdir(options.destinationDir), []);
});

test('rejects symlink source and destination', async (t) => {
  const options = await fixture(t);
  const sourceLink = path.join(options.root, 'link');
  const destinationLink = path.join(options.root, 'dirlink');
  await fs.symlink(options.sourcePath, sourceLink);
  await fs.symlink(options.destinationDir, destinationLink);
  await assert.rejects(createRestorePoint({ ...options, sourcePath: sourceLink }), /symlink-not-allowed/);
  await assert.rejects(createRestorePoint({ ...options, destinationDir: destinationLink }), /symlink-not-allowed/);
  assert.deepEqual(await fs.readdir(options.destinationDir), []);
});

test('CLI creates a verified copy and reports a generic stale-hash error', async t => {
  const options = await fixture(t);
  const script = path.join(__dirname, '../phase-0/create-restore-point.js');
  const run = spawnSync(process.execPath, [script, options.sourcePath, options.destinationDir, options.expectedHash], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.sha256, options.expectedHash);
  assert.equal(await fs.readFile(result.restorePointPath, 'utf8'), 'original project');
  const stale = spawnSync(process.execPath, [script, options.sourcePath, options.destinationDir, hash('stale')], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.equal(stale.stderr, 'restore-point-preflight-failed\n');
  assert.equal(await fs.readFile(options.sourcePath, 'utf8'), 'original project');
});
