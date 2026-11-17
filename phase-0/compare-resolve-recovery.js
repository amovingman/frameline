'use strict';

const fs = require('node:fs/promises');
const { compareResolveRecovery } = require('../src/resolve-recovery-comparison');

async function readBounded(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('invalid-input');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('changed-input');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('usage');
  const [source, recovered] = await Promise.all(args.map(readBounded));
  const report = compareResolveRecovery(source, recovered);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'observed-fields-match') process.exitCode = 2;
})().catch(() => { process.stderr.write('resolve-recovery-comparison-failed\n'); process.exitCode = 1; });
