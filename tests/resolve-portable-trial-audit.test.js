'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, exportRenameTrialAudit,
  prepareRenameTrialRecovery, readRenameTrialRecoveryCapture, issueRenameTrialRecovery, recordRenameTrialRecoveryResult } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveRevisionManifest, validateResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { validatePortableTrialAudit, portableTrialAuditHash, createPortableTrialAuditBundle } = require('../src/resolve-portable-trial-audit');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');
const { importPortableTrialAudit } = require('../src/resolve-audit-history');
const { readResolveHistoryPreviewSources } = require('../src/resolve-history-preview');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createRevisionSyncService } = require('../src/revision-sync');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { effects = true, recovered = false, forceFailure = true } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'portable-trial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const local = await fs.readFile(path.join(f, 'live-rename-before-schema3.json'));
  const incoming = await fs.readFile(path.join(f, 'live-rename-applied-schema3.json'));
  const effectBytes = await fs.readFile(path.join(f, 'live-effects-enabled.json'));
  const base = JSON.parse(local); base.timelines[0].items[0].name = 'Earlier clip name';
  const sources = { base: JSON.stringify(base), local, incoming }, plan = createResolvePreviewPlan(sources);
  const conflicts = createResolveConflictReview(plan, sources).conflicts;
  const audit = createResolveDecisionAudit(plan, sources, conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'take-incoming' })));
  const trial = await prepareReviewedRenameTrial({ sources, plan, audit, destinationDir: root,
    disposableProjectName: 'Frameline Restore Probe', ...(effects ? { effectObservationBytes: effectBytes } : {}) });
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const file = path.join(trial.directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
  await issueRenameTrial({ directory: trial.directory, forceFailure });
  if (recovered) {
    const recovery = await prepareRenameTrialRecovery({ directory: trial.directory });
    const renamed = JSON.parse(effectBytes); renamed.snapshot = JSON.parse(incoming);
    await readRenameTrialRecoveryCapture({ directory: trial.directory, attemptId: recovery.attemptId,
      consoleOutput: capture(recovery.attemptId, JSON.stringify(renamed)) });
    await issueRenameTrialRecovery({ directory: trial.directory, attemptId: recovery.attemptId });
    await recordRenameTrialRecoveryResult({ directory: trial.directory, attemptId: recovery.attemptId,
      consoleOutput: capture(recovery.attemptId, effectBytes, 'restored') });
  } else await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: local,
    ...(effects ? { effectObservationBytes: effectBytes } : {}) });
  return { root, trial, sources, snapshot: JSON.parse(local), portable: await exportRenameTrialAudit(trial.directory) };
}
function capture(id, bytes, status) {
  const raw = bytes.toString('utf8').trimEnd(), parts = [];
  for (let offset = 0; offset < raw.length; offset += 8192) parts.push(raw.slice(offset, offset + 8192));
  return parts.map((part, index) => status ? `FRAMELINE_RENAME_RECOVERY_CAPTURE_V1:${id}:${index + 1}:${part}`
    : `FRAMELINE_EFFECT_PART_V1:${id}:${index + 1}:${parts.length}:${part}`).concat(status
    ? [`FRAMELINE_RENAME_RECOVERY_RESULT_V1:${id}:${status}`] : []).join('\n');
}

async function saved(t, options) {
  const context = await fixture(t, options), store = createLocalMetadataStore(path.join(context.root, 'history'));
  const manifest = createResolveRevisionManifest(context.snapshot);
  const project = await store.getResolveProjectId(context.snapshot.project_id, context.snapshot.project_name);
  const baseline = await store.saveRevision(project.id, manifest, 'Baseline');
  const target = { directory: context.trial.directory, store, branch: 'main', expectedHeadId: baseline.id };
  const link = await saveRenameTrialRevision(target);
  return { ...context, store, project, baseline, target, link };
}

test('new reviewed outcome revisions retain complete choices and effect evidence while preserving snapshot hashes', async t => {
  const context = await saved(t), { store, project, link, snapshot, portable, target, trial } = context;
  const record = await store.getRevision(project.id, link.revisionId);
  assert.equal(record.manifest.schemaVersion, 2);
  assert.equal(record.manifest.sourceHash, createResolveRevisionManifest(snapshot).sourceHash);
  assert.equal(record.manifest.transactionAuditHash, portableTrialAuditHash(portable));
  assert.equal(link.transactionAuditHash, record.manifest.transactionAuditHash);
  assert.equal(record.manifest.transactionAudit.review.choices[0].choice, 'take-incoming');
  assert.equal(record.manifest.transactionAudit.effects.before, record.manifest.transactionAudit.effects.after);
  assert.equal(record.manifest.transactionAudit.nativeBackupIncluded, false);
  assert(!JSON.stringify(portable).includes(context.root));
  assert(!JSON.stringify(portable).includes('backupPath'));
  assert.deepEqual(await saveRenameTrialRevision(target), link);
  await fs.unlink(path.join(trial.directory, 'revision-link.json'));
  assert.deepEqual(await saveRenameTrialRevision(target), link);
  assert.equal((await store.listRevisions(project.id)).length, 2);
});

