'use strict';

const fs = require('node:fs/promises');
const { prepareRenameTrial, issueRenameTrial, recordRenameTrialResult } = require('../src/resolve-rename-trial');

async function readBounded(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error('invalid-input');
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
  const [operation, ...args] = process.argv.slice(2);
  let result;
  if (operation === 'prepare' && args.length === 4) {
    result = await prepareRenameTrial({ beforeBytes: await readBounded(args[0]), afterBytes: await readBounded(args[1]),
      destinationDir: args[2], disposableProjectName: args[3] });
  } else if (operation === 'issue' && (args.length === 1 || (args.length === 2 && args[1] === '--force-failure'))) {
    result = await issueRenameTrial({ directory: args[0], forceFailure: args[1] === '--force-failure' });
  } else if (operation === 'record' && args.length === 3) {
    result = await recordRenameTrialResult({ directory: args[0], status: args[1], snapshotBytes: await readBounded(args[2]) });
  } else throw new Error('usage');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
})().catch(() => { process.stderr.write('resolve-rename-trial-failed\n'); process.exitCode = 1; });
