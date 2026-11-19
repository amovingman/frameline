'use strict';

// Main-process helper only. This prepares an untouched review copy; it never
// applies a merge, edits the source, or opens an editor.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const MAX_XML_BYTES = 20 * 1024 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = 'invalid-review-copy';
  throw error;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
function assertPlainPath(filename) {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) invalid('Symlink paths are not supported for review copies.');
  }
  return absolute;
}
function readAtStart(fd) {
  const chunks = [];
  let position = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const count = fs.readSync(fd, chunk, 0, chunk.length, position);
    if (!count) return Buffer.concat(chunks);
    chunks.push(chunk.subarray(0, count));
    position += count;
  }
}

/**
 * Prepare a byte-identical, verified .fcpxml review copy in an existing directory.
 * Return the absolute path to the main-process caller only. No merge is applied.
 * Destination publication uses an exclusive hard link, so collisions never
 * replace files and incomplete bytes are never visible under the chosen name.
 */
function prepareReviewCopy({ sourcePath, expectedSha256, destinationDirectory, preferredFilename, cleanupJournal = null, onTransaction = () => {} } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath || !/\.fcpxml$/iu.test(sourcePath)
    || typeof destinationDirectory !== 'string' || !destinationDirectory
    || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(expectedSha256)
    || typeof preferredFilename !== 'string' || preferredFilename !== path.basename(preferredFilename)
    || preferredFilename.includes('\\') || preferredFilename.includes('\0')
    || !/^[^.].*\.fcpxml$/iu.test(preferredFilename) || typeof onTransaction !== 'function') invalid('Invalid review-copy request.');
  const source = assertPlainPath(sourcePath);
  const directory = assertPlainPath(destinationDirectory);
  const directoryStat = fs.statSync(directory, { bigint: true });
  if (!directoryStat.isDirectory()) invalid('Review-copy destination must be an existing directory.');
  const fd = fs.openSync(source, READ_FLAGS);
  let temporary;
  let published;
  let created = false;
  let transaction = null, ownedStage = null;
  try {
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile()) invalid('Review-copy source must be a regular FCPXML file.');
    if (initial.size > BigInt(MAX_XML_BYTES)) invalid('Review-copy source exceeds the supported FCPXML size.');
    const bytes = readAtStart(fd);
    if (digest(bytes) !== expectedSha256.toLowerCase()) invalid('Review-copy source has changed.');
    if (cleanupJournal) {
      transaction = cleanupJournal.begin({ sourcePath: source, destinationDirectory: directory, expectedSha256: expectedSha256.toLowerCase(), sourceIdentity: initial, directoryIdentity: directoryStat });
      temporary = transaction.temporaryPath; onTransaction(transaction);
    } else temporary = path.join(directory, `.review-copy-${randomBytes(16).toString('hex')}.tmp`);
    const output = transaction ? transaction.outputFd : fs.openSync(temporary, 'wx+', 0o600);
    ownedStage = fs.fstatSync(output, { bigint: true });
    created = true;
    try {
      fs.writeFileSync(output, bytes);
      if (transaction) cleanupJournal.willPreserveMetadata(transaction);
      // Preserve ordinary permission bits without propagating special bits.
      fs.fchmodSync(output, Number(initial.mode & 0o777n));
      fs.futimesSync(output, Number(initial.atimeNs) / 1e9, Number(initial.mtimeNs) / 1e9);
      fs.fsyncSync(output);
      if (digest(readAtStart(output)) !== expectedSha256.toLowerCase()) invalid('Review copy verification failed.');
      if (transaction) cleanupJournal.stageReady(transaction);
    } finally { ownedStage = fs.fstatSync(output, { bigint: true }); fs.closeSync(output); }
    assertPlainPath(source);
    assertPlainPath(directory);
    const currentDirectory = fs.statSync(directory, { bigint: true });
    if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino
      || !sameFile(initial, fs.fstatSync(fd, { bigint: true }))
      || !sameFile(initial, fs.lstatSync(source, { bigint: true }))
      || digest(readAtStart(fd)) !== expectedSha256.toLowerCase()
      || !sameFile(initial, fs.fstatSync(fd, { bigint: true }))) invalid('Review-copy source or destination has changed.');
    const extension = path.extname(preferredFilename);
    const stem = preferredFilename.slice(0, -extension.length);
    for (let index = 1; ; index += 1) {
      const candidate = path.join(directory, index === 1 ? preferredFilename : `${stem} (${index})${extension}`);
      try {
        if (transaction) cleanupJournal.prepareDestination(transaction, candidate);
        fs.linkSync(temporary, candidate); published = candidate;
        if (transaction) cleanupJournal.published(transaction);
        else { const parent = fs.openSync(directory, READ_FLAGS); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
        break;
      }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return published;
  } finally {
    fs.closeSync(fd);
    if (transaction) cleanupJournal.releaseStage(transaction);
    else if (created) {
      try {
        assertPlainPath(directory);
        const named = fs.lstatSync(temporary, { bigint: true }), parent = fs.statSync(directory, { bigint: true });
        if (named.isFile() && !named.isSymbolicLink() && ownedStage && parent.dev === directoryStat.dev && parent.ino === directoryStat.ino
          && ['dev', 'ino', 'birthtimeNs'].every(key => named[key] === ownedStage[key])) fs.unlinkSync(temporary);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { prepareReviewCopy };
