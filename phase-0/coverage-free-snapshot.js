// Aggregate read coverage only; explicit selection never establishes item identity.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { buildResolveCoverageMatrix } = require('../src/resolve-coverage-matrix');

const MAX_BYTES = 20 * 1024 * 1024;
function readBounded(selectedPath) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid-input');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > MAX_BYTES) throw new Error('invalid-input');
  return bytes;
}
function coverageFiles(snapshotPath, exportPath, timelineId, sequenceId) {
  const xmlPath = path.extname(exportPath).toLowerCase() === '.fcpxmld' ? path.join(exportPath, 'Info.fcpxml') : exportPath;
  const snapshotBytes = readBounded(snapshotPath);
  const xmlBytes = readBounded(xmlPath);
  const manifest = normalizeResolveSnapshot(JSON.parse(snapshotBytes.toString('utf8')));
  return { ...buildResolveCoverageMatrix(manifest, xmlBytes.toString('utf8'), { timelineId, sequenceId }),
    sources: { snapshotSha256: createHash('sha256').update(snapshotBytes).digest('hex'),
      exportSha256: createHash('sha256').update(xmlBytes).digest('hex') } };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (![2, 4].includes(args.length)) throw new Error('usage');
    const result = coverageFiles(...args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message === 'usage' ? 'usage' : 'invalid-coverage-input'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { coverageFiles };
