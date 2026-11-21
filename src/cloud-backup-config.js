'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const validPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
  && !/[\x00-\x1f\x7f]/.test(value);

function validateCloudBackupConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'bucket|provider|region|version'
    || value.version !== 1 || value.provider !== 'aws-s3'
    || typeof value.region !== 'string' || value.region.length > 32 || !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9][0-9]?$/.test(value.region)
    || typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucket)
    || value.bucket.startsWith('xn--') || value.bucket.startsWith('sthree-') || value.bucket.startsWith('amzn-s3-demo-')
    || ['-s3alias', '--ol-s3', '--x-s3', '--table-s3'].some(suffix => value.bucket.endsWith(suffix))) {
    throw fail('cloud-backup-config-invalid');
  }
  return { version: 1, provider: 'aws-s3', region: value.region, bucket: value.bucket };
}

async function loadCloudBackupConfig(filename) {
  if (!validPath(filename)) throw fail('cloud-backup-config-invalid');
  let handle;
  try {
    let current = path.parse(filename).root;
    for (const part of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('cloud-backup-config-invalid');
    }
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > 4096
      || process.platform !== 'win32' && (before.mode & 0o777) !== 0o600
      || typeof process.getuid === 'function' && before.uid !== process.getuid()) throw fail('cloud-backup-config-invalid');
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const named = await fs.lstat(filename);
    if (named.isSymbolicLink() || size !== before.size || !same(before, await handle.stat()) || !same(before, named)) {
      throw fail('cloud-backup-config-invalid');
    }
    return validateCloudBackupConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
  } catch { throw fail('cloud-backup-config-invalid'); }
  finally { await handle?.close(); }
}

module.exports = { validateCloudBackupConfig, loadCloudBackupConfig };
