'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { parseResolvePreviewSource } = require('./resolve-preview-source');

// Publish complete, validated bytes without replacing an existing file or link.
async function saveResolveCaptureFile(filename, source) {
  parseResolvePreviewSource(source);
  const bytes = Buffer.from(source);
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.frameline-capture-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.link(temporary, filename);
    const parent = await fs.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}
module.exports = { saveResolveCaptureFile };
