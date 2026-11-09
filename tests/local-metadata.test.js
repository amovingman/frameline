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
  assert.deepEqual(JSON.parse(saved).schemaVersion, 3);
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
  const newer = '{"schemaVersion":4,"projects":{}}';
  await fs.writeFile(filePath, newer);
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-newer-version' });
  assert.equal(await fs.readFile(filePath, 'utf8'), newer);
}));

test('reports damage when no valid backup exists', async () => withStore(async directory => {
  await fs.writeFile(path.join(directory, 'metadata.json'), '{broken');
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-invalid' });
}));

test('migrates v1 project IDs before storing immutable linked revisions', async () => withStore(async directory => {
  const filePath = '/private/editing/client-cut.fcpxml';
  const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
  const projectId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, projects: { [fingerprint]: projectId } }));
  const store = createLocalMetadataStore(directory);
  assert.equal((await store.getProjectId(filePath)).id, projectId);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8')).schemaVersion, 3);

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
