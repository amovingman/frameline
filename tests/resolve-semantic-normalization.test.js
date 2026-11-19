'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareEffectObservations } = require('../src/resolve-effect-observation');
const { createResolveObservationManifest } = require('../src/resolve-revision-manifest');
const { compareResolveRevisionManifests } = require('../src/resolve-revision-comparison');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const read = name => fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof', name));
function rich() {
  const value = JSON.parse(read('live-properties-enabled.json'));
  value.items[0].properties.Pan = { decimal: '0.0000000000000000e+00' };
  value.items[0].properties.ZoomX = { decimal: '1.0000000000000000e+00' };
  return value;
}
const bytes = value => Buffer.from(JSON.stringify(value));

test('low-level property comparison, history and three-way preview agree on exact equivalent decimal spellings', () => {
  const base = rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.items[0].properties.Pan.decimal = '-0.0000000000000000e+99';
  incoming.items[0].properties.ZoomX.decimal = '0.1000000000000000e+01';
  local.items.reverse(); local.tracks.reverse();
  for (const observation of [local, incoming]) {
    observation.snapshot.timelines.reverse();
    for (const timeline of observation.snapshot.timelines) { timeline.items.reverse(); timeline.tracks.reverse(); for (const item of timeline.items) item.linked_item_ids.reverse(); }
    for (const item of observation.items) { item.effects.reverse(); item.properties = Object.fromEntries(Object.entries(item.properties).reverse()); }
  }
  const originals = [base, local, incoming].map(bytes);
  for (const changed of [local, incoming]) {
    const diff = compareEffectObservations(bytes(base), bytes(changed));
    assert.deepEqual(diff.snapshotChanges, []); assert.deepEqual(diff.effectChanges, []); assert.deepEqual(diff.propertyChanges, []); assert.deepEqual(diff.trackStateChanges, []);
    assert.deepEqual(compareResolveRevisionManifests(createResolveObservationManifest(base), createResolveObservationManifest(changed)).changes, []);
  }
  const plan = createResolvePreviewPlan({ base: bytes(base), local: bytes(local), incoming: bytes(incoming) });
  assert.deepEqual(plan.classification.decisions, []);
  assert.deepEqual([base, local, incoming].map(bytes), originals);
});

test('semantic normalization retains every represented digit and does not conflate absent coverage with a value', () => {
  const base = rich(), changed = structuredClone(base);
  base.items[0].properties.Pan.decimal = '1.0000000000000000e-01'; changed.items[0].properties.Pan.decimal = '1.0000000000000001e-01';
  const diff = compareEffectObservations(bytes(base), bytes(changed));
  assert.equal(diff.propertyChanges.length, 1); assert.equal(diff.propertyChanges[0].field, 'Pan');
  assert.equal(diff.propertyChanges[0].after.decimal, '1.0000000000000001e-01');
  delete changed.items[0].properties.Pan;
  const missing = compareEffectObservations(bytes(base), bytes(changed));
  assert.ok(missing.propertyChanges.some(row => row.field === 'Pan' && row.after === null));
  const plan = createResolvePreviewPlan({ base: bytes(base), local: bytes(base), incoming: bytes(changed) });
  assert.ok(plan.classification.observationCoverage.gaps.some(row => row.field === 'properties.Pan'));
  assert.equal(plan.safeToApply, false);
});

test('baseline canonical plan, conflict, and audit identities are unchanged by semantic comparison improvements', () => {
  const base = read('live-mapping-before-schema3.json'), local = JSON.parse(base), incoming = JSON.parse(base);
  local.timelines[0].items[0].name = 'Retained local edit'; incoming.timelines[0].items.shift();
  const sources = { base, local: bytes(local), incoming: bytes(incoming) };
  const plan = createResolvePreviewPlan(sources), review = createResolveConflictReview(plan, sources);
  const audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(row => ({ conflictId: row.id, choice: 'keep-local' })));
  assert.equal(review.planHash, '30379afcdecf3a7360394b4a819ba90477f9b2fb1bb17a8fe77f69035d7e0f06');
  assert.equal(review.conflicts[0].id, '2804850e7d734ce4ece70531f012229bf86141407863da92a634b4eccc5e2fe8');
  assert.equal(audit.auditHash, 'ea002b63ed8dd18e5856a3d4a30528ba02671a8410cb08d50a8504d4cddae8d7');
});
