'use strict';
// Reconstruct the disposable reader/migration drill without running a reader,
// acquiring a metadata lock, repairing state or installing software.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./local-migration-common.cjs');
const EXPECTED_STAGES = ['bootstrap-old', 'upgrade', 'old-refuses', 'write-new', 'before', 'before-reopen',
  'after', 'after-reopen', 'restore-old', 'future-refuses', 'legacy-upgrade'];
async function reconstruct(directory) {
  const history = await c.archive();
  for (const [name, value] of Object.entries(history.files)) assert.equal(c.sha(await c.read(c.within(path.join(directory, 'historical-reader'), name))), value.sha256);
  const f = JSON.parse(await c.read(path.join(directory, 'fixture.json')));
  assert.equal(f.operation, 'disposable-local-schema-upgrade');
  assert.equal(c.sha(await c.read(path.join(directory, 'timeline.fcpxml'))), f.sourceHash);
  c.need(f.observedRuntime && /^\d+\.\d+\.\d+$/.test(f.observedRuntime.node) && typeof f.observedRuntime.platform === 'string'
    && typeof f.observedRuntime.architecture === 'string' && /^\d+\.\d+\.\d+$/.test(f.observedRuntime.fastXmlParser)
    && /^[a-f0-9]{64}$/.test(f.observedRuntime.parserEntrySha256) && /^[a-f0-9]{64}$/.test(f.observedRuntime.packageLockSha256), 'runtime-provenance');
  const processes = JSON.parse(await c.read(path.join(directory, 'processes.json')));
  assert.deepEqual(processes.map(p => p.stage), EXPECTED_STAGES);
  for (const p of processes) {
    const killed = ['before', 'after'].includes(p.stage);
    assert.equal(p.code, killed ? null : 0); assert.equal(p.signal, killed ? 'SIGKILL' : null);
  }
  const event = async stage => {
    const value = JSON.parse(await c.read(path.join(directory, 'events', stage + '.json')));
    assert.equal(value.stage, stage); return value;
  };
  const base = await c.graph(path.join(directory, 'base-workspace'));
  assert.equal(base.schemaVersion, 4); assert.equal(base.projects.length, 1);
  assert.equal(base.projects[0].records.length, 3); assert.equal(Object.keys(base.projects[0].branches).length, 2);
  assert.deepEqual((await event('bootstrap-old')).graph, base);
  const primary = await c.read(path.join(directory, 'base-workspace/metadata.json'));
  const initialIndex = JSON.parse(primary);
  const expectedUpgrade = { schemaVersion: 5, projects: Object.fromEntries(Object.entries(initialIndex.projects)
    .map(([key, project]) => [key, { ...project, serviceSyncBases: [] }])) };
  const upgraded = await event('upgrade');
  assert.deepEqual(upgraded.graph, { ...base, schemaVersion: 5 });
  const refused = await event('old-refuses');
  assert.equal(refused.error, 'metadata-newer-version'); assert.equal(refused.primarySchema, 5); assert.equal(refused.backupSchema, 4);
  assert.deepEqual(refused.before, refused.after);
  assert.deepEqual(refused.before, upgraded.canonicalFiles);
  assert.equal(refused.before['metadata.json.bak'], c.sha(primary));
  const interruptions = [];
  for (const point of ['before', 'after']) {
    const before = await event(point), snapshot = path.join(directory, point + '-observed');
    const index = await c.metadata(snapshot);
    assert.equal(index.schemaVersion, point === 'before' ? 4 : 5);
    assert.deepEqual(index, point === 'before' ? initialIndex : expectedUpgrade);
    assert.equal(before.primarySchema, index.schemaVersion);
    assert.equal(before.primaryHash, c.sha(await c.read(path.join(snapshot, 'metadata.json'))));
    assert.equal(before.backupHash, c.sha(primary));
    assert.equal(c.sha(await c.read(path.join(snapshot, 'metadata.json.bak'))), c.sha(primary));
    for (const record of base.projects[0].records) {
      assert.equal(c.sha(await c.read(path.join(snapshot, 'revisions', base.projects[0].id, record.id + '.json'))), record.hash);
    }
    assert.deepEqual(await c.metadata(path.join(directory, point + '-workspace')), expectedUpgrade);
    const recovered = await c.graph(path.join(directory, point + '-workspace'));
    assert.deepEqual(recovered, { ...base, schemaVersion: 5 }); assert.deepEqual((await event(point + '-reopen')).graph, recovered);
    interruptions.push({ point: before.point, signal: 'SIGKILL', observedPrimarySchema: index.schemaVersion,
      recoveredSchema: 5, originalBackupSha256: before.backupHash, immutableRecordCount: 3 });
  }
  const normal = await c.graph(path.join(directory, 'normal-workspace')), written = await event('write-new');
  assert.deepEqual(written.graph, normal); assert.equal(normal.schemaVersion, 5);
  const p = normal.projects[0], old = base.projects[0];
  assert.equal(p.id, old.id); assert.equal(p.records.length, 4);
  assert.deepEqual(p.records.slice(0, 3), old.records); assert.deepEqual(p.syncBases, old.syncBases);
  assert.equal(p.currentBranch, old.currentBranch); assert.equal(p.branches.alternate, old.branches.alternate);
  assert.equal(p.branches.main, written.revisionId); assert.equal(p.records[3].id, written.revisionId);
  const newRecord = JSON.parse(await c.read(path.join(directory, 'normal-workspace/revisions', p.id, written.revisionId + '.json')));
  assert.equal(newRecord.parentRevisionId, old.branches.main);
  assert.deepEqual(Object.values((await c.metadata(path.join(directory, 'normal-workspace'))).projects)[0].serviceSyncBases, []);
  assert.deepEqual(await c.graph(path.join(directory, 'restored-workspace')), base);
  assert.deepEqual((await event('restore-old')).graph, base);
  assert.deepEqual(await c.canonicalTree(path.join(directory, 'restored-workspace')), await c.canonicalTree(path.join(directory, 'base-workspace')));
  const future = await event('future-refuses');
  assert.equal(future.error, 'metadata-newer-version'); assert.equal(future.primarySchema, 6); assert.equal(future.backupSchema, 4);
  assert.deepEqual(future.before, future.after); assert.deepEqual(future.after, await c.canonicalTree(path.join(directory, 'future-workspace')));
  const legacy = await event('legacy-upgrade'), legacyIndex = await c.metadata(path.join(directory, 'legacy-workspace'));
  assert.equal(legacyIndex.schemaVersion, 5); assert.equal(legacy.revisions, 0);
  assert.equal(Object.values(legacyIndex.projects)[0].id, old.id); assert.equal(Object.values(legacyIndex.projects)[0].revisions.length, 0);
  return { historicalReader: { commit: c.COMMIT, archiveSha256: c.ARCHIVE_SHA, sourceFiles: 9, maximumSchema: 4 },
    processCount: processes.length, processes, observedRuntime: f.observedRuntime, sourceSha256: f.sourceHash, metadataUpgrade: { from: 4, to: 5, projects: 1, revisionsPreserved: 3,
      branchesPreserved: 2, legacySyncBasesPreserved: true, noServiceBaseGuessed: true, originalBackupSha256: c.sha(primary) },
    interruptedMigrations: interruptions, downgradeRefusal: { readerMaximumSchema: 4, primarySchema: 5, validBackupSchema: 4,
      error: refused.error, canonicalFilesUnchanged: true },
    postUpgradeWrite: { revisionCount: 4, oldRecordHashesPreserved: true, alternateBranchUnchanged: true },
    separateWorkspaceRestoration: { restoredSchema: 4, originalGraphAndBytesRestored: true, newerWorkspacePreserved: true },
    futureSchemaRefusal: { primarySchema: 6, validBackupSchema: 4, error: future.error, canonicalFilesUnchanged: true },
    legacyProjectIdMigration: { from: 1, to: 5, projectIdPreserved: true } };
}
async function buildMigrationReceipt({ retentionDirectory, sourceHashes, manifestSha256 } = {}) {
  const relative = path.relative(c.ROOT, retentionDirectory);
  return { schemaVersion: 1, operation: 'verified-personal-local-migration-drill',
    scope: 'Owner-only manual code/metadata upgrade and separate-workspace restoration; actual historical schema4 reader with current Node/npm dependencies and current schema5 reader. No signed installer, binary activation, automatic update, hosted deployment or machine power-loss claim.',
    privateRetentionDirectory: !relative.startsWith('..') ? relative : 'phase-0/private-integration-proof/disposable-test',
    manifestSha256, sourceHashes, ...await reconstruct(retentionDirectory),
    installerUpgradeProven: false, automaticUpdatesEnabled: false, rollbackOverwritesCurrentWorkspace: false };
}
async function auditLocalMigrations({ receipt, retentionDirectory } = {}) {
  const p = receipt || JSON.parse(await fs.readFile(path.join(c.ROOT, 'phase-0/local-migration-proof.json')));
  c.need(p.schemaVersion === 1 && p.operation === 'verified-personal-local-migration-drill'
    && p.installerUpgradeProven === false && p.automaticUpdatesEnabled === false && p.rollbackOverwritesCurrentWorkspace === false, 'scope');
  const current = await c.codeHashes(); assert.deepEqual(p.sourceHashes, current);
  const directory = retentionDirectory || c.within(c.ROOT, p.privateRetentionDirectory);
  const bytes = await c.read(path.join(directory, 'manifest.json')); assert.equal(c.sha(bytes), p.manifestSha256);
  const manifest = JSON.parse(bytes), actual = await c.tree(directory); delete actual['manifest.json'];
  assert.deepEqual(actual, manifest.files);
  const expected = await buildMigrationReceipt({ retentionDirectory: directory, sourceHashes: current, manifestSha256: p.manifestSha256 });
  expected.privateRetentionDirectory = p.privateRetentionDirectory;
  assert.deepEqual(p, expected);
  return { verified: true, operation: p.operation, actualReaderProcesses: p.processCount, actualSigkillInterruptions: 2,
    metadataUpgrade: '4-to-5', historicalReaderRefusedNewerPrimary: true, immutableRevisionBytesPreserved: true,
    separateWorkspaceRestoreVerified: true, newWorkspaceWorkPreserved: true, installerUpgradeProven: false };
}
module.exports = { buildMigrationReceipt, auditLocalMigrations, reconstruct };
if (require.main === module) auditLocalMigrations().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });
