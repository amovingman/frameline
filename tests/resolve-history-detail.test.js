'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { describeResolveHistoryChanges } = require('../src/resolve-history-detail');

const fixture = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'live-mapping-before-schema3.json');

test('observation details filter the entire verified diff before the display limit', async () => {
  const original = JSON.parse(await fs.readFile(fixture, 'utf8'));
  const changed = structuredClone(original);
  const template = changed.timelines[0].items[0];
  for (let index = 0; index < 101; index++) changed.timelines[0].items.push({
    ...structuredClone(template), id: `synthetic-video-${String(index).padStart(3, '0')}`,
    name: `Synthetic ${index}`, linked_item_ids: []
  });
  changed.timelines[0].items.push({ ...structuredClone(template), id: 'zz-synthetic-audio',
    name: 'Synthetic audio', type: 'audio', track_type: 'audio', track_index: 1, linked_item_ids: [] });
  const before = createResolveRevisionManifest(original);
  const after = createResolveRevisionManifest(changed);
  const all = describeResolveHistoryChanges(before, after);
  assert.equal(all.changeCount, 102);
  assert.equal(all.changes.length, 100);
  assert.deepEqual(all.options.tracks, ['A1', 'V1']);
  const audio = describeResolveHistoryChanges(before, after, { track: 'A1', status: 'added' });
  assert.equal(audio.filteredCount, 1);
  assert.equal(audio.changes[0].itemName, 'Synthetic audio');
  assert.equal(audio.changes[0].timelineName, original.timelines[0].name);
  assert.equal(describeResolveHistoryChanges(before, after, { kind: 'item-deleted' }).filteredCount, 0);
  assert.throws(() => describeResolveHistoryChanges(before, after, { unknown: 'x' }),
    { code: 'resolve-history-filter-invalid' });
});
