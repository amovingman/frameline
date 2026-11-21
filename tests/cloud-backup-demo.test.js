'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCloudBackupDemo, formatCloudDemo } = require('../scripts/demo-cloud-backup.cjs');

test('account-free cloud demo composes real saved revision export with upload, retry, list and exact download', async () => {
  const result = await runCloudBackupDemo();
  assert.equal(result.storage, 'simulated-in-memory');
  assert.equal(result.liveAwsVerified, false);
  assert.equal(result.revisionCount, 2);
  assert(result.byteCount > 0);
  assert(Object.values(result.checks).every(value => value === true));
  const transcript = formatCloudDemo(result);
  assert.match(transcript, /simulated in memory/);
  assert.match(transcript, /does not verify a live S3 bucket/);
  assert.doesNotMatch(transcript, /\/Users\/|\/private\/|frameline-portfolio-[a-zA-Z0-9]+|AKIA/);
});

test('cloud demo rejects unknown arguments without starting a fixture run', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/demo-cloud-backup.cjs'), '--live'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage:/);
});
