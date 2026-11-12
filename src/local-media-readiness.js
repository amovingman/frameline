const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Local-only API. Paths returned by searchFolderCandidates must never be persisted
// in a public manifest. createReadinessReport deliberately omits all paths.
// evidence accepts only explicit booleans: volumeOffline, proxyOnly, excluded.
// expected identities are { size: nonnegative safe integer, sha256: hex SHA256 }.
function validIdentity(value) {
  return value && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256);
}
function fail(code) { const error = new Error(code); error.code = code; return error; }
async function noSymlinks(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail('invalid-path');
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await fsp.lstat(current)).isSymbolicLink()) throw fail('symlink-unsupported');
  }
  return absolute;
}

// Streams the file through SHA256; rejects symlinks, non-files and files observed
// changing during the read. Errors contain generic codes, never source paths.
async function fingerprintFile(filename) {
  let handle;
  try {
    const absolute = await noSymlinks(filename);
    handle = await fsp.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size)) throw fail('not-regular-file');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw fail('file-changed');
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    throw fail(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'symlink-unsupported',
      'invalid-path', 'not-regular-file', 'file-changed'].includes(error.code) ? error.code : 'read-failed');
  } finally { if (handle) await handle.close(); }
}

async function inspectAvailability({ path: filename, evidence = {} } = {}) {
  if (evidence.excluded === true) return { state: 'excluded', reason: 'explicit-exclusion' };
  if (evidence.volumeOffline === true) return { state: 'offline-volume', reason: 'explicit-offline-volume' };
  if (evidence.proxyOnly === true) return { state: 'proxy-only', reason: 'explicit-proxy-only' };
  if (!filename) return { state: 'unknown', reason: 'no-local-reference' };
  try {
    const absolute = await noSymlinks(filename);
    const stat = await fsp.lstat(absolute);
    return stat.isFile() ? { state: 'local', reason: 'regular-file-present' }
      : { state: 'unknown', reason: 'not-regular-file' };
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error.code)
      ? { state: 'missing', reason: 'reference-not-found' }
      : { state: 'unknown', reason: error.code === 'symlink-unsupported' ? 'symlink-unsupported' : 'reference-unreadable' };
  }
}

async function verifyCandidate(filename, expected) {
  if (!validIdentity(expected)) return { verified: false, reason: 'identity-unavailable' };
  try {
    const absolute = await noSymlinks(filename);
    const stat = await fsp.lstat(absolute);
    if (!stat.isFile()) return { verified: false, reason: 'not-regular-file' };
    if (stat.size !== expected.size) return { verified: false, reason: 'size-mismatch' };
    const actual = await fingerprintFile(absolute);
    return actual.size === expected.size && actual.sha256 === expected.sha256.toLowerCase()
      ? { verified: true, reason: 'size-and-hash-match' }
      : { verified: false, reason: 'hash-mismatch' };
  } catch (error) {
    return { verified: false, reason: error.code === 'file-changed' ? 'file-changed' : 'candidate-unreadable' };
  }
}

// Searches only the caller-selected folder. Does not follow directory/file
// symlinks. Bounds count every visited entry, including nonmatching files.
async function searchFolderCandidates(selectedFolder, { name, maxEntries = 10000, maxDepth = 8, maxCandidates = 100 } = {}) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name) throw fail('invalid-name');
  if (![maxEntries, maxCandidates].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(maxDepth) || maxDepth < 0) throw fail('invalid-limits');
  const candidates = [];
  let visited = 0;
  let truncated = false;
  let unreadable = 0;
  try {
    const root = await noSymlinks(selectedFolder);
    if (!(await fsp.lstat(root)).isDirectory()) throw fail('invalid-folder');
    const queue = [{ directory: root, depth: 0 }];
    outer: while (queue.length) {
      const { directory, depth } = queue.shift();
      let dir;
      try {
        await noSymlinks(directory);
        dir = await fsp.opendir(directory);
        for await (const entry of dir) {
          if (visited >= maxEntries) { truncated = true; break outer; }
          visited++;
          if (entry.isSymbolicLink()) continue;
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < maxDepth) queue.push({ directory: filename, depth: depth + 1 });
            else truncated = true;
          } else if (entry.isFile() && entry.name === name) {
            candidates.push({ path: filename });
            if (candidates.length >= maxCandidates) { truncated = true; break outer; }
          }
        }
      } catch { unreadable++; }
    }
  } catch { throw fail('folder-unreadable'); }
  return { candidates, visited, truncated, unreadable };
}

// media: [{ id: opaque path-free token, required?: boolean, path?, expected?, evidence? }]
// Required defaults to true. Presence or a filename match is never identity proof.
async function createReadinessReport(media) {
  if (!Array.isArray(media) || media.some(item => !item || typeof item.id !== 'string'
    || !/^[a-zA-Z0-9_.:-]+$/.test(item.id) || (item.required !== undefined && typeof item.required !== 'boolean'))
    || new Set(media.map(item => item.id)).size !== media.length) throw fail('invalid-media');
  const items = [];
  for (const item of media) {
    const availability = await inspectAvailability(item);
    const verification = availability.state === 'local'
      ? await verifyCandidate(item.path, item.expected)
      : { verified: false, reason: 'original-unavailable' };
    items.push({ id: item.id, required: item.required !== false, state: availability.state,
      availabilityReason: availability.reason, verified: verification.verified, reason: verification.reason });
  }
  const required = items.filter(item => item.required);
  return { schemaVersion: 1, readOnly: true, ready: required.every(item => item.verified),
    requiredCount: required.length, verifiedCount: required.filter(item => item.verified).length, items };
}

module.exports = { fingerprintFile, inspectAvailability, searchFolderCandidates, verifyCandidate, createReadinessReport };
