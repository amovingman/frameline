'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createReviewCopyCleanup } = require('../src/review-copy-cleanup');
const { prepareReviewCopySession } = require('../src/review-copy-session');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copy-cleanup-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destinationDirectory = path.join(directory, 'copies'); fs.mkdirSync(destinationDirectory);
  const sourcePath = path.join(directory, 'source.fcpxml'), bytes = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/basic-edits.fcpxml'));
  fs.writeFileSync(sourcePath, bytes, { mode: 0o640 }); fs.utimesSync(sourcePath, 1700000000, 1700000000);
  const journalDirectory = path.join(directory, 'journal');
  const journal = createReviewCopyCleanup({ directory: journalDirectory, ...options });
  const request = { sourcePath, destinationDirectory, preferredFilename: 'Review.fcpxml', expectedSha256: sha(bytes), cleanupJournal: journal };
  return { directory, journalDirectory, journal, request, bytes };
}
function staged(f, complete = false) {
  const transaction = f.journal.begin({ ...f.request, sourceIdentity: fs.statSync(f.request.sourcePath, { bigint: true }),
    directoryIdentity: fs.statSync(f.request.destinationDirectory, { bigint: true }) });
  fs.writeSync(transaction.outputFd, complete ? f.bytes : f.bytes.subarray(0, 15)); fs.fsyncSync(transaction.outputFd); fs.closeSync(transaction.outputFd);
  return transaction;
}
function publish(f, name = 'Review.fcpxml') {
  const transaction = staged(f, true), candidate = path.join(f.request.destinationDirectory, name);
  f.journal.prepareDestination(transaction, candidate); fs.linkSync(transaction.temporaryPath, candidate); f.journal.published(transaction);
  return { transaction, candidate };
}
function abandon(f, transaction) {
  const filename = path.join(f.journalDirectory, `${transaction.id}.json`), record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const retired = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  record.ownerPid = Number(retired.stdout); fs.writeFileSync(filename, JSON.stringify(record));
}

