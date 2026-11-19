'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareReviewCopy } = require('./review-copy-preflight');
const adapter = require('./fcpxml-adapter');

// Main-process workflow. Only counts and basenames cross the public boundary.
function verifyRegularFile(filename, expectedHash) {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('changed');
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 20n * 1024n * 1024n) throw new Error('changed');
    const hash = createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(absolute, { bigint: true });
    if (hash !== expectedHash || !named.isFile() || named.isSymbolicLink()
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key] || before[key] !== named[key])) {
      throw new Error('changed');
    }
    return after;
  } finally { fs.closeSync(fd); }
}

async function prepareReviewCopySession(request) {
  let copyPath, transaction;
  try {
    copyPath = prepareReviewCopy({ ...request, onTransaction: value => { transaction = value; } });
    const expectedHash = request.expectedSha256.toLowerCase();
    const scan = await adapter.scanFcpXml(copyPath);
    if (scan.sourceHash !== expectedHash) throw new Error('changed');
    verifyRegularFile(copyPath, expectedHash);
    verifyRegularFile(request.sourcePath, expectedHash);
    if (transaction) request.cleanupJournal.validated(transaction);
    return {
      status: 'ready', copyName: path.basename(copyPath), sourceHash: expectedHash,
      scanSummary: {
        clipCount: scan.clips.length, mediaCount: scan.media.length,
        warningCount: scan.warnings.length, durationFrames: scan.sequence.durationFrames
      },
      error: null
    };
  } catch {
    if (transaction) { try { request.cleanupJournal.abort(transaction); } catch { /* Recovery remains available at next startup. */ } }
    // Publication is a point of uncertainty. Never unlink a published pathname
    // after asynchronous work: it may now contain user edits or be the only
    // remaining copy of the originally verified source bytes.
    return {
      status: 'error', copyName: null, sourceHash: null, scanSummary: null,
      error: { code: 'review-copy-failed', message: 'Unable to prepare a verified FCPXML review copy.' },
      ...(copyPath || transaction ? { recoveryRequired: true } : {})
    };
  }
}

module.exports = { prepareReviewCopySession };
