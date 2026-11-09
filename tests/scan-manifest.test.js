const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanFcpXml } = require('../src/fcpxml-adapter');
const { validateScanManifest } = require('../src/scan-manifest');

const corpus = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof');

test('every FCPXML compatibility fixture produces a valid v1 scan manifest', async () => {
  const entries = (await fs.readdir(corpus)).filter(name => /\.fcpxml(d)?$/.test(name));
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    const scan = await scanFcpXml(path.join(corpus, entry));
    assert.equal(validateScanManifest(scan), scan, entry);
  }
});

test('rejects unknown versions, unsafe extra fields, and invalid frame values', async () => {
  const original = await scanFcpXml(path.join(corpus, 'sample.fcpxml'));
  for (const change of [
    scan => { scan.schemaVersion = 2; },
    scan => { scan.clips[0].source = 'file:///private/media.mov'; },
    scan => { scan.clips[0].durationFrames = 1.5; },
    scan => { scan.media[0].availability = 'synced'; }
  ]) {
    const scan = structuredClone(original);
    change(scan);
    assert.throws(() => validateScanManifest(scan), { code: 'invalid-manifest' });
  }
});
