const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectFreeExport } = require('../phase-0/inspect-free-export');
const { reconcileCoverage } = require('../phase-0/reconcile-free-coverage');

const corpus = path.join(__dirname, '../phase-0/compatibility-corpus');
const snapshot = JSON.parse(fs.readFileSync(path.join(corpus, 'live-structure-api.json'), 'utf8'));
const xml = inspectFreeExport(path.join(corpus, 'resolve-structure-live.fcpxmld'));

test('reports live Free API/XML agreement and omissions without exposing IDs or paths', () => {
  const report = reconcileCoverage(snapshot, xml);
  assert.deepEqual(report.api, {
    videoTracks: 3, audioTracks: 2, videoItems: 4, audioItems: 2,
    transitions: 1, itemsReportingLinks: 2, ofxOccurrences: 1
  });
  assert.deepEqual(report.xml, {
    pictureEntries: 3, compoundReferences: 1, explicitAudioEntries: 1,
    transitions: 1, serializedEffectNodes: 5, candidateAudioLinks: 0
  });
  assert.equal(report.coverage.videoAndUnknownCount, 'counts-agree-type-and-identity-unknown');
  assert.equal(report.coverage.audioCount, 'counts-differ');
  assert.equal(report.coverage.transitionCount, 'counts-agree-identity-unknown');
  assert.equal(report.completeEnumeration, false);
  assert.equal(report.safeToApply, false);
  assert.doesNotMatch(JSON.stringify(report), /file:\/\/|Users\/user|f9d4820a|5e1e6390/);
});

test('accepts a matching schema-3 Free snapshot without treating XML lanes as API tracks', () => {
  const tracks = snapshot.tracks.map(({ type, index }) => ({ type, index }));
  const items = snapshot.tracks.flatMap(track => track.items.map(item => ({
    type: item.type, track_type: track.type, track_index: track.index,
    linked_item_ids: item.linked_items ? ['linked-id'] : [],
    effect_counts: { ofx: item.ofx_effects }
  })));
  const schema3 = { schema_version: 3, resolve_version: '21.1.2.10',
    project_name: 'Frameline API Relink Test', timelines: [{
      name: 'Frameline Structure Coverage 00 Copy', tracks, items
    }] };
  const report = reconcileCoverage(schema3, xml);
  assert.equal(report.api.videoTracks, 3);
  assert.equal(report.coverage.audioCount, 'counts-differ');
  assert.equal(report.coverage.trackMapping, 'unresolved');
});

test('a missing XML item changes coverage and malformed observations fail closed', () => {
  const missing = structuredClone(xml);
  missing.transitions = [];
  assert.equal(reconcileCoverage(snapshot, missing).coverage.transitionCount, 'counts-differ');
  assert.throws(() => reconcileCoverage({}, xml), { message: 'invalid-api-observation' });
  assert.throws(() => reconcileCoverage(snapshot, {}), { message: 'invalid-xml-observation' });
  assert.throws(() => reconcileCoverage({ ...snapshot, provenance: 'DaVinci Resolve Free 21.1.2.10 / another Frameline timeline' }, xml), { message: 'matching-timeline-required' });
});
