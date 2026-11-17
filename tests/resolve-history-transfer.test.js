'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { createResolveHistoryTransfer } = require('../src/resolve-history-transfer');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-history-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-rename-before-schema3.json')));
  const store = createLocalMetadataStore(path.join(root, 'source'));
  const project = await store.getResolveProjectId(snapshot.project_id, snapshot.project_name);
  const first = await store.saveRevision(project.id, createResolveRevisionManifest(snapshot), 'Original observation');
  await store.createBranch(project.id, 'review', first.id);
  await store.switchBranch(project.id, 'main');
  const session = createResolveHistoryTransfer({ store });
  return { root, snapshot, store, project, first, session };
}
function audit(snapshot) {
  const local = JSON.stringify(snapshot), changed = structuredClone(snapshot);
  changed.timelines[0].items[0].name = 'Portable rename';
  const sources = { base: local, local, incoming: JSON.stringify(changed) }, plan = createResolvePreviewPlan(sources);
  const choices = createResolveConflictReview(plan, sources).conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'take-incoming' }));
  const review = createResolveDecisionAudit(plan, sources, choices), derived = resolveReviewedRename({ sources, plan, audit: review });
  const transactionId = 'a'.repeat(32), stamp = '2026-11-17T19:00:00.000Z';
  const resultSnapshot = `${local}\n`;
  return { schemaVersion: 1, kind: 'resolve-rename-trial-audit', readOnly: true, safeToApply: false,
    nativeBackupIncluded: false, provenance: 'copied-console-observation', transactionId, sources, review,
    issuedRecord: JSON.stringify({ transactionId, forceFailure: true, issuedAt: stamp, recoveryVersion: 1,
      backup: { schemaVersion: 1, sha256: 'b'.repeat(64), size: 300, mode: 0o600, timelineCount: 1, archiveVerified: true } }),
    outcome: { status: 'rolled-back', recordedAt: stamp, sourceSha256: hash(derived.beforeBytes), incomingSha256: hash(derived.afterBytes),
      resultingSnapshotSha256: hash(resultSnapshot), validation: 'observed-fields-only', effectObservation: null },
    resultSnapshot, effects: null, recovery: null };
}

test('Resolve backup review discloses all saved branches and audits without exposing source data or writing files', async t => {
  const { root, snapshot, store, project, first, session } = await fixture(t);
  const portable = audit(snapshot);
  await store.saveRevision(project.id, createResolveRevisionManifest(snapshot, portable), 'Reviewed outcome', first.id, 'main');
  const before = await store.getResolveRevisionGraph(project.id), review = await session.prepareExport(project.id);
  assert.equal(review.revisionCount, 2); assert.equal(review.branchCount, 2); assert.equal(review.auditCount, 1);
  assert.equal(review.effectAuditCount, 0); assert.equal(review.recoveryAuditCount, 0);
  assert.equal(review.metadataOnly, true); assert.equal(review.nativeBackupsIncluded, false);
  assert(!JSON.stringify(review).includes(root)); assert(!JSON.stringify(review).includes('issuedRecord'));
  assert(!JSON.stringify(review).includes(snapshot.timelines[0].items[0].name));
  assert.deepEqual(await store.getResolveRevisionGraph(project.id), before);
  assert.deepEqual((await fs.readdir(root)).sort(), ['source']);
  const output = path.join(root, 'export.json'); await session.saveExport(review.token, output);
  const bytes = await fs.readFile(output), bundle = JSON.parse(bytes);
  assert.equal(hash(bytes), review.bundleHash); assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(bundle.records[1].bytes).manifest.transactionAudit, portable);
  await assert.rejects(session.saveExport(review.token, path.join(root, 'replay.json')), /review-expired/);
});

test('export refuses stale branches or records and never replaces an existing destination', async t => {
  const { root, store, project, first, session } = await fixture(t);
  let review = await session.prepareExport(project.id);
  const output = path.join(root, 'existing.json'); await fs.writeFile(output, 'keep');
  await assert.rejects(session.saveExport(review.token, output), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'keep');
  assert(!(await fs.readdir(root)).some(name => name.endsWith('.tmp')));
  await store.createBranch(project.id, 'later', first.id);
  await assert.rejects(session.saveExport(review.token, path.join(root, 'stale.json')), /backup-changed/);
  review = await session.prepareExport(project.id);
  await fs.appendFile(path.join(root, 'source/revisions', project.id, `${first.id}.json`), ' ');
  await assert.rejects(session.saveExport(review.token, path.join(root, 'corrupt.json')), /revision-corrupt/);
  await assert.rejects(fs.stat(path.join(root, 'stale.json')), { code: 'ENOENT' });
});

