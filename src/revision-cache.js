const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');

const MAX_CACHE_BYTES = 64 * 1024 * 1024, MAX_HISTORY = 10_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/, MANIFEST = /^sha256:[a-f0-9]{64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const validId = value => typeof value === 'string' && ID.test(value);
const date = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const message = value => typeof value === 'string' && value.trim() && value.length <= 240
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
function fail(code) { return Object.assign(new Error(code), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function validateResult(value) {
  const keys = ['schemaVersion', 'remoteProjectId', 'branch', 'head', 'revisions', 'manifests', 'mediaFetched'];
  if (!exact(value, [...keys, ...(Object.hasOwn(value || {}, 'checkedAt') ? ['checkedAt'] : [])])
    || value.schemaVersion !== 1 || !validId(value.remoteProjectId) || !validId(value.branch)
    || value.head !== null && !validId(value.head) || value.mediaFetched !== false
    || !Array.isArray(value.revisions) || value.revisions.length > MAX_HISTORY
    || !Array.isArray(value.manifests) || value.manifests.length > MAX_HISTORY
    || Object.hasOwn(value, 'checkedAt') && (!Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0
      || value.checkedAt > 8_640_000_000_000_000)) throw fail('revision-cache-invalid');
  const manifests = new Map();
  for (const item of value.manifests) {
    if (!exact(item, ['id', 'projectId', 'document', 'createdAt']) || typeof item.id !== 'string' || !MANIFEST.test(item.id)
      || item.projectId !== value.remoteProjectId || manifests.has(item.id) || !date(item.createdAt)) throw fail('revision-cache-invalid');
    try { validateRevisionManifest(item.document); if (item.id !== `sha256:${fingerprint(item.document)}`) throw fail('revision-cache-invalid'); }
    catch { throw fail('revision-cache-invalid'); }
    manifests.set(item.id, item);
  }
  const ids = new Set(), sources = new Set(), used = new Set(); let parent = null;
  for (const item of value.revisions) {
    if (!exact(item, ['id', 'projectId', 'manifestId', 'parentRevisionId', 'authorId', 'message', 'sourceRevisionId', 'createdAt'])
      || !validId(item.id) || ids.has(item.id) || item.projectId !== value.remoteProjectId || !manifests.has(item.manifestId)
      || item.parentRevisionId !== parent || !validId(item.authorId) || !message(item.message) || !date(item.createdAt)
      || item.sourceRevisionId !== null && (!validId(item.sourceRevisionId) || sources.has(item.sourceRevisionId))) throw fail('revision-cache-invalid');
    ids.add(item.id); if (item.sourceRevisionId !== null) sources.add(item.sourceRevisionId);
    used.add(item.manifestId); parent = item.id;
  }
  if (parent !== value.head || used.size !== manifests.size) throw fail('revision-cache-invalid');
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw fail('revision-cache-invalid'); }
  if (bytes > MAX_CACHE_BYTES) throw fail('revision-cache-invalid');
  return structuredClone(value);
}

// Synchronous storage injection is private and supports real filesystem failure tests.
// A publication failure latches writes; a new instance may validate the saved state.
function createRevisionCache({ directory, storage = fs }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('revision-cache-invalid');
  directory = path.resolve(directory);
  const snapshots = path.join(directory, 'snapshots'), indexes = path.join(directory, 'indexes');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0); let uncertain = false;
  function syncDirectory(target) {
    const handle = storage.openSync(target, flags);
    try { storage.fsyncSync(handle); } finally { storage.closeSync(handle); }
  }
  function checkDirectory(target) {
    const stat = storage.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (target === directory || target.startsWith(`${directory}${path.sep}`)) && stat.mode & 0o077) throw fail('revision-cache-corrupt');
  }
  function ensureDirectory(target) {
    try { checkDirectory(target); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(target); if (parent === target) throw fail('revision-cache-storage-unavailable');
    ensureDirectory(parent);
    try { storage.mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkDirectory(target); syncDirectory(target); syncDirectory(parent);
  }
  function readBounded(filename, limit = MAX_CACHE_BYTES) {
    const handle = storage.openSync(filename, flags);
    try {
      const stat = storage.fstatSync(handle);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size < 2 || stat.size > limit) throw fail('revision-cache-corrupt');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const count = storage.readSync(handle, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count;
      }
      if (offset !== bytes.length) throw fail('revision-cache-corrupt'); return bytes;
    } finally { storage.closeSync(handle); }
  }
  function write(targetDirectory, filename, bytes, immutable = false) {
    ensureDirectory(targetDirectory);
    const temporary = path.join(targetDirectory, `.${randomUUID()}.tmp`); let publishing = false;
    try {
      const handle = storage.openSync(temporary, 'wx', 0o600);
      try { storage.writeFileSync(handle, bytes); storage.fsyncSync(handle); } finally { storage.closeSync(handle); }
      publishing = true;
      if (immutable) {
        try { storage.linkSync(temporary, filename); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          publishing = false;
          if (!readBounded(filename).equals(bytes)) throw fail('revision-cache-corrupt');
          const existing = storage.openSync(filename, flags);
          try { storage.fsyncSync(existing); } finally { storage.closeSync(existing); }
          // Reaffirm the existing immutable entry's directory durability too.
          publishing = true;
        }
        storage.unlinkSync(temporary);
      } else storage.renameSync(temporary, filename);
      syncDirectory(targetDirectory);
    } catch (error) {
      if (publishing) { uncertain = true; throw fail('revision-cache-uncertain'); }
      if (error.code === 'revision-cache-corrupt') throw error;
      throw fail('revision-cache-storage-unavailable');
    } finally { try { storage.unlinkSync(temporary); } catch { /* Never replace a publication error with cleanup details. */ } }
  }
  function indexPath(projectId, branch) {
    if (!validId(projectId) || !validId(branch)) throw fail('revision-cache-invalid');
    return path.join(indexes, `${fingerprint({ projectId, branch })}.json`);
  }
  function publish(result, advanceIndex) {
    if (uncertain) throw fail('revision-cache-uncertain');
    const checked = validateResult(result), bytes = Buffer.from(`${JSON.stringify(checked)}\n`);
    if (bytes.length > MAX_CACHE_BYTES) throw fail('revision-cache-invalid');
    const snapshotHash = hash(bytes), snapshotPath = path.join(snapshots, `${snapshotHash}.json`);
    try {
      write(snapshots, snapshotPath, bytes, true);
      if (advanceIndex) {
        const pointer = Buffer.from(`${JSON.stringify({ schemaVersion: 1, projectId: checked.remoteProjectId,
          branch: checked.branch, snapshotHash })}\n`);
        write(indexes, indexPath(checked.remoteProjectId, checked.branch), pointer);
      }
      return { snapshotHash, head: checked.head };
    } catch (error) {
      if (error.code?.startsWith('revision-cache-')) throw error;
      throw fail('revision-cache-storage-unavailable');
    }
  }
  function readSnapshot(snapshotHash, { projectId, branch } = {}) {
    if (typeof snapshotHash !== 'string' || !HASH.test(snapshotHash) || !validId(projectId) || !validId(branch)) throw fail('revision-cache-invalid');
    try {
      checkDirectory(directory); checkDirectory(snapshots);
      const bytes = readBounded(path.join(snapshots, `${snapshotHash}.json`));
      if (hash(bytes) !== snapshotHash) throw fail('revision-cache-corrupt');
      const result = validateResult(JSON.parse(bytes.toString('utf8')));
      if (result.remoteProjectId !== projectId || result.branch !== branch) throw fail('revision-cache-corrupt');
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('revision-cache-miss');
      throw fail('revision-cache-corrupt');
    }
  }
  function read(projectId, branch = 'main') {
    const filename = indexPath(projectId, branch);
    try {
      checkDirectory(directory); checkDirectory(indexes);
      const pointer = JSON.parse(readBounded(filename, 4096).toString('utf8'));
      if (!exact(pointer, ['schemaVersion', 'projectId', 'branch', 'snapshotHash']) || pointer.schemaVersion !== 1
        || pointer.projectId !== projectId || pointer.branch !== branch || typeof pointer.snapshotHash !== 'string'
        || !HASH.test(pointer.snapshotHash)) throw fail('revision-cache-corrupt');
      return readSnapshot(pointer.snapshotHash, { projectId, branch });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'revision-cache-miss') throw fail('revision-cache-miss');
      throw fail('revision-cache-corrupt');
    }
  }
  return { store: result => publish(result, true), storeSnapshot: result => publish(result, false), read, readSnapshot };
}
module.exports = { createRevisionCache, MAX_CACHE_BYTES };