test('successful journaled copy preserves source metadata and leaves no recovery work', async t => {
  const f = fixture(t), before = fs.statSync(f.request.sourcePath, { bigint: true });
  const result = await prepareReviewCopySession(f.request);
  assert.equal(result.status, 'ready'); assert.equal(f.journal.getState().preservedCount, 0);
  assert.equal(f.journal.getState().pendingCount, 0); assert.equal(f.journal.getState().removedCount, 0);
  assert.deepEqual(fs.readdirSync(f.request.destinationDirectory), ['Review.fcpxml']);
  assert.deepEqual(fs.readdirSync(f.journalDirectory), []);
  const after = fs.statSync(f.request.sourcePath, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
  assert.equal(fs.statSync(path.join(f.request.destinationDirectory, result.copyName)).mode & 0o777, 0o640);
});
test('recovery skips a live worker, then removes only the owned partial stage after owner retirement', t => {
  const f = fixture(t), transaction = staged(f);
  assert.equal(f.journal.recover().pendingCount, 1); assert.equal(fs.existsSync(transaction.temporaryPath), true);
  abandon(f, transaction);
  const result = f.journal.recover(); assert.equal(result.removedCount, 1); assert.equal(result.preservedCount, 0);
  assert.deepEqual(fs.readdirSync(f.request.destinationDirectory), []);
  assert.deepEqual(f.journal.recover(), result);
});
test('published unvalidated copies survive recovery and reveal through opaque transaction identity', t => {
  const f = fixture(t), { transaction, candidate } = publish(f); abandon(f, transaction);
  const result = f.journal.recover(); assert.equal(result.preservedCount, 1); assert.equal(result.entries[0].code, 'published-unvalidated');
  assert.equal(f.journal.getRecoveryLocation(transaction.id), candidate); assert.deepEqual(fs.readFileSync(candidate), f.bytes);
  assert.equal(fs.existsSync(transaction.temporaryPath), false);
  assert.throws(() => f.journal.getRecoveryLocation('../source'), { code: 'review-copy-cleanup-unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /source\.fcpxml|Review\.fcpxml|copy-cleanup-test-/);
});
for (const replacement of ['changed-copy', 'replaced-copy', 'copy-symlink', 'source-hardlink']) test(`${replacement} is preserved without trusting a pathname`, t => {
  const f = fixture(t), { transaction, candidate } = publish(f); abandon(f, transaction);
  const other = path.join(f.directory, 'unrelated'); fs.writeFileSync(other, 'unrelated data');
  if (replacement === 'changed-copy') fs.appendFileSync(candidate, 'user edits');
  if (replacement === 'replaced-copy') { fs.unlinkSync(candidate); fs.writeFileSync(candidate, 'user replacement'); }
  if (replacement === 'copy-symlink') { fs.unlinkSync(candidate); fs.symlinkSync(other, candidate); }
  if (replacement === 'source-hardlink') { fs.unlinkSync(candidate); fs.linkSync(f.request.sourcePath, candidate); }
  const result = f.journal.recover(); assert.equal(result.preservedCount, 1);
  assert.equal(fs.existsSync(candidate), true); assert.equal(fs.readFileSync(other, 'utf8'), 'unrelated data');
  assert.deepEqual(fs.readFileSync(f.request.sourcePath), f.bytes);
  if (replacement === 'changed-copy') assert.match(fs.readFileSync(candidate, 'utf8'), /user edits$/);
  if (replacement === 'replaced-copy') assert.equal(fs.readFileSync(candidate, 'utf8'), 'user replacement');
});
for (const replacement of ['new-inode', 'symlink', 'extra-file', 'source-link']) test(`ambiguous stage ${replacement} is never automatically removed`, t => {
  const f = fixture(t), transaction = staged(f); abandon(f, transaction);
  const other = path.join(f.directory, 'unrelated'); fs.writeFileSync(other, 'unrelated data');
  if (replacement === 'new-inode') { fs.unlinkSync(transaction.temporaryPath); fs.writeFileSync(transaction.temporaryPath, 'replacement'); }
  if (replacement === 'symlink') { fs.unlinkSync(transaction.temporaryPath); fs.symlinkSync(other, transaction.temporaryPath); }
  if (replacement === 'extra-file') fs.writeFileSync(path.join(path.dirname(transaction.temporaryPath), 'user-file'), 'user data');
  if (replacement === 'source-link') { fs.unlinkSync(transaction.temporaryPath); fs.linkSync(f.request.sourcePath, transaction.temporaryPath); }
  const result = f.journal.recover(); assert.equal(result.preservedCount, 1); assert.equal(result.removedCount, 0);
  assert.equal(fs.existsSync(transaction.temporaryPath), true); assert.equal(fs.readFileSync(other, 'utf8'), 'unrelated data');
  assert.deepEqual(fs.readFileSync(f.request.sourcePath), f.bytes);
});
test('symlinked or replaced destination parents do not redirect cleanup or reveal', t => {
  const f = fixture(t), transaction = staged(f); abandon(f, transaction);
  const moved = `${f.request.destinationDirectory}-moved`; fs.renameSync(f.request.destinationDirectory, moved);
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'user-file'), 'untouched');
  fs.symlinkSync(outside, f.request.destinationDirectory);
  const report = f.journal.recover(); assert.equal(report.preservedCount, 1); assert.equal(report.entries[0].canReveal, false);
  assert.throws(() => f.journal.getRecoveryLocation(transaction.id));
  assert.equal(fs.readFileSync(path.join(outside, 'user-file'), 'utf8'), 'untouched');
});
test('changed sources preserve the published original-byte recovery copy', t => {
  const f = fixture(t), { transaction, candidate } = publish(f); abandon(f, transaction); fs.appendFileSync(f.request.sourcePath, 'new source edits');
  const report = f.journal.recover(); assert.equal(report.entries[0].code, 'source-changed');
  assert.deepEqual(fs.readFileSync(candidate), f.bytes); assert.match(fs.readFileSync(f.request.sourcePath, 'utf8'), /new source edits$/);
});
for (const change of ['overwritten', 'deleted', 'replaced']) test(`prepared original-byte staging copy survives when its source is ${change}`, t => {
  const f = fixture(t), transaction = staged(f, true);
  f.journal.prepareDestination(transaction, path.join(f.request.destinationDirectory, 'Review.fcpxml'));
  abandon(f, transaction);
  const unrelated = path.join(f.request.destinationDirectory, 'unrelated.txt'); fs.writeFileSync(unrelated, 'unrelated work');
  if (change === 'overwritten') fs.writeFileSync(f.request.sourcePath, 'new source contents');
  else {
    fs.unlinkSync(f.request.sourcePath);
    if (change === 'replaced') fs.writeFileSync(f.request.sourcePath, f.bytes);
  }
  const result = f.journal.recover();
  assert.equal(result.removedCount, 0); assert.equal(result.preservedCount, 1); assert.equal(result.entries[0].code, 'source-changed');
  assert.deepEqual(fs.readFileSync(transaction.temporaryPath), f.bytes);
  assert.equal(f.journal.getRecoveryLocation(transaction.id), transaction.temporaryPath);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated work');
  assert.equal(fs.existsSync(path.join(f.request.destinationDirectory, 'Review.fcpxml')), false);
  assert.deepEqual(f.journal.recover(), result);
});
test('normal prepublication release retains original staging bytes after a failed source recheck', t => {
  const f = fixture(t), transaction = staged(f, true);
  fs.writeFileSync(f.request.sourcePath, 'concurrent source edits');
  assert.equal(f.journal.releaseStage(transaction), false);
  const result = f.journal.abort(transaction);
  assert.equal(result.removedCount, 0); assert.equal(result.entries[0].code, 'source-changed');
  assert.deepEqual(fs.readFileSync(transaction.temporaryPath), f.bytes);
  assert.equal(fs.readFileSync(f.request.sourcePath, 'utf8'), 'concurrent source edits');
});
test('validated copies never become cleanup candidates even after user edits', t => {
  const f = fixture(t), { transaction, candidate } = publish(f); f.journal.releaseStage(transaction); f.journal.validated(transaction);
  fs.appendFileSync(candidate, 'later user edits');
  const report = createReviewCopyCleanup({ directory: f.journalDirectory }).recover();
  assert.equal(report.preservedCount, 0); assert.match(fs.readFileSync(candidate, 'utf8'), /later user edits$/);
});
test('corrupt private journals fail closed and recovery page input never becomes a path', t => {
  const f = fixture(t), transaction = staged(f);
  assert.throws(() => f.journal.getState({ offset: '../source' }), { code: 'review-copy-cleanup-input-invalid' });
  assert.throws(() => f.journal.getState({ limit: 1000 }), { code: 'review-copy-cleanup-input-invalid' });
  fs.writeFileSync(path.join(f.journalDirectory, `${transaction.id}.json`), '{corrupt');
  assert.throws(() => f.journal.recover()); assert.equal(fs.existsSync(transaction.temporaryPath), true);
});
test('PID reuse is distinguished from a live owner while an unavailable identity probe fails closed', t => {
  const f = fixture(t, { getProcessStart: () => 'Original process start identity' }), transaction = staged(f);
  const uncertain = createReviewCopyCleanup({ directory: f.journalDirectory, getProcessStart: () => null });
  assert.equal(uncertain.recover().pendingCount, 1); assert.equal(fs.existsSync(transaction.temporaryPath), true);
  const reused = createReviewCopyCleanup({ directory: f.journalDirectory, getProcessStart: () => 'Replacement process start identity' });
  const result = reused.recover(); assert.equal(result.removedCount, 1); assert.equal(result.pendingCount, 0);
});
test('all recovery entries are accessible through bounded validated pages', t => {
  const f = fixture(t, { getProcessStart: () => 'Current process start identity' });
  for (let index = 0; index < 25; index++) {
    const { transaction } = publish(f, `Review-${index}.fcpxml`); f.journal.abort(transaction);
  }
  const first = f.journal.getState(); assert.equal(first.totalEntries, 25); assert.equal(first.entries.length, 20); assert.equal(first.nextOffset, 20);
  const second = f.journal.getState({ offset: first.nextOffset }); assert.equal(second.entries.length, 5); assert.equal(second.previousOffset, 0); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(row => row.id)).size, 25);
  assert.equal(f.journal.getState({ offset: 10000 }).offset, 20);
});
test('unknown stage birth time and replaced private journal directories do not permit automatic cleanup', t => {
  const f = fixture(t), transaction = staged(f); abandon(f, transaction);
  const file = path.join(f.journalDirectory, `${transaction.id}.json`), record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.stageIdentity.birthtimeNs = '0'; fs.writeFileSync(file, JSON.stringify(record));
  const result = f.journal.recover(); assert.equal(result.preservedCount, 1); assert.equal(result.removedCount, 0);
  const moved = `${f.journalDirectory}-moved`; fs.renameSync(f.journalDirectory, moved); fs.mkdirSync(f.journalDirectory);
  assert.throws(() => f.journal.getState(), { code: 'review-copy-cleanup-unavailable' });
  assert.equal(fs.existsSync(transaction.temporaryPath), true);
});
test('durability failure before copying preserves source and exposes recovery instead of publishing bytes', async t => {
  const f = fixture(t), original = fs.fsyncSync; let count = 0;
  fs.fsyncSync = function (fd) { if (++count === 1) throw Object.assign(new Error('disk sync failed'), { code: 'EIO' }); return original(fd); };
  try {
    const result = await prepareReviewCopySession(f.request); assert.equal(result.status, 'error');
    assert.deepEqual(fs.readFileSync(f.request.sourcePath), f.bytes);
    assert.deepEqual(fs.readdirSync(f.request.destinationDirectory), []);
    assert.deepEqual(fs.readdirSync(f.journalDirectory), []);
  } finally { fs.fsyncSync = original; }
});
test('real SIGKILL checkpoints recover partial work while preserving every published or validated copy', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-copy-cleanup.cjs')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout); assert.equal(evidence.results.length, 7);
  assert.ok(evidence.results.every(row => row.sourceBytesAndMetadataUnchanged && row.repeatedRecoveryIdempotent));
});
