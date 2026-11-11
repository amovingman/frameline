const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { compareResolveManifests } = require('../src/resolve-id-diff');
const { summarizeResolveChanges } = require('../src/resolve-change-summary');

const fixture = name => normalizeResolveSnapshot(JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof', name), 'utf8')));

test('classifies the live retained-ID edit as a position change with unchanged duration', () => {
  const summary = summarizeResolveChanges(compareResolveManifests(fixture('live-mapping-before-schema3.json'), fixture('live-mapping-after-schema3.json')));
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.otherChangeCount, 0);
  assert.deepEqual(summary.itemSummaries[0].classifications, ['position-change']);
  assert.equal(summary.itemSummaries[0].changes.length, 2);
  assert.equal(summary.safeToApply, false);
});

test('separates duration, rename, link, and effect-count changes, and handles no-op', () => {
  const before = fixture('live-mapping-before-schema3.json');
  assert.equal(summarizeResolveChanges(compareResolveManifests(before, before)).itemCount, 0);
  const after = structuredClone(before);
  const item = after.timelines[0].items[0];
  item.endFrame += 12;
  item.name = 'Renamed';
  item.linkedItemIds = [after.timelines[0].items[1].id];
  item.effectCounts.ofx = 1;
  const summary = summarizeResolveChanges(compareResolveManifests(before, after));
  assert.deepEqual(summary.itemSummaries[0].classifications, ['duration-change', 'effect-count-change', 'link-change', 'rename']);
});

test('refuses a write-authorizing or malformed diff', () => {
  assert.throws(() => summarizeResolveChanges({}), /invalid-resolve-diff/);
  assert.throws(() => summarizeResolveChanges({ schemaVersion: 1, readOnly: true, safeToApply: true, trackIdentityStatus: 'index-only', changes: [] }), /invalid-resolve-diff/);
});
