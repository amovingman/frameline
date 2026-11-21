const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { fingerprint: stableFingerprint } = require('./project-api-contracts');
const { validateServiceSyncBaseScope, validateServiceSyncBaseCandidate, validateServiceSyncBaseEntry } = require('./service-sync-base');
const { validateRevisionManifest } = require('./revision-manifest');
const { acquireMetadataLock } = require('./metadata-lock');
const { validateTransferBundle, verifyRecord } = require('./revision-transfer');
const { verifyFcpXmlSource } = require('./fcpxml-adapter');

const FILE_NAME = 'metadata.json';
const BACKUP_NAME = 'metadata.json.bak';
const branchNamePattern = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const projectKind = project => project.sourceKind || 'export';

class MetadataError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2, 3, 4, 5].includes(value.schemaVersion)
    || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw new MetadataError('metadata-invalid');
  const projectIds = new Set(); let serviceBaseCount = 0;
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
    if (value.schemaVersion < 5 && project?.serviceSyncBases !== undefined) throw new MetadataError('metadata-invalid');
    if (value.schemaVersion >= 3) {
      if (project.sourceKind !== undefined && !['export', 'resolve-api'].includes(project.sourceKind)) throw new MetadataError('metadata-invalid');
      if (projectKind(project) === 'resolve-api') {
        if (typeof project.editorProjectId !== 'string' || !project.editorProjectId.trim()
          || project.editorProjectId.length > 160 || /[\\/\x00-\x1f\x7f]/.test(project.editorProjectId)
          || /^[a-z]:/i.test(project.editorProjectId)
          || fingerprint !== createHash('sha256').update(`resolve-api:${project.editorProjectId}`).digest('hex')) throw new MetadataError('metadata-invalid');
        if (project.displayName !== undefined && (typeof project.displayName !== 'string'
          || !project.displayName.trim() || project.displayName.length > 160
          || /[\\/\x00-\x1f\x7f]/.test(project.displayName) || /^[a-z]:/i.test(project.displayName))) throw new MetadataError('metadata-invalid');
      } else if (project.editorProjectId !== undefined) throw new MetadataError('metadata-invalid');
      if (projectIds.has(project.id)) throw new MetadataError('metadata-invalid');
      projectIds.add(project.id);
      const byId = new Map(project.revisions.map(revision => [revision.id, revision]));
      if (byId.size !== project.revisions.length || project.revisions.some(revision =>
        revision.projectId !== project.id || (revision.parentRevisionId !== null && !byId.has(revision.parentRevisionId)))) {
        throw new MetadataError('metadata-invalid');
      }
      const checked = new Set();
      for (const revision of project.revisions) {
        const seen = new Set();
        let current = revision;
        while (current && !checked.has(current.id)) {
          if (seen.has(current.id)) throw new MetadataError('metadata-invalid');
          seen.add(current.id);
          current = byId.get(current.parentRevisionId);
        }
        for (const id of seen) checked.add(id);
      }
      if (!project.branches || typeof project.branches !== 'object' || Array.isArray(project.branches)
        || !Object.hasOwn(project.branches, 'main') || !Object.hasOwn(project.branches, project.currentBranch)
        || Object.entries(project.branches).some(([name, headId]) => !branchNamePattern.test(name)
          || (headId !== null && !project.revisions.some(revision => revision.id === headId)))) throw new MetadataError('metadata-invalid');
      if (value.schemaVersion >= 4) {
        if (!project.syncBases || typeof project.syncBases !== 'object' || Array.isArray(project.syncBases)
          || Object.keys(project.syncBases).length !== Object.keys(project.branches).length) throw new MetadataError('metadata-invalid');
        for (const [name, headId] of Object.entries(project.branches)) {
          if (!Object.hasOwn(project.syncBases, name)) throw new MetadataError('metadata-invalid');
          const base = project.syncBases[name];
          if (base !== null) {
            let id = headId;
            while (id && id !== base) id = byId.get(id).parentRevisionId;
            if (id !== base) throw new MetadataError('metadata-invalid');
          }
        }
      }
      if (value.schemaVersion === 5) {
        if (!Array.isArray(project.serviceSyncBases) || (serviceBaseCount += project.serviceSyncBases.length) > 10000) throw new MetadataError('metadata-invalid');
        const scopes = new Set();
        const ancestor = (base, head) => { let current = head; while (current && current !== base) current = byId.get(current).parentRevisionId; return current === base; };
        for (const item of project.serviceSyncBases) {
          try { validateServiceSyncBaseEntry(item); } catch { throw new MetadataError('metadata-invalid'); }
          const key = stableFingerprint(item.scope);
          if (scopes.has(key) || item.scope.localProjectId !== project.id || !Object.hasOwn(project.branches, item.scope.localBranch)
            || !byId.has(item.localRevisionId) || !byId.has(item.observedLocalHead)
            || !ancestor(item.observedLocalHead, project.branches[item.scope.localBranch]) || !ancestor(item.localRevisionId, item.observedLocalHead)
            || byId.get(item.localRevisionId).recordHash !== undefined && byId.get(item.localRevisionId).recordHash !== item.recordHash) throw new MetadataError('metadata-invalid');
          scopes.add(key);
        }
      }
    }
  }
  return value;
}

