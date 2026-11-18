'use strict';
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { validateAdminRequest, runServiceAdmin, safeErrorCode } = require('./service-admin');

const MAX_ADMIN_REQUEST_BYTES = 16 * 1024;
function fail(code) { return Object.assign(new Error(code), { code }); }
async function readAdminRequest(input) {
  const chunks = []; let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_ADMIN_REQUEST_BYTES) throw fail('service-admin-input-invalid');
    chunks.push(bytes);
  }
  let request;
  try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw fail('service-admin-input-invalid'); }
  return validateAdminRequest(request);
}
async function runServiceAdminCli({ argv = process.argv.slice(2), input = process.stdin,
  output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1] || '')) throw fail('service-admin-input-invalid');
    // Read and validate credentials before touching the config or state file.
    const request = await readAdminRequest(input);
    const { loadServiceStorageConfig } = require('./service-host-config');
    const config = await loadServiceStorageConfig(argv[1]);
    const result = await runServiceAdmin({ config, request });
    output.write(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    const code = ['service-host-config-invalid', 'service-host-config-unavailable', 'service-host-tls-unavailable'].includes(error?.code)
      ? error.code : safeErrorCode(error);
    errorOutput.write(`${code}\n`); return 1;
  }
}
if (require.main === module) runServiceAdminCli().then(code => { process.exitCode = code; }, () => {
  process.stderr.write('service-admin-operation-failed\n'); process.exitCode = 1;
});
module.exports = { readAdminRequest, runServiceAdminCli, MAX_ADMIN_REQUEST_BYTES };
