'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { validateTransferBundle } = require('../src/revision-transfer');
const { compareScanRevisions } = require('../src/revision-comparison');
const { createMediaBoundScanManifest } = require('../src/media-revision-manifest');

test('immutable revision backups preserve media dependencies and reject dependency-only tampering', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-media-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(directory), project = await store.getProjectId('/disposable/timeline.fcpxml');
  const base = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
    sourceHash: 'a'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
  const identity = { version: 1, algorithm: 'sha256', contentId: `sha256:${'b'.repeat(64)}`, size: 6, assetClass: 'original', mediaType: null };
  const bound = createMediaBoundScanManifest(base, { coverage: 'complete', assets: [{ referenceId: 'media-1', identity, required: true }] });
  const saved = await store.saveRevision(project.id, bound, 'Media bound export');
  const loaded = await createLocalMetadataStore(directory).getRevision(project.id, saved.id);
  assert.deepEqual(loaded.manifest, bound); assert.equal(loaded.manifestVersion, 3);
  assert.deepEqual(compareScanRevisions(base, loaded.manifest).changes, []);
  const bundle = await store.exportRevisions(project.id);
  assert.deepEqual(validateTransferBundle(bundle).get(saved.id).manifest.mediaDependencies, bound.mediaDependencies);
  const altered = structuredClone(bundle), bytes = JSON.parse(altered.records[0].bytes);
  bytes.manifest.mediaDependencies.assets[0].identity.contentId = `sha256:${'c'.repeat(64)}`;
  altered.records[0].bytes = `${JSON.stringify(bytes, null, 2)}\n`;
  assert.throws(() => validateTransferBundle(altered), { code: 'revision-transfer-invalid' });
});
