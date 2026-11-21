'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { loadCloudBackupConfig } = require('./cloud-backup-config');
const fail = code => Object.assign(new Error(code), { code });
const SAFE = new Set(['cloud-backup-config-invalid', 'cloud-backup-options-invalid', 'cloud-backup-invalid-bundle',
  'cloud-backup-too-large', 'cloud-backup-invalid-file', 'cloud-backup-source-changed', 'cloud-backup-review-changed',
  'cloud-backup-exists', 'cloud-backup-conflict', 'cloud-backup-cancelled', 'cloud-backup-integrity',
  'cloud-backup-invalid-response', 'cloud-backup-unavailable', 'cloud-backup-auth', 'cloud-backup-not-found',
  'cloud-backup-timeout', 'cloud-backup-save-uncertain', 'cloud-backup-invalid-id', 'cloud-backup-invalid']);
const USAGE = `Frameline revision backup (AWS S3)

inspect  --file /absolute/revisions.json
upload   --config /absolute/cloud.json --file /absolute/revisions.json --sha256 REVIEWED_HASH
list     --config /absolute/cloud.json [--cursor PAGE_CURSOR]
download --config /absolute/cloud.json --sha256 BACKUP_HASH --destination /absolute/new-backup.json

Use AWS_PROFILE or the AWS SDK's standard credential chain. No credential flags are accepted.
Download verifies a revision bundle and saves a new file; import remains a separate desktop action.
`;

function parseCloudBackupArgs(argv) {
  const allowed = { inspect: ['file'], upload: ['config', 'file', 'sha256'], list: ['config', 'cursor'],
    download: ['config', 'sha256', 'destination'] };
  if (!Array.isArray(argv) || argv.length > 9 || !Object.hasOwn(allowed, argv[0])) throw fail('cloud-backup-options-invalid');
  const result = { action: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || !allowed[result.action].includes(flag.slice(2))
      || Object.hasOwn(result, flag.slice(2)) || typeof value !== 'string' || !value || value.length > 4096
      || /[\x00-\x1f\x7f]/.test(value)) throw fail('cloud-backup-options-invalid');
    result[flag.slice(2)] = value;
  }
  for (const key of allowed[result.action].filter(key => key !== 'cursor')) if (!Object.hasOwn(result, key)) throw fail('cloud-backup-options-invalid');
  for (const key of ['file', 'config', 'destination']) if (result[key] !== undefined && !path.isAbsolute(result[key])) throw fail('cloud-backup-options-invalid');
  if (result.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(result.sha256)) throw fail('cloud-backup-options-invalid');
  return result;
}

async function runCloudBackupCli({ argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr,
  loadConfig = loadCloudBackupConfig, operations, createTransport, signal, timeoutMs = 120000 } = {}) {
  if (argv.length === 1 && argv[0] === '--help') { output.write(USAGE); return 0; }
  let transport, timer, onAbort, externalAbort;
  const controller = new AbortController();
  try {
    const request = parseCloudBackupArgs(argv);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('cloud-backup-options-invalid');
    operations ||= require('./cloud-backup');
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(fail(controller.signal.reason === 'timeout' ? 'cloud-backup-timeout' : 'cloud-backup-cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      externalAbort = () => controller.abort('cancelled');
      if (signal?.aborted) externalAbort(); else signal?.addEventListener('abort', externalAbort, { once: true });
    });
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const work = async () => {
      if (controller.signal.aborted) throw fail('cloud-backup-cancelled');
      // Resolve directory aliases (such as /tmp on macOS), preserving the leaf
      // so the filesystem boundary can still refuse a selected symlink file.
      for (const key of ['file', 'config', 'destination']) if (request[key] !== undefined) {
        try { request[key] = path.join(await fs.realpath(path.dirname(request[key])), path.basename(request[key])); }
        catch { throw fail(key === 'config' ? 'cloud-backup-config-invalid' : 'cloud-backup-invalid-file'); }
      }
      if (controller.signal.aborted) throw fail('cloud-backup-cancelled');
      if (request.action === 'inspect') return operations.inspectBackup(request.file);
      const config = await loadConfig(request.config);
      if (controller.signal.aborted) throw fail('cloud-backup-cancelled');
      const factory = createTransport || require('./cloud-backup-s3').createS3BackupTransport;
      transport = factory(config);
      const common = { transport, signal: controller.signal };
      if (request.action === 'upload') return operations.uploadBackup({ ...common, filename: request.file, expectedSha256: request.sha256 });
      if (request.action === 'list') return operations.listBackups({ ...common, continuationToken: request.cursor });
      return operations.downloadBackup({ ...common, sha256: request.sha256, destination: request.destination });
    };
    const result = await Promise.race([work(), aborted]);
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    errorOutput.write(`${SAFE.has(error?.code) ? error.code : 'cloud-backup-failed'}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', externalAbort);
    try { transport?.close?.(); } catch { /* No credentials or provider errors reach output. */ }
  }
}

if (require.main === module) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  runCloudBackupCli({ signal: controller.signal }).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('cloud-backup-failed\n'); process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); });
}

module.exports = { parseCloudBackupArgs, runCloudBackupCli };
