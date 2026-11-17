'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest, validateResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { compareResolveRevisionManifests } = require('../src/resolve-revision-comparison');

const fixture = name => path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', `live-mapping-${name}-schema3.json`);

test('API observations form durable, source-bound local revisions without exposing a project path', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-resolve-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const before = createResolveRevisionManifest(JSON.parse(await fs.readFile(fixture('before'), 'utf8')));
  const after = createResolveRevisionManifest(JSON.parse(await fs.readFile(fixture('after'), 'utf8')));
  const store = createLocalMetadataStore(directory);
  const project = await store.getResolveProjectId(before.snapshot.project_id, before.snapshot.project_name);
  assert.equal(project.id, (await createLocalMetadataStore(directory).getResolveProjectId(before.snapshot.project_id)).id);
  assert.deepEqual((await store.listResolveProjects()).map(entry => ({ id: entry.id,
    displayName: entry.displayName, revisionCount: entry.revisionCount })),
  [{ id: project.id, displayName: before.snapshot.project_name, revisionCount: 0 }]);
  assert.equal(before.sourceHash !== after.sourceHash, true);
  const first = await store.saveRevision(project.id, before, 'Before move');
  const second = await store.saveRevision(project.id, after, 'Move on copy', first.id);
  assert.equal(second.parentRevisionId, first.id);
  assert.equal(second.editorVersion, '21.1.2.10');
  const loaded = await createLocalMetadataStore(directory).getRevision(project.id, second.id);
  assert.deepEqual(loaded.manifest, after);
  assert.equal(compareResolveRevisionManifests(before, loaded.manifest).changes.length, 2);
  assert.deepEqual((await store.listRevisions(project.id)).map(revision => revision.id), [second.id, first.id]);
  assert.equal((await store.listResolveProjects())[0].revisionCount, 2);
  const metadata = await fs.readFile(path.join(directory, 'metadata.json'), 'utf8');
  assert.doesNotMatch(metadata, /\/Users\//);
  const transfer = await store.exportRevisions(project.id);
  assert.equal(transfer.version, 2);
  const otherDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-resolve-import-'));
  t.after(() => fs.rm(otherDirectory, { recursive: true, force: true }));
  const other = createLocalMetadataStore(otherDirectory);
  const destination = await other.getResolveProjectId(before.snapshot.project_id);
  assert.equal((await other.importRevisions(destination.id, transfer)).revisionCount, 2);
  assert.equal((await other.listRevisions(destination.id, 'import-main')).length, 2);
  const unrelated = await other.getResolveProjectId('different-disposable-project-id');
  await assert.rejects(other.importRevisions(unrelated.id, transfer), { code: 'metadata-project-invalid' });
  await assert.rejects(other.saveRevision(unrelated.id, before, 'Wrong project'), { code: 'metadata-project-invalid' });
  await assert.rejects(other.importRevisions(destination.id, { ...transfer, version: 1 }),
    { code: 'revision-transfer-invalid' });
  await assert.rejects(store.getResolveProjectId(before.snapshot.project_id, '/private/name'),
    { code: 'metadata-project-invalid' });
});

test('Resolve revision manifests reject extra fields and changed captured observations', async () => {
  const before = createResolveRevisionManifest(JSON.parse(await fs.readFile(fixture('before'), 'utf8')));
  assert.equal(validateResolveRevisionManifest(before), before);
  assert.throws(() => validateResolveRevisionManifest({ ...before, sourceHash: '0'.repeat(64) }),
    { code: 'resolve-revision-invalid' });
  assert.throws(() => validateResolveRevisionManifest({ ...before, unknown: true }),
    { code: 'resolve-revision-invalid' });
  const changed = structuredClone(before);
  changed.snapshot.timelines[0].items[0].name = 'Changed after capture';
  assert.throws(() => validateResolveRevisionManifest(changed), { code: 'resolve-revision-invalid' });
});

test('API revision comparison ignores equivalent ordering and detects the paired edit', async () => {
  const original = JSON.parse(await fs.readFile(fixture('before'), 'utf8'));
  const base = createResolveRevisionManifest(original);
  const reordered = structuredClone(original);
  reordered.timelines.reverse();
  reordered.timelines[0].tracks.reverse();
  reordered.timelines[0].items.reverse();
  for (const item of reordered.timelines[0].items) item.linked_item_ids.reverse();
  const equivalent = createResolveRevisionManifest(reordered);
  assert.equal(compareResolveRevisionManifests(base, equivalent).changes.length, 0);
  const changed = createResolveRevisionManifest(JSON.parse(await fs.readFile(fixture('after'), 'utf8')));
  assert.equal(compareResolveRevisionManifests(base, changed).changes.length, 2);
});
