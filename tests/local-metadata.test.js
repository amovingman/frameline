const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { scanFcpXml } = require('../src/fcpxml-adapter');

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-metadata-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('project IDs survive restart and metadata stores no project paths', async () => withStore(async directory => {
  const filePath = '/private/editing/client-cut.fcpxml';
  const first = await createLocalMetadataStore(directory).getProjectId(filePath);
  const second = await createLocalMetadataStore(directory).getProjectId(filePath);
  assert.equal(first.id, second.id);
  assert.equal(first.recovered, false);
  const saved = await fs.readFile(path.join(directory, 'metadata.json'), 'utf8');
  assert.doesNotMatch(saved, /private|editing|client-cut|fcpxml/);
  assert.deepEqual(JSON.parse(saved).schemaVersion, 5);
  assert.equal(await fs.readFile(path.join(directory, 'metadata.json.bak'), 'utf8'), saved);
}));

test('restores a damaged primary from backup and preserves the damaged file', async () => withStore(async directory => {
  const store = createLocalMetadataStore(directory);
  const filePath = '/private/editing/client-cut.fcpxml';
  const first = await store.getProjectId(filePath);
  await fs.writeFile(path.join(directory, 'metadata.json'), '{broken');
  const restored = await createLocalMetadataStore(directory).getProjectId(filePath);
  assert.equal(restored.id, first.id);
  assert.equal(restored.recovered, true);
  assert.equal((await createLocalMetadataStore(directory).getProjectId(filePath)).recovered, false);
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('metadata.json.corrupt-')));
}));

test('rejects a future schema version without overwriting it', async () => withStore(async directory => {
  const filePath = path.join(directory, 'metadata.json');
  const newer = '{"schemaVersion":6,"projects":{}}';
  await fs.writeFile(filePath, newer);
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-newer-version' });
  assert.equal(await fs.readFile(filePath, 'utf8'), newer);
}));

test('reports damage when no valid backup exists', async () => withStore(async directory => {
  await fs.writeFile(path.join(directory, 'metadata.json'), '{broken');
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-invalid' });
}));

test('rejects duplicate project IDs and cyclic revision parents in metadata', async () => withStore(async directory => {
  const id = '11111111-1111-4111-8111-111111111111';
  const first = '22222222-2222-4222-8222-222222222222';
  const second = '33333333-3333-4333-8333-333333333333';
  const fingerprintA = 'a'.repeat(64);
  const fingerprintB = 'b'.repeat(64);
  const empty = { id, revisions: [], branches: { main: null }, currentBranch: 'main' };
  const metadataPath = path.join(directory, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify({ schemaVersion: 3, projects: { [fingerprintA]: empty, [fingerprintB]: empty } }));
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-invalid' });
  const revisions = [
    { id: first, projectId: id, parentRevisionId: second, message: 'First', contentHash: 'a'.repeat(64) },
    { id: second, projectId: id, parentRevisionId: first, message: 'Second', contentHash: 'b'.repeat(64) }
  ];
  await fs.writeFile(metadataPath, JSON.stringify({ schemaVersion: 3, projects: { [fingerprintA]: { id, revisions, branches: { main: second }, currentBranch: 'main' } } }));
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-invalid' });
}));

test('migrates v1 project IDs before storing immutable linked revisions', async () => withStore(async directory => {
  const filePath = '/private/editing/client-cut.fcpxml';
  const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
  const projectId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, projects: { [fingerprint]: projectId } }));
  const store = createLocalMetadataStore(directory);
  assert.equal((await store.getProjectId(filePath)).id, projectId);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8')).schemaVersion, 5);

  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  const first = await store.saveRevision(projectId, manifest, 'First cut', null);
  const second = await store.saveRevision(projectId, manifest, 'Shorter opening', first.id);
  assert.equal(second.parentRevisionId, first.id);
  assert.equal(second.contentHash, manifest.sourceHash);
  assert.equal(second.manifestVersion, 2);
  assert.deepEqual((await createLocalMetadataStore(directory).listRevisions(projectId)).map(item => item.id), [second.id, first.id]);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'revisions', projectId, `${first.id}.json`), 'utf8'));
  assert.deepEqual(saved.manifest, manifest);
  assert.equal(saved.message, 'First cut');
  assert.deepEqual(await store.getRevision(projectId, first.id), saved);
  assert.match(first.recordHash, /^[a-f0-9]{64}$/);
  await assert.rejects(store.getRevision(projectId, '22222222-2222-4222-8222-222222222222'), { code: 'revision-not-found' });
  await assert.rejects(store.saveRevision(projectId, manifest, 'Stale write', null), { code: 'revision-head-changed' });
  assert.equal((await fs.readFile(path.join(directory, 'revisions', projectId, `${first.id}.json`), 'utf8')).includes('Shorter opening'), false);
}));

