const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventoryTracks } = require('../src/fcpxml-tracks');
test('connected lanes retain their parent coordinate containers', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml'), 'utf8');
  const result = inventoryTracks(xml)[0];
  const lane = result.tracks.find(t => t.lane === 1 && t.type === 'video');
  assert.ok(lane.entries.every(e => result.containers.some(c => c.id === e.parentId)));
  assert.equal(result.timingMeaning, 'xml-serialized-unresolved');
  assert.deepEqual(result.counts, { serializedGaps: 1, pictureEntries: 3, audioEntries: 1, unknownEntries: 2 });
  assert.deepEqual(result.tracks.map(({ type, lane }) => [type, lane]), [
    ['video', 0], ['video', 1], ['unknown', 1], ['audio', 4], ['unknown', 2]
  ]);
});
