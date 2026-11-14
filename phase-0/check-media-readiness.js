// Local-only media readiness report. Input paths never appear in output.
const fs = require('node:fs');
const { createReadinessReport } = require('../src/local-media-readiness');

async function reportFile(selectedPath) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid-input');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > 1024 * 1024) throw new Error('invalid-input');
  return createReadinessReport(JSON.parse(bytes.toString('utf8')));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) { process.stderr.write('usage\n'); process.exitCode = 1; }
  else reportFile(args[0])
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(() => { process.stderr.write('media-readiness-failed\n'); process.exitCode = 1; });
}

module.exports = { reportFile };
