'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./shared-storage-protocol');

async function noLinks(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.resolve(filename) !== filename) throw fail('shared-storage-invalid');
  let current = path.parse(filename).root;
  for (const segment of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw fail('symlink-unsupported');
  }
}
async function inspectStorageRoot(root) {
  try {
    await noLinks(root);
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || await fs.realpath(root) !== root) throw fail('shared-storage-invalid');
    await fs.access(root, constants.R_OK | constants.X_OK);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch (error) {
    if (['shared-storage-invalid', 'symlink-unsupported'].includes(error.code)) throw fail(error.code);
    throw fail(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'shared-storage-offline' : 'shared-storage-unreadable');
  }
}
async function assertStorageRoot(volume) {
  const actual = await inspectStorageRoot(volume.root);
  if (actual.dev !== volume.identity.dev || actual.ino !== volume.identity.ino) throw fail('shared-storage-volume-changed');
}
function cancelled(signal) { if (signal?.aborted) throw fail('shared-storage-cancelled'); }
// Each component and the open file are rechecked after streaming. No write or
// marker is made on the selected volume; mount identity is a local observation.
async function verifyStorageAsset(volume, asset, { signal, onProgress = () => {} } = {}) {
  cancelled(signal); await assertStorageRoot(volume);
  const candidate = path.resolve(volume.root, ...asset.relativePath.split('/'));
  const relative = path.relative(volume.root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('shared-storage-invalid');
  let handle, reason;
  try {
    await noLinks(candidate);
    handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) reason = 'not-regular-file';
    else if (before.size !== asset.expected.size) reason = 'size-mismatch';
    else {
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        cancelled(signal); size += chunk.length;
        if (size > before.size) throw fail('file-changed');
        hash.update(chunk); await onProgress(size);
      }
      cancelled(signal);
      const after = await handle.stat(); await noLinks(candidate);
      const current = await fs.lstat(candidate);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw fail('file-changed');
      reason = hash.digest('hex') === asset.expected.sha256 ? 'size-and-hash-match' : 'hash-mismatch';
    }
  } catch (error) {
    if (error.code === 'shared-storage-cancelled') throw error;
    reason = ['symlink-unsupported', 'file-changed'].includes(error.code) ? error.code
      : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'candidate-missing' : 'candidate-unreadable';
  } finally { await handle?.close(); }
  cancelled(signal); await assertStorageRoot(volume);
  return { id: asset.id, assetClass: asset.assetClass, expected: structuredClone(asset.expected),
    verified: reason === 'size-and-hash-match', reason };
}
module.exports = { noLinks, inspectStorageRoot, assertStorageRoot, verifyStorageAsset, cancelled };
