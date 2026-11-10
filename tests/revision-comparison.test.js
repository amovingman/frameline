const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scanFcpXml } = require('../src/fcpxml-adapter');
const { compareScanRevisions } = require('../src/revision-comparison');

const fixture = name => path.join(__dirname, '..', 'phase-0', 'compatibility-corpus', name);

test('read-only comparison reports sequence and media inventory without claiming clip matches', async () => {
  const before = await scanFcpXml(fixture('edit-before.fcpxml'));
  const after = await scanFcpXml(fixture('edit-after.fcpxml'));
  const comparison = compareScanRevisions(before, after);
  assert.deepEqual(comparison.changes, [
    { kind: 'sequence', name: 'name', before: 'Edit before', after: 'Edit after' },
    { kind: 'sequence', name: 'durationFrames', before: 144, after: 120 },
    { kind: 'media', name: 'inserted.mov', before: null, after: 'unknown' },
    { kind: 'media', name: 'removed.mov', before: 'unknown', after: null }
  ]);
  assert.equal(comparison.beforeClipCount, 3);
  assert.equal(comparison.afterClipCount, 3);
  assert.equal(comparison.clipChangesAvailable, false);
});

test('same scan is a no-op and local media availability remains a distinct change', async () => {
  const before = await scanFcpXml(fixture('basic-edits.fcpxml'));
  assert.deepEqual(compareScanRevisions(before, before).changes, []);
  const after = structuredClone(before);
  after.media[0].availability = 'local';
  assert.deepEqual(compareScanRevisions(before, after).changes, [
    { kind: 'media', name: 'wide.mov', before: 'unknown', after: 'local' }
  ]);
});

test('equivalent rational frame durations are not reported as edits', async () => {
  const before = await scanFcpXml(fixture('basic-edits.fcpxml'));
  const after = structuredClone(before);
  after.sequence.frameDuration = '2/48s';
  assert.deepEqual(compareScanRevisions(before, after).changes, []);
});

test('duplicate media display names do not produce guessed asset matches', async () => {
  const before = await scanFcpXml(fixture('basic-edits.fcpxml'));
  const after = structuredClone(before);
  after.media.push({ name: 'wide.mov', availability: 'missing' });
  const comparison = compareScanRevisions(before, after);
  assert.equal(comparison.mediaNamesAmbiguous, true);
  assert.deepEqual(comparison.changes, []);
});
