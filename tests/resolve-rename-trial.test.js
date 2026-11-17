'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { prepareRenameTrial, prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, recordRenameTrialConsoleResult } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const { readRenameTrialResult } = require('../src/resolve-rename-trial');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rename-trial-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
  return { destinationDir: directory, disposableProjectName: 'Frameline Restore Probe',
    beforeBytes: await fs.readFile(path.join(root, 'live-rename-before-schema3.json')),
    afterBytes: await fs.readFile(path.join(root, 'live-rename-applied-schema3.json')) };
}

async function exportFixture(trial) {
  // Synthetic archive tests the orchestration boundary. Live Resolve export and
  // execution are recorded separately in SAFE_PULL_PREFLIGHT.md.
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/test.xml']) {
    const filename = path.join(trial.directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, '<Fixture/>');
  }
  const zipped = spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/test.xml'], { cwd: trial.directory });
  assert.equal(zipped.status, 0);
  await fs.chmod(trial.backupPath, 0o666);
}

test('requires a private directory, exact named project, and exactly one observed rename', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareRenameTrial({ ...options, disposableProjectName: 'Other project' }), /named-disposable-project-required/);
  await assert.rejects(prepareRenameTrial({ ...options, afterBytes: options.beforeBytes }), /trial-requires-one-rename/);
  const changed = JSON.parse(options.afterBytes);
  changed.timelines[0].items[1].name = 'Extra edit';
  await assert.rejects(prepareRenameTrial({ ...options, afterBytes: JSON.stringify(changed) }), /trial-requires-one-rename/);
  await fs.chmod(options.destinationDir, 0o755);
  await assert.rejects(prepareRenameTrial(options), /trial-directory-not-private/);
});

test('cannot issue without an archive; keeps private backup and immutable result after verified rollback', async t => {
  const options = await fixture(t);
  const trial = await prepareRenameTrial(options);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }));
  await exportFixture(trial);
  const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  assert.equal(issued.backup.archiveVerified, true);
  assert.equal((await fs.stat(trial.backupPath)).mode & 0o777, 0o600);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }), { code: 'EEXIST' });
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.beforeBytes }), /trial-result-mismatch/);
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes });
  assert.equal(result.sourceSha256, result.resultingSnapshotSha256);
  assert.equal(result.validation, 'observed-fields-only');
  assert.equal(result.backupPath, trial.backupPath);
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes }), { code: 'EEXIST' });
  assert.ok((await fs.stat(trial.backupPath)).isFile());
});

test('refuses symlinked or damaged backup and mismatched result state', async t => {
  const options = await fixture(t);
  const trial = await prepareRenameTrial(options);
  const linkTarget = path.join(options.destinationDir, 'unrelated.drp');
  await fs.writeFile(linkTarget, 'not an archive');
  await fs.symlink(linkTarget, trial.backupPath);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }));
  await fs.unlink(trial.backupPath);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  await fs.appendFile(trial.backupPath, 'changed');
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.afterBytes }), /export-hash-mismatch/);
  await assert.rejects(fs.stat(path.join(trial.directory, 'result.json')), { code: 'ENOENT' });
});

test('records the expected applied state while normalizing incoming enumeration order', async t => {
  const options = await fixture(t);
  const incoming = JSON.parse(options.afterBytes);
  incoming.timelines[0].items.reverse();
  const trial = await prepareRenameTrial({ ...options, afterBytes: JSON.stringify(incoming) });
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'applied', snapshotBytes: options.afterBytes });
  assert.equal(result.status, 'applied');
  assert.notEqual(result.resultingSnapshotSha256, result.sourceSha256);
  assert.equal(result.backup.archiveVerified, true);
});

async function reviewedFixture(t) {
  const options = await fixture(t);
  const base = JSON.parse(options.beforeBytes);
  base.timelines[0].items[0].name = 'Earlier clip name';
  const sources = { base: JSON.stringify(base), local: options.beforeBytes, incoming: options.afterBytes };
  const plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources);
  const audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'take-incoming' })));
  return { ...options, sources, plan, audit };
}

