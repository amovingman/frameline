'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCaptureRequest, readCaptureResponse } = require('../src/resolve-companion-protocol');

async function prepare(directory, expectedProjectName) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('invalid-directory');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const request = await createCaptureRequest({ directory, expectedProjectName });
  const companion = path.join(__dirname, '..', 'src', 'companion', 'resolve-internal.py');
  const consoleCommand = `import runpy; bridge = runpy.run_path(${JSON.stringify(companion)}); bridge['capture_request'](resolve, ${JSON.stringify(request.requestFile)})`;
  return { ...request, consoleCommand, readOnly: true, safeToApply: false };
}

if (require.main === module) {
  (async () => {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'prepare' && args.length === 2) {
      process.stdout.write(`${JSON.stringify(await prepare(...args), null, 2)}\n`);
    } else if (command === 'read' && args.length === 3) {
      process.stdout.write(`${JSON.stringify(await readCaptureResponse({ directory: args[0],
        requestId: args[1], requestSha256: args[2] }), null, 2)}\n`);
    } else throw new Error('usage');
  })().catch(() => { process.stderr.write('companion-capture-invalid\n'); process.exitCode = 1; });
}

module.exports = { prepare };
