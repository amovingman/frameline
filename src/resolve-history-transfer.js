'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { validateTransferBundle } = require('./revision-transfer');

const MAX_BYTES = 50 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
const identity = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
async function privateParent(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('resolve-backup-invalid-file');
  let current = path.parse(filename).root;
  for (const component of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('resolve-backup-invalid-file');
  }
}
async function readBundle(filename) {
  await privateParent(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_BYTES) fail('resolve-backup-size');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== before.size || identity(before) !== identity(await handle.stat())
      || identity(before) !== identity(await fs.lstat(filename))) fail('resolve-backup-changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}
async function writeBundle(filename, bytes) {
  await privateParent(filename);
  const temporary = path.join(path.dirname(filename), `.frameline-backup-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // A selected existing file is never replaced, including a symlink destination.
    await fs.link(temporary, filename);
    const directory = await fs.open(path.dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
function inspectBundle(bytes) {
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('resolve-backup-size');
  const bundle = JSON.parse(bytes), records = [...validateTransferBundle(bundle).values()];
  if (bundle.version !== 2 || !records.length || records.some(record => record.manifest.format !== 'resolve-api-observation')
    || new Set(records.map(record => record.manifest.snapshot.project_id)).size !== 1) fail('resolve-backup-invalid');
  const audits = records.map(record => record.manifest.transactionAudit).filter(Boolean);
  return { bundle, editorProjectId: records[0].manifest.snapshot.project_id,
    sourceName: records[0].manifest.snapshot.project_name,
    summary: { revisionCount: records.length, branchCount: Object.keys(bundle.branches).length,
      auditCount: audits.length, choiceCount: audits.reduce((sum, audit) => sum + audit.review.choices.length, 0),
      effectAuditCount: audits.filter(audit => audit.effects !== null).length,
      recoveryAuditCount: audits.filter(audit => audit.recovery !== null).length,
      byteCount: Buffer.byteLength(bytes), metadataOnly: true, nativeBackupsIncluded: false,
      readOnly: true, safeToApply: false } };
}

function createResolveHistoryTransfer({ store, now = Date.now } = {}) {
  let pending = null, busy = false;
  async function exclusive(action) {
    if (busy) fail('resolve-backup-busy');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  function reviewed(token, operation) {
    if (!pending || token !== pending.token || pending.operation !== operation
      || now() - pending.createdAt > 10 * 60 * 1000) fail('resolve-backup-review-expired');
    return pending;
  }
  async function projectFor(id) {
    const project = (await store.listResolveProjects()).find(item => item.id === id);
    if (!project) fail('resolve-backup-project-missing');
    return project;
  }
  function review(operation, bytes, inspected, project) {
    pending = { ...inspected, operation, bytes, token: randomUUID(), createdAt: now(),
      projectId: project?.id || null, bundleHash: hash(bytes) };
    return { ready: true, token: pending.token, operation, projectName: project?.displayName || inspected.sourceName,
      createsProject: operation === 'import' && !project, bundleHash: pending.bundleHash, ...inspected.summary };
  }
  return {
    prepareExport(projectId) { return exclusive(async () => {
      pending = null;
      const project = await projectFor(projectId);
      const bytes = `${JSON.stringify(await store.exportRevisions(projectId))}\n`;
      return review('export', bytes, inspectBundle(bytes), project);
    }); },
    prepareImport(filename) { return exclusive(async () => {
      pending = null;
      const bytes = await readBundle(filename), inspected = inspectBundle(bytes);
      const project = (await store.listResolveProjects()).find(item => item.editorProjectId === inspected.editorProjectId);
      return review('import', bytes, inspected, project);
    }); },
    saveExport(token, filename) { return exclusive(async () => {
      const selected = reviewed(token, 'export');
      // Re-read all records and branch heads; a preview cannot approve later edits.
      const current = `${JSON.stringify(await store.exportRevisions(selected.projectId))}\n`;
      if (hash(current) !== selected.bundleHash) { pending = null; fail('resolve-backup-changed'); }
      await writeBundle(filename, selected.bytes); pending = null;
      return { saved: true, revisionCount: selected.summary.revisionCount, bundleHash: selected.bundleHash };
    }); },
    importReviewed(token) { return exclusive(async () => {
      const selected = reviewed(token, 'import');
      // The verified bytes stay in the main process; replacing the chosen file
      // after preview cannot substitute a different import payload.
      const project = (await store.listResolveProjects()).find(item => item.editorProjectId === selected.editorProjectId)
        || await store.getResolveProjectId(selected.editorProjectId, selected.sourceName);
      const result = await store.importRevisions(project.id, selected.bundle);
      pending = null;
      return { imported: true, projectId: project.id, ...result, bundleHash: selected.bundleHash };
    }); },
    cancel(token) { return exclusive(async () => {
      if (pending && pending.token !== token) fail('resolve-backup-review-expired');
      pending = null; return { cancelled: true };
    }); }
  };
}

module.exports = { createResolveHistoryTransfer, MAX_RESOLVE_BACKUP_BYTES: MAX_BYTES };
