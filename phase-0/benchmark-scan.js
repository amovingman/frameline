const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { scanFcpXml } = require('../src/fcpxml-adapter');

async function main() {
  const count = Number(process.argv[2] || 5000);
  if (!Number.isSafeInteger(count) || count < 1 || count > 50000) throw new Error('Choose 1–50000 clips');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-scan-bench-'));
  const filePath = path.join(directory, 'timeline.fcpxml');
  try {
    const header = '<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="synthetic.mov"/></resources><library><event><project name="Benchmark"><sequence format="f" duration="' + count + 's"><spine>';
    const footer = '</spine></sequence></project></event></library></fcpxml>';
    const handle = await fs.open(filePath, 'wx');
    try {
      await handle.writeFile(header);
      for (let index = 0; index < count; index++) {
        await handle.writeFile(`<asset-clip ref="a" name="Clip ${index + 1}" offset="${index}s" duration="1s"/>`);
      }
      await handle.writeFile(footer);
    } finally { await handle.close(); }
    const bytes = (await fs.stat(filePath)).size;
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const manifest = await scanFcpXml(filePath);
    const elapsedMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    if (manifest.clips.length !== count || manifest.sequence.durationFrames !== count * 24) throw new Error('Scan result did not match fixture');
    process.stdout.write(`${JSON.stringify({ clips: count, xmlBytes: bytes, elapsedMs: Math.round(elapsedMs), heapBeforeMiB: Math.round(heapBefore / 1048576), heapAfterMiB: Math.round(heapAfter / 1048576), warnings: manifest.warnings.length })}\n`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
