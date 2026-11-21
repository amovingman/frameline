'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const common = require('../scripts/local-migration-common.cjs');
const { runFixture } = require('../scripts/verify-local-migrations.cjs');
const { buildMigrationReceipt, auditLocalMigrations } = require('../scripts/audit-local-migrations.cjs');
let run;
async function fixture() { return run ||= runFixture(); }
test.after(async () => { if (run) await fs.rm((await run).root, { recursive: true, force: true }); });
async function fresh(t) {
  const base = await fixture(), folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-local-migration-test-')));
  const directory = path.join(folder, 'retained'); await common.copy(base.root, directory);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const receipt = await buildMigrationReceipt({ retentionDirectory: directory, sourceHashes: base.sourceHashes, manifestSha256: base.manifestSha256 });
  return { directory, receipt };
}
async function resign(f) {
  const files = await common.tree(f.directory); delete files['manifest.json'];
  await fs.writeFile(path.join(f.directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files }));
  f.receipt.manifestSha256 = common.sha(await common.read(path.join(f.directory, 'manifest.json')));
}
test('actual historical/current readers migrate, survive two SIGKILLs and restore separately without changing immutable history', async t => {
  const f = await fresh(t), before = await common.tree(f.directory), report = await auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory });
  assert.equal(report.actualReaderProcesses, 11); assert.equal(report.actualSigkillInterruptions, 2);
  assert.equal(report.metadataUpgrade, '4-to-5'); assert.equal(report.installerUpgradeProven, false);
  assert.equal(report.historicalReaderRefusedNewerPrimary, true); assert.equal(report.immutableRevisionBytesPreserved, true);
  assert.equal(report.separateWorkspaceRestoreVerified, true); assert.equal(report.newWorkspaceWorkPreserved, true);
  assert.deepEqual(await common.tree(f.directory), before);
  assert.equal(f.receipt.historicalReader.commit, common.COMMIT);
  assert.equal(f.receipt.downgradeRefusal.validBackupSchema, 4);
  assert.deepEqual(f.receipt.interruptedMigrations.map(p => p.observedPrimarySchema), [4, 5]);
});
test('installer/automatic-update claims and changed production reader code hashes cannot substitute for the local drill', async t => {
  const f = await fresh(t);
  for (const field of ['installerUpgradeProven', 'automaticUpdatesEnabled', 'rollbackOverwritesCurrentWorkspace']) {
    await assert.rejects(auditLocalMigrations({ receipt: { ...f.receipt, [field]: true }, retentionDirectory: f.directory }));
  }
  const changed = structuredClone(f.receipt); changed.sourceHashes['src/local-metadata.js'] = '0'.repeat(64);
  await assert.rejects(auditLocalMigrations({ receipt: changed, retentionDirectory: f.directory }));
});
test('a changed historical reader is refused even with an updated private artifact manifest', async t => {
  const f = await fresh(t);
  await fs.appendFile(path.join(f.directory, 'historical-reader/src/local-metadata.js'), '\n// changed\n'); await resign(f);
  await assert.rejects(auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory }));
});
test('claimed process death without the exact recorded SIGKILL exit is refused after manifest recomputation', async t => {
  const f = await fresh(t), filename = path.join(f.directory, 'processes.json'), value = JSON.parse(await common.read(filename));
  value.find(row => row.stage === 'after').signal = null;
  await fs.writeFile(filename, JSON.stringify(value)); await resign(f);
  await assert.rejects(auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory }));
});
test('changing a restored immutable record cannot be hidden behind updated container hashes', async t => {
  const f = await fresh(t), index = await common.metadata(path.join(f.directory, 'restored-workspace')), project = Object.values(index.projects)[0];
  const filename = path.join(f.directory, 'restored-workspace/revisions', project.id, project.revisions[0].id + '.json');
  const record = JSON.parse(await common.read(filename)); record.message = 'Corrupted';
  await fs.writeFile(filename, JSON.stringify(record)); await resign(f);
  await assert.rejects(auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory }));
});
test('unsafe linked artifacts are refused without chmod, cleanup or file repair', async t => {
  const f = await fresh(t), filename = path.join(f.directory, 'timeline.fcpxml'), alias = path.join(f.directory, 'hardlink.fcpxml');
  const before = await fs.stat(filename); await fs.link(filename, alias);
  await assert.rejects(auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory }));
  assert.equal((await fs.stat(filename)).mode, before.mode); assert.equal((await fs.stat(filename)).nlink, 2);
});
test('an artifact cannot use an index project or record ID to read outside its retained workspace', async t => {
  const f = await fresh(t), file = path.join(f.directory, 'restored-workspace/metadata.json');
  const index = JSON.parse(await common.read(file)); Object.values(index.projects)[0].id = '../../outside';
  await fs.writeFile(file, JSON.stringify(index)); await resign(f);
  await assert.rejects(auditLocalMigrations({ receipt: f.receipt, retentionDirectory: f.directory }), /local-migration-record-path/);
});
