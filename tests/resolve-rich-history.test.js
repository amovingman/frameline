'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createResolveRevisionManifest, createResolveObservationManifest, validateResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { compareResolveRevisionManifests, describeResolveRevisionCoverage } = require('../src/resolve-revision-comparison');
const { describeResolveHistoryChanges } = require('../src/resolve-history-detail');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveHistoryTransfer } = require('../src/resolve-history-transfer');
const { readResolveHistoryPreviewSources } = require('../src/resolve-history-preview');
const { createCaptureRequest, readCaptureResponse } = require('../src/resolve-companion-protocol');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rich = async () => JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json')));
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-rich-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('rich revisions bind every returned field while retaining a separate snapshot hash', async () => {
  const observed = await rich(), manifest = createResolveObservationManifest(observed);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.sourceHash, hash(observed));
  assert.equal(manifest.snapshotHash, createResolveRevisionManifest(observed.snapshot).sourceHash);
  assert.equal(validateResolveRevisionManifest(manifest), manifest);
  const altered = structuredClone(manifest);
  altered.observation.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  assert.throws(() => validateResolveRevisionManifest(altered), { code: 'resolve-revision-invalid' });
  altered.sourceHash = hash(altered.observation);
  assert.equal(validateResolveRevisionManifest(altered), altered);
  assert.equal(altered.snapshotHash, manifest.snapshotHash);
  altered.snapshot.timelines[0].items[0].name = 'Other name'; altered.snapshotHash = hash(altered.snapshot);
  assert.throws(() => validateResolveRevisionManifest(altered), { code: 'resolve-revision-invalid' });
  assert.throws(() => validateResolveRevisionManifest({ ...manifest, extra: true }), { code: 'resolve-revision-invalid' });
  observed.items[0].properties.Undocumented = true;
  assert.throws(() => createResolveObservationManifest(observed), { code: 'resolve-revision-invalid' });
});

test('history compares clip properties, effect slots and indexed track state without inventing missing coverage', async () => {
  const observed = await rich(), before = createResolveObservationManifest(observed), changed = structuredClone(observed);
  changed.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  changed.items[0].effects[0].enabled = false; changed.tracks[0].locked = true;
  const after = createResolveObservationManifest(changed);
  const diff = compareResolveRevisionManifests(before, after);
  assert.equal(diff.changes.length, 3);
  assert.deepEqual(new Set(diff.changes.map(change => change.kind)), new Set(['item-property-changed', 'effect-slot-changed', 'track-state-changed']));
  const detail = describeResolveHistoryChanges(before, after, { track: 'V1', kind: 'item-property-changed' });
  assert.equal(detail.filteredCount, 1); assert.equal(detail.changes[0].field, 'Pan');
  assert.equal(detail.changes[0].itemName, 'mountain-alps.jpg');
  assert.equal(detail.changes[0].timelineName, 'Frameline Capture Timeline');
  assert.deepEqual(detail.changes[0].after, { decimal: '1.3250000000000000e+01' });
  assert.equal(diff.coverage.comparableProperties, true);
  const legacy = createResolveRevisionManifest(observed.snapshot);
  const mixed = compareResolveRevisionManifests(legacy, after);
  assert.equal(mixed.coverageChanged, true); assert.equal(mixed.coverage.comparableProperties, false);
  assert.equal(mixed.changes.length, 0);
  assert.equal(mixed.coverage.before, null);
  assert.equal(describeResolveRevisionCoverage(after).propertyValueCount, 443);
  const unavailable = structuredClone(observed);
  unavailable.items[0].properties = {}; unavailable.items[0].propertyReadStatus = 'unavailable'; unavailable.tracks[0].enabled = null;
  const missing = compareResolveRevisionManifests(before, createResolveObservationManifest(unavailable));
  assert(missing.changes.some(change => change.field === 'propertyReadStatus' && change.after === 'unavailable'));
  assert(missing.changes.some(change => change.field === 'Pan' && change.after === null));
  assert.equal(missing.coverage.after.unavailablePropertyReads, 1);
});

test('richer revision comparison ignores equivalent observation ordering', async () => {
  const observed = await rich(), reordered = structuredClone(observed);
  reordered.items.reverse(); reordered.tracks.reverse(); reordered.snapshot.timelines.reverse();
  for (const timeline of reordered.snapshot.timelines) {
    timeline.items.reverse(); timeline.tracks.reverse(); for (const item of timeline.items) item.linked_item_ids.reverse();
  }
  const diff = compareResolveRevisionManifests(createResolveObservationManifest(observed), createResolveObservationManifest(reordered));
  assert.deepEqual(diff.changes, []); assert.equal(diff.coverageChanged, false);
});

test('history normalizes equivalent decimal spellings without losing represented precision', async () => {
  const observed = await rich(), changed = structuredClone(observed);
  changed.items[0].properties.Pan.decimal = '-0.0000000000000000e+00';
  changed.items[0].properties.ZoomX.decimal = '0.1000000000000000e+01';
  const before = createResolveObservationManifest(observed);
  assert.deepEqual(compareResolveRevisionManifests(before, createResolveObservationManifest(changed)).changes, []);
  observed.items[0].properties.Pan.decimal = '1.0000000000000000e-01';
  changed.items[0].properties.Pan.decimal = '1.0000000000000001e-01';
  const diff = compareResolveRevisionManifests(createResolveObservationManifest(observed), createResolveObservationManifest(changed));
  assert.equal(diff.changes.length, 1); assert.equal(diff.changes[0].field, 'Pan');
});

