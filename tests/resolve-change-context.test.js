'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseResolvePreviewSource } = require('../src/resolve-preview-source');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveChangeContext, indexResolveSnapshotContext } = require('../src/resolve-change-context');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const baseFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json')));
function fixture(mutate = () => {}) {
  const snapshots = Object.fromEntries(['base', 'local', 'incoming'].map(role => [role, structuredClone(baseFixture)]));
  for (const snapshot of Object.values(snapshots)) for (const timeline of snapshot.timelines) for (const item of timeline.items) item.linked_item_ids = [];
  mutate(snapshots);
  const sources = Object.fromEntries(Object.entries(snapshots).map(([role, snapshot]) => [role, Buffer.from(JSON.stringify(snapshot))]));
  const documents = Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, parseResolvePreviewSource(source)]));
  const plan = createResolvePreviewPlan(sources);
  return { snapshots, sources, documents, plan, report: createResolveChangeContext(documents, plan.classification) };
}
const first = snapshot => snapshot.timelines[0].items[0];

test('all changed fields get identity-based per-source context and explicit consequences without touching canonical artifacts', () => {
  const { report, plan, sources, documents } = fixture(({ local, incoming }) => {
    first(local).name = 'Local rename'; first(incoming).name = 'Incoming rename';
    first(local).start_frame += 1; first(incoming).start_frame += 2;
  });
  const unchanged = JSON.stringify({ sources, documents, plan }), review = createResolveConflictReview(plan, sources);
  const audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'keep-local' })));
  assert.equal(report.records.length, plan.classification.decisions.length);
  const name = report.records.find(value => value.field === 'name');
  assert.equal(name.itemName, 'Local rename'); assert.equal(name.kind, 'clip-property'); assert.deepEqual(name.tracks, ['V1']);
  assert.equal(name.roles.local.itemName, 'Local rename'); assert.equal(name.roles.incoming.itemName, 'Incoming rename');
  assert.equal(name.roles.local.timelineName, baseFixture.timelines[0].name);
  assert.equal(name.roles.local.track.name, baseFixture.timelines[0].tracks.find(track => track.type === 'video').name);
  assert(name.consequences['keep-local'].description.includes('local observed value for name'));
  assert(name.consequences['take-incoming'].description.includes('incoming observed value for name'));
  const timing = report.records.find(value => value.field === 'startFrame');
  assert.equal(timing.kind, 'timing'); assert.match(timing.consequences['take-incoming'].description, /invalid intervals or overlaps/);
  assert.equal(report.safeToApply, false);
  assert.equal(JSON.stringify({ sources, documents, plan }), unchanged);
  assert.deepEqual(createResolveDecisionAudit(plan, sources, review.conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'keep-local' }))), audit);
  name.roles.local.neighbors.length = 0; assert.deepEqual(createResolveChangeContext(documents, plan.classification).records.find(row => row.field === 'name').roles.local.neighbors.length > 0, true);
});
test('deleted clips retain context on surviving sides and never fabricate absent placements', () => {
  const { report } = fixture(({ local, incoming }) => { first(local).name = 'Edited'; incoming.timelines[0].items.shift(); });
  const row = report.records.find(value => value.field === 'existence');
  assert.equal(row.kind, 'clip-deletion'); assert.equal(row.roles.incoming.present, false);
  assert.equal(row.roles.incoming.startFrame, null); assert.equal(row.roles.incoming.itemName, null);
  assert.equal(row.roles.local.present, true); assert.match(row.consequences['take-incoming'].description, /No editor deletion is performed/);
  assert.match(row.consequences['keep-local'].description, /instead of incoming deletion/);
});
test('whole timelines expose sequence context and affected track labels without invented clip intervals', () => {
  const { report } = fixture(({ local, incoming }) => { first(local).name = 'Edited'; incoming.timelines = []; });
  const row = report.records[0];
  assert.equal(row.kind, 'timeline-deletion'); assert.equal(row.itemId, null);
  assert.equal(row.roles.local.present, true); assert.equal(row.roles.local.startFrame, null); assert.equal(row.roles.local.track, null);
  assert.equal(row.roles.local.timelineOriginFrame, baseFixture.timelines[0].start_frame);
  assert.equal(row.roles.incoming.timelineName, null); assert.deepEqual(row.tracks, ['A1', 'V1']);
  assert.match(row.consequences['take-incoming'].description, /timeline and its represented contents/);
});
test('source identity wins over repeated names, and track moves retain old and new observed tracks', () => {
  const { report, snapshots } = fixture(({ local, incoming }) => {
    for (const snapshot of [local, incoming]) snapshot.timelines[0].tracks.push({ type: 'video', index: 2, name: 'Second picture' });
    first(local).track_index = 2; first(incoming).track_index = 2;
  });
  const row = report.records.find(value => value.field === 'track');
  assert.equal(row.itemId, first(snapshots.base).id); assert.deepEqual(row.tracks, ['V1', 'V2']);
  assert.equal(row.roles.base.track.index, 1); assert.equal(row.roles.local.track.index, 2);
});
test('neighbor order is deterministic under source enumeration and includes unchanged same-track context only', () => {
  const source = structuredClone(baseFixture), timeline = source.timelines[0], item = timeline.items[0];
  timeline.items = [0, 10, 20].map((frame, i) => ({ ...structuredClone(item), id: `v-${i}`, name: 'Repeated name', linked_item_ids: [], start_frame: frame, end_frame: frame + 10 }));
  const a = indexResolveSnapshotContext(source).context(timeline.id, 'v-1');
  assert.deepEqual(a.neighbors.map(row => row.id), ['v-0', 'v-2']);
  timeline.items.reverse(); timeline.tracks.reverse();
  assert.deepEqual(indexResolveSnapshotContext(source).context(timeline.id, 'v-1'), a);
  assert.equal(a.neighbors.length, 2);
});
test('track-state fields resolve the actual track without pretending they are clip fields', () => {
  const timeline = baseFixture.timelines[0], index = indexResolveSnapshotContext(baseFixture);
  const a = index.context(timeline.id, null, 'trackState.video.1.enabled');
  assert.equal(a.present, true); assert.equal(a.track.type, 'video'); assert.equal(a.track.index, 1); assert.equal(a.itemName, null);
  assert.equal(a.startFrame, null); assert.deepEqual(a.neighbors, []);
  assert.equal(index.context(timeline.id, null, 'trackState.video.999.enabled').present, false);
  // Snapshot presence establishes an indexed track, not that enabled/locked
  // values were observed. A track context is present even without supplements.
  assert.equal(index.context(timeline.id, null, 'trackState.video.1.locked').present, true);
  const wholeTimeline = index.context(timeline.id, null, 'tracks');
  assert.equal(wholeTimeline.present, true); assert.equal(wholeTimeline.track, null);
  assert.equal(wholeTimeline.startFrame, null);
});
test('rejects malformed sources and cross-project classification without returning misleading context', () => {
  const { documents, plan } = fixture(({ local }) => { first(local).name = 'Rename'; });
  assert.throws(() => createResolveChangeContext({ ...documents, extra: documents.base }, plan.classification), { code: 'invalid-resolve-change-context' });
  const bad = structuredClone(documents); bad.incoming.snapshot.project_id = 'different';
  assert.throws(() => createResolveChangeContext(bad, plan.classification), { code: 'invalid-resolve-change-context' });
  const wrong = structuredClone(plan.classification); wrong.projectId = 'different';
  assert.throws(() => createResolveChangeContext(documents, wrong), { code: 'invalid-resolve-change-context' });
});
