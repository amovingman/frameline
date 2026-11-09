const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateScanManifest } = require('./scan-manifest');
const { acquireMetadataLock } = require('./metadata-lock');

const FILE_NAME = 'metadata.json';
const BACKUP_NAME = 'metadata.json.bak';
const branchNamePattern = /^[a-z0-9][a-z0-9._-]{0,39}$/;

class MetadataError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2, 3].includes(value.schemaVersion)
    || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw new MetadataError('metadata-invalid');
  for (const [fingerprint, project] of Object.entries(value.projects)) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new MetadataError('metadata-invalid');
    if (value.schemaVersion === 1) {
      if (typeof project !== 'string' || !/^[a-f0-9-]{36}$/.test(project)) throw new MetadataError('metadata-invalid');
    } else if (!project || typeof project !== 'object' || !/^[a-f0-9-]{36}$/.test(project.id)
      || !Array.isArray(project.revisions) || project.revisions.some(revision =>
        !/^[a-f0-9-]{36}$/.test(revision.id) || typeof revision.message !== 'string'
        || !/^[a-f0-9]{64}$/.test(revision.contentHash)
        || (revision.recordHash !== undefined && !/^[a-f0-9]{64}$/.test(revision.recordHash)))) {
      throw new MetadataError('metadata-invalid');
    }
    if (value.schemaVersion === 3) {
      if (!project.branches || typeof project.branches !== 'object' || Array.isArray(project.branches)
        || !Object.hasOwn(project.branches, 'main') || !Object.hasOwn(project.branches, project.currentBranch)
        || Object.entries(project.branches).some(([name, headId]) => !branchNamePattern.test(name)
          || (headId !== null && !project.revisions.some(revision => revision.id === headId)))) throw new MetadataError('metadata-invalid');
    }
  }
  return value;
}

