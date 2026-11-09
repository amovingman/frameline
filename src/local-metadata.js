const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const FILE_NAME = 'metadata.json';
const BACKUP_NAME = 'metadata.json.bak';

class MetadataError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw new MetadataError('metadata-invalid');
  for (const [fingerprint, id] of Object.entries(value.projects)) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || typeof id !== 'string'
      || !/^[a-f0-9-]{36}$/.test(id)) throw new MetadataError('metadata-invalid');
  }
  return value;
}

async function readMetadata(filePath) {
  let content;
  try { content = await fs.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new MetadataError('metadata-unavailable');
  }
  let value;
  try { value = JSON.parse(content); }
  catch { throw new MetadataError('metadata-invalid'); }
  if (value?.schemaVersion > 1) throw new MetadataError('metadata-newer-version');
  return validateMetadata(value);
}

async function writeMetadata(directory, value, backupExisting = true) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, FILE_NAME);
  const tempPath = path.join(directory, `${FILE_NAME}.${randomUUID()}.tmp`);
  const backupPath = path.join(directory, BACKUP_NAME);
  const backupTempPath = path.join(directory, `${BACKUP_NAME}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    if (backupExisting) {
      try {
        await fs.copyFile(filePath, backupTempPath);
        await fs.rename(backupTempPath, backupPath);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(tempPath, filePath);
    if (backupExisting && !(await fs.stat(backupPath).catch(() => null))) {
      await fs.copyFile(filePath, backupTempPath);
      await fs.rename(backupTempPath, backupPath);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(backupTempPath, { force: true }).catch(() => {});
    if (error instanceof MetadataError) throw error;
    throw new MetadataError('metadata-unavailable');
  }
}

function createLocalMetadataStore(directory) {
  let pending = Promise.resolve();

  async function getProjectId(filePath) {
    const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
    const operation = pending.then(async () => {
      let recovered = false;
      const primary = path.join(directory, FILE_NAME);
      let metadata;
      try { metadata = await readMetadata(primary); }
      catch (error) {
        if (error.code !== 'metadata-invalid') throw error;
        const backup = await readMetadata(path.join(directory, BACKUP_NAME));
        if (!backup) throw error;
        await fs.rename(primary, path.join(directory, `${FILE_NAME}.corrupt-${randomUUID()}`));
        await writeMetadata(directory, backup, false);
        recovered = true;
        metadata = backup;
      }
      if (!metadata) {
        const backup = await readMetadata(path.join(directory, BACKUP_NAME));
        if (backup) {
          await writeMetadata(directory, backup, false);
          recovered = true;
          metadata = backup;
        }
      }
      metadata ||= { schemaVersion: 1, projects: {} };
      if (!metadata.projects[fingerprint]) {
        metadata.projects[fingerprint] = randomUUID();
        await writeMetadata(directory, metadata);
      }
      return { id: metadata.projects[fingerprint], recovered };
    });
    pending = operation.catch(() => {});
    return operation;
  }

  return { getProjectId };
}

module.exports = { MetadataError, createLocalMetadataStore };
