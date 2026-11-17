'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { readResolveHistoryPreviewSources } = require('../src/resolve-history-preview');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');

const fixture = name => path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', `live-mapping-${name}-schema3.json`);

test('stored Resolve branch ancestry supplies an exact-source three-way preview', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-resolve-history-preview-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(directory);
  const beforeSnapshot = JSON.parse(await fs.readFile(fixture('before'), 'utf8'));
  const afterSnapshot = JSON.parse(await fs.readFile(fixture('after'), 'utf8'));
  const project = await store.getResolveProjectId(beforeSnapshot.project_id, beforeSnapshot.project_name);
  const base = await store.saveRevision(project.id, createResolveRevisionManifest(beforeSnapshot), 'Base');
  await store.createBranch(project.id, 'incoming', base.id);
  const incomingSnapshot = structuredClone(beforeSnapshot);
  incomingSnapshot.timelines[0].items[0].name = 'Incoming rename';
  const incoming = await store.saveRevision(project.id, createResolveRevisionManifest(incomingSnapshot), 'Incoming', base.id, 'incoming');
  await store.switchBranch(project.id, 'main');
  const local = await store.saveRevision(project.id, createResolveRevisionManifest(afterSnapshot), 'Local move', base.id, 'main');
  const ids = { base: base.id, local: local.id, incoming: incoming.id };
  const sources = await readResolveHistoryPreviewSources(store, project.id, ids);
  assert.equal(JSON.parse(sources.base).project_id, beforeSnapshot.project_id);
  const plan = createResolvePreviewPlan(sources);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.safeToApply, false);
  assert.ok(plan.classification.decisions.length > 0);
  await assert.rejects(readResolveHistoryPreviewSources(store, project.id,
    { base: local.id, local: local.id, incoming: incoming.id }),
  { code: 'resolve-history-preview-invalid' });
  await assert.rejects(readResolveHistoryPreviewSources(store, project.id,
    { base: base.id, local: '0'.repeat(36), incoming: incoming.id }),
  { code: 'resolve-history-preview-invalid' });
  await fs.writeFile(path.join(directory, 'revisions', project.id, `${incoming.id}.json`), '{}');
  await assert.rejects(readResolveHistoryPreviewSources(store, project.id, ids),
    { code: 'resolve-history-preview-invalid' });
});