test('property filters apply before the history display limit', async () => {
  const observed = await rich(), changed = structuredClone(observed);
  for (const item of changed.items) {
    for (const key of ['AudioPan', 'AudioPitchCents', 'AudioPitchSemiTones', 'AudioVolume']) {
      if (item.properties[key]) item.properties[key].decimal = '1.0000000000000000e+00';
    }
  }
  changed.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  const before = createResolveObservationManifest(observed), after = createResolveObservationManifest(changed);
  const all = describeResolveHistoryChanges(before, after);
  assert(all.changeCount > 100); assert.equal(all.changes.length, 100);
  const filtered = describeResolveHistoryChanges(before, after, { track: 'V1', kind: 'item-property-changed' });
  assert.equal(filtered.filteredCount, 1); assert.equal(filtered.changes[0].field, 'Pan');
});

test('private richer capture requests reject downgrade, mixed request hashes and incomplete observations', async t => {
  const directory = await temporary(t), observation = await rich();
  const request = await createCaptureRequest({ directory, expectedProjectName: observation.snapshot.project_name, includeProperties: true });
  const response = { schemaVersion: 2, operation: 'capture-result', requestId: request.requestId,
    requestSha256: request.requestSha256, observation };
  const read = await readCaptureResponse({ directory, ...request, responseText: JSON.stringify(response), includeSnapshot: true });
  assert.deepEqual(read.observation, observation); assert.equal(read.coverage.propertyValueCount, 443);
  const publicRead = await readCaptureResponse({ directory, ...request, responseText: JSON.stringify(response) });
  assert.equal(publicRead.observation, undefined); assert.equal(publicRead.snapshot, undefined);
  const downgrade = { ...response, schemaVersion: 1, snapshot: observation.snapshot }; delete downgrade.observation;
  for (const invalid of [downgrade, { ...response, requestSha256: '0'.repeat(64) },
    { ...response, observation: { ...observation, items: [] } }]) {
    await assert.rejects(readCaptureResponse({ directory, ...request, responseText: JSON.stringify(invalid) }), { code: 'resolve-companion-invalid' });
  }
});

test('rich observation history survives reviewed backup transfer and still supplies snapshot-only preview sources', async t => {
  const root = await temporary(t), store = createLocalMetadataStore(path.join(root, 'metadata'));
  const observed = await rich(), manifest = createResolveObservationManifest(observed);
  const project = await store.getResolveProjectId(observed.snapshot.project_id, observed.snapshot.project_name);
  const baseline = await store.saveRevision(project.id, manifest, 'Properties before');
  const changed = structuredClone(observed); changed.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  const after = await store.saveRevision(project.id, createResolveObservationManifest(changed), 'Pan changed', baseline.id);
  const transfer = createResolveHistoryTransfer({ store });
  const review = await transfer.prepareExport(project.id), filename = path.join(root, 'history.json');
  await transfer.saveExport(review.token, filename);
  const importReview = await transfer.prepareImport(filename); await transfer.importReviewed(importReview.token);
  const imported = await store.listRevisions(project.id, 'import-main');
  assert.equal(imported.length, 2); assert.notEqual(imported[0].id, after.id);
  const loaded = await store.getRevision(project.id, imported[0].id);
  assert.deepEqual(loaded.manifest.observation, changed);
  assert.equal(loaded.contentHash, hash(changed));
  const sources = await readResolveHistoryPreviewSources(store, project.id, { base: baseline.id, local: after.id, incoming: after.id });
  assert.deepEqual(JSON.parse(sources.local), changed.snapshot);
  assert.equal(sources.local.toString(), sources.base.toString());
  assert.equal((await store.getBranchState(project.id)).currentBranch, 'main');
});

test('native normal-property history evidence binds the richer hashes while the snapshot hash stays unchanged', async () => {
  const bytes = await fs.readFile(path.join(__dirname, '../phase-0/normal-property-history-live-observation.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'dbd01700e28b5c939cd3f3032df1f737970ad091a2eb8e9849613f4bbf5f7d05');
  const report = JSON.parse(bytes), original = createResolveObservationManifest(await rich());
  const changed = createResolveObservationManifest(JSON.parse(await fs.readFile(path.join(__dirname,
    '../phase-0/resolve-xml-proof/live-properties-pan-changed.json'))));
  assert.equal(report.changedObservationHash, changed.sourceHash); assert.equal(report.restoredObservationHash, original.sourceHash);
  assert.equal(report.snapshotHash, original.snapshotHash); assert.equal(report.changedSnapshotHash, changed.snapshotHash);
  assert.equal(report.changedRevisionParentId, report.headBefore); assert.equal(report.restoredRevisionParentId, report.changedRevisionId);
  assert.equal(report.capturePartsPerObservation, 6); assert.equal(report.coverage.propertyValueCount, 443);
  assert.equal(report.initialMatchingCaptureCreatedNoRevision, true); assert.equal(report.restoredCaptureRepeatCreatedNoRevision, true);
  assert.equal(report.reopenedAfterDesktopRestart, true); assert.equal(report.nativePropertyComparisonVerified, true);
  assert.equal(report.fullNativePropertiesVerified, false); assert.equal(report.safeToApply, false);
});
