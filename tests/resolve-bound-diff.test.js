'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBoundResolveDiff, verifyBoundResolveDiff } = require('../src/resolve-bound-diff');

const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
const read = phase => ({ snapshot: fs.readFileSync(path.join(root, `live-mapping-${phase}-schema3.json`)),
  xml: fs.readFileSync(path.join(root, `live-mapping-${phase}.fcpxmld/Info.fcpxml`)) });
const before = read('before'), after = read('after');
const sources = { beforeSnapshotBytes: before.snapshot, beforeExportBytes: before.xml,
  afterSnapshotBytes: after.snapshot, afterExportBytes: after.xml,
  timelineId: 'a00c8594-ea28-480e-bfd9-4d3ed64d62ee' };

test('live paired exports show ID-based field changes with candidate context only', () => {
  const report = createBoundResolveDiff(sources);
  assert.equal(report.bindingStatus, 'paired-candidates-only');
  assert.equal(report.xmlIdentityProven, false);
  assert.equal(report.safeToApply, false);
  assert.deepEqual(report.changes.map(change => [change.kind, change.field]),
    [['item-changed', 'startFrame'], ['item-changed', 'endFrame']]);
  assert(report.changes.every(change => change.itemId === '8543c72f-9c48-4744-81b5-ccc620e7c9bb'));
  assert(report.changes.every(change => change.xmlCandidate.beforeSpineIndex === 5
    && change.xmlCandidate.afterSpineIndex === 6));
  assert.equal(verifyBoundResolveDiff(report, sources).valid, true);
  assert.equal(verifyBoundResolveDiff({ ...report, safeToApply: true }, sources).valid, false);
  assert.equal(verifyBoundResolveDiff(report, { ...sources,
    afterExportBytes: Buffer.concat([after.xml, Buffer.from(' ')]) }).valid, false);
});

test('ambiguous XML signatures leave API observations unanchored', () => {
  const duplicate = JSON.parse(before.snapshot);
  duplicate.timelines[0].items.push({ ...duplicate.timelines[0].items[0], id: 'duplicate' });
  const report = createBoundResolveDiff({ ...sources, beforeSnapshotBytes: Buffer.from(JSON.stringify(duplicate)) });
  assert.equal(report.bindingStatus, 'unresolved');
  assert(report.changes.length > 0);
  assert(report.changes.every(change => change.xmlCandidate === null));
  assert.equal(report.safeToApply, false);
});

test('CLI reports the same path-free source-bound comparison', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../phase-0/compare-bound-exports.js'),
    path.join(root, 'live-mapping-before-schema3.json'), path.join(root, 'live-mapping-before.fcpxmld'),
    path.join(root, 'live-mapping-after-schema3.json'), path.join(root, 'live-mapping-after.fcpxmld'),
    sources.timelineId], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), createBoundResolveDiff(sources));
  assert(!output.includes('/Users/'));
});
