'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { prepareRenameTrial, issueRenameTrial, recordRenameTrialResult } = require('../src/resolve-rename-trial');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rename-trial-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
  return { destinationDir: directory, disposableProjectName: 'Frameline Restore Probe',
    beforeBytes: await fs.readFile(path.join(root, 'live-rename-before-schema3.json')),
    afterBytes: await fs.readFile(path.join(root, 'live-rename-applied-schema3.json')) };
}

async function exportFixture(trial) {
  // Synthetic archive tests the orchestration boundary. Live Resolve export and
  // execution are recorded separately in SAFE_PULL_PREFLIGHT.md.
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/test.xml']) {
    const filename = path.join(trial.directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, '<Fixture/>');
  }
  const zipped = spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/test.xml'], { cwd: trial.directory });
  assert.equal(zipped.status, 0);
  await fs.chmod(trial.backupPath, 0o666);
}

test('requires a private directory, exact named project, and exactly one observed rename', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareRenameTrial({ ...options, disposableProjectName: 'Other project' }), /named-disposable-project-required/);
  await assert.rejects(prepareRenameTrial({ ...options, afterBytes: options.beforeBytes }), /trial-requires-one-rename/);
  const changed = JSON.parse(options.afterBytes);
  changed.timelines[0].items[1].name = 'Extra edit';
  await assert.rejects(prepareRenameTrial({ ...options, afterBytes: JSON.stringify(changed) }), /trial-requires-one-rename/);
  await fs.chmod(options.destinationDir, 0o755);
  await assert.rejects(prepareRenameTrial(options), /trial-directory-not-private/);
});

test('cannot issue without an archive; keeps private backup and immutable result after verified rollback', async t => {
  const options = await fixture(t);
  const trial = await prepareRenameTrial(options);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }));
  await exportFixture(trial);
  const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  assert.equal(issued.backup.archiveVerified, true);
  assert.equal((await fs.stat(trial.backupPath)).mode & 0o777, 0o600);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }), { code: 'EEXIST' });
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.beforeBytes }), /trial-result-mismatch/);
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes });
  assert.equal(result.sourceSha256, result.resultingSnapshotSha256);
  assert.equal(result.validation, 'observed-fields-only');
  assert.equal(result.backupPath, trial.backupPath);
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes }), { code: 'EEXIST' });
  assert.ok((await fs.stat(trial.backupPath)).isFile());
});

test('refuses symlinked or damaged backup and mismatched result state', async t => {
  const options = await fixture(t);
  const trial = await prepareRenameTrial(options);
  const linkTarget = path.join(options.destinationDir, 'unrelated.drp');
  await fs.writeFile(linkTarget, 'not an archive');
  await fs.symlink(linkTarget, trial.backupPath);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }));
  await fs.unlink(trial.backupPath);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  await fs.appendFile(trial.backupPath, 'changed');
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.afterBytes }), /export-hash-mismatch/);
  await assert.rejects(fs.stat(path.join(trial.directory, 'result.json')), { code: 'ENOENT' });
});

test('records the expected applied state while normalizing incoming enumeration order', async t => {
  const options = await fixture(t);
  const incoming = JSON.parse(options.afterBytes);
  incoming.timelines[0].items.reverse();
  const trial = await prepareRenameTrial({ ...options, afterBytes: JSON.stringify(incoming) });
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.afterBytes });
  assert.equal(result.status, 'applied');
  assert.notEqual(result.resultingSnapshotSha256, result.sourceSha256);
  assert.equal(result.backup.archiveVerified, true);
});
