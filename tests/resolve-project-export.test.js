'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectResolveProjectExport } = require('../src/resolve-project-export');

async function archive(t, withTimeline = true) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'MediaPool/Master'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.xml'), '<Project/>');
  await fs.writeFile(path.join(root, 'MediaPool/Master/MpFolder.xml'), '<Folder/>');
  if (withTimeline) {
    await fs.mkdir(path.join(root, 'SeqContainer'));
    await fs.writeFile(path.join(root, 'SeqContainer/timeline.xml'), '<Timeline/>');
  }
  const filePath = path.join(root, 'copy.drp');
  const files = ['project.xml', 'MediaPool/Master/MpFolder.xml'];
  if (withTimeline) files.push('SeqContainer/timeline.xml');
  const zipped = spawnSync('zip', ['-q', filePath, ...files], { cwd: root, encoding: 'utf8' });
  assert.equal(zipped.status, 0, zipped.stderr);
  await fs.chmod(filePath, 0o600);
  return filePath;
}

test('verifies a private Resolve export archive and its timeline member', async t => {
  const filePath = await archive(t);
  const report = await inspectResolveProjectExport(filePath);
  assert.equal(report.archiveVerified, true);
  assert.equal(report.timelineCount, 1);
  assert.equal(report.mode, 0o600);
  assert.equal(report.sha256.length, 64);
  assert.equal((await inspectResolveProjectExport(filePath, report.sha256)).sha256, report.sha256);
  await assert.rejects(inspectResolveProjectExport(filePath, '0'.repeat(64)), /export-hash-mismatch/);
});

test('refuses missing timeline, malformed archive, insecure mode, and symlink', async t => {
  const noTimeline = await archive(t, false);
  await assert.rejects(inspectResolveProjectExport(noTimeline), /missing-project-members/);
  const filePath = await archive(t);
  await fs.chmod(filePath, 0o666);
  await assert.rejects(inspectResolveProjectExport(filePath), /export-permissions-insecure/);
  await fs.chmod(filePath, 0o600);
  const link = path.join(path.dirname(filePath), 'link.drp');
  await fs.symlink(filePath, link);
  await assert.rejects(inspectResolveProjectExport(link));
  const linkedDirectory = path.join(path.dirname(filePath), 'linked-directory');
  await fs.symlink(path.dirname(filePath), linkedDirectory);
  await assert.rejects(inspectResolveProjectExport(path.join(linkedDirectory, 'copy.drp')), /export-symlink-invalid/);
  await assert.rejects(inspectResolveProjectExport('copy.drp'), /invalid-export-input/);
  await fs.truncate(filePath, (await fs.stat(filePath)).size - 20);
  await assert.rejects(inspectResolveProjectExport(filePath), /export-archive-invalid/);
});
