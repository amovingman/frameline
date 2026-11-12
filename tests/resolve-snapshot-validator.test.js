const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');

function fixture(name = 'live-mapping-before-schema3.json') {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof', name), 'utf8'));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function rejects(mutate) {
  const snapshot = fixture();
  mutate(snapshot, snapshot.timelines[0], snapshot.timelines[0].items[0]);
  const before = JSON.stringify(snapshot);
  assert.throws(() => validateResolveSnapshot(snapshot), { code: 'INVALID_RESOLVE_SNAPSHOT' });
  assert.equal(JSON.stringify(snapshot), before);
}

test('all three observed schema-3 captures validate unchanged and deeply frozen', () => {
  for (const name of ['live-mapping-before-schema3.json', 'live-mapping-after-schema3.json', 'live-relink-schema3.json']) {
    const snapshot = freeze(fixture(name));
    assert.equal(validateResolveSnapshot(snapshot), snapshot);
  }
});

test('rejects unsupported versions and missing or extra fields at every level', () => {
  rejects(s => { s.schema_version = 2; });
  rejects(s => { s.resolve_version = '21.1.2.11'; });
  for (const select of [s => s, s => s.timelines[0], s => s.timelines[0].tracks[0], s => s.timelines[0].items[0], s => s.timelines[0].items[0].effect_counts]) {
    rejects(s => { select(s).file_path = '/Users/private/media.mov'; });
    rejects(s => { delete select(s)[Object.keys(select(s))[0]]; });
  }
});

test('rejects duplicate IDs and invalid tracks', () => {
  rejects((s, t) => { s.timelines.push(structuredClone(t)); });
  rejects((s, t) => { t.items.push(structuredClone(t.items[0])); });
  rejects((s, t) => { t.tracks.push(structuredClone(t.tracks[0])); });
  rejects((s, t, i) => { i.id = ''; });
  rejects((s, t, i) => { i.track_index = 99; });
  rejects((s, t, i) => { i.track_type = 'unknown'; });
  rejects((s, t, i) => { i.type = 'audio'; });
  rejects((s, t, i) => { i.type = 'transition'; i.track_type = 'subtitle'; });
  rejects((s, t) => { t.tracks[0].index = 0; });
});

test('validates frame intervals and nonnegative integral effect counts', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    rejects((s, t, i) => { i.start_frame = value; });
    rejects((s, t, i) => { i.effect_counts.fusion = value; });
  }
  rejects((s, t, i) => { i.end_frame = i.start_frame; });
  rejects((s, t, i) => { i.source_start_frame = 2; i.source_end_frame = 1; });
  rejects((s, t) => { t.start_frame = 1; });
});

test('accepts nullable media, links, effects, and empty timelines', () => {
  const snapshot = fixture();
  const [a, b] = snapshot.timelines[0].items;
  a.media_pool_id = null;
  a.linked_item_ids = [b.id];
  b.linked_item_ids = [a.id];
  a.effect_counts.fusion = 2;
  snapshot.timelines.push({ id: 'empty', name: '', start_frame: 0, tracks: [], items: [] });
  assert.equal(validateResolveSnapshot(snapshot), snapshot);
});

test('accepts a transition item on a video track without a source-media interval', () => {
  const snapshot = fixture();
  const item = snapshot.timelines[0].items[0];
  item.type = 'transition';
  item.media_pool_id = null;
  item.source_start_frame = null;
  item.source_end_frame = null;
  assert.equal(validateResolveSnapshot(snapshot), snapshot);
});

test('rejects dangling, duplicate, self, and malformed links', () => {
  for (const links of [['missing'], ['', 'missing'], [null], 'missing']) {
    rejects((s, t, i) => { i.linked_item_ids = links; });
  }
  rejects((s, t, i) => { i.linked_item_ids = [i.id]; });
  rejects((s, t, i) => { i.linked_item_ids = [t.items[1].id, t.items[1].id]; });
});

test('rejects paths, malformed objects, accessors and sparse arrays with sanitized errors', () => {
  for (const value of ['/Users/private/movie.mov', 'C:\\private\\movie.mov', 'https://private/media', 'file:///private/media']) {
    rejects(s => { s.project_name = value; });
    rejects((s, t, i) => { i.media_pool_id = value; });
  }
  for (const value of [null, [], true, 'private path', {}]) {
    assert.throws(() => validateResolveSnapshot(value), { code: 'INVALID_RESOLVE_SNAPSHOT' });
  }
  const snapshot = fixture();
  Object.defineProperty(snapshot, 'project_name', { enumerable: true, get() { throw new Error('/Users/private/secret'); } });
  assert.throws(() => validateResolveSnapshot(snapshot), error => {
    assert.equal(error.message, 'Invalid or unsupported Resolve API snapshot.');
    assert.equal(error.cause, undefined);
    return true;
  });
  rejects((s, t) => { delete t.items[0]; });
});
