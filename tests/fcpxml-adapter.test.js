const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scanFcpXml, scanXml } = require('../src/fcpxml-adapter');

const fixture = name => path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', name);

test('scans a plain FCPXML fixture into exact frames', async () => {
  const scan = await scanFcpXml(fixture('sample.fcpxml'));
  assert.equal(scan.schemaVersion, 1);
  assert.equal(scan.readOnly, true);
  assert.equal(scan.identityStatus, 'unresolved');
  assert.deepEqual(scan.sequence, { name: 'Mountain sample', frameDuration: '1/24s', durationFrames: 480 });
  assert.deepEqual(scan.clips.map(({ offsetFrames, durationFrames, sourceInFrames }) => [offsetFrames, durationFrames, sourceInFrames]), [[0, 192, 24], [192, 144, 48]]);
  assert.deepEqual(scan.media, ['alpine-wide.mov', 'ridge-detail.mov']);
});

test('scans a Resolve bundle and never sends source paths to the renderer', async () => {
  const scan = await scanFcpXml(fixture('api-identity-before.fcpxmld'));
  assert.equal(scan.clips.length, 5);
  assert.deepEqual(scan.clips.map(clip => clip.offsetFrames), [0, 72, 168, 337, 457]);
  assert.equal(scan.clips[4].name, 'Alps API rename');
  assert.equal(scan.sequence.durationFrames, 554);
  assert.equal(scan.media.length, 3);
  assert.doesNotMatch(JSON.stringify(scan), /file:\/\/|Users\/user|Downloads/);
});

test('reports unsupported timeline elements without inventing clips', () => {
  const xml = `<?xml version="1.0"?><fcpxml><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="a.mov"/></resources><library><event><project name="Test"><sequence format="f" duration="2s"><spine><asset-clip ref="a" offset="0s" duration="1s"/><transition offset="1s" duration="1s"/></spine></sequence></project></event></library></fcpxml>`;
  const scan = scanXml(xml);
  assert.equal(scan.clips.length, 1);
  assert.deepEqual(scan.warnings, ['Unsupported timeline element: transition']);
});

test('rejects malformed XML and non-frame-aligned timing', () => {
  assert.throws(() => scanXml('<fcpxml>'), { code: 'malformed-xml' });
  const xml = `<?xml version="1.0"?><fcpxml><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="a.mov"/></resources><library><event><project><sequence format="f" duration="1s"><spine><asset-clip ref="a" offset="0s" duration="1/25s"/></spine></sequence></project></event></library></fcpxml>`;
  assert.throws(() => scanXml(xml), { code: 'unsupported-timing' });
});

test('rejects absent bundle content and unsupported files', async () => {
  await assert.rejects(scanFcpXml(fixture('missing.fcpxmld')), { code: 'file-unavailable' });
  await assert.rejects(scanFcpXml(fixture('sample.txt')), { code: 'unsupported-format' });
});
