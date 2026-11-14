const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { benchmark, EXPECTED } = require('../phase-0/benchmark-editor-scan');

const fixture = path.join(__dirname, '../phase-0/performance-live.fcpxmld');

test('rejects invalid run counts and unknown fixture bytes', async () => {
  await assert.rejects(benchmark(fixture, 0), /Runs must be/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-benchmark-'));
  try {
    const file = path.join(dir, 'other.fcpxml');
    await fs.writeFile(file, 'not the fixture');
    await assert.rejects(benchmark(file), /Fixture hash or byte count/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('checks every result and reports ordered summary with all warnings', async t => {
  try { await fs.access(path.join(fixture, 'Info.fcpxml')); } catch { return t.skip('ignored editor fixture is unavailable'); }
  const result = { sourceHash: EXPECTED.sourceHash, sequence: { durationFrames: EXPECTED.sequenceFrames }, clips: Array(EXPECTED.scannedClips), warnings: ['first', 'second'] };
  let calls = 0;
  const report = await benchmark(fixture, 4, async () => { calls++; return result; });
  assert.equal(calls, 4);
  assert.equal(report.samplesMs.length, 4);
  assert.ok(report.minMs <= report.medianMs && report.medianMs <= report.maxMs);
  assert.deepEqual(report.warnings, result.warnings);
  await assert.rejects(benchmark(fixture, 2, async () => ({ ...result, clips: [] })), /Scan 1 did not match/);
  let index = 0;
  await assert.rejects(benchmark(fixture, 2, async () => ({ ...result, warnings: [String(index++)] })), /different warnings/);
});