test('revision backup import remaps local IDs and preserves self-contained audit bytes and preview sources', async t => {
  const source = await saved(t), bundle = await source.store.exportRevisions(source.project.id);
  const target = createLocalMetadataStore(path.join(source.root, 'imported'));
  const project = await target.getResolveProjectId(source.snapshot.project_id);
  const imported = await target.importRevisions(project.id, JSON.parse(JSON.stringify(bundle)));
  const records = await target.listRevisions(project.id, imported.branches[0]);
  const audited = await target.getRevision(project.id, records[0].id);
  assert.notEqual(audited.id, source.link.revisionId);
  assert.notEqual(audited.projectId, source.project.id);
  assert.deepEqual(audited.manifest.transactionAudit, source.portable);
  assert.equal(audited.manifest.transactionAuditHash, source.link.transactionAuditHash);
  assert.equal(audited.manifest.transactionAudit.transactionId, source.trial.transactionId);
  const sources = await readResolveHistoryPreviewSources(target, project.id,
    { base: records[1].id, local: records[0].id, incoming: records[0].id });
  assert.deepEqual(JSON.parse(sources.local), source.snapshot);
  const memory = createCloudHistoryStore(); memory.createProject({ projectId: 'audit-proof', name: 'Disposable audit proof' });
  const sync = createRevisionSyncService(memory);
  sync.push({ remoteProjectId: 'audit-proof', bundle, authorId: 'local-test' });
  const fetched = sync.fetch({ remoteProjectId: 'audit-proof' });
  assert.equal(fetched.mediaFetched, false);
  assert.equal(fetched.manifests.length, 2);
  assert.deepEqual(fetched.manifests.find(item => item.document.schemaVersion === 2).document.transactionAudit, source.portable);
});

test('semantic validation rejects changed sources, decisions, effects, provenance, and private paths even after rehashing', async t => {
  const { portable, snapshot } = await fixture(t);
  const mutations = [
    value => { value.sources.local += '\n'; },
    value => { value.review.choices[0].choice = 'keep-local'; },
    value => { value.nativeBackupIncluded = true; },
    value => { value.provenance = 'editor-signed'; },
    value => { const issued = JSON.parse(value.issuedRecord); issued.backupPath = '/private/source.drp'; value.issuedRecord = JSON.stringify(issued); },
    value => { const local = JSON.parse(value.sources.local); local.timelines[0].items[0].name = '/private/media.mov'; value.sources.local = JSON.stringify(local); },
    value => { const effects = JSON.parse(value.effects.after); effects.items.flatMap(item => item.effects)[0].enabled = false;
      value.effects.after = JSON.stringify(effects); value.outcome.effectObservation.resultingSha256 = hash(value.effects.after); }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(portable); mutate(changed);
    const manifest = { ...createResolveRevisionManifest(snapshot, portable), transactionAudit: changed,
      transactionAuditHash: portableTrialAuditHash(changed) };
    assert.throws(() => validateResolveRevisionManifest(manifest), { code: 'resolve-revision-invalid' });
  }
});

test('recovered observations retain and validate their exact inspection and retirement binding', async t => {
  const { portable, snapshot } = await fixture(t, { recovered: true });
  assert.equal(portable.outcome.status, 'restored');
  assert.equal(portable.recovery.binding.operation, 'restore-name');
  assert.equal(validatePortableTrialAudit(portable, snapshot), portable);
  const changed = structuredClone(portable);
  changed.recovery.binding.operation = 'verify-source';
  assert.throws(() => createResolveRevisionManifest(snapshot, changed), { code: 'resolve-revision-invalid' });
  const inspection = structuredClone(portable);
  inspection.recovery.inspection = inspection.effects.before;
  inspection.recovery.binding.inspectionSha256 = hash(inspection.recovery.inspection);
  assert.throws(() => validatePortableTrialAudit(inspection), { code: 'invalid-portable-trial-audit' });
});

