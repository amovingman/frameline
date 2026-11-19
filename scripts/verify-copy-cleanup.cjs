'use strict';
// Real process-death proof against disposable source/copy/journal directories.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createReviewCopyCleanup } = require('../src/review-copy-cleanup');
const { prepareReviewCopySession } = require('../src/review-copy-session');
const root = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv[2] === '--worker') {
  const directory = process.env.FRAMELINE_COPY_PROOF_ROOT, phase = process.env.FRAMELINE_COPY_PROOF_PHASE;
  if (!directory || !fs.existsSync(path.join(directory, '.disposable-copy-proof'))) throw new Error('Disposable fixture required');
  const sourcePath = path.join(directory, 'source.fcpxml'), bytes = fs.readFileSync(sourcePath);
  const die = () => process.kill(process.pid, 'SIGKILL');
  const journal = createReviewCopyCleanup({ directory: path.join(directory, 'journal'), onCheckpoint(name, transaction) {
    if (phase === 'partial-stage' && name === 'staged') {
      fs.writeSync(transaction.outputFd, bytes.subarray(0, Math.floor(bytes.length / 2))); fs.fsyncSync(transaction.outputFd); die();
    }
    if (phase === name) die();
  } });
  if (phase === 'linked-before-record') {
    const link = fs.linkSync;
    fs.linkSync = (...args) => { const result = link(...args); if (args[0].endsWith(`${path.sep}copy.tmp`)) die(); return result; };
  }
  if (phase === 'during-validation') {
    const adapter = require('../src/fcpxml-adapter'), scan = adapter.scanFcpXml;
    adapter.scanFcpXml = async (...args) => { await scan(...args); die(); };
  }
  prepareReviewCopySession({ sourcePath, destinationDirectory: path.join(directory, 'copies'), preferredFilename: 'Review.fcpxml',
    expectedSha256: sha(bytes), cleanupJournal: journal }).then(result => {
    assert.equal(result.status, 'ready'); console.log(JSON.stringify({ ready: true }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frameline-copy-cleanup-'));
  const bytes = fs.readFileSync(path.join(root, 'phase-0/compatibility-corpus/basic-edits.fcpxml'));
  const results = [];
  try {
    for (const phase of ['partial-stage', 'prepared', 'linked-before-record', 'published', 'during-validation', 'validated', 'complete']) {
      const fixture = path.join(directory, phase); fs.mkdirSync(fixture); fs.mkdirSync(path.join(fixture, 'copies'));
      fs.writeFileSync(path.join(fixture, '.disposable-copy-proof'), 'owned fixture');
      const source = path.join(fixture, 'source.fcpxml'); fs.writeFileSync(source, bytes, { mode: 0o640 }); fs.utimesSync(source, 1700000000, 1700000000);
      const before = fs.statSync(source, { bigint: true });
      const child = spawnSync(process.execPath, [__filename, '--worker'], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, FRAMELINE_COPY_PROOF_ROOT: fixture, FRAMELINE_COPY_PROOF_PHASE: phase } });
      if (phase === 'complete') assert.equal(child.status, 0, child.stderr);
      else assert.equal(child.signal, 'SIGKILL', child.stderr);
      const journal = createReviewCopyCleanup({ directory: path.join(fixture, 'journal') });
      const report = journal.recover();
      const output = path.join(fixture, 'copies/Review.fcpxml');
      const published = !['partial-stage', 'prepared'].includes(phase);
      assert.equal(fs.existsSync(output), published);
      if (published) assert.equal(sha(fs.readFileSync(output)), sha(bytes));
      assert.equal(report.preservedCount, ['linked-before-record', 'published', 'during-validation'].includes(phase) ? 1 : 0);
      assert.equal(fs.readdirSync(path.join(fixture, 'copies')).some(name => name.startsWith('.frameline-review-copy-')), false);
      assert.deepEqual(fs.readFileSync(source), bytes);
      const after = fs.statSync(source, { bigint: true });
      for (const key of ['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], `${phase} source ${key}`);
      assert.deepEqual(journal.recover(), report);
      assert.doesNotMatch(JSON.stringify(report), /source\.fcpxml|Review\.fcpxml|\/Users\/|frameline-copy-cleanup-/);
      results.push({ phase, signal: child.signal, removedCount: report.removedCount, preservedCount: report.preservedCount,
        publishedCopyPreserved: published, sourceBytesAndMetadataUnchanged: true, repeatedRecoveryIdempotent: true });
    }
    const evidence = { schemaVersion: 1, scope: 'Seven real Node process deaths/completions using disposable copies of a pinned FCPXML fixture; no editor write or user project',
      checks: ['partial staged bytes removed only after private marker/inode ownership verification', 'prepared copy cleanup after SIGKILL',
        'publication-before-record ambiguity retained', 'unvalidated published copies retained', 'durably validated copies never removed',
        'source bytes, mode, mtime, ctime, and identity unchanged', 'repeated startup recovery idempotent', 'public counts contain no paths'], results };
    const target = path.join(root, 'phase-0/copy-cleanup'); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