test('rejects a revision record changed after it was saved', async () => withStore(async directory => {
  const store = createLocalMetadataStore(directory);
  const projectId = (await store.getProjectId('/private/cut.fcpxml')).id;
  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  const summary = await store.saveRevision(projectId, manifest, 'First cut');
  const filePath = path.join(directory, 'revisions', projectId, `${summary.id}.json`);
  const record = JSON.parse(await fs.readFile(filePath, 'utf8'));
  record.manifest.clips[0].name = 'Altered clip';
  await fs.writeFile(filePath, JSON.stringify(record));
  await assert.rejects(store.getRevision(projectId, summary.id), { code: 'revision-corrupt' });
}));

test('migrates v2 history into main and keeps branch histories separate', async () => withStore(async directory => {
  const filePath = '/private/editing/client-cut.fcpxml';
  const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
  const projectId = '11111111-1111-4111-8111-111111111111';
  const oldId = '22222222-2222-4222-8222-222222222222';
  const oldSummary = { id: oldId, projectId, parentRevisionId: null, message: 'Old cut', contentHash: 'a'.repeat(64) };
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 2, projects: { [fingerprint]: { id: projectId, revisions: [oldSummary] } } }));
  const store = createLocalMetadataStore(directory);
  assert.equal((await store.getProjectId(filePath)).id, projectId);
  assert.deepEqual(await store.getBranchState(projectId), { currentBranch: 'main', branches: ['main'] });
  assert.deepEqual((await store.listRevisions(projectId)).map(item => item.id), [oldId]);

  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  const branch = await store.createBranch(projectId, 'alternate-cut', oldId);
  assert.equal(branch.currentBranch, 'alternate-cut');
  assert.equal((await createLocalMetadataStore(directory).getBranchState(projectId)).currentBranch, 'alternate-cut');
  const alternate = await store.saveRevision(projectId, manifest, 'Alternate opening', oldId, 'alternate-cut');
  await store.switchBranch(projectId, 'main');
  const main = await store.saveRevision(projectId, manifest, 'Main opening', oldId, 'main');
  assert.equal(alternate.parentRevisionId, oldId);
  assert.equal(main.parentRevisionId, oldId);
  assert.deepEqual((await store.listRevisions(projectId, 'main')).map(item => item.id), [main.id, oldId]);
  assert.deepEqual((await store.listRevisions(projectId, 'alternate-cut')).map(item => item.id), [alternate.id, oldId]);
  assert.equal((await createLocalMetadataStore(directory).getBranchState(projectId)).currentBranch, 'main');
  await assert.rejects(store.createBranch(projectId, 'alternate-cut', main.id), { code: 'branch-exists' });
  await assert.rejects(store.createBranch(projectId, '../escape', main.id), { code: 'branch-name-invalid' });
  await assert.rejects(store.saveRevision(projectId, manifest, 'Stale', oldId, 'main'), { code: 'revision-head-changed' });
}));

