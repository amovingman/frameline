'use strict';
// Scan timing only. Missing editor measurements stay missing.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { createFcpXmlScanner } = require('../src/fcpxml-adapter');
const { catalog, readCorpusEntry } = require('./integration-corpus');

async function benchmark({ iterations = 3, signal, includeLarge = false } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10 || typeof includeLarge !== 'boolean') throw new Error('invalid-integration-benchmark-options');
  const entries = catalog.entries.filter(entry => includeLarge || entry.expected.clips <= 50);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-integration-benchmark-'));
  await fs.chmod(directory, 0o700);
  const results = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const { bytes } = readCorpusEntry(entry);
      const filename = path.join(directory, `fixture-${index}.fcpxml`);
      await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      for (let iteration = 1; iteration <= iterations; iteration++) {
        const scanner = createFcpXmlScanner();
        try {
          for (const mode of ['first-scan', 'cached-rescan']) {
            const memoryBefore = process.memoryUsage();
            const cpu = process.cpuUsage(), start = performance.now();
            const progress = [];
            const manifest = await scanner.scan(filename, { signal, onProgress: event => { progress.push(event); } });
            const elapsedMs = performance.now() - start, cpuUsed = process.cpuUsage(cpu);
            const source = await fs.readFile(filename);
            if (createHash('sha256').update(source).digest('hex') !== entry.sourceSha256
              || manifest.clips.length !== entry.expected.clips || manifest.media.length !== entry.expected.media
              || manifest.sequence.durationFrames !== entry.expected.durationFrames
              || JSON.stringify(manifest.warnings) !== JSON.stringify(entry.expected.warnings)) throw new Error('integration-benchmark-mismatch');
            const cacheHit = progress.some(event => event.cacheHit === true);
            if (cacheHit !== (mode === 'cached-rescan')) throw new Error('integration-cache-mismatch');
            results.push({ sourceSha256: entry.sourceSha256, clips: manifest.clips.length, media: manifest.media.length,
              iteration, mode, elapsedMs, processCpuMicros: cpuUsed,
              processRssBefore: memoryBefore.rss, processRssAfter: process.memoryUsage().rss,
              cacheHit, sourceUnchanged: true, warningCount: manifest.warnings.length });
          }
        } finally { await scanner.dispose(); }
      }
    }
    return { schemaVersion: 1, readOnly: true, safeToApply: false, fixturePolicy: includeLarge ? 'explicit-scale-check' : 'small-disposable-fixtures',
      target: catalog.target, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
      iterations, results, editorWrite: null, editorReopen: null, fullGateCompleted: false,
      limitations: ['Elapsed time covers worker startup when applicable, reading, hashing, parsing, and media availability checks.',
        'CPU and RSS describe this process including worker threads; RSS is sampled, not a peak or editor-memory measure.',
        'Stored exports retain historical media paths; this run does not regenerate their media.',
        'Editor write/reopen and recovery timing require a live disposable operation; no duration is inferred from old observations.'] };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--include-large')) { process.stderr.write('invalid-integration-benchmark-options\n'); process.exitCode = 1; }
  else benchmark({ includeLarge: args.includes('--include-large') }).then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(() => { process.stderr.write('integration-benchmark-failed\n'); process.exitCode = 1; });
}
module.exports = { benchmark };
