// Read-only three-way preview for named Resolve Free 21.1.2 schema-3 captures.
const fs = require('node:fs');
const { createResolvePreviewPlan, verifyResolvePreviewPlan, refreshResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { saveResolvePreview, loadResolvePreview } = require('../src/resolve-preview-store');

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function readBounded(selectedPath, maximum = MAX_FILE_BYTES) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > maximum) throw new Error('invalid-input');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > maximum || bytes.length !== stat.size) throw new Error('invalid-input');
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
  const plan = JSON.parse(readBounded(planPath, 32 * 1024 * 1024).toString('utf8'));
  return verifyResolvePreviewPlan(plan, sourcesFromPaths(basePath, localPath, incomingPath));
}

function refreshPreviewFile(planPath, basePath, localPath, incomingPath) {
  const plan = JSON.parse(readBounded(planPath, 32 * 1024 * 1024).toString('utf8'));
  return refreshResolvePreviewPlan(plan, sourcesFromPaths(basePath, localPath, incomingPath));
}

function savePreviewFiles(directory, basePath, localPath, incomingPath) {
  return { artifactId: saveResolvePreview(directory, sourcesFromPaths(basePath, localPath, incomingPath)),
    readOnly: true, safeToApply: false };
}

function recoverPreviewFiles(directory, artifactId, basePath, localPath, incomingPath) {
  return loadResolvePreview(directory, artifactId, sourcesFromPaths(basePath, localPath, incomingPath));
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const result = args.length === 3 ? previewSnapshotFiles(...args)
      : args.length === 5 && args[0] === 'verify' ? verifyPreviewFile(...args.slice(1))
        : args.length === 5 && args[0] === 'refresh' ? refreshPreviewFile(...args.slice(1))
          : args.length === 5 && args[0] === 'save' ? savePreviewFiles(...args.slice(1))
            : args.length === 6 && args[0] === 'recover' ? recoverPreviewFiles(...args.slice(1))
        : (() => { throw new Error('usage'); })();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message === 'usage' ? 'usage' : 'invalid-or-incompatible-preview'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { previewSnapshotFiles, verifyPreviewFile, refreshPreviewFile, savePreviewFiles, recoverPreviewFiles };
