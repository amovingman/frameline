'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const adapter = require('../src/fcpxml-adapter');
const { prepareReviewCopySession } = require('../src/review-copy-session');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-session-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.fcpxml');
  const bytes = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/basic-edits.fcpxml'));
  fs.writeFileSync(sourcePath, bytes);
  const destinationDirectory = path.join(directory, 'copies');
  fs.mkdirSync(destinationDirectory);
  return { sourcePath, destinationDirectory, preferredFilename: 'Review.fcpxml',
    expectedSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('creates and scans an unchanged review copy without overwriting collisions or exposing paths', async t => {
  const request = fixture(t);
  const occupied = path.join(request.destinationDirectory, request.preferredFilename);
  fs.writeFileSync(occupied, 'existing');
  const original = fs.readFileSync(request.sourcePath);
  const result = await prepareReviewCopySession(request);
  assert.equal(result.status, 'ready');
  assert.equal(result.copyName, 'Review (2).fcpxml');
  assert.equal(result.sourceHash, request.expectedSha256);
  assert.equal(result.error, null);
  assert.equal(typeof result.scanSummary.clipCount, 'number');
  assert.deepEqual(fs.readFileSync(request.sourcePath), original);
  assert.deepEqual(fs.readFileSync(path.join(request.destinationDirectory, result.copyName)), original);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing');
  assert.equal(JSON.stringify(result).includes(path.dirname(request.sourcePath)), false);
});

test('fails closed for invalid requests, bundles, symlinks, stale sources and malformed XML', async t => {
  const request = fixture(t);
  const bundle = path.join(path.dirname(request.sourcePath), 'bundle.fcpxmld');
  fs.mkdirSync(bundle);
  const disguisedBundle = path.join(path.dirname(request.sourcePath), 'directory.fcpxml');
  fs.mkdirSync(disguisedBundle);
  const link = path.join(path.dirname(request.sourcePath), 'link.fcpxml');
  fs.symlinkSync(request.sourcePath, link);
  for (const input of [undefined, {}, { ...request, sourcePath: bundle }, { ...request, sourcePath: disguisedBundle },
    { ...request, sourcePath: link }, { ...request, preferredFilename: '../escape.fcpxml' },
    { ...request, expectedSha256: '0'.repeat(64) }]) {
    const result = await prepareReviewCopySession(input);
    assert.equal(result.status, 'error');
    assert.equal(result.copyName, null);
    assert.equal(JSON.stringify(result).includes(path.dirname(request.sourcePath)), false);
  }
  fs.writeFileSync(request.sourcePath, '<broken');
  request.expectedSha256 = createHash('sha256').update('<broken').digest('hex');
  assert.equal((await prepareReviewCopySession(request)).status, 'error');
  assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
});

for (const tamper of ['source', 'copy', 'scan-hash', 'source-symlink']) {
  test(`rejects ${tamper} tampering during scan and removes the failed copy`, async t => {
    const request = fixture(t);
    const scan = adapter.scanFcpXml;
    adapter.scanFcpXml = async filename => {
      const result = await scan(filename);
      if (tamper === 'scan-hash') result.sourceHash = '0'.repeat(64);
      else if (tamper === 'source-symlink') {
        fs.unlinkSync(request.sourcePath);
        fs.symlinkSync(filename, request.sourcePath);
      } else fs.appendFileSync(tamper === 'source' ? request.sourcePath : filename, 'changed');
      return result;
    };
    try {
      const result = await prepareReviewCopySession(request);
      assert.equal(result.status, 'error');
      assert.equal(result.scanSummary, null);
      assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
    } finally { adapter.scanFcpXml = scan; }
  });
}