function migrateMetadata(value) {
  const projects = Object.fromEntries(Object.entries(value.projects).map(([fingerprint, project]) => {
    const entry = value.schemaVersion === 1 ? { id: project, revisions: [] } : project;
    const branched = value.schemaVersion >= 3 ? entry : { ...entry, branches: { main: entry.revisions.at(-1)?.id || null }, currentBranch: 'main' };
    return [fingerprint, { ...branched, syncBases: value.schemaVersion >= 4 ? branched.syncBases
      : Object.fromEntries(Object.keys(branched.branches).map(name => [name, null])), serviceSyncBases: [] }];
  }));
  return { schemaVersion: 5, projects };
}

async function readMetadataFile(filePath, storage = fs) {
  const fs = storage;
  let content;
  try { content = await fs.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new MetadataError('metadata-unavailable');
  }
  let value;
  try { value = JSON.parse(content); }
  catch { throw new MetadataError('metadata-invalid'); }
  if (value?.schemaVersion > 5) throw new MetadataError('metadata-newer-version');
  return validateMetadata(value);
}

async function writeMetadataFile(directory, value, backupExisting = true, storage = fs, onUncertain = () => {}) {
  const fs = storage;
  let replacing = false;
  async function syncDirectory() { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  async function copySynced(from, to) { await fs.copyFile(from, to); const handle = await fs.open(to, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
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
        await copySynced(filePath, backupTempPath);
        await fs.rename(backupTempPath, backupPath);
        await syncDirectory();
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    replacing = true; await fs.rename(tempPath, filePath); await syncDirectory();
    if (backupExisting && !(await fs.stat(backupPath).catch(() => null))) {
      await copySynced(filePath, backupTempPath);
      await fs.rename(backupTempPath, backupPath);
      await syncDirectory();
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(backupTempPath, { force: true }).catch(() => {});
    if (replacing) { onUncertain(); throw new MetadataError('metadata-storage-uncertain'); }
    if (error instanceof MetadataError) throw error;
    throw new MetadataError('metadata-unavailable');
  }
}

function createLocalMetadataStore(directory, { lockTimeoutMs = 5000, storage = fs } = {}) {
  const fs = storage;
  let pending = Promise.resolve(), uncertain = false;
  const readMetadata = filename => readMetadataFile(filename, fs);
  const writeMetadata = (directory, value, backupExisting = true) => writeMetadataFile(directory, value, backupExisting, fs, () => { uncertain = true; });

  function transact(action) {
    const operation = pending.then(async () => {
      if (uncertain) throw new MetadataError('metadata-storage-uncertain');
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
        metadata ||= { schemaVersion: 5, projects: {} };
        if (metadata.schemaVersion !== 5) {
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
        metadata.projects[fingerprint] = { id: randomUUID(), sourceKind: 'export', revisions: [], branches: { main: null }, currentBranch: 'main', syncBases: { main: null }, serviceSyncBases: [] };
        await writeMetadata(directory, metadata);
      }
      if (projectKind(metadata.projects[fingerprint]) !== 'export') throw new MetadataError('metadata-invalid');
      return { id: metadata.projects[fingerprint].id, recovered };
    });
  }

  async function getResolveProjectId(resolveProjectId, displayName = null) {
    if (typeof resolveProjectId !== 'string' || !resolveProjectId.trim() || resolveProjectId.length > 160
      || /[\\/\x00-\x1f\x7f]/.test(resolveProjectId) || /^[a-z]:/i.test(resolveProjectId)) {
      throw new MetadataError('metadata-project-invalid');
    }
    if (displayName !== null && (typeof displayName !== 'string' || !displayName.trim()
      || displayName.length > 160 || /[\\/\x00-\x1f\x7f]/.test(displayName)
      || /^[a-z]:/i.test(displayName))) throw new MetadataError('metadata-project-invalid');
    const fingerprint = createHash('sha256').update(`resolve-api:${resolveProjectId}`).digest('hex');
    return transact(async (metadata, recovered) => {
      if (!metadata.projects[fingerprint]) {
        metadata.projects[fingerprint] = { id: randomUUID(), sourceKind: 'resolve-api', editorProjectId: resolveProjectId,
          ...(displayName ? { displayName } : {}),
          revisions: [], branches: { main: null },
          currentBranch: 'main', syncBases: { main: null }, serviceSyncBases: [] };
        await writeMetadata(directory, metadata);
      }
      if (projectKind(metadata.projects[fingerprint]) !== 'resolve-api'
        || metadata.projects[fingerprint].editorProjectId !== resolveProjectId) throw new MetadataError('metadata-invalid');
      if (displayName && metadata.projects[fingerprint].displayName !== displayName) {
        metadata.projects[fingerprint].displayName = displayName;
        await writeMetadata(directory, metadata);
      }
      return { id: metadata.projects[fingerprint].id, recovered };
    });
  }

  function listResolveProjects() {
    return transact(async metadata => Object.values(metadata.projects)
      .filter(project => projectKind(project) === 'resolve-api')
      .map(project => ({ id: project.id, editorProjectId: project.editorProjectId,
        displayName: project.displayName || null, currentBranch: project.currentBranch,
        revisionCount: project.revisions.length }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '') || a.id.localeCompare(b.id)));
  }

  function getResolveRevisionGraph(projectId) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project || projectKind(project) !== 'resolve-api') throw new MetadataError('metadata-project-missing');
      return structuredClone({ projectId, editorProjectId: project.editorProjectId,
        displayName: project.displayName || null,
        currentBranch: project.currentBranch, branches: project.branches, revisions: project.revisions });
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

  function listRelinkCandidates(targetProjectId, sourceHash) {
    return transact(async metadata => {
      if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new MetadataError('relink-source-changed');
      const target = Object.values(metadata.projects).find(item => item.id === targetProjectId);
      if (!target) throw new MetadataError('metadata-project-missing');
      if (target.revisions.length || Object.keys(target.branches).length !== 1
        || target.branches.main !== null || target.currentBranch !== 'main') return [];
      const candidates = [];
      for (const project of Object.values(metadata.projects)) {
        if (project.id === targetProjectId) continue;
        if (projectKind(project) !== 'export') continue;
        const branch = project.currentBranch;
        const headId = project.branches[branch];
        const head = project.revisions.find(item => item.id === headId);
        if (head?.contentHash !== sourceHash) continue;
        try {
          const bytes = await fs.readFile(path.join(directory, 'revisions', project.id, `${head.id}.json`), 'utf8');
          verifyRecord(head, bytes);
        } catch { continue; }
        candidates.push({ projectId: project.id, branch, revisionId: head.id, message: head.message, createdAt: head.createdAt });
      }
      return candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  function relinkProject(filePath, targetProjectId, sourceProjectId, sourceHash) {
    return transact(async metadata => {
      const targetFingerprint = createHash('sha256').update(path.resolve(filePath)).digest('hex');
      const target = metadata.projects[targetFingerprint];
      const sourceEntry = Object.entries(metadata.projects).find(([, project]) => project.id === sourceProjectId);
      if (!target || target.id !== targetProjectId || !sourceEntry || targetProjectId === sourceProjectId
        || projectKind(target) !== 'export' || projectKind(sourceEntry[1]) !== 'export'
        || target.revisions.length || Object.keys(target.branches).length !== 1
        || target.branches.main !== null || target.currentBranch !== 'main') throw new MetadataError('relink-unavailable');
      const [sourceFingerprint, source] = sourceEntry;
      const head = source.revisions.find(item => item.id === source.branches[source.currentBranch]);
      if (!head || head.contentHash !== sourceHash) throw new MetadataError('relink-source-changed');
      try {
        const bytes = await fs.readFile(path.join(directory, 'revisions', source.id, `${head.id}.json`), 'utf8');
        verifyRecord(head, bytes);
      } catch { throw new MetadataError('revision-corrupt'); }
      await verifyFcpXmlSource(filePath, sourceHash);
      delete metadata.projects[sourceFingerprint];
      metadata.projects[targetFingerprint] = source;
      await writeMetadata(directory, metadata);
      return { id: source.id, currentBranch: source.currentBranch };
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
      project.syncBases[name] = project.syncBases[project.currentBranch];
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

  function getSyncBase(projectId, branchName) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (typeof branchName !== 'string' || !Object.hasOwn(project.branches, branchName)) throw new MetadataError('branch-not-found');
      return project.syncBases[branchName];
    });
  }

  function recordSyncBase(projectId, branchName, baseRevisionId, expectedHeadId) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (typeof branchName !== 'string' || !Object.hasOwn(project.branches, branchName)) throw new MetadataError('branch-not-found');
      const head = project.branches[branchName];
      if (head !== expectedHeadId) throw new MetadataError('revision-head-changed');
      if (baseRevisionId !== null) {
        const byId = new Map(project.revisions.map(revision => [revision.id, revision]));
        let id = head;
        while (id && id !== baseRevisionId) id = byId.get(id).parentRevisionId;
        if (id !== baseRevisionId) throw new MetadataError('sync-base-invalid');
      }
      project.syncBases[branchName] = baseRevisionId;
      await writeMetadata(directory, metadata);
      return baseRevisionId;
    });
  }

  async function getServiceSyncBase(input) {
    const scope = validateServiceSyncBaseScope(input);
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === scope.localProjectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (!Object.hasOwn(project.branches, scope.localBranch)) throw new MetadataError('branch-not-found');
      const entry = project.serviceSyncBases.find(item => stableFingerprint(item.scope) === stableFingerprint(scope));
      return entry ? structuredClone(entry) : null;
    });
  }

  async function recordServiceSyncBase({ scope: inputScope, candidate: inputCandidate, proofSnapshotHash, expectedHeadId, expectedBaseVersion } = {}) {
    const scope = validateServiceSyncBaseScope(inputScope), candidate = validateServiceSyncBaseCandidate(inputCandidate);
    if (typeof proofSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(proofSnapshotHash)
      || !Number.isSafeInteger(expectedBaseVersion) || expectedBaseVersion < 0 || expectedHeadId !== candidate.observedLocalHead) throw new MetadataError('sync-base-invalid');
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === scope.localProjectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (!Object.hasOwn(project.branches, scope.localBranch)) throw new MetadataError('branch-not-found');
      const head = project.branches[scope.localBranch]; if (head !== expectedHeadId) throw new MetadataError('revision-head-changed');
      const byId = new Map(project.revisions.map(item => [item.id, item]));
      const ancestor = (base, from) => { let current = from; while (current && current !== base) current = byId.get(current)?.parentRevisionId; return current === base; };
      if (!ancestor(candidate.localRevisionId, head)) throw new MetadataError('sync-base-invalid');
      const index = project.serviceSyncBases.findIndex(item => stableFingerprint(item.scope) === stableFingerprint(scope));
      const previous = index < 0 ? null : project.serviceSyncBases[index];
      if ((previous?.version || 0) !== expectedBaseVersion) throw new MetadataError('sync-base-version-changed');
      if (previous && !ancestor(previous.localRevisionId, candidate.localRevisionId)) throw new MetadataError('sync-base-regression');
      if (previous?.localRevisionId === candidate.localRevisionId && (previous.remoteRevisionId !== candidate.remoteRevisionId
        || previous.manifestId !== candidate.manifestId || previous.recordHash !== candidate.recordHash)) throw new MetadataError('sync-base-invalid');
      const summary = byId.get(candidate.localRevisionId); let handle;
      try {
        handle = await fs.open(path.join(directory, 'revisions', scope.localProjectId, `${candidate.localRevisionId}.json`),
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024 * 1024) throw new MetadataError('revision-corrupt');
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new MetadataError('revision-corrupt'); offset += result.bytesRead; }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new MetadataError('revision-corrupt');
        const record = verifyRecord(summary, bytes.toString('utf8'));
        if (createHash('sha256').update(bytes).digest('hex') !== candidate.recordHash
          || `sha256:${stableFingerprint(record.manifest)}` !== candidate.manifestId) throw new MetadataError('sync-base-invalid');
      } catch (error) { throw new MetadataError(['sync-base-invalid', 'revision-corrupt'].includes(error.code) ? error.code : 'revision-corrupt'); }
      finally { await handle?.close(); }
      if (previous?.version === Number.MAX_SAFE_INTEGER || index < 0 && Object.values(metadata.projects).reduce((sum, item) => sum + item.serviceSyncBases.length, 0) >= 10000) throw new MetadataError('sync-base-invalid');
      const entry = validateServiceSyncBaseEntry({ version: (previous?.version || 0) + 1, scope, ...candidate, proofSnapshotHash });
      if (index < 0) project.serviceSyncBases.push(entry); else project.serviceSyncBases[index] = entry;
      validateMetadata(metadata); await writeMetadata(directory, metadata); return structuredClone(entry);
    });
  }

  function saveRevision(projectId, manifest, message, expectedHeadId = null, branchName = 'main') {
    return transact(async metadata => {
      if (typeof message !== 'string' || !message.trim() || message.length > 120
        || /[\\/\x00-\x1f\x7f]/.test(message) || /^[a-z]:/i.test(message)) throw new MetadataError('revision-message-invalid');
      validateRevisionManifest(manifest);
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      const resolveApi = manifest.format === 'resolve-api-observation';
      if (projectKind(project) !== (resolveApi ? 'resolve-api' : 'export')
        || (resolveApi && project.editorProjectId !== manifest.snapshot.project_id)) throw new MetadataError('metadata-project-invalid');
      if (!Object.hasOwn(project.branches, branchName) || project.currentBranch !== branchName) throw new MetadataError('branch-not-found');
      const parentRevisionId = project.branches[branchName];
      if (parentRevisionId !== expectedHeadId) throw new MetadataError('revision-head-changed');
      const revision = {
        id: randomUUID(), projectId, parentRevisionId, author: 'Local editor',
        createdAt: new Date().toISOString(), message,
        editorVersion: manifest.format === 'resolve-api-observation' ? manifest.snapshot.resolve_version : null,
        manifestVersion: manifest.schemaVersion,
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
      try { revision = JSON.parse(bytes.toString('utf8')); validateRevisionManifest(revision.manifest); }
      catch { throw new MetadataError('revision-corrupt'); }
      const fields = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];
      if (projectKind(project) !== (revision.manifest.format === 'resolve-api-observation' ? 'resolve-api' : 'export')
        || (projectKind(project) === 'resolve-api' && project.editorProjectId !== revision.manifest.snapshot.project_id)
        || fields.some(field => revision[field] !== summary[field]) || revision.contentHash !== revision.manifest.sourceHash
        || revision.editorVersion !== (revision.manifest.format === 'resolve-api-observation' ? revision.manifest.snapshot.resolve_version : null)
        || revision.manifestVersion !== revision.manifest.schemaVersion) throw new MetadataError('revision-corrupt');
      return structuredClone(revision);
    });
  }

  function exportRevisions(projectId) {
    return transact(async metadata => {
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      const records = [];
      for (const summary of project.revisions) {
        let bytes;
        try { bytes = await fs.readFile(path.join(directory, 'revisions', projectId, `${summary.id}.json`), 'utf8'); }
        catch { throw new MetadataError('revision-corrupt'); }
        try { verifyRecord(summary, bytes); }
        catch { throw new MetadataError('revision-corrupt'); }
        const record = JSON.parse(bytes);
        if (projectKind(project) !== (record.manifest.format === 'resolve-api-observation' ? 'resolve-api' : 'export')
          || (projectKind(project) === 'resolve-api' && project.editorProjectId !== record.manifest.snapshot.project_id)) {
          throw new MetadataError('revision-corrupt');
        }
        records.push({ summary, bytes });
      }
      const bundle = { format: 'frameline-revisions', version: projectKind(project) === 'resolve-api' ? 2 : 1,
        projectId, branches: project.branches, records };
      try { validateTransferBundle(bundle); }
      catch { throw new MetadataError('revision-corrupt'); }
      return structuredClone(bundle);
    });
  }

  // Verification must not invoke transact(): its normal startup path may
  // recover a backup or migrate metadata. This reader accepts only a stable,
  // current primary and existing immutable records, without creating a lock.
  async function exportRevisionsReadOnly(projectId) {
    await pending;
    if (uncertain) throw new MetadataError('metadata-storage-uncertain');
    if (typeof projectId !== 'string' || !/^[a-f0-9-]{36}$/.test(projectId)) throw new MetadataError('metadata-project-missing');
    const base = path.resolve(directory), primary = path.join(base, FILE_NAME);
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
    async function existingDirectory(folder) {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || stat.mode & 0o022 || await fs.realpath(folder) !== folder) throw new MetadataError('metadata-readonly-unsafe-directory');
    }
    async function existingFile(file, limit) {
      if (await fs.realpath(file) !== file) throw new MetadataError('metadata-readonly-unsafe-file');
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || Number(before.uid) !== process.getuid()
          || Number(before.mode) & 0o077 || before.size <= 0n || before.size > BigInt(limit)) throw new MetadataError('metadata-readonly-unsafe-file');
        const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await fs.lstat(file, { bigint: true });
        if (!same(before, after) || !same(before, named) || bytes.length !== Number(before.size)
          || named.isSymbolicLink() || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new MetadataError('metadata-readonly-changed');
        return { bytes, identity: before };
      } finally { await handle.close(); }
    }
    try {
      await existingDirectory(base);
      const initial = await existingFile(primary, 16 * 1024 * 1024);
      let metadata;
      try { metadata = JSON.parse(initial.bytes); } catch { throw new MetadataError('metadata-invalid'); }
      if (metadata?.schemaVersion !== 5) throw new MetadataError('metadata-readonly-current-schema-required');
      validateMetadata(metadata);
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if (project.revisions.length > 1000) throw new MetadataError('metadata-readonly-capacity');
      const records = [], files = [];
      let totalBytes = initial.bytes.length;
      if (project.revisions.length) {
        await existingDirectory(path.join(base, 'revisions'));
        await existingDirectory(path.join(base, 'revisions', projectId));
      }
      for (const summary of project.revisions) {
        const file = path.join(base, 'revisions', projectId, `${summary.id}.json`), captured = await existingFile(file, 32 * 1024 * 1024);
        totalBytes += captured.bytes.length;
        if (totalBytes > 128 * 1024 * 1024) throw new MetadataError('metadata-readonly-capacity');
        const bytes = captured.bytes.toString('utf8'), record = verifyRecord(summary, bytes);
        if (projectKind(project) !== (record.manifest.format === 'resolve-api-observation' ? 'resolve-api' : 'export')
          || projectKind(project) === 'resolve-api' && project.editorProjectId !== record.manifest.snapshot.project_id) throw new MetadataError('revision-corrupt');
        records.push({ summary, bytes }); files.push({ file, identity: captured.identity });
      }
      const bundle = { format: 'frameline-revisions', version: projectKind(project) === 'resolve-api' ? 2 : 1,
        projectId, branches: project.branches, records };
      validateTransferBundle(bundle);
      for (const file of files) {
        const now = await fs.lstat(file.file, { bigint: true });
        if (!same(file.identity, now) || now.isSymbolicLink()) throw new MetadataError('metadata-readonly-changed');
      }
      const final = await existingFile(primary, 16 * 1024 * 1024);
      if (!same(initial.identity, final.identity) || !initial.bytes.equals(final.bytes)) throw new MetadataError('metadata-readonly-changed');
      return structuredClone(bundle);
    } catch (error) {
      if (error instanceof MetadataError || error.code === 'revision-transfer-invalid') throw error;
      throw new MetadataError(error.code === 'ENOENT' ? 'metadata-readonly-primary-or-record-missing' : 'metadata-unavailable');
    }
  }

  function importRevisions(projectId, bundle) {
    return transact(async metadata => {
      const incoming = validateTransferBundle(bundle);
      const project = Object.values(metadata.projects).find(item => item.id === projectId);
      if (!project) throw new MetadataError('metadata-project-missing');
      if ([...incoming.values()].some(record => projectKind(project) !== (record.manifest.format === 'resolve-api-observation' ? 'resolve-api' : 'export')
        || (projectKind(project) === 'resolve-api' && project.editorProjectId !== record.manifest.snapshot.project_id))) {
        throw new MetadataError('metadata-project-invalid');
      }
      const ids = new Map([...incoming.keys()].map(id => [id, randomUUID()]));
      const newRecords = [];
      for (const record of incoming.values()) {
        const rewritten = {
          ...record, id: ids.get(record.id), projectId,
          parentRevisionId: record.parentRevisionId ? ids.get(record.parentRevisionId) : null
        };
        const bytes = `${JSON.stringify(rewritten, null, 2)}\n`;
        const { manifest: _manifest, ...summary } = rewritten;
        summary.recordHash = createHash('sha256').update(bytes).digest('hex');
        newRecords.push({ summary, bytes });
      }
      const importedBranches = [];
      for (const [name, head] of Object.entries(bundle.branches)) {
        const stem = `import-${name}`.slice(0, 36);
        let candidate = stem;
        for (let suffix = 2; Object.hasOwn(project.branches, candidate) || importedBranches.some(([used]) => used === candidate); suffix++) candidate = `${stem}-${suffix}`.slice(0, 40);
        importedBranches.push([candidate, head ? ids.get(head) : null]);
      }
      const folder = path.join(directory, 'revisions', projectId);
      try {
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        for (const { summary, bytes } of newRecords) {
          const handle = await fs.open(path.join(folder, `${summary.id}.json`), 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); }
          finally { await handle.close(); }
        }
      } catch { throw new MetadataError('metadata-unavailable'); }
      project.revisions.push(...newRecords.map(item => item.summary));
      for (const [name, head] of importedBranches) { project.branches[name] = head; project.syncBases[name] = null; }
      await writeMetadata(directory, metadata);
      return { revisionCount: newRecords.length, branches: importedBranches.map(([name]) => name) };
    });
  }

  return { getProjectId, getResolveProjectId, listResolveProjects, getResolveRevisionGraph, listRevisions, getBranchState, getSyncBase, recordSyncBase,
    getServiceSyncBase, recordServiceSyncBase, listRelinkCandidates, relinkProject, createBranch, switchBranch, saveRevision, getRevision, exportRevisions, exportRevisionsReadOnly, importRevisions };
}

module.exports = { MetadataError, createLocalMetadataStore };
