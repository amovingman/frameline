'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;

async function rejectSymlinkComponents(filePath) {
  let current = path.parse(filePath).root;
  for (const part of filePath.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('export-symlink-invalid');
  }
}

async function fingerprint(filePath) {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1) throw new Error('invalid-export-file');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const named = await fs.lstat(filePath);
    if (named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== named.size || before.mtimeMs !== named.mtimeMs || before.ctimeMs !== named.ctimeMs) {
      throw new Error('export-changed');
    }
    return { sha256: hash.digest('hex'), size: before.size, mode: before.mode & 0o777,
      identity: [before.dev, before.ino, before.mtimeMs, before.ctimeMs] };
  } finally {
    await handle.close();
  }
}

function checkMembers(output) {
  const members = output.trimEnd().split('\n');
  const unique = new Set(members);
  if (members.length !== unique.size || members.some(name =>
    !name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\'))) {
    throw new Error('invalid-export-members');
  }
  if (!unique.has('project.xml') || !unique.has('MediaPool/Master/MpFolder.xml') ||
      !members.some(name => /^SeqContainer\/[^/]+\.xml$/.test(name))) {
    throw new Error('missing-project-members');
  }
  return members.filter(name => /^SeqContainer\/[^/]+\.xml$/.test(name)).length;
}

// Read-only archive evidence. This does not prove the copied timeline opens in Resolve
// and is never sufficient authorization to mutate the live project.
async function inspectResolveProjectExport(filePath, expectedSha256) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !filePath.endsWith('.drp') ||
      (expectedSha256 !== undefined && !HASH.test(expectedSha256))) throw new Error('invalid-export-input');
  filePath = path.resolve(filePath);
  await rejectSymlinkComponents(filePath);
  const before = await fingerprint(filePath);
  if (expectedSha256 !== undefined && before.sha256 !== expectedSha256) throw new Error('export-hash-mismatch');
  if (before.mode & 0o077) throw new Error('export-permissions-insecure');
  let timelineCount;
  try {
    const listing = await run('unzip', ['-Z', '-1', filePath], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    timelineCount = checkMembers(listing.stdout);
    await run('unzip', ['-tqq', filePath], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (error.message === 'missing-project-members' || error.message === 'invalid-export-members') throw error;
    throw new Error('export-archive-invalid');
  }
  const after = await fingerprint(filePath);
  await rejectSymlinkComponents(filePath);
  if (before.sha256 !== after.sha256 || before.size !== after.size || after.mode !== before.mode ||
      before.identity.some((value, index) => value !== after.identity[index])) throw new Error('export-changed');
  return { schemaVersion: 1, sha256: before.sha256, size: before.size, mode: before.mode, timelineCount, archiveVerified: true };
}

module.exports = { inspectResolveProjectExport };
