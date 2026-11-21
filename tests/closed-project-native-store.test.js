'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { closedProjectFixture, sha } = require('./helpers/closed-project-apply-fixture');
const native = require('../src/closed-project-native-store');
const { createClosedProjectApplyPlan } = require('../src/closed-project-apply-plan');
async function captured(f) {
  return native.inspectClosedDatabase({ sourcePath: f.sourcePath, directory: await f.directory('backup'), projectId: f.fixture.projectId, projectName: f.fixture.projectName });
}
test('packaged Python helpers copy exact source and preserve all opaque cells during one private Name edit', async t => {
  const f = await closedProjectFixture(t), original = await fs.readFile(f.sourcePath), backup = await captured(f);
  const plan = createClosedProjectApplyPlan({ ...f.review, databaseBytes: backup.databaseBytes, censusBytes: backup.censusBytes });
  const candidate = await native.createNameCandidate({ snapshotPath: backup.snapshotPath, directory: await f.directory('candidate'), plan });
  const report = await native.compareNameCandidate({ plan, backup: { path: backup.snapshotPath, sha256: sha(original) }, candidate: { path: candidate.candidatePath, sha256: sha(await fs.readFile(candidate.candidatePath)) }, directory: await f.directory('comparison') });
  assert.equal(report.verified, true); assert.equal(report.changedFields, 1);
  assert.deepEqual(report.comparison.unexplainedDifferences, []);
  assert.deepEqual(report.comparison.excludedApplicationColumns, []);
  assert.deepEqual(await fs.readFile(f.sourcePath), original);
  assert.deepEqual(await fs.readFile(backup.snapshotPath), original);
  const census = JSON.parse(backup.censusBytes);
  assert.equal(census.tables.find(value => value.name === 'OpaqueRows').rowCount, 2);
});
test('extra changed unknown BLOB fails complete preservation comparison', async t => {
  const f = await closedProjectFixture(t), backup = await captured(f);
  const plan = createClosedProjectApplyPlan({ ...f.review, databaseBytes: backup.databaseBytes, censusBytes: backup.censusBytes });
  const candidate = await native.createNameCandidate({ snapshotPath: backup.snapshotPath, directory: await f.directory('candidate'), plan });
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE Sm2TiItem SET Unknown=x'00fe7f'\");c.commit();c.close()", candidate.candidatePath]);
  await assert.rejects(native.compareNameCandidate({ plan, backup: { path: backup.snapshotPath, sha256: sha(backup.databaseBytes) }, candidate: { path: candidate.candidatePath, sha256: sha(await fs.readFile(candidate.candidatePath)) }, directory: await f.directory('comparison') }), /native-store-preservation-unverified/);
});
test('reserved header extensions and appended data are rejected even when SQLite can read the database', async t => {
  for (const mode of ['header-extension', 'appended-bytes']) {
    await t.test(mode, async t => {
      const f = await closedProjectFixture(t);
      const bytes = await fs.readFile(f.sourcePath);
      if (mode === 'header-extension') bytes[72] = 1;
      await fs.writeFile(f.sourcePath, mode === 'appended-bytes' ? Buffer.concat([bytes, Buffer.from('opaque trailer')]) : bytes);
      await assert.rejects(captured(f), /native-store-physical-/);
    });
  }
});
test('stale reviewed old Name cannot create a candidate', async t => {
  const f = await closedProjectFixture(t), backup = await captured(f);
  const plan = createClosedProjectApplyPlan({ ...f.review, databaseBytes: backup.databaseBytes, censusBytes: backup.censusBytes });
  await assert.rejects(native.createNameCandidate({ snapshotPath: backup.snapshotPath, directory: await f.directory('candidate'), plan: { ...plan, edit: { ...plan.edit, oldName: 'wrong' } } }), /stale-name-cell/);
});
