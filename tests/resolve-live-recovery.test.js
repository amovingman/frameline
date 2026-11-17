'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { compareResolveRecovery } = require('../src/resolve-recovery-comparison');

const directory = path.join(__dirname, '../phase-0/resolve-xml-proof');
const source = fs.readFileSync(path.join(directory, 'live-mixed-linked-effect-schema3.json'));
const restored = fs.readFileSync(path.join(directory, 'live-restored-mixed-schema3.json'));

test('live DRP import regenerates every captured identity and cannot reuse the original plan bindings', () => {
  assert.equal(createHash('sha256').update(restored).digest('hex'),
    '654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850');
  const before = validateResolveSnapshot(JSON.parse(source));
  const after = validateResolveSnapshot(JSON.parse(restored));
  assert.notEqual(before.project_id, after.project_id);
  assert.notEqual(before.timelines[0].id, after.timelines[0].id);
  const oldIds = new Set(before.timelines[0].items.flatMap(item => [item.id, item.media_pool_id]).filter(Boolean));
  for (const item of after.timelines[0].items) {
    assert.ok(!oldIds.has(item.id));
    if (item.media_pool_id) assert.ok(!oldIds.has(item.media_pool_id));
  }
  const report = compareResolveRecovery(source, restored);
  assert.equal(report.status, 'observed-fields-differ');
  assert.equal(report.recoveryValidated, false);
  assert.deepEqual(report.changes.map(change => change.kind).sort(), ['timeline-added', 'timeline-deleted']);
});

// This fixture assertion compares the API's enumeration positions for this one
// known export/import pair. It is not an identity matcher for arbitrary projects.
function positionalObservation(snapshot) {
  return snapshot.timelines.map(timeline => {
    const itemPositions = new Map(timeline.items.map((item, index) => [item.id, index]));
    const mediaGroups = new Map();
    for (const [index, item] of timeline.items.entries()) {
      if (item.media_pool_id !== null) {
        const group = mediaGroups.get(item.media_pool_id) || [];
        group.push(index);
        mediaGroups.set(item.media_pool_id, group);
      }
    }
    return { name: timeline.name, start_frame: timeline.start_frame, tracks: timeline.tracks,
      items: timeline.items.map(item => {
        const { id, media_pool_id, linked_item_ids, ...observed } = item;
        return { ...observed, mediaGroup: media_pool_id === null ? null : mediaGroups.get(media_pool_id),
          linkedPositions: linked_item_ids.map(id => itemPositions.get(id)).sort((a, b) => a - b) };
      }) };
  });
}

test('known live restored fixture retains all enumerated values, link edges, and media sharing groups', () => {
  assert.deepEqual(positionalObservation(JSON.parse(restored)), positionalObservation(JSON.parse(source)));
});

test('live saved rename changes one observed field and forced-failure rollback restores exact snapshot bytes', () => {
  const read = phase => fs.readFileSync(path.join(directory, `live-rename-${phase}-schema3.json`));
  const before = read('before');
  const applied = read('applied');
  const rolledBack = read('rolled-back');
  assert.equal(createHash('sha256').update(applied).digest('hex'),
    '7655ea985e1033860f194f3e94b3e4f4c32147d71af4a98552d1cebf2021c9a9');
  assert.deepEqual(before, restored);
  assert.deepEqual(rolledBack, before);
  const changed = compareResolveRecovery(before, applied);
  assert.deepEqual(changed.changes, [{ kind: 'item-changed',
    timelineId: 'ed6239f2-300b-4615-ba3e-55bbef44b11c',
    itemId: 'caead6fa-1b2c-49a5-9325-8aae89a0fe55', field: 'name',
    before: 'mountain-alps.jpg', after: 'Frameline disposable rename' }]);
  assert.equal(compareResolveRecovery(before, rolledBack).status, 'observed-fields-match');
});
