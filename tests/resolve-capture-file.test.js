'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { saveResolveCaptureFile } = require('../src/resolve-capture-file');

test('capture export preserves exact verified bytes privately without overwriting files or symlinks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-capture-export-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rich = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json'));
  const filename = path.join(directory, 'capture.json');
  const result = await saveResolveCaptureFile(filename, rich);
  assert.deepEqual(await fs.readFile(filename), rich);
  assert.equal(result.sha256, createHash('sha256').update(rich).digest('hex'));
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  await assert.rejects(saveResolveCaptureFile(filename, rich), { code: 'EEXIST' });
  const link = path.join(directory, 'link.json');
  await fs.symlink(filename, link);
  await assert.rejects(saveResolveCaptureFile(link, rich), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(filename), rich);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['capture.json', 'link.json']);
  const snapshot = Buffer.from(JSON.stringify(JSON.parse(rich).snapshot));
  await saveResolveCaptureFile(path.join(directory, 'snapshot.json'), snapshot);
  assert.deepEqual(await fs.readFile(path.join(directory, 'snapshot.json')), snapshot);
});

test('invalid capture export leaves no published or temporary artifact', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-capture-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(saveResolveCaptureFile(path.join(directory, 'invalid.json'), '{}'));
  assert.deepEqual(await fs.readdir(directory), []);
});
