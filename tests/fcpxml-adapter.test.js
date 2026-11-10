const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { fileErrorCode, scanFcpXml, scanXml, verifyFcpXmlSource } = require('../src/fcpxml-adapter');

const fixture = name => path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', name);

test('scans a plain FCPXML fixture into exact frames', async () => {
  const scan = await scanFcpXml(fixture('sample.fcpxml'));
  assert.equal(scan.schemaVersion, 2);
  assert.match(scan.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(scan.readOnly, true);
  assert.equal(scan.identityStatus, 'unresolved');
  assert.deepEqual(scan.sequence, { name: 'Mountain sample', frameDuration: '1/24s', durationFrames: 480 });
  assert.deepEqual(scan.clips.map(({ offsetFrames, durationFrames, sourceInFrames }) => [offsetFrames, durationFrames, sourceInFrames]), [[0, 192, 24], [192, 144, 48]]);
  assert.deepEqual(scan.media, [{ name: 'alpine-wide.mov', availability: 'missing' }, { name: 'ridge-detail.mov', availability: 'missing' }]);
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

test('checks local, missing, external, and unspecified sources without exposing paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-media-'));
  try {
    const localPath = path.join(dir, 'local clip.mov');
    await fs.writeFile(localPath, 'fixture');
    const sources = [pathToFileURL(localPath).href, pathToFileURL(path.join(dir, 'missing.mov')).href, 'https://example.invalid/remote.mov', null];
    const assets = sources.map((source, index) => `<asset id="a${index}" name="clip-${index}.mov"${source ? ` src="${source}"` : ''}/>`).join('');
    const clips = sources.map((_, index) => `<asset-clip ref="a${index}" offset="${index}s" duration="1s"/>`).join('');
    const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/>${assets}</resources><library><event><project><sequence format="f" duration="4s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`;
    const xmlPath = path.join(dir, 'cut.fcpxml');
    await fs.writeFile(xmlPath, xml);
    const scan = await scanFcpXml(xmlPath);
    assert.deepEqual(scan.media.map(item => item.availability), ['local', 'missing', 'external', 'unknown']);
    assert.doesNotMatch(JSON.stringify(scan), /frameline-media-|file:\/\/|example\.invalid/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reports unsupported timeline elements without inventing clips', () => {
  const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="a.mov"/></resources><library><event><project name="Test"><sequence format="f" duration="2s"><spine><asset-clip ref="a" offset="0s" duration="1s"/><transition offset="1s" duration="1s"/></spine></sequence></project></event></library></fcpxml>`;
  const scan = scanXml(xml);
  assert.equal(scan.clips.length, 1);
  assert.deepEqual(scan.warnings, ['Unsupported timeline element: transition']);
});

test('rejects malformed XML and non-frame-aligned timing', () => {
  assert.throws(() => scanXml('<fcpxml>'), { code: 'malformed-xml' });
  const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="a.mov"/></resources><library><event><project><sequence format="f" duration="1s"><spine><asset-clip ref="a" offset="0s" duration="1/25s"/></spine></sequence></project></event></library></fcpxml>`;
  assert.throws(() => scanXml(xml), { code: 'unsupported-timing' });
  assert.throws(() => scanXml(xml.replace('version="1.10"', 'version="1.11"')), { code: 'unsupported-fcpxml-version' });
});

test('rejects absent bundle content and unsupported files', async () => {
  await assert.rejects(scanFcpXml(fixture('missing.fcpxmld')), { code: 'file-unavailable' });
  await assert.rejects(scanFcpXml(fixture('sample.txt')), { code: 'unsupported-format' });
});

test('classifies filesystem errors without returning paths or system error details', () => {
  assert.equal(fileErrorCode({ code: 'EACCES' }), 'file-access-denied');
  assert.equal(fileErrorCode({ code: 'EPERM' }), 'file-access-denied');
  assert.equal(fileErrorCode({ code: 'EBUSY' }), 'file-busy');
  assert.equal(fileErrorCode({ code: 'ETXTBSY' }), 'file-busy');
  assert.equal(fileErrorCode({ code: 'ENOENT', path: '/private/project/cut.fcpxml' }), 'file-unavailable');
});

test('rejects saving a scan after the FCPXML source changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-source-'));
  try {
    const filePath = path.join(directory, 'cut.fcpxml');
    await fs.copyFile(fixture('sample.fcpxml'), filePath);
    const scan = await scanFcpXml(filePath);
    await verifyFcpXmlSource(filePath, scan.sourceHash);
    await fs.appendFile(filePath, '\n');
    await assert.rejects(verifyFcpXmlSource(filePath, scan.sourceHash), { code: 'revision-source-changed' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