test('reviewed conflict choice survives transaction preparation and a recorded rollback', async t => {
  const options = await reviewedFixture(t);
  assert.equal(options.audit.choices.length, 1);
  const trial = await prepareReviewedRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes });
  assert.deepEqual(result.review.choices, options.audit.choices);
  assert.deepEqual(result.review.sourceBindings, options.plan.binding);
  assert.equal(result.review.auditHash, options.audit.auditHash);
  assert.equal(result.review.planHash, options.audit.planHash);
});

test('rejects stale review bytes, changed audit, keep-local no-op, and additional unresolved incoming work', async t => {
  const options = await reviewedFixture(t);
  await assert.rejects(prepareReviewedRenameTrial({ ...options, sources: { ...options.sources, local: Buffer.concat([options.sources.local, Buffer.from('\n')]) } }));
  const altered = structuredClone(options.audit);
  altered.choices[0].selectedValue = 'Unreviewed name';
  await assert.rejects(prepareReviewedRenameTrial({ ...options, audit: altered }));
  const audit = createResolveDecisionAudit(options.plan, options.sources,
    options.audit.choices.map(choice => ({ conflictId: choice.conflictId, choice: 'keep-local' })));
  await assert.rejects(prepareReviewedRenameTrial({ ...options, audit }), /reviewed-trial-requires-one-rename/);
  const incoming = JSON.parse(options.afterBytes);
  incoming.timelines[0].items[2].start_frame++;
  const sources = { ...options.sources, incoming: JSON.stringify(incoming) };
  const plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources);
  const completeAudit = createResolveDecisionAudit(plan, sources,
    review.conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'take-incoming' })));
  await assert.rejects(prepareReviewedRenameTrial({ ...options, sources, plan, audit: completeAudit }), /unsupported-reviewed-operation/);
  assert.deepEqual(await fs.readdir(options.destinationDir), []);
});

test('rechecks persisted review bindings before issuing a command', async t => {
  const options = await reviewedFixture(t);
  const trial = await prepareReviewedRenameTrial(options);
  await exportFixture(trial);
  const filename = path.join(trial.directory, 'prepared.json');
  const prepared = JSON.parse(await fs.readFile(filename));
  prepared.reviewContext.audit.choices[0].choice = 'keep-local';
  await fs.writeFile(filename, JSON.stringify(prepared));
  await assert.rejects(issueRenameTrial({ directory: trial.directory }));
  await assert.rejects(fs.stat(path.join(trial.directory, 'issued.json')), { code: 'ENOENT' });
});

test('preserves independent local edits when resolving the incoming name change', async t => {
  const options = await fixture(t);
  const local = JSON.parse(options.beforeBytes);
  local.timelines[0].items[2].start_frame++;
  const sources = { base: options.beforeBytes, local: JSON.stringify(local), incoming: options.afterBytes };
  const plan = createResolvePreviewPlan(sources);
  const audit = createResolveDecisionAudit(plan, sources, []);
  const derived = resolveReviewedRename({ sources, plan, audit });
  const desired = JSON.parse(derived.afterBytes);
  assert.equal(desired.timelines[0].items[2].start_frame, local.timelines[0].items[2].start_frame);
  assert.equal(desired.timelines[0].items[0].name, 'Frameline disposable rename');
});

test('Console recording requires ordered same-transaction parts followed by exactly one result', async t => {
  const options = await reviewedFixture(t);
  const trial = await prepareReviewedRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  const raw = options.beforeBytes.toString('utf8').trimEnd();
  const parts = [];
  for (let offset = 0; offset < raw.length; offset += 8192) parts.push(raw.slice(offset, offset + 8192));
  const lines = parts.map((part, index) => `FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${trial.transactionId}:${index + 1}:${part}`);
  const status = `FRAMELINE_RENAME_TRIAL_RESULT_V1:${trial.transactionId}:rolled-back`;
  const valid = [...lines, status].join('\n');
  for (const bad of [[...lines.slice(1), status].join('\n'), [...lines, status, status].join('\n'),
    [status, ...lines].join('\n'), valid.replaceAll(trial.transactionId, '0'.repeat(32))]) {
    await assert.rejects(recordRenameTrialConsoleResult({ directory: trial.directory, consoleOutput: bad }));
  }
  const report = await recordRenameTrialConsoleResult({ directory: trial.directory, consoleOutput: valid });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.resultingSnapshotSha256, report.sourceSha256);
  assert.equal(report.review.auditHash, options.audit.auditHash);
});

