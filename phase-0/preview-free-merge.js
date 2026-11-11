// Read-only three-way preview for named Resolve Free 21.1.2 schema-3 captures.
const fs = require('node:fs');
const { createResolvePreviewPlan, verifyResolvePreviewPlan } = require('../src/resolve-preview-plan');

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function readBounded(selectedPath) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('invalid-input');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('invalid-input');
  return bytes;
}

function sourcesFromPaths(basePath, localPath, incomingPath) {
  return {
    base: readBounded(basePath),
    local: readBounded(localPath),
    incoming: readBounded(incomingPath)
  };
}

function previewSnapshotFiles(basePath, localPath, incomingPath) {
  return createResolvePreviewPlan(sourcesFromPaths(basePath, localPath, incomingPath));
}

function verifyPreviewFile(planPath, basePath, localPath, incomingPath) {
  const plan = JSON.parse(readBounded(planPath).toString('utf8'));
  return verifyResolvePreviewPlan(plan, sourcesFromPaths(basePath, localPath, incomingPath));
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const result = args.length === 3 ? previewSnapshotFiles(...args)
      : args.length === 5 && args[0] === 'verify' ? verifyPreviewFile(...args.slice(1))
        : (() => { throw new Error('usage'); })();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message === 'usage' ? 'usage' : 'invalid-or-incompatible-preview'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { previewSnapshotFiles, verifyPreviewFile };
