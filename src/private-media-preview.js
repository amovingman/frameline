'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_BYTES = 4 * 1024 * 1024;
const unavailable = () => Object.assign(new Error('media-artifact-unavailable'), { code: 'media-artifact-unavailable' });
// The path stays in main. Never let a file replaced after verification cause an
// unbounded read, or follow a new symlink while building a renderer data URL.
async function readPrivateMediaPreview(artifact, getCurrent) {
  if (!artifact || !path.isAbsolute(artifact.path || '') || !['image/png', 'image/jpeg'].includes(artifact.mimeType)
    || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || typeof getCurrent !== 'function') throw unavailable();
  const handle = await fs.open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== artifact.byteLength) throw unavailable();
    const buffer = Buffer.alloc(artifact.byteLength + 1); let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== artifact.byteLength || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw unavailable();
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw unavailable();
  const current = await getCurrent();
  if (!current || current.path !== artifact.path || current.mimeType !== artifact.mimeType
    || current.sha256 !== artifact.sha256 || current.byteLength !== bytes.length) throw unavailable();
  return { dataUrl: `data:${artifact.mimeType};base64,${bytes.toString('base64')}`, canonical: false };
}
module.exports = { readPrivateMediaPreview };
