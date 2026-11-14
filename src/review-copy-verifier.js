'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const adapter = require('./fcpxml-adapter');
const { validateScanManifest } = require('./scan-manifest');

const MAX_BYTES = 20n * 1024n * 1024n;
const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
const same = (a, b) => fields.every(key => a[key] === b[key]);

async function plainPath(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || !/\.fcpxml$/iu.test(filename)) throw new Error('invalid');
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('invalid');
  }
  return absolute;
}

async function fingerprint(filename, expected, original) {
  await plainPath(filename);
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > MAX_BYTES || (original && !same(before, original))) throw new Error('changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (BigInt(position) > MAX_BYTES) throw new Error('changed');
    }
    await plainPath(filename);
    const after = await handle.stat({ bigint: true });
    const named = await fs.promises.lstat(filename, { bigint: true });
    if (!named.isFile() || !same(before, after) || !same(before, named)
      || BigInt(position) !== before.size || hash.digest('hex') !== expected) throw new Error('changed');
    return before;
  } finally { await handle.close(); }
}

// Media availability is relative to the containing directory and may legitimately
// differ for byte-identical XML in another folder. Everything else must match.
function comparable(scan) {
  return { ...scan, media: scan.media.map(({ availability, ...item }) => item) };
}

/** Verify an existing untouched review copy without modifying either file. */
async function verifyReviewCopy(request = {}) {
  try {
    if (!request || typeof request.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(request.expectedSha256)) throw new Error('invalid');
    const expected = request.expectedSha256.toLowerCase();
    const source = await plainPath(request.sourcePath);
    const copy = await plainPath(request.copyPath);
    const sourceStat = await fingerprint(source, expected);
    const copyStat = await fingerprint(copy, expected);
    if (sourceStat.dev === copyStat.dev && sourceStat.ino === copyStat.ino) throw new Error('invalid');
    const sourceScan = validateScanManifest(await adapter.scanFcpXml(source));
    const copyScan = validateScanManifest(await adapter.scanFcpXml(copy));
    if (sourceScan.sourceHash !== expected || copyScan.sourceHash !== expected
      || JSON.stringify(comparable(sourceScan)) !== JSON.stringify(comparable(copyScan))) throw new Error('changed');
    await fingerprint(source, expected, sourceStat);
    await fingerprint(copy, expected, copyStat);
    return { status: 'ready', copyName: path.basename(copy), sourceHash: expected,
      scanSummary: { clipCount: copyScan.clips.length, mediaCount: copyScan.media.length,
        warningCount: copyScan.warnings.length, durationFrames: copyScan.sequence.durationFrames }, error: null };
  } catch {
    return { status: 'error', copyName: null, sourceHash: null, scanSummary: null,
      error: { code: 'review-copy-failed', message: 'Unable to verify the FCPXML review copy.' } };
  }
}

module.exports = { verifyReviewCopy };
