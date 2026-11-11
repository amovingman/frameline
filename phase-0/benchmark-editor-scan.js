// Measure an actual editor FCPXML export with the production read-only scanner.
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanFcpXml } = require('../src/fcpxml-adapter');

async function main() {
  const selectedPath = process.argv[2];
  if (!selectedPath) {
    console.error('Usage: node phase-0/benchmark-editor-scan.js <export.fcpxml|export.fcpxmld>');
    process.exitCode = 2;
    return;
  }
  const xmlPath = path.extname(selectedPath).toLowerCase() === '.fcpxmld'
    ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  const bytes = (await fs.stat(xmlPath)).size;
  const started = process.hrtime.bigint();
  const scan = await scanFcpXml(selectedPath);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(JSON.stringify({
    xmlBytes: bytes,
    sourceHash: scan.sourceHash,
    scanMs: elapsedMs,
    sequenceFrames: scan.sequence.durationFrames,
    scannedClips: scan.clips.length,
    warnings: scan.warnings
  }, null, 2));
}

main().catch(error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
