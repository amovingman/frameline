// Local, read-only comparison of two Resolve Free 21.1.2 schema-3 captures.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { compareResolveManifests } = require('../src/resolve-id-diff');
const { summarizeResolveChanges } = require('../src/resolve-change-summary');

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

function readSnapshot(selectedPath) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('invalid-snapshot');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('invalid-snapshot');
  return { hash: createHash('sha256').update(bytes).digest('hex'), manifest: normalizeResolveSnapshot(JSON.parse(bytes.toString('utf8'))) };
}

function compareSnapshotFiles(beforePath, afterPath) {
  const before = readSnapshot(beforePath);
  const after = readSnapshot(afterPath);
  const diff = compareResolveManifests(before.manifest, after.manifest);
  return {
    schemaVersion: 1,
    readOnly: true,
    safeToApply: false,
    beforeHash: before.hash,
    afterHash: after.hash,
    diff,
    summary: summarizeResolveChanges(diff)
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    process.stdout.write(`${JSON.stringify(compareSnapshotFiles(process.argv[2], process.argv[3]), null, 2)}\n`);
  } catch (error) {
    const code = error.message === 'usage' ? 'usage' : 'invalid-or-incompatible-snapshots';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

module.exports = { compareSnapshotFiles };
