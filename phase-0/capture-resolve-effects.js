'use strict';
const fs = require('node:fs/promises');
const { createEffectCaptureCommand, readEffectConsoleResult } = require('../src/resolve-effect-console');
const { compareEffectObservations } = require('../src/resolve-effect-observation');
async function read(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('input-too-large');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('input-changed');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
(async () => {
  const [operation, ...args] = process.argv.slice(2);
  if (['prepare', 'prepare-properties'].includes(operation) && args.length === 1) {
    process.stdout.write(`${JSON.stringify(await createEffectCaptureCommand(args[0], { includeProperties: operation === 'prepare-properties' }))}\n`);
  } else if (operation === 'read' && args.length === 2) {
    process.stdout.write(readEffectConsoleResult({ captureId: args[0], output: (await read(args[1])).toString('utf8') }));
  } else if (operation === 'compare' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(compareEffectObservations(await read(args[0]), await read(args[1])), null, 2)}\n`);
  } else throw new Error('usage');
})().catch(() => { process.stderr.write('resolve-effect-observation-failed\n'); process.exitCode = 1; });
