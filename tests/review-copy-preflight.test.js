'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareReviewCopy } = require('../src/review-copy-preflight');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-copy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.fcpxml');
  const bytes = Buffer.from('<?xml version="1.0"?><fcpxml version="1.11"/>');
  fs.writeFileSync(sourcePath, bytes, { mode: 0o640 });
  fs.utimesSync(sourcePath, 1700000000, 1700000000);
  const destinationDirectory = path.join(directory, 'copies');
  fs.mkdirSync(destinationDirectory);
  return { sourcePath, destinationDirectory, preferredFilename: 'Review.fcpxml',
    expectedSha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
test('prepares a verified copy, preserves source and metadata, and avoids collisions', (t) => {
  const request = fixture(t);
  const before = fs.statSync(request.sourcePath);
  const occupied = path.join(request.destinationDirectory, request.preferredFilename);
  fs.writeFileSync(occupied, 'existing');
  const result = prepareReviewCopy(request);
  assert.equal(result, path.join(request.destinationDirectory, 'Review (2).fcpxml'));
  assert.deepEqual(fs.readFileSync(result), request.bytes);
  assert.deepEqual(fs.readFileSync(request.sourcePath), request.bytes);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing');
  const after = fs.statSync(request.sourcePath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(fs.statSync(result).mode & 0o777, before.mode & 0o777);
  assert.equal(fs.statSync(result).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(request.destinationDirectory).sort(), ['Review (2).fcpxml', 'Review.fcpxml']);
});
test('rejects stale source hash without creating a copy', (t) => {
  const request = fixture(t);
  fs.appendFileSync(request.sourcePath, 'tampered');
  assert.throws(() => prepareReviewCopy(request), { code: 'invalid-review-copy' });
  assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
});
test('detects source modification during copying and cleans temporary files', (t) => {
  const request = fixture(t);
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    fs.appendFileSync(request.sourcePath, 'tampered');
    return original(fd);
  };
  try { assert.throws(() => prepareReviewCopy(request), { code: 'invalid-review-copy' }); }
  finally { fs.fsyncSync = original; }
  assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
});
test('cleans temporary files after a write failure', (t) => {
  const request = fixture(t);
  const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('disk failure'); };
  try { assert.throws(() => prepareReviewCopy(request), /disk failure/u); }
  finally { fs.fsyncSync = original; }
  assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
  assert.deepEqual(fs.readFileSync(request.sourcePath), request.bytes);
});
test('refuses bundle directories, symlink paths and path traversal filenames', (t) => {
  const request = fixture(t);
  const bundle = path.join(path.dirname(request.sourcePath), 'bundle.fcpxml');
  fs.mkdirSync(bundle);
  assert.throws(() => prepareReviewCopy({ ...request, sourcePath: bundle }), { code: 'invalid-review-copy' });
  const link = path.join(path.dirname(request.sourcePath), 'link.fcpxml');
  fs.symlinkSync(request.sourcePath, link);
  assert.throws(() => prepareReviewCopy({ ...request, sourcePath: link }), { code: 'invalid-review-copy' });
  const directoryLink = path.join(path.dirname(request.sourcePath), 'copies-link');
  fs.symlinkSync(request.destinationDirectory, directoryLink);
  assert.throws(() => prepareReviewCopy({ ...request, destinationDirectory: directoryLink }), { code: 'invalid-review-copy' });
  assert.throws(() => prepareReviewCopy({ ...request, preferredFilename: '../escape.fcpxml' }), { code: 'invalid-review-copy' });
});

test('rejects a source larger than the supported FCPXML scan limit', t => {
  const request = fixture(t);
  fs.truncateSync(request.sourcePath, 20 * 1024 * 1024 + 1);
  assert.throws(() => prepareReviewCopy(request), { code: 'invalid-review-copy' });
  assert.deepEqual(fs.readdirSync(request.destinationDirectory), []);
});

test('CLI prepares a review copy and reports a generic stale-source error', t => {
  const request = fixture(t);
  const script = path.join(__dirname, '../phase-0/prepare-review-copy.js');
  const run = spawnSync(process.execPath, [script, request.sourcePath, request.destinationDirectory,
    request.preferredFilename, request.expectedSha256], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.planApplied, false);
  assert.deepEqual(fs.readFileSync(result.reviewCopyPath), request.bytes);
  fs.appendFileSync(request.sourcePath, 'changed');
  const stale = spawnSync(process.execPath, [script, request.sourcePath, request.destinationDirectory,
    request.preferredFilename, request.expectedSha256], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.equal(stale.stderr, 'review-copy-preflight-failed\n');
});
