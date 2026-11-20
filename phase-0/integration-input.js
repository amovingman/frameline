'use strict';
const fs = require('node:fs');

// Nonblocking open is essential: opening a FIFO must not wait for a writer
// before the regular-file check can reject it.
function readInput(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 24 * 1024 * 1024) throw new Error('integration-input-invalid');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(descriptor, bytes, length, bytes.length - length, length))) length += count;
    const after = fs.fstatSync(descriptor);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('integration-input-changed');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

module.exports = { readInput };