test('portable audit import is idempotent, preserves branch/sync-base state, and rejects conflicting payloads', async t => {
  const { root, portable, snapshot } = await fixture(t), store = createLocalMetadataStore(path.join(root, 'destination'));
  const project = await store.getResolveProjectId(snapshot.project_id, 'Current local display name');
  const base = await store.saveRevision(project.id, createResolveRevisionManifest(snapshot), 'User baseline');
  await store.createBranch(project.id, 'local-work', base.id);
  await store.recordSyncBase(project.id, 'local-work', base.id, base.id);
  const bundle = createPortableTrialAuditBundle(portable);
  const first = await importPortableTrialAudit(store, bundle);
  assert.equal(first.imported, true); assert.equal(first.branch, 'local-work');
  assert.equal((await importPortableTrialAudit(store, bundle)).imported, false);
  assert.equal((await store.listRevisions(project.id, 'local-work')).length, 2);
  assert.equal((await store.listRevisions(project.id, 'main')).length, 1);
  assert.equal((await store.getBranchState(project.id)).currentBranch, 'local-work');
  assert.equal(await store.getSyncBase(project.id, 'local-work'), base.id);
  assert.equal((await store.listResolveProjects())[0].displayName, 'Current local display name');
  const changed = structuredClone(portable); changed.outcome.recordedAt = new Date(Date.parse(changed.outcome.recordedAt) + 1000).toISOString();
  await assert.rejects(importPortableTrialAudit(store, createPortableTrialAuditBundle(changed)), /conflicting-imported-trial-audit/);
  assert.equal((await store.listRevisions(project.id, 'local-work')).length, 2);
});

test('legacy linked revisions remain immutable and counts-only audits make no effect claim', async t => {
  const context = await fixture(t, { effects: false }), store = createLocalMetadataStore(path.join(context.root, 'legacy'));
  assert.equal(context.portable.effects, null); assert.equal(context.portable.outcome.effectObservation, null);
  const project = await store.getResolveProjectId(context.snapshot.project_id), manifest = createResolveRevisionManifest(context.snapshot);
  const baseline = await store.saveRevision(project.id, manifest, 'Baseline');
  const legacy = await store.saveRevision(project.id, manifest, `Rename trial ${context.trial.transactionId} rolled-back`, baseline.id);
  const link = await saveRenameTrialRevision({ directory: context.trial.directory, store, branch: 'main', expectedHeadId: baseline.id });
  assert.equal(link.revisionId, legacy.id); assert.equal(link.transactionAuditHash, undefined);
  assert.equal((await store.getRevision(project.id, legacy.id)).manifest.schemaVersion, 1);
  assert.equal((await store.listRevisions(project.id)).length, 2);
});

test('audit and manifest accessors are rejected without executing them', async t => {
  const { portable, snapshot } = await fixture(t); let called = 0;
  const accessor = { ...portable }; Object.defineProperty(accessor, 'sources', { enumerable: true, get() { called++; return portable.sources; } });
  assert.throws(() => validatePortableTrialAudit(accessor), { code: 'invalid-portable-trial-audit' });
  const manifest = createResolveRevisionManifest(snapshot, portable);
  Object.defineProperty(manifest, 'transactionAudit', { enumerable: true, get() { called++; return portable; } });
  assert.throws(() => validateResolveRevisionManifest(manifest), { code: 'resolve-revision-invalid' });
  assert.equal(called, 0);
  const cyclic = { ...portable }; cyclic.loop = cyclic;
  assert.throws(() => validatePortableTrialAudit(cyclic), { code: 'invalid-portable-trial-audit' });
});

test('CLI exports complete private files without replacement, verifies them, and imports once', async t => {
  const { root, trial } = await fixture(t), filename = path.join(root, 'audit.json');
  const cli = path.join(__dirname, '../phase-0/portable-resolve-audit.js');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run(['export', trial.directory, filename]).status, 0);
  const original = await fs.readFile(filename);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal(run(['verify', filename]).status, 0);
  assert.equal(run(['export', trial.directory, filename]).status, 1);
  assert.deepEqual(await fs.readFile(filename), original);
  assert(!(await fs.readdir(root)).some(name => name.startsWith('.frameline-audit-')));
  const link = path.join(root, 'linked.json'); await fs.symlink(filename, link);
  assert.equal(run(['verify', link]).status, 1);
  const destination = path.join(root, 'cli-history');
  const first = run(['import', destination, filename]); assert.equal(first.status, 0);
  assert.equal(JSON.parse(first.stdout).imported, true);
  assert.equal(JSON.parse(run(['import', destination, filename]).stdout).imported, false);
});

test('non-forced v2 recovery audit preserves restore-original evidence and rejects changed issuance mode or future versions', async t => {
  const { portable, snapshot } = await fixture(t, { recovered: true, forceFailure: false });
  const issued = JSON.parse(portable.issuedRecord); assert.equal(issued.recoveryVersion, 2); assert.equal(issued.forceFailure, false);
  assert.equal(portable.outcome.status, 'restored'); assert.equal(portable.recovery.binding.operation, 'restore-name');
  assert.deepEqual(validatePortableTrialAudit(portable, snapshot), portable);
  for (const edit of [value => { value.forceFailure = true; }, value => { value.recoveryVersion = 3; },
    value => { value.recoveryVersion = 1; }, value => { value.extra = 'unknown'; }]) {
    const changed = structuredClone(portable), record = JSON.parse(changed.issuedRecord); edit(record); changed.issuedRecord = JSON.stringify(record);
    assert.throws(() => validatePortableTrialAudit(changed), { code: 'invalid-portable-trial-audit' });
  }
});
