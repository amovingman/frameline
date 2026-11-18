'use strict';
const path = require('node:path');
const { loadServiceHostConfig, loadServiceStorageConfig } = require('./service-host-config');
const { startServiceHost } = require('./service-host');
const { createDurableCollaborationService } = require('./durable-collaboration-service');

const ERRORS = new Set(['service-host-config-invalid', 'service-host-config-unavailable', 'service-host-tls-unavailable',
  'service-host-invalid', 'service-host-listen-unavailable', 'service-host-shutdown-timeout', 'service-host-shutdown-failed',
  'collaboration-state-invalid', 'collaboration-state-newer-version', 'collaboration-storage-unavailable',
  'collaboration-storage-uncertain', 'collaboration-service-busy', 'collaboration-key-rotation-required']);
function log(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }
function report(error) { log(process.stderr, { event: 'service-error', code: ERRORS.has(error?.code) ? error.code : 'service-host-failed' }); }
async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || !['serve', 'initialize'].includes(args[0]) || args[1] !== '--config' || !path.isAbsolute(args[2])) {
    throw Object.assign(new Error('service-host-config-invalid'), { code: 'service-host-config-invalid' });
  }
  if (args[0] === 'initialize') {
    const config = await loadServiceStorageConfig(args[2]);
    const runtime = await createDurableCollaborationService({ directory: config.directory, keyring: config.keyring, initialize: true });
    await runtime.close(); log(process.stdout, { event: 'service-initialized' }); return;
  }
  const host = await startServiceHost({ config: await loadServiceHostConfig(args[2]) });
  log(process.stdout, { event: 'service-ready', address: host.address });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    // This is an error exit if any operation cannot drain; never report a forced exit as success.
    const deadline = setTimeout(() => { report({ code: 'service-host-shutdown-timeout' }); process.exit(1); }, 12_000);
    try { await host.close(); log(process.stdout, { event: 'service-stopped' }); }
    catch (error) { report(error); process.exitCode = 1; }
    finally { clearTimeout(deadline); process.off('SIGTERM', stop); process.off('SIGINT', stop); }
    if (process.exitCode) process.exit(process.exitCode);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (require.main === module) main().catch(error => { report(error); process.exitCode = 1; });
module.exports = { main };
