'use strict';
const { TextDecoder } = require('node:util');
const path = require('node:path');
const { loadServiceStorageConfig } = require('./service-host-config');
const backup = require('./service-backup');
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const SAFE = new Set(['backup-invalid', 'backup-key-unavailable', 'backup-source-invalid', 'backup-source-unclassified', 'backup-source-changed',
  'backup-source-busy', 'backup-destination-exists', 'backup-destination-invalid', 'backup-storage-unavailable', 'backup-storage-uncertain',
  'backup-cancelled', 'backup-progress-failed', 'backup-review-required', 'backup-options-invalid', 'incident-record-invalid',
  'service-host-config-invalid', 'service-host-config-unavailable']);
function validateBackupRequest(value) {
  const keys = { backup: ['action', 'configPath', 'destination'], verify: ['action', 'configPath', 'backupDirectory'],
    restore: ['action', 'configPath', 'backupDirectory', 'destination', 'expectedSha256', 'confirmed'],
    'record-incident': ['action', 'directory', 'record'] };
  if (!value || !Object.hasOwn(keys, value.action) || !exact(value, keys[value.action])) throw fail('backup-options-invalid');
  for (const key of ['configPath', 'destination', 'backupDirectory', 'directory']) if (value[key] !== undefined
    && (typeof value[key] !== 'string' || value[key].length > 4096 || !path.isAbsolute(value[key]) || /[\x00-\x1f\x7f]/.test(value[key]))) throw fail('backup-options-invalid');
  if (value.action === 'restore' && (value.confirmed !== true || typeof value.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSha256))) throw fail('backup-review-required');
  return structuredClone(value);
}
async function runServiceBackupCli({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  loadConfig = loadServiceStorageConfig, operations = backup } = {}) {
  try {
    if (argv.length) throw fail('backup-options-invalid');
    const chunks = []; let size = 0;
    for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024) throw fail('backup-options-invalid'); chunks.push(bytes); }
    let request;
    try { request = validateBackupRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))); }
    catch (error) { throw fail(SAFE.has(error?.code) ? error.code : 'backup-options-invalid'); }
    let result;
    if (request.action === 'record-incident') result = await operations.recordOwnerIncident({ directory: request.directory, record: request.record });
    else {
      const config = await loadConfig(request.configPath), common = { keyring: config.keyring };
      if (request.action === 'backup') result = await operations.createServiceBackup({ ...common, directory: config.directory,
        assetsDirectory: config.assets?.directory, destination: request.destination });
      else if (request.action === 'verify') result = await operations.verifyServiceBackup({ ...common, backupDirectory: request.backupDirectory });
      else result = await operations.restoreServiceBackup({ ...common, backupDirectory: request.backupDirectory, destination: request.destination,
        confirmed: request.confirmed, expectedSha256: request.expectedSha256 });
    }
    output.write(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) { errorOutput.write(`${SAFE.has(error?.code) ? error.code : 'backup-operation-failed'}\n`); return 1; }
}
if (require.main === module) runServiceBackupCli().then(code => { process.exitCode = code; }, () => { process.stderr.write('backup-operation-failed\n'); process.exitCode = 1; });
module.exports = { validateBackupRequest, runServiceBackupCli };
