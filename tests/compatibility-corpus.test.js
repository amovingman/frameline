const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { scanFcpXml } = require('../src/fcpxml-adapter');
const { validateScanManifest } = require('../src/scan-manifest');

const corpus = path.join(__dirname, '..', 'phase-0', 'compatibility-corpus');

test('synthetic compatibility corpus matches expected read-only manifests', async () => {
  const expected = JSON.parse(await fs.readFile(path.join(corpus, 'expected.json'), 'utf8'));
  for (const [name, inventory] of Object.entries(expected)) {
    const filePath = path.join(corpus, name);
    const scan = await scanFcpXml(filePath);
    assert.equal(validateScanManifest(scan), scan);
    assert.equal(scan.sourceHash, createHash('sha256').update(await fs.readFile(filePath)).digest('hex'));
    const { sourceHash, schemaVersion, adapter, readOnly, identityStatus, ...actual } = scan;
    assert.deepEqual(actual, inventory, name);
    assert.equal(schemaVersion, 2);
    assert.equal(adapter, 'fcpxml');
    assert.equal(readOnly, true);
    assert.equal(identityStatus, 'unresolved');
  }
});