test('live reviewed rollback observation retains the recomputed audit and exact local source hash', async t => {
  const options = await reviewedFixture(t);
  const observation = JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/reviewed-rename-live-observation.json')));
  assert.equal(observation.status, 'rolled-back');
  assert.equal(observation.forcedFailure, true);
  assert.equal(observation.sourceSha256, observation.resultingSnapshotSha256);
  assert.deepEqual(observation.review.sourceBindings, options.plan.binding);
  assert.equal(observation.review.planHash, options.audit.planHash);
  assert.equal(observation.review.auditHash, options.audit.auditHash);
  assert.deepEqual(observation.review.choices, options.audit.choices);
  assert.equal(observation.backup.archiveVerified, true);
  assert.equal(observation.backup.mode, 0o600);
  assert.equal(observation.desktopIntegrated, false);
  assert.ok(!JSON.stringify(observation).includes('/private/'));
});

async function completedTrial(t, status = 'applied') {
  const options = await reviewedFixture(t);
  const trial = await prepareReviewedRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  await recordRenameTrialResult({ directory: trial.directory, status,
    snapshotBytes: status === 'applied' ? options.afterBytes : options.beforeBytes });
  const store = createLocalMetadataStore(path.join(options.destinationDir, 'history'));
  const manifest = createResolveRevisionManifest(JSON.parse(options.beforeBytes));
  const project = await store.getResolveProjectId(manifest.snapshot.project_id, manifest.snapshot.project_name);
  const baseline = await store.saveRevision(project.id, manifest, 'Before trial');
  return { options, trial, store, project, baseline,
    target: { directory: trial.directory, store, branch: 'main', expectedHeadId: baseline.id } };
}

test('saves an audited resulting observation and reconciles interruption without creating a duplicate revision', async t => {
  const { trial, store, project, baseline, target } = await completedTrial(t);
  const link = await saveRenameTrialRevision(target);
  assert.equal(link.status, 'applied');
  assert.equal(link.expectedHeadId, baseline.id);
  const { result, snapshot } = await readRenameTrialResult(trial.directory);
  const revision = await store.getRevision(project.id, link.revisionId);
  assert.deepEqual(revision.manifest.snapshot, snapshot);
  assert.equal(link.auditHash, result.review.auditHash);
  assert.deepEqual(await saveRenameTrialRevision(target), link);
  await fs.unlink(path.join(trial.directory, 'revision-link.json'));
  assert.deepEqual(await saveRenameTrialRevision(target), link);
  assert.equal((await store.listRevisions(project.id)).length, 2);
});

test('does not advance history after a branch-head race or an unresolved recovery outcome', async t => {
  const { store, project, baseline, target, options } = await completedTrial(t);
  const manifest = createResolveRevisionManifest(JSON.parse(options.beforeBytes));
  const concurrent = await store.saveRevision(project.id, manifest, 'Concurrent local work', baseline.id);
  await assert.rejects(saveRenameTrialRevision(target), { code: 'revision-head-changed' });
  assert.equal((await store.listRevisions(project.id))[0].id, concurrent.id);
  const recovery = await completedTrial(t, 'recovery-required');
  await assert.rejects(saveRenameTrialRevision(recovery.target), /trial-recovery-required/);
  assert.equal((await recovery.store.listRevisions(recovery.project.id)).length, 1);
});

test('rejects altered outcome snapshots before recording a resulting revision', async t => {
  const { trial, target, store, project } = await completedTrial(t);
  await fs.appendFile(path.join(trial.directory, 'result-snapshot.json'), '\n');
  await assert.rejects(saveRenameTrialRevision(target), /trial-result-mismatch/);
  assert.equal((await store.listRevisions(project.id)).length, 1);
});
