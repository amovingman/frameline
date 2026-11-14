'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { buildResolveCoverageMatrix } = require('../src/resolve-coverage-matrix');
const read = file => fs.readFileSync(path.join(__dirname, '../phase-0', file), 'utf8');
const manifest = () => normalizeResolveSnapshot(JSON.parse(read('resolve-xml-proof/live-mapping-before-schema3.json')));
const xml = read('compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml');

test('reports aggregate live structure evidence without claiming identities or track mappings', () => {
  const input = manifest();
  const before = structuredClone(input);
  const report = buildResolveCoverageMatrix(input, xml);
  assert.deepEqual(input, before);
  assert.equal(report.completeEnumeration, false);
  assert.equal(report.safeToApply, false);
  assert.equal(report.identityStatus, 'unresolved');
  const row = report.timelines[0];
  assert.equal(row.coverage.video.xmlCompoundReferences, 1);
  assert.equal(row.coverage.transitions.xmlEntries, 1);
  assert.equal(row.coverage.audio.xmlExplicitEntries, 1);
  assert.equal(row.coverage.effects.status, 'not-comparable');
  assert.equal(row.coverage.linked.status, 'identity-unresolved');
  assert.equal(row.coverage.extraTracks.status, 'track-mapping-unresolved');
  assert.ok(row.omitted.includes('empty-tracks-unavailable'));
  assert.ok(row.unobservable.includes('linked-item-identity'));
  assert.doesNotMatch(JSON.stringify(report), /moving-bars|mediaPoolId|file:\/\/|\/Users\/|\.mov/);
});

test('does not guess associations for multiple timelines and allows explicit selection', () => {
  const input = manifest();
  input.timelines.push({ ...structuredClone(input.timelines[0]), id: 'second-timeline' });
  const unresolved = buildResolveCoverageMatrix(input, xml);
  assert.ok(unresolved.timelines.every(row => row.sequenceId === null && row.coverage.video.status === 'unobservable'));
  const selected = buildResolveCoverageMatrix(input, xml, { timelineId: 'second-timeline', sequenceId: 'sequence-1' });
  assert.equal(selected.timelines.length, 1);
  assert.equal(selected.timelines[0].sequenceId, 'sequence-1');
  assert.equal(selected.scopeBasis, 'single-selected-pair-identity-unverified');
  assert.throws(() => buildResolveCoverageMatrix(input, xml, { sequenceId: 'missing' }), { code: 'INVALID_COVERAGE_INPUT' });
});

test('is deterministic under API collection ordering and rejects malformed input', () => {
  const input = manifest();
  const report = buildResolveCoverageMatrix(input, xml);
  input.timelines.reverse();
  input.timelines.forEach(t => { t.items.reverse(); t.tracks.reverse(); });
  assert.deepEqual(buildResolveCoverageMatrix(input, xml), report);
  input.timelines[0].items[0].effectCounts.ofx = -1;
  assert.throws(() => buildResolveCoverageMatrix(input, xml), { code: 'INVALID_COVERAGE_INPUT' });
});
