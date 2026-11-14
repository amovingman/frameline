// Measure the known editor export with the production read-only scanner.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { scanFcpXml } = require('../src/fcpxml-adapter');

const EXPECTED = Object.freeze({
  sourceHash: '8ba263fc39c71ad92f5b7e46c8273a8e1ac6bb31d1e3a4bc331a124f6ced00b5',
  xmlBytes: 822382,
  sequenceFrames: 24240,
  scannedClips: 1001
});

async function benchmark(selectedPath, runs = 5, scan = scanFcpXml) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('Runs must be an integer from 1 to 100');
  const xmlPath = path.extname(selectedPath).toLowerCase() === '.fcpxmld'
    ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  const xml = await fs.readFile(xmlPath);
  const sourceHash = crypto.createHash('sha256').update(xml).digest('hex');
  if (sourceHash !== EXPECTED.sourceHash || xml.length !== EXPECTED.xmlBytes) throw new Error('Fixture hash or byte count does not match the known editor export');
  const samplesMs = [];
  let warnings;
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    const result = await scan(selectedPath);
    samplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (result.sourceHash !== EXPECTED.sourceHash || result.sequence.durationFrames !== EXPECTED.sequenceFrames || result.clips.length !== EXPECTED.scannedClips) {
      throw new Error(`Scan ${i + 1} did not match the expected hash, frame count, or clip count`);
    }
    if (warnings && JSON.stringify(warnings) !== JSON.stringify(result.warnings)) throw new Error(`Scan ${i + 1} returned different warnings`);
    warnings = result.warnings;
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { ...EXPECTED, runs, samplesMs, minMs: sorted[0], medianMs, maxMs: sorted.at(-1), warnings };
}

async function main() {
  const selectedPath = process.argv[2];
  if (!selectedPath) throw new Error('Usage: node phase-0/benchmark-editor-scan.js <export.fcpxml|export.fcpxmld> [runs]');
  console.log(JSON.stringify(await benchmark(selectedPath, process.argv[3] === undefined ? 5 : Number(process.argv[3])), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { benchmark, EXPECTED };
