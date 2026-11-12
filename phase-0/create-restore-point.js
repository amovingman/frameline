// Standalone preflight copy. This command never edits the source or Resolve.
const { createRestorePoint } = require('../src/resolve-restore-point');

if (require.main === module) {
  const [sourcePath, destinationDir, expectedHash, ...extra] = process.argv.slice(2);
  if (extra.length || !sourcePath || !destinationDir || !expectedHash) {
    process.stderr.write('usage\n');
    process.exitCode = 1;
  } else {
    createRestorePoint({ sourcePath, destinationDir, expectedHash })
      .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch(() => { process.stderr.write('restore-point-preflight-failed\n'); process.exitCode = 1; });
  }
}