function migrateMetadata(value) {
  if (value.schemaVersion === 3) return value;
  const projects = Object.fromEntries(Object.entries(value.projects).map(([fingerprint, project]) => {
    const entry = value.schemaVersion === 1 ? { id: project, revisions: [] } : project;
    return [fingerprint, { ...entry, branches: { main: entry.revisions.at(-1)?.id || null }, currentBranch: 'main' }];
  }));
  return { schemaVersion: 3, projects };
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
  if (value?.schemaVersion > 3) throw new MetadataError('metadata-newer-version');
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

function createLocalMetadataStore(directory, { lockTimeoutMs = 5000 } = {}) {
  let pending = Promise.resolve();

  function transact(action) {
    const operation = pending.then(async () => {
      const release = await acquireMetadataLock(directory, lockTimeoutMs);
      try {
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
        metadata ||= { schemaVersion: 3, projects: {} };
        if (metadata.schemaVersion !== 3) {
          metadata = migrateMetadata(metadata);
          await writeMetadata(directory, metadata);
        }
        return await action(metadata, recovered);
      } finally {
        await release();
      }
    });
    pending = operation.catch(() => {});
    return operation;
  }

  async function getProjectId(filePath) {
    const fingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
    return transact(async (metadata, recovered) => {
      if (!metadata.projects[fingerprint]) {
        metadata.projects[fingerprint] = { id: randomUUID(), revisions: [], branches: { main: null }, currentBranch: 'main' };
        await writeMetadata(directory, metadata);
      }
      return { id: metadata.projects[fingerprint].id, recovered };
    });
  }

  function listRevisions(projectId, branchName = null) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      const headId = project.branches[branchName || project.currentBranch];
      if (headId === undefined) throw new MetadataError('branch-not-found');
      const byId = new Map(project.revisions.map(revision => [revision.id, revision]));
      const result = [];
      const seen = new Set();
      let id = headId;
      while (id) {
        if (seen.has(id) || !byId.has(id)) throw new MetadataError('metadata-invalid');
        seen.add(id);
        const revision = byId.get(id);
        result.push(revision);
        id = revision.parentRevisionId;
      }
      return structuredClone(result);
    });
  }

  function getBranchState(projectId) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      return { currentBranch: project.currentBranch, branches: Object.keys(project.branches).sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)) };
    });
  }

  function createBranch(projectId, name, expectedHeadId = null) {
    return transact(async metadata => {
      if (typeof name !== 'string' || !branchNamePattern.test(name)) throw new MetadataError('branch-name-invalid');
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (Object.hasOwn(project.branches, name)) throw new MetadataError('branch-exists');
      const headId = project.branches[project.currentBranch];
      if (headId !== expectedHeadId) throw new MetadataError('revision-head-changed');
      project.branches[name] = headId;
      project.currentBranch = name;
      await writeMetadata(directory, metadata);
      return { currentBranch: name, branches: Object.keys(project.branches).sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)) };
    });
  }

  function switchBranch(projectId, name) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (typeof name !== 'string' || !Object.hasOwn(project.branches, name)) throw new MetadataError('branch-not-found');
      project.currentBranch = name;
      await writeMetadata(directory, metadata);
      return { currentBranch: name, branches: Object.keys(project.branches).sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)) };
    });
  }

  function saveRevision(projectId, manifest, message, expectedHeadId = null, branchName = 'main') {
    return transact(async metadata => {
      if (typeof message !== 'string' || !message.trim() || message.length > 120) throw new MetadataError('revision-message-invalid');
      validateScanManifest(manifest);
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (!Object.hasOwn(project.branches, branchName) || project.currentBranch !== branchName) throw new MetadataError('branch-not-found');
      const parentRevisionId = project.branches[branchName];
      if (parentRevisionId !== expectedHeadId) throw new MetadataError('revision-head-changed');
      const revision = {
        id: randomUUID(), projectId, parentRevisionId, author: 'Local editor',
        createdAt: new Date().toISOString(), message,
        editorVersion: null, manifestVersion: manifest.schemaVersion,
        contentHash: manifest.sourceHash, manifest
      };
      const folder = path.join(directory, 'revisions', projectId);
      const recordBytes = `${JSON.stringify(revision, null, 2)}\n`;
      try {
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        const handle = await fs.open(path.join(folder, `${revision.id}.json`), 'wx', 0o600);
        try { await handle.writeFile(recordBytes); await handle.sync(); }
        finally { await handle.close(); }
      } catch { throw new MetadataError('metadata-unavailable'); }
      const { manifest: _manifest, ...summary } = revision;
      summary.recordHash = createHash('sha256').update(recordBytes).digest('hex');
      project.revisions.push(summary);
      project.branches[branchName] = revision.id;
      await writeMetadata(directory, metadata);
      return structuredClone(summary);
    });
  }

  function getRevision(projectId, revisionId) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      const summary = project?.revisions.find(item => item.id === revisionId);
      if (!summary) throw new MetadataError('revision-not-found');
      let bytes;
      try { bytes = await fs.readFile(path.join(directory, 'revisions', projectId, `${revisionId}.json`)); }
      catch { throw new MetadataError('revision-corrupt'); }
      if (summary.recordHash && createHash('sha256').update(bytes).digest('hex') !== summary.recordHash) throw new MetadataError('revision-corrupt');
      let revision;
      try { revision = JSON.parse(bytes.toString('utf8')); validateScanManifest(revision.manifest); }
      catch { throw new MetadataError('revision-corrupt'); }
      const fields = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];
      if (fields.some(field => revision[field] !== summary[field]) || revision.contentHash !== revision.manifest.sourceHash
        || revision.manifestVersion !== revision.manifest.schemaVersion) throw new MetadataError('revision-corrupt');
      return structuredClone(revision);
    });
  }

  return { getProjectId, listRevisions, getBranchState, createBranch, switchBranch, saveRevision, getRevision };
}

module.exports = { MetadataError, createLocalMetadataStore };
