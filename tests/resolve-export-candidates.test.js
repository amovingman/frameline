'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { compareResolveSnapshotToExport: compare } = require('../src/resolve-export-candidates');
const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
const fixture = phase => ({ snapshot: fs.readFileSync(path.join(root, `live-mapping-${phase}-schema3.json`)), xml: fs.readFileSync(path.join(root, `live-mapping-${phase}.fcpxmld/Info.fcpxml`)) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'a00c8594-ea28-480e-bfd9-4d3ed64d62ee';
const moved = '8543c72f-9c48-4744-81b5-ccc620e7c9bb';
const buffer = value => Buffer.from(JSON.stringify(value));

test('live snapshots produce candidate-only mappings bound to exact input bytes', () => {
  for (const [phase, index] of [['before', 5], ['after', 6]]) {
    const { snapshot, xml } = fixture(phase); const result = compare(snapshot, xml, id);
    assert.equal(result.status, 'candidates-only'); assert.equal(result.matches.length, 5);
    assert.equal(result.matches.find(m => m.apiItemId === moved).xmlSpineIndex, index);
    assert.deepEqual(result.unresolved, []); assert.equal(result.safeToApply, false);
    assert.equal(result.snapshotSha256, digest(snapshot)); assert.equal(result.exportSha256, digest(xml));
    assert.notEqual(compare(Buffer.concat([snapshot, Buffer.from(' ')]), xml, id).snapshotSha256, result.snapshotSha256);
    assert(!JSON.stringify(result).includes('/Users/'));
  }
});
test('reports collisions and missing candidates without selecting an arbitrary match', () => {
  const { snapshot, xml } = fixture('before'); const data = JSON.parse(snapshot); const timeline = data.timelines[0];
  const duplicate = structuredClone(timeline.items[0]); duplicate.id = 'duplicate'; timeline.items.push(duplicate);
  const result = compare(buffer(data), xml, id);
  assert.equal(result.status, 'unresolved'); assert.equal(result.matches.length, 4);
  assert.deepEqual(result.unresolved[0].apiItemIds.sort(), [duplicate.id, timeline.items[0].id].sort());
  assert.deepEqual(result.unresolved[0].xmlSpineIndices, [0]); assert.equal(result.safeToApply, false);
  timeline.items = timeline.items.slice(1, -1);
  const missing = compare(buffer(data), xml, id);
  assert(missing.unresolved.some(group => group.apiItemIds.length === 0 && group.xmlSpineIndices.length === 1));
});
test('rejects unsupported timeline content and selection with sanitized errors', () => {
  const { snapshot, xml } = fixture('before'); const text = xml.toString();
  for (const bad of [`<!DOCTYPE fcpxml SYSTEM "file:///private/tmp/not-used">${text}`, text.replace('</video>', '<audio/></video>'), text.replace('<gap name=', '<gap lane="1" name='), text.replace('</spine>', '<gap><video lane="1"/></gap></spine>'), text.replace('</spine>', '<audio/></spine>'), text.replace('duration="3/1s" offset="0/1s"', 'duration="1/100s" offset="0/1s"'), text.replace('version="1.10"', 'version="1.11"')]) {
    assert.throws(() => compare(snapshot, Buffer.from(bad), id));
  }
  assert.throws(() => compare(snapshot, xml, 'missing'), { code: 'INVALID_TIMELINE_SELECTION' });
  const data = JSON.parse(snapshot); data.timelines[0].items[0].track_type = 'audio';
  assert.throws(() => compare(buffer(data), xml, id));
  data.schema_version = 2; assert.throws(() => compare(buffer(data), xml, id), { code: 'INVALID_RESOLVE_SNAPSHOT' });
});
test('Resolve wrapper uses wrapper timing and requires a single video asset', () => {
  const { snapshot } = fixture('before'); const data = JSON.parse(snapshot); const t = data.timelines[0];
  t.items = [t.items[0]]; const item = t.items[0]; item.start_frame = t.start_frame + 48; item.end_frame = item.start_frame + 24; item.source_start_frame = 24; item.source_end_frame = 24;
  const makeXml = body => Buffer.from(`<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" hasVideo="1"/></resources><library><event><project><sequence format="f"><spine><clip offset="2s" start="1s" duration="1s">${body}</clip></spine></sequence></project></event></library></fcpxml>`);
  const video = '<video ref="a" duration="10s"/>';
  assert.deepEqual(compare(buffer(data), makeXml(video), id).matches, [{ apiItemId: item.id, xmlSpineIndex: 0 }]);
  for (const body of [video + video, video + '<audio/>', '<video ref="missing"/>', '<video ref="a"><audio/></video>']) assert.throws(() => compare(buffer(data), makeXml(body), id), { code: 'UNSUPPORTED_TIMELINE_CONTENT' });
});
