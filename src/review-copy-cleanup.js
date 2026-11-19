'use strict';
// Main-process ownership journal. Only private staging names are automatically
// removed. A published copy is preserved until its owner reviews it explicitly.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 20 * 1024 * 1024;
const READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const fail = () => Object.assign(new Error('Review-copy recovery is unavailable.'), { code: 'review-copy-cleanup-unavailable' });
const same = (a, b) => a && b && ['dev', 'ino', 'birthtimeNs'].every(key => a[key] === b[key]);
const identity = stat => Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map(key => [key, String(stat[key])]));
function plain(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]/.test(filename)) throw fail();
  let current = path.parse(filename).root;
  for (const component of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw fail();
  }
  return filename;
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, READ);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function stat(filename) { return fs.lstatSync(plain(filename), { bigint: true }); }
function currentIdentity(filename, expected, directory = false) {
  const value = stat(filename);
  if ((directory ? !value.isDirectory() : !value.isFile()) || !same(identity(value), expected)) throw fail();
  return value;
}
function fileHash(filename, expectedIdentity) {
  const before = currentIdentity(filename, expectedIdentity);
  if (before.size > BigInt(MAX_BYTES)) throw fail();
  const fd = fs.openSync(filename, READ);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!same(identity(opened), expectedIdentity)) throw fail();
    const hash = createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
    const after = fs.fstatSync(fd, { bigint: true }), named = stat(filename);
    if (!same(identity(named), expectedIdentity) || ['size', 'mtimeNs', 'ctimeNs'].some(key => opened[key] !== after[key] || opened[key] !== named[key])) throw fail();
    return hash;
  } finally { fs.closeSync(fd); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function processStart(pid) {
  try {
    const value = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[A-Za-z0-9 :]{10,60}$/.test(value) ? value : null;
  } catch { return null; }
}
function ownerActive(record, probe) {
  if (!alive(record.ownerPid)) return false;
  const start = record.ownerStart && probe(record.ownerPid);
  return !start || record.ownerStart === start;
}

function createReviewCopyCleanup({ directory, onCheckpoint = () => {}, getProcessStart = processStart } = {}) {
  if (!path.isAbsolute(directory || '') || typeof onCheckpoint !== 'function' || typeof getProcessStart !== 'function') throw fail();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); plain(directory);
  const journalIdentity = identity(stat(directory));
  let removedCount = 0;
  const filename = id => { if (!ID.test(id || '')) throw fail(); return path.join(directory, `${id}.json`); };
  function save(record) {
    currentIdentity(directory, journalIdentity, true);
    const target = filename(record.id), temporary = path.join(directory, `.${record.id}-${randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target); syncDirectory(directory);
    }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function read(id) {
    const fd = fs.openSync(filename(id), READ);
    let value;
    try {
      const details = fs.fstatSync(fd);
      if (!details.isFile() || details.size > 32768) throw fail();
      value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    const validIdentity = item => item && Object.keys(item).sort().join(',') === 'birthtimeNs,dev,ino'
      && Object.values(item).every(part => typeof part === 'string' && /^\d+$/.test(part));
    if (!value || value.version !== 1 || value.id !== id || !ID.test(value.token || '')
      || !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1
      || value.ownerStart !== null && (typeof value.ownerStart !== 'string' || !/^[A-Za-z0-9 :]{10,60}$/.test(value.ownerStart))
      || !['created', 'staged', 'prepared', 'published', 'validated', 'needs-review'].includes(value.status)
      || !HASH.test(value.expectedHash || '') || !validIdentity(value.sourceIdentity) || !validIdentity(value.directoryIdentity)
      || value.stageDirectoryIdentity !== null && !validIdentity(value.stageDirectoryIdentity)
      || value.stageIdentity !== null && !validIdentity(value.stageIdentity)
      || typeof value.metadataPending !== 'boolean'
      || !path.isAbsolute(value.sourcePath || '') || !path.isAbsolute(value.destinationDirectory || '')
      || value.stageDirectory !== path.join(value.destinationDirectory, `.frameline-review-copy-${id}`)
      || value.temporaryPath !== path.join(value.stageDirectory, 'copy.tmp')
      || value.candidatePath !== null && (path.dirname(value.candidatePath) !== value.destinationDirectory
        || !/^[^.].*\.fcpxml$/i.test(path.basename(value.candidatePath)))
      || value.code !== null && !['published-unvalidated', 'copy-changed', 'ownership-unverified', 'source-changed'].includes(value.code)) throw fail();
    return value;
  }
  function records() {
    currentIdentity(directory, journalIdentity, true);
    const names = fs.readdirSync(plain(directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
    if (names.length > 10000) throw fail();
    return names.sort().map(name => read(name.slice(0, -5)));
  }
  function forget(record) { fs.unlinkSync(filename(record.id)); syncDirectory(directory); }
  function destinationAvailable(record) {
    try { currentIdentity(record.destinationDirectory, record.directoryIdentity, true); return true; } catch { return false; }
  }
  function hasCandidate(record) {
    if (!record.candidatePath) return false;
    try {
      currentIdentity(record.candidatePath, record.stageIdentity);
      return true;
    } catch { return false; }
  }
  function markerMatches(record) {
    currentIdentity(record.destinationDirectory, record.directoryIdentity, true);
    currentIdentity(record.stageDirectory, record.stageDirectoryIdentity, true);
    const marker = path.join(record.stageDirectory, 'owner.json');
    const fd = fs.openSync(plain(marker), READ);
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 1024) throw fail();
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!fs.fstatSync(fd).isFile() || value.id !== record.id || value.token !== record.token || Object.keys(value).length !== 2) throw fail();
    } finally { fs.closeSync(fd); }
  }
  function sourceMatches(record) {
    try { return fileHash(record.sourcePath, record.sourceIdentity) === record.expectedHash; }
    catch { return false; }
  }
  function removeStage(record, countRemoval = false, sourceVerified = undefined) {
    try { fs.lstatSync(record.stageDirectory); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    if (!record.stageDirectoryIdentity) return false;
    markerMatches(record);
    const names = fs.readdirSync(record.stageDirectory);
    if (names.some(name => !['copy.tmp', 'owner.json'].includes(name))) return false;
    if (names.includes('copy.tmp')) {
      // Even provably owned staging bytes may now be the only remaining copy
      // of the verified original. Keep them when the source cannot be proved.
      if (!(sourceVerified ?? sourceMatches(record))) return false;
      if (!record.stageIdentity) return false;
      if (record.stageIdentity.birthtimeNs === '0') return false;
      let owned;
      try { owned = currentIdentity(record.temporaryPath, record.stageIdentity); }
      catch (error) {
        // macOS may adjust birth time when preserving an older mtime. This
        // transition is declared durably before futimes and accepted only for
        // the same owned inode with the complete expected bytes.
        const changed = stat(record.temporaryPath);
        if (!record.metadataPending || changed.dev.toString() !== record.stageIdentity.dev || changed.ino.toString() !== record.stageIdentity.ino
          || fileHash(record.temporaryPath, identity(changed)) !== record.expectedHash) throw error;
        owned = changed;
      }
      if (same(identity(owned), record.sourceIdentity)) return false;
      // A source replaced with a hard link to the stage is not ours to remove.
      try { if (same(identity(fs.statSync(record.sourcePath, { bigint: true })), record.stageIdentity)) return false; }
      catch (error) { if (error.code !== 'ENOENT') return false; }
      markerMatches(record); currentIdentity(record.temporaryPath, identity(owned));
      fs.unlinkSync(record.temporaryPath); if (countRemoval) removedCount++;
    }
    markerMatches(record);
    fs.unlinkSync(path.join(record.stageDirectory, 'owner.json'));
    fs.rmdirSync(record.stageDirectory); syncDirectory(record.destinationDirectory);
    return true;
  }
  function candidateCode(record, sourceVerified = undefined) {
    if (!destinationAvailable(record)) return 'ownership-unverified';
    if (!record.candidatePath) return null;
    try { fs.lstatSync(record.candidatePath); } catch (error) { if (error.code === 'ENOENT') return null; return 'ownership-unverified'; }
    if (!hasCandidate(record)) return 'ownership-unverified';
    try {
      if (record.candidatePath === record.sourcePath || same(record.stageIdentity, record.sourceIdentity)) return 'ownership-unverified';
      if (fileHash(record.candidatePath, record.stageIdentity) !== record.expectedHash) return 'copy-changed';
      if (!(sourceVerified ?? sourceMatches(record))) return 'source-changed';
      return 'published-unvalidated';
    } catch { return 'ownership-unverified'; }
  }
  function publicState(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['offset', 'limit'].includes(key))
      || !Number.isSafeInteger(options.offset ?? 0) || (options.offset ?? 0) < 0 || (options.offset ?? 0) > 10000
      || !Number.isSafeInteger(options.limit ?? 20) || (options.limit ?? 20) < 1 || (options.limit ?? 20) > 100) {
      throw Object.assign(new Error('Invalid copy-recovery page.'), { code: 'review-copy-cleanup-input-invalid' });
    }
    const pending = [];
    let pendingCount = 0, preservedCount = 0;
    for (const record of records()) {
      if (record.status === 'validated' && !fs.existsSync(record.stageDirectory)) continue;
      if (record.status !== 'needs-review' && record.status !== 'validated' && ownerActive(record, getProcessStart)) { pendingCount++; continue; }
      preservedCount++;
      pending.push(record);
    }
    const limit = options.limit ?? 20, requested = options.offset ?? 0;
    const offset = Math.min(requested, Math.max(0, Math.ceil(pending.length / limit) - 1) * limit);
    const entries = pending.slice(offset, offset + limit).map(record => ({ id: record.id, code: record.code || 'ownership-unverified', canReveal: destinationAvailable(record) }));
    return { status: preservedCount ? 'needs-review' : 'ready', removedCount, preservedCount, pendingCount, entries,
      offset, limit, totalEntries: preservedCount, previousOffset: offset ? Math.max(0, offset - limit) : null,
      nextOffset: offset + entries.length < pending.length ? offset + entries.length : null, truncated: false };
  }
  function recover() {
    for (const record of records()) {
      if (record.status !== 'needs-review' && record.status !== 'validated' && ownerActive(record, getProcessStart)) continue;
      const sourceVerified = sourceMatches(record);
      let stageRemoved = false;
      try { stageRemoved = removeStage(record, true, sourceVerified); } catch { /* Preserve ambiguity. */ }
      if (record.status === 'validated') {
        if (stageRemoved) forget(record);
        else { record.code = sourceVerified ? 'ownership-unverified' : 'source-changed'; save(record); }
        continue;
      }
      const code = candidateCode(record, sourceVerified);
      if (stageRemoved && code === null && destinationAvailable(record)) { forget(record); continue; }
      record.status = 'needs-review'; record.code = code || (!stageRemoved && !sourceVerified ? 'source-changed' : 'ownership-unverified'); save(record);
    }
    return publicState();
  }
  function begin({ sourcePath, destinationDirectory, expectedSha256, sourceIdentity, directoryIdentity }) {
    const id = randomBytes(16).toString('hex'), stageDirectory = path.join(destinationDirectory, `.frameline-review-copy-${id}`);
    const record = { version: 1, id, token: randomBytes(16).toString('hex'), ownerPid: process.pid, ownerStart: getProcessStart(process.pid), status: 'created', code: null,
      sourcePath, destinationDirectory, expectedHash: expectedSha256, sourceIdentity: identity(sourceIdentity), directoryIdentity: identity(directoryIdentity),
      stageDirectory, temporaryPath: path.join(stageDirectory, 'copy.tmp'), stageDirectoryIdentity: null, stageIdentity: null, candidatePath: null, metadataPending: false };
    plain(sourcePath); currentIdentity(destinationDirectory, record.directoryIdentity, true); save(record);
    let outputFd;
    try {
      fs.mkdirSync(stageDirectory, { mode: 0o700 });
      const markerFd = fs.openSync(path.join(stageDirectory, 'owner.json'), 'wx', 0o600);
      try { fs.writeFileSync(markerFd, JSON.stringify({ id, token: record.token })); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
      record.stageDirectoryIdentity = identity(stat(stageDirectory)); syncDirectory(stageDirectory); syncDirectory(destinationDirectory); save(record);
      outputFd = fs.openSync(record.temporaryPath, 'wx+', 0o600);
      record.stageIdentity = identity(fs.fstatSync(outputFd, { bigint: true })); record.status = 'staged'; syncDirectory(stageDirectory); save(record);
      const transaction = { id, temporaryPath: record.temporaryPath, outputFd };
      onCheckpoint('staged', transaction); return transaction;
    } catch (error) {
      if (outputFd !== undefined) fs.closeSync(outputFd);
      record.status = 'needs-review'; record.code = 'ownership-unverified'; save(record); throw error;
    }
  }
  function prepareDestination(transaction, candidatePath) {
    const record = read(transaction.id);
    if (record.ownerPid !== process.pid || !['staged', 'prepared'].includes(record.status)
      || path.dirname(candidatePath) !== record.destinationDirectory) throw fail();
    markerMatches(record);
    if (fileHash(record.temporaryPath, record.stageIdentity) !== record.expectedHash) throw fail();
    record.candidatePath = candidatePath; record.status = 'prepared'; save(record); onCheckpoint('prepared', { ...transaction, candidatePath });
  }
  function willPreserveMetadata(transaction) {
    const record = read(transaction.id); markerMatches(record); currentIdentity(record.temporaryPath, record.stageIdentity);
    record.metadataPending = true; save(record);
  }
  function stageReady(transaction) {
    const record = read(transaction.id), current = stat(record.temporaryPath); markerMatches(record);
    if (current.dev.toString() !== record.stageIdentity.dev || current.ino.toString() !== record.stageIdentity.ino
      || fileHash(record.temporaryPath, identity(current)) !== record.expectedHash) throw fail();
    record.stageIdentity = identity(current); record.metadataPending = false; save(record);
  }
  function published(transaction) {
    const record = read(transaction.id);
    if (record.status !== 'prepared' || !hasCandidate(record)) throw fail();
    syncDirectory(record.destinationDirectory); record.status = 'published'; save(record); onCheckpoint('published', { ...transaction, candidatePath: record.candidatePath });
  }
  function releaseStage(transaction) { return removeStage(read(transaction.id)); }
  function validated(transaction) {
    const record = read(transaction.id);
    const sourceVerified = sourceMatches(record);
    if (record.status !== 'published' || candidateCode(record, sourceVerified) !== 'published-unvalidated') throw fail();
    record.status = 'validated'; save(record); onCheckpoint('validated', { ...transaction, candidatePath: record.candidatePath });
    if (removeStage(record, false, sourceVerified)) forget(record);
  }
  function abort(transaction) {
    const record = read(transaction.id);
    const sourceVerified = sourceMatches(record);
    let removed = false;
    try { removed = removeStage(record, true, sourceVerified); } catch { /* Preserve ambiguity. */ }
    const code = candidateCode(record, sourceVerified);
    if (removed && code === null && destinationAvailable(record)) forget(record);
    else { record.status = 'needs-review'; record.code = code || (!removed && !sourceVerified ? 'source-changed' : 'ownership-unverified'); save(record); }
    return publicState();
  }
  function getRecoveryLocation(id) {
    const record = read(id);
    if (!['needs-review', 'validated'].includes(record.status) || !destinationAvailable(record)) throw fail();
    if (record.status === 'validated') return record.destinationDirectory;
    if (record.candidatePath && record.candidatePath !== record.sourcePath) {
      try { currentIdentity(record.candidatePath, record.stageIdentity); return record.candidatePath; } catch { /* Reveal only the verified parent. */ }
    }
    try { markerMatches(record); currentIdentity(record.temporaryPath, record.stageIdentity); return record.temporaryPath; }
    catch { /* A substituted stage is never a trusted reveal target. */ }
    return record.destinationDirectory;
  }
  return { recover, getState: publicState, begin, willPreserveMetadata, stageReady, prepareDestination, published, releaseStage, validated, abort, getRecoveryLocation };
}
module.exports = { createReviewCopyCleanup };
