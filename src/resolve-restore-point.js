const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// This utility only creates a backup in a caller-owned disposable directory.
// It does not modify or apply anything to the source or an editor project.
async function rejectSymlinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('symlink-not-allowed');
  }
  return absolute;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function digest(handle, output) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (output) {
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error('copy-failed');
        written += result.bytesWritten;
      }
    }
    position += bytesRead;
  }
  return hash.digest('hex');
}

async function createRestorePoint({ sourcePath, destinationDir, expectedHash, now = new Date() }) {
  if (typeof sourcePath !== 'string' || typeof destinationDir !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedHash || '') || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('invalid-restore-point-input');
  }
  const source = await rejectSymlinks(sourcePath);
  const destination = await rejectSymlinks(destinationDir);
  if (!(await fs.lstat(source)).isFile()) throw new Error('source-not-regular-file');
  if (!(await fs.stat(destination)).isDirectory()) throw new Error('invalid-destination');
  let input;
  let output;
  let copyPath;
  let complete = false;
  try {
    input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await input.stat();
    if (!before.isFile()) throw new Error('source-not-regular-file');
    if (!sameFile(before, await fs.lstat(source))) throw new Error('source-changed');
    if (await digest(input) !== expectedHash) throw new Error('source-hash-mismatch');
    if (!sameFile(before, await input.stat()) || !sameFile(before, await fs.lstat(source))) throw new Error('source-changed');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < 1000; i++) {
      const candidate = path.join(destination, `${path.basename(source)}.${stamp}${i ? `-${i}` : ''}.restore-point`);
      try {
        output = await fs.open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
        copyPath = candidate;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (!output) throw new Error('restore-point-name-exhausted');
    if (await digest(input, output) !== expectedHash) throw new Error('source-changed');
    await output.sync();
    if (await digest(output) !== expectedHash) throw new Error('copy-verification-failed');
    if (!sameFile(before, await input.stat()) || !sameFile(before, await fs.lstat(source)) || await digest(input) !== expectedHash) {
      throw new Error('source-changed');
    }
    const directoryHandle = await fs.open(destination, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    complete = true;
    return { restorePointPath: copyPath, sha256: expectedHash, size: before.size };
  } finally {
    if (output) await output.close();
    if (input) await input.close();
    if (copyPath && !complete) await fs.unlink(copyPath).catch(() => {});
  }
}

module.exports = { createRestorePoint };