test('import review is nonmutating and confirms the verified bytes even if the chosen file is replaced', async t => {
  const { root, snapshot, store, project, session } = await fixture(t);
  const exported = await session.prepareExport(project.id), file = path.join(root, 'backup.json');
  await session.saveExport(exported.token, file);
  const target = createLocalMetadataStore(path.join(root, 'target'));
  const receiver = createResolveHistoryTransfer({ store: target });
  const review = await receiver.prepareImport(file);
  assert.equal(review.createsProject, true); assert.deepEqual(await target.listResolveProjects(), []);
  await fs.writeFile(file, 'replaced after review');
  const result = await receiver.importReviewed(review.token);
  assert.equal(result.imported, true); assert.equal(result.revisionCount, 1);
  assert.deepEqual(result.branches, ['import-main', 'import-review']);
  const importedProject = (await target.listResolveProjects())[0];
  assert.equal(importedProject.editorProjectId, snapshot.project_id);
  const graph = await target.getResolveRevisionGraph(importedProject.id);
  assert.equal(graph.currentBranch, 'main'); assert.equal(graph.branches.main, null);
  assert.notEqual(graph.revisions[0].id, (await store.listRevisions(project.id))[0].id);
  await assert.rejects(receiver.importReviewed(review.token), /review-expired/);
});

test('import into existing Resolve history preserves its display name, current branch, heads, and sync base', async t => {
  const { root, snapshot, store, project, first, session } = await fixture(t);
  const review = await session.prepareExport(project.id), file = path.join(root, 'backup.json');
  await session.saveExport(review.token, file);
  const target = createLocalMetadataStore(path.join(root, 'existing'));
  const local = await target.getResolveProjectId(snapshot.project_id, 'Current project label');
  const head = await target.saveRevision(local.id, createResolveRevisionManifest(snapshot), 'Local work');
  await target.createBranch(local.id, 'working', head.id); await target.switchBranch(local.id, 'working');
  await target.recordSyncBase(local.id, 'working', head.id, head.id);
  const receiver = createResolveHistoryTransfer({ store: target }), selected = await receiver.prepareImport(file);
  assert.equal(selected.projectName, 'Current project label'); assert.equal(selected.createsProject, false);
  const result = await receiver.importReviewed(selected.token), graph = await target.getResolveRevisionGraph(local.id);
  assert.equal(result.projectId, local.id); assert.equal(graph.currentBranch, 'working');
  assert.equal(graph.branches.main, head.id); assert.equal(graph.branches.working, head.id);
  assert.equal(await target.getSyncBase(local.id, 'working'), head.id);
  assert.equal((await target.listResolveProjects())[0].displayName, 'Current project label');
  assert.notEqual(graph.branches['import-main'], first.id);
});

test('rejects mixed projects, FCPXML backups, malformed data, symlinks and invalid UTF-8 before creating history', async t => {
  const { root, store, project } = await fixture(t), bundle = await store.exportRevisions(project.id);
  const target = createLocalMetadataStore(path.join(root, 'target')), receiver = createResolveHistoryTransfer({ store: target });
  const file = path.join(root, 'invalid.json');
  for (const bytes of ['{}', '{', Buffer.from([0xff, 0xfe]), JSON.stringify({ ...bundle, version: 1 })]) {
    await fs.writeFile(file, bytes); await assert.rejects(receiver.prepareImport(file));
  }
  const other = structuredClone(bundle.records[0]); const record = JSON.parse(other.bytes);
  record.id = '11111111-1111-4111-8111-111111111111'; record.manifest.snapshot.project_id = 'other-project';
  record.manifest = createResolveRevisionManifest(record.manifest.snapshot); record.contentHash = record.manifest.sourceHash;
  other.bytes = `${JSON.stringify(record)}\n`; const { manifest, ...summary } = record;
  other.summary = { ...summary, recordHash: hash(other.bytes) }; bundle.records.push(other);
  await fs.writeFile(file, JSON.stringify(bundle)); await assert.rejects(receiver.prepareImport(file), /backup-invalid/);
  const link = path.join(root, 'symlink.json'); await fs.symlink(file, link); await assert.rejects(receiver.prepareImport(link));
  await assert.rejects(receiver.prepareImport(root));
  assert.deepEqual(await target.listResolveProjects(), []);
});

test('reviews expire, cancel without writes, reject wrong tokens and serialize overlapping actions', async t => {
  const { store, project } = await fixture(t); let time = 0;
  const session = createResolveHistoryTransfer({ store, now: () => time });
  let selected = await session.prepareExport(project.id);
  await assert.rejects(session.importReviewed(selected.token), /review-expired/);
  await assert.rejects(session.cancel('wrong-token'), /review-expired/);
  time = 600001; await assert.rejects(session.saveExport(selected.token, '/private/tmp/not-created.json'), /review-expired/);
  selected = await session.prepareExport(project.id); await session.cancel(selected.token);
  await assert.rejects(session.saveExport(selected.token, '/private/tmp/not-created.json'), /review-expired/);
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const blocked = createResolveHistoryTransfer({ store: { ...store, listResolveProjects: async () => { await barrier; return store.listResolveProjects(); } } });
  const pending = blocked.prepareExport(project.id);
  await assert.rejects(blocked.prepareExport(project.id), /backup-busy/); release();
  assert.equal((await pending).ready, true);
});