test('separate store instances cannot replace the same branch head', async () => withStore(async directory => {
  const firstStore = createLocalMetadataStore(directory);
  const secondStore = createLocalMetadataStore(directory);
  const projectId = (await firstStore.getProjectId('/private/cut.fcpxml')).id;
  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  const outcomes = await Promise.allSettled([
    firstStore.saveRevision(projectId, manifest, 'First writer', null, 'main'),
    secondStore.saveRevision(projectId, manifest, 'Second writer', null, 'main')
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'revision-head-changed');
  assert.equal((await firstStore.listRevisions(projectId)).length, 1);
}));

test('active metadata locks time out and abandoned locks are reclaimed', async () => withStore(async directory => {
  const lockPath = path.join(directory, 'metadata.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'active' }));
  const store = createLocalMetadataStore(directory, { lockTimeoutMs: 120 });
  await assert.rejects(store.getProjectId('/private/cut.fcpxml'), { code: 'metadata-locked' });
  assert.equal((await fs.readdir(directory)).includes('metadata.json'), false);
  await fs.writeFile(lockPath, JSON.stringify({ pid: 99999999, token: 'abandoned' }));
  const recovered = await store.getProjectId('/private/cut.fcpxml');
  assert.match(recovered.id, /^[a-f0-9-]{36}$/);
  assert.equal((await fs.readdir(directory)).includes('metadata.lock'), false);
}));

test('exports verified history and imports it onto new branches without replacing local work', async () => withStore(async directory => {
  const source = createLocalMetadataStore(path.join(directory, 'source'));
  const target = createLocalMetadataStore(path.join(directory, 'target'));
  const sourceId = (await source.getProjectId('/private/source.fcpxml')).id;
  const targetId = (await target.getProjectId('/private/target.fcpxml')).id;
  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  const base = await source.saveRevision(sourceId, manifest, 'Base');
  await source.createBranch(sourceId, 'alternate', base.id);
  const alternate = await source.saveRevision(sourceId, manifest, 'Alternate', base.id, 'alternate');
  await source.switchBranch(sourceId, 'main');
  const main = await source.saveRevision(sourceId, manifest, 'Main', base.id);
  const local = await target.saveRevision(targetId, manifest, 'Local');
  const bundle = await source.exportRevisions(sourceId);
  assert.equal(bundle.records.length, 3);
  assert.deepEqual(bundle.branches, { main: main.id, alternate: alternate.id });
  const result = await target.importRevisions(targetId, JSON.parse(JSON.stringify(bundle)));
  assert.equal(result.revisionCount, 3);
  assert.deepEqual(result.branches, ['import-main', 'import-alternate']);
  assert.deepEqual((await target.listRevisions(targetId)).map(item => item.id), [local.id]);
  const importedMain = await target.listRevisions(targetId, 'import-main');
  const importedAlternate = await target.listRevisions(targetId, 'import-alternate');
  assert.deepEqual(importedMain.map(item => item.message), ['Main', 'Base']);
  assert.deepEqual(importedAlternate.map(item => item.message), ['Alternate', 'Base']);
  assert.equal(importedMain[1].id, importedAlternate[1].id);
  assert.deepEqual((await target.getRevision(targetId, importedMain[0].id)).manifest, manifest);
  assert.deepEqual((await target.importRevisions(targetId, bundle)).branches, ['import-main-2', 'import-alternate-2']);
  assert.deepEqual((await source.listRevisions(sourceId)).map(item => item.id), [main.id, base.id]);
}));

test('rejects damaged transfer packages before changing target history', async () => withStore(async directory => {
  const store = createLocalMetadataStore(directory);
  const projectId = (await store.getProjectId('/private/cut.fcpxml')).id;
  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  await store.saveRevision(projectId, manifest, 'Base');
  const bundle = await store.exportRevisions(projectId);
  bundle.records[0].bytes = bundle.records[0].bytes.replace('Base', 'Fake');
  await assert.rejects(store.importRevisions(projectId, bundle), { code: 'revision-transfer-invalid' });
  assert.deepEqual((await store.getBranchState(projectId)).branches, ['main']);
  assert.equal((await store.listRevisions(projectId)).length, 1);
}));

test('explicit relink moves verified history to an identical export at a new path', async () => withStore(async directory => {
  const store = createLocalMetadataStore(path.join(directory, 'app-data'));
  const original = path.join(directory, 'original.fcpxml');
  const moved = path.join(directory, 'moved.fcpxml');
  const fixture = path.join(__dirname, '..', 'phase-0', 'compatibility-corpus', 'edit-before.fcpxml');
  await fs.copyFile(fixture, original);
  await fs.copyFile(fixture, moved);
  const originalId = (await store.getProjectId(original)).id;
  const manifest = await scanFcpXml(original);
  const head = await store.saveRevision(originalId, manifest, 'Before move');
  const newId = (await store.getProjectId(moved)).id;
  const candidates = await store.listRelinkCandidates(newId, manifest.sourceHash);
  assert.deepEqual(candidates.map(item => item.projectId), [originalId]);
  assert.doesNotMatch(JSON.stringify(candidates), /original\.fcpxml|moved\.fcpxml/);
  const relinked = await store.relinkProject(moved, newId, originalId, manifest.sourceHash);
  assert.equal(relinked.id, originalId);
  assert.equal((await store.getProjectId(moved)).id, originalId);
  assert.equal((await store.listRevisions(originalId))[0].id, head.id);
  assert.notEqual((await store.getProjectId(original)).id, originalId);
  assert.deepEqual(await store.listRelinkCandidates(originalId, manifest.sourceHash), []);
}));

test('relink refuses changed files and a destination with its own history', async () => withStore(async directory => {
  const store = createLocalMetadataStore(path.join(directory, 'app-data'));
  const original = path.join(directory, 'original.fcpxml');
  const moved = path.join(directory, 'moved.fcpxml');
  const fixture = path.join(__dirname, '..', 'phase-0', 'compatibility-corpus', 'edit-before.fcpxml');
  await fs.copyFile(fixture, original);
  await fs.copyFile(fixture, moved);
  const originalId = (await store.getProjectId(original)).id;
  const movedId = (await store.getProjectId(moved)).id;
  const manifest = await scanFcpXml(original);
  await store.saveRevision(originalId, manifest, 'Before move');
  await fs.appendFile(moved, '\n');
  await assert.rejects(store.relinkProject(moved, movedId, originalId, manifest.sourceHash), { code: 'revision-source-changed' });
  assert.equal((await store.getProjectId(moved)).id, movedId);
  await store.saveRevision(movedId, await scanFcpXml(moved), 'Separate history');
  await assert.rejects(store.relinkProject(moved, movedId, originalId, manifest.sourceHash), { code: 'relink-unavailable' });
}));


test('sync bases persist per branch, inherit at creation, and reject stale or unrelated revisions', async () => withStore(async directory => {
  const store = createLocalMetadataStore(directory);
  const projectId = (await store.getProjectId('/private/cut.fcpxml')).id;
  const manifest = await scanFcpXml(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'));
  assert.equal(await store.getSyncBase(projectId, 'main'), null);
  const base = await store.saveRevision(projectId, manifest, 'Base');
  await store.recordSyncBase(projectId, 'main', base.id, base.id);
  await store.createBranch(projectId, 'alternate', base.id);
  const alternate = await store.saveRevision(projectId, manifest, 'Alternate', base.id, 'alternate');
  assert.equal(await createLocalMetadataStore(directory).getSyncBase(projectId, 'alternate'), base.id);
  await store.recordSyncBase(projectId, 'alternate', alternate.id, alternate.id);
  await store.switchBranch(projectId, 'main');
  const main = await store.saveRevision(projectId, manifest, 'Main', base.id, 'main');
  await assert.rejects(store.recordSyncBase(projectId, 'main', main.id, base.id), { code: 'revision-head-changed' });
  await assert.rejects(store.recordSyncBase(projectId, 'main', alternate.id, main.id), { code: 'sync-base-invalid' });
  assert.equal(await store.getSyncBase(projectId, 'main'), base.id);
  const bundle = await store.exportRevisions(projectId);
  const imported = await store.importRevisions(projectId, bundle);
  assert.equal(await store.getSyncBase(projectId, imported.branches[0]), null);
  await store.recordSyncBase(projectId, 'main', null, main.id);
  assert.equal(await store.getSyncBase(projectId, 'main'), null);
}));

test('migrates v3 branches with unknown sync bases and rejects invalid v4 bases', async () => withStore(async directory => {
  const filePath = '/private/cut.fcpxml';
  const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
  const projectId = '11111111-1111-4111-8111-111111111111';
  const project = { id: projectId, revisions: [], branches: { main: null, other: null }, currentBranch: 'main' };
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 3, projects: { [fingerprint]: project } }));
  const store = createLocalMetadataStore(directory);
  assert.equal(await store.getSyncBase(projectId, 'other'), null);
  const migrated = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
  assert.deepEqual(migrated.projects[fingerprint].syncBases, { main: null, other: null });
  migrated.projects[fingerprint].syncBases.other = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(migrated));
  await fs.rm(path.join(directory, 'metadata.json.bak'));
  await assert.rejects(store.getSyncBase(projectId, 'main'), { code: 'metadata-invalid' });
}));
