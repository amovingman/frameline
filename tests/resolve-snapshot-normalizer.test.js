'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');

const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const readFixture = name => JSON.parse(fs.readFileSync(path.join(proof, name), 'utf8'));

for (const fixture of ['live-mapping-before-schema3.json', 'live-mapping-after-schema3.json']) {
  test(`normalizes ${fixture} into a read-only camelCase manifest`, () => {
    const snapshot = readFixture(fixture);
    const manifest = normalizeResolveSnapshot(snapshot);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.readOnly, true);
    assert.equal(manifest.projectId, snapshot.project_id);
    assert.equal(manifest.resolveVersion, snapshot.resolve_version);
    assert.equal(manifest.timelines.length, snapshot.timelines.length);
    const timeline = manifest.timelines[0];
    assert.deepEqual(Object.keys(timeline), ['id', 'name', 'startFrame', 'tracks', 'items']);
    assert.deepEqual(Object.keys(timeline.tracks[0]), ['type', 'index', 'name']);
    assert.deepEqual(Object.keys(timeline.items[0]), [
      'id', 'trackType', 'trackIndex', 'type', 'name', 'startFrame', 'endFrame',
      'sourceStartFrame', 'sourceEndFrame', 'mediaPoolId', 'linkedItemIds', 'effectCounts'
    ]);
    assert.deepEqual(Object.keys(timeline.items[0].effectCounts), ['fusion', 'ofx', 'audio']);
    assert.equal('schema_version' in manifest, false);
  });
}

test('sorts tracks, items, and linked IDs deterministically without exposing source paths', () => {
  const snapshot = readFixture('live-mapping-after-schema3.json');
  const manifest = normalizeResolveSnapshot(snapshot);
  const reversed = structuredClone(snapshot);
  reversed.timelines.reverse();
  reversed.timelines.forEach(timeline => {
    timeline.tracks.reverse();
    timeline.items.reverse();
    timeline.items.forEach(item => item.linked_item_ids.reverse());
  });
  assert.deepEqual(normalizeResolveSnapshot(reversed), manifest);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /file:\/\/|Users\/user|\.fcpxml|\/Volumes\//i);
  assert.equal(serialized.includes('source_path'), false);
});

test('rejects an invalid schema-3 observation through the validator', () => {
  const invalid = readFixture('live-mapping-before-schema3.json');
  invalid.schema_version = 99;
  assert.throws(() => normalizeResolveSnapshot(invalid), { code: 'INVALID_RESOLVE_SNAPSHOT' });
});
