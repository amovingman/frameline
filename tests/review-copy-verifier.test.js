'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const adapter = require('../src/fcpxml-adapter');
const { verifyReviewCopy } = require('../src/review-copy-verifier');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.fcpxml');
  const copyPath = path.join(dir, 'copy.fcpxml');
  const bytes = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/basic-edits.fcpxml'));
  fs.writeFileSync(sourcePath, bytes); fs.writeFileSync(copyPath, bytes);
  return { dir, bytes, sourcePath, copyPath, expectedSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('verifies existing identical files without writing or exposing paths', async t => {
  const req = fixture(t);
  const result = await verifyReviewCopy(req);
  assert.equal(result.status, 'ready');
  assert.equal(result.copyName, 'copy.fcpxml');
  assert.equal(result.sourceHash, req.expectedSha256);
  assert.equal(result.error, null);
  assert.equal(typeof result.scanSummary.clipCount, 'number');
  assert.deepEqual(fs.readFileSync(req.sourcePath), req.bytes);
  assert.deepEqual(fs.readFileSync(req.copyPath), req.bytes);
  assert.equal(JSON.stringify(result).includes(req.dir), false);
});

test('fails closed for stale, malformed, linked, identical and non-file inputs', async t => {
  const req = fixture(t);
  const link = path.join(req.dir, 'link.fcpxml'); fs.symlinkSync(req.copyPath, link);
  const ancestor = path.join(req.dir, 'linked'); fs.symlinkSync(req.dir, ancestor);
  const hard = path.join(req.dir, 'hard.fcpxml'); fs.linkSync(req.sourcePath, hard);
  const bundle = path.join(req.dir, 'bundle.fcpxml'); fs.mkdirSync(bundle);
  for (const input of [undefined, null, {}, { ...req, expectedSha256: '0'.repeat(64) },
    { ...req, copyPath: link }, { ...req, copyPath: path.join(ancestor, 'copy.fcpxml') },
    { ...req, copyPath: hard }, { ...req, copyPath: req.sourcePath }, { ...req, copyPath: bundle },
    { ...req, copyPath: path.join(req.dir, 'foo.fcpxmld') }]) {
    const result = await verifyReviewCopy(input);
    assert.equal(result.status, 'error'); assert.equal(result.copyName, null);
    assert.equal(JSON.stringify(result).includes(req.dir), false);
  }
  fs.writeFileSync(req.copyPath, 'changed');
  assert.equal((await verifyReviewCopy(req)).status, 'error');
  fs.writeFileSync(req.sourcePath, '<broken'); fs.writeFileSync(req.copyPath, '<broken');
  req.expectedSha256 = createHash('sha256').update('<broken').digest('hex');
  assert.equal((await verifyReviewCopy(req)).status, 'error');
});

for (const target of ['sourcePath', 'copyPath', 'manifest']) {
  test(`rejects ${target} tampering during scanning`, async t => {
    const req = fixture(t); const scan = adapter.scanFcpXml; let calls = 0;
    adapter.scanFcpXml = async filename => {
      const result = await scan(filename); calls++;
      if (calls === 2) {
        if (target === 'manifest') result.sequence.name += ' altered';
        else fs.appendFileSync(req[target], 'changed');
      }
      return result;
    };
    try { assert.equal((await verifyReviewCopy(req)).status, 'error'); }
    finally { adapter.scanFcpXml = scan; }
  });
}
