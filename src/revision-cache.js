const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readBounded(filename) {
  const handle = fs.openSync(filename, FLAGS);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CACHE_BYTES) throw fail('revision-cache-corrupt');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) throw fail('revision-cache-corrupt');
    return bytes;
  } finally { fs.closeSync(handle); }
}
function atomicWrite(directory, filename, bytes) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function validateResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || !ID.test(value.remoteProjectId) || !ID.test(value.branch) || (value.head !== null && !ID.test(value.head))
    || !Array.isArray(value.revisions) || !Array.isArray(value.manifests) || value.mediaFetched !== false) throw fail('revision-cache-invalid');
  const manifests = new Map();
  for (const manifest of value.manifests) {
    if (!manifest || !ID.test(manifest.id) || manifest.projectId !== value.remoteProjectId
      || manifests.has(manifest.id) || !manifest.document || typeof manifest.document !== 'object') throw fail('revision-cache-invalid');
    manifests.set(manifest.id, manifest);
  }
  const revisions = new Map();
  for (const revision of value.revisions) {
    if (!revision || !ID.test(revision.id) || revision.projectId !== value.remoteProjectId
      || !manifests.has(revision.manifestId) || revisions.has(revision.id)
      || (revision.parentRevisionId !== null && !revisions.has(revision.parentRevisionId))) throw fail('revision-cache-invalid');
    revisions.set(revision.id, revision);
  }
  if ((value.revisions.at(-1)?.id || null) !== value.head) throw fail('revision-cache-invalid');
  return structuredClone(value);
}

function createRevisionCache({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('revision-cache-invalid');
  const snapshots = path.join(directory, 'snapshots');
  const indexes = path.join(directory, 'indexes');
  function indexPath(projectId, branch) {
    if (!ID.test(projectId) || !ID.test(branch)) throw fail('revision-cache-invalid');
    return path.join(indexes, `${fingerprint({ projectId, branch })}.json`);
  }
  function store(result) {
    const checked = validateResult(result);
    const bytes = Buffer.from(`${JSON.stringify(checked)}\n`);
    if (bytes.length > MAX_CACHE_BYTES) throw fail('revision-cache-invalid');
    const snapshotHash = hash(bytes);
    const snapshotPath = path.join(snapshots, `${snapshotHash}.json`);
    fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
    if (fs.existsSync(snapshotPath)) {
      if (!readBounded(snapshotPath).equals(bytes)) throw fail('revision-cache-corrupt');
    } else atomicWrite(snapshots, snapshotPath, bytes);
    const pointer = Buffer.from(`${JSON.stringify({ schemaVersion: 1, projectId: checked.remoteProjectId,
      branch: checked.branch, snapshotHash })}\n`);
    atomicWrite(indexes, indexPath(checked.remoteProjectId, checked.branch), pointer);
    return { snapshotHash, head: checked.head };
  }
  function read(projectId, branch = 'main') {
    try {
      const pointer = JSON.parse(readBounded(indexPath(projectId, branch)).toString('utf8'));
      if (pointer.schemaVersion !== 1 || pointer.projectId !== projectId || pointer.branch !== branch
        || !HASH.test(pointer.snapshotHash)) throw fail('revision-cache-corrupt');
      const bytes = readBounded(path.join(snapshots, `${pointer.snapshotHash}.json`));
      if (hash(bytes) !== pointer.snapshotHash) throw fail('revision-cache-corrupt');
      return validateResult(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('revision-cache-miss');
      if (error.code?.startsWith('revision-cache-')) throw error;
      throw fail('revision-cache-corrupt');
    }
  }
  return { store, read };
}

module.exports = { createRevisionCache, MAX_CACHE_BYTES };
