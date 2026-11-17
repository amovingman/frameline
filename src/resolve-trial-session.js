'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialConsoleResult,
  readRenameTrialResult } = require('./resolve-rename-trial');
const { saveRenameTrialRevision } = require('./resolve-trial-history');
const { createResolveRevisionManifest } = require('./resolve-revision-manifest');
const { compareResolveRevisionManifests } = require('./resolve-revision-comparison');
const { inspectResolveProjectExport } = require('./resolve-project-export');
const { createEffectCaptureCommand, readEffectConsoleResult } = require('./resolve-effect-console');
const { resolveReviewedRename } = require('./resolve-rename-review');
const { createHash } = require('node:crypto');

function createResolveTrialSession({ enabled = false, directory, store, getReview, clipboard } = {}) {
  let pending = null, phase = 'idle', error = null, busy = false, outcome = null, revision = null;
  function getState() {
    return { enabled, phase, busy, transactionId: pending?.transactionId || null,
      captureId: pending?.captureId || null, effectGuard: pending?.effectGuard || null,
      backup: pending?.backup || null, outcome: outcome ? { status: outcome.status,
        snapshotSha256: outcome.resultingSnapshotSha256, auditHash: outcome.review?.auditHash || null,
        effectObservation: outcome.effectObservation || null } : null,
      revisionId: revision?.revisionId || null, branch: pending?.target?.branch || null, error };
  }
  async function run(action) {
    if (!enabled || busy) return { ...getState(), error: enabled ? 'A trial action is already running.' : 'Rename experiments are disabled.' };
    busy = true; error = null;
    try { await action(); }
    catch (failure) {
      error = failure.message === 'complete-current-review-required' ? 'Sources changed or conflicts are incomplete. Refresh and review the snapshots.'
        : failure.message === 'named-disposable-project-required' ? 'Enter the exact reviewed project name, starting with “Frameline ”, and acknowledge the disposable project.'
        : ['reviewed-trial-requires-one-rename', 'unsupported-reviewed-operation'].includes(failure.message) ? 'This drill requires a completed review with exactly one clip rename.'
        : failure.message === 'effect-source-snapshot-mismatch' ? 'The live capture differs from the reviewed local snapshot. Cancel preparation, refresh the snapshots, and review again.'
        : phase === 'effect-command' ? 'The effect capture could not be verified. Run the copied capture in Resolve’s Lua Console, copy all output, and read it again.'
        : 'The trial action could not be verified. Keep the backup and trial records; check the Console output and retry.';
    } finally { busy = false; }
    return getState();
  }
  async function prepare(projectName, acknowledged) {
    return run(async () => {
      if (acknowledged !== true || (pending && phase !== 'saved')) throw new Error('trial-not-ready');
      const review = await getReview();
      const derived = resolveReviewedRename(review);
      const snapshot = JSON.parse(derived.beforeBytes);
      if (typeof projectName !== 'string' || !projectName.startsWith('Frameline ') || projectName !== snapshot.project_name) {
        throw new Error('named-disposable-project-required');
      }
      const capture = await createEffectCaptureCommand(projectName);
      pending = { ...capture, projectName, auditHash: review.audit.auditHash };
      outcome = revision = null; phase = 'effect-command';
      clipboard.writeText(capture.command);
    });
  }
  async function prepareBackup() {
    const review = await getReview();
    if (review.audit.auditHash !== pending.auditHash) throw new Error('complete-current-review-required');
    const effectObservationBytes = readEffectConsoleResult({ captureId: pending.captureId, output: clipboard.readText() });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const trial = await prepareReviewedRenameTrial({ ...review, effectObservationBytes,
      destinationDir: directory, disposableProjectName: pending.projectName });
    const before = createResolveRevisionManifest(JSON.parse(review.sources.local.toString('utf8')));
    const project = await store.getResolveProjectId(before.snapshot.project_id, before.snapshot.project_name);
    const branch = (await store.getBranchState(project.id)).currentBranch;
    const revisions = await store.listRevisions(project.id, branch);
    let head = revisions[0]?.id || null;
    const parent = head ? await store.getRevision(project.id, head) : null;
    if (!parent || compareResolveRevisionManifests(parent.manifest, before).changes.length) {
      head = (await store.saveRevision(project.id, before, `Before rename trial ${trial.transactionId}`, head, branch)).id;
    }
    const target = { branch, expectedHeadId: head };
    await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify(target), { flag: 'wx', mode: 0o600 });
    pending = { ...trial, target, auditHash: review.audit.auditHash,
      effectGuard: { sourceSha256: createHash('sha256').update(effectObservationBytes).digest('hex') } };
    outcome = revision = null; phase = 'backup-command';
    clipboard.writeText(trial.command);
  }
  async function issue() {
    return run(async () => {
      if (phase !== 'backup-command') throw new Error('trial-not-ready');
      const review = await getReview();
      if (review.audit.auditHash !== pending.auditHash) throw new Error('complete-current-review-required');
      // Desktop exposes the forced-failure drill only while full apply validation
      // is unproven. Both rename and rollback execute on the named disposable project.
      const issued = await issueRenameTrial({ directory: pending.directory, forceFailure: true });
      pending.backup = issued.backup;
      pending.command = issued.command;
      phase = 'rollback-command'; clipboard.writeText(issued.command);
    });
  }
  async function read() {
    return run(async () => {
      if (phase === 'effect-command') { await prepareBackup(); return; }
      if (phase !== 'rollback-command') throw new Error('trial-not-ready');
      outcome = await recordRenameTrialConsoleResult({ directory: pending.directory, consoleOutput: clipboard.readText() });
      phase = 'verified';
    });
  }
  async function saveRevision() {
    return run(async () => {
      if (!['verified', 'saved'].includes(phase)) throw new Error('trial-not-ready');
      revision = await saveRenameTrialRevision({ directory: pending.directory, store, ...pending.target });
      phase = 'saved';
    });
  }
  async function recover(selected) {
    return run(async () => {
      if (pending && phase !== 'saved') throw new Error('trial-already-active');
      if (typeof selected !== 'string' || path.dirname(selected) !== path.resolve(directory)) throw new Error('invalid-trial-directory');
      const { result } = await readRenameTrialResult(selected);
      const handle = await fs.open(path.join(selected, 'history-target.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let target;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 1024) throw new Error('invalid-history-target');
        target = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      if (typeof target.branch !== 'string' || typeof target.expectedHeadId !== 'string') throw new Error('invalid-history-target');
      pending = { directory: selected, transactionId: result.transactionId, backup: result.backup,
        backupPath: result.backupPath, target, auditHash: result.review?.auditHash,
        effectGuard: result.effectObservation ? { sourceSha256: result.effectObservation.sourceSha256 } : null };
      outcome = result; revision = null; phase = 'verified';
    });
  }
  async function backupPath() {
    if (!enabled || !pending?.backup) throw new Error('verified-backup-required');
    await inspectResolveProjectExport(pending.backupPath, pending.backup.sha256);
    return pending.backupPath;
  }
  async function copyCommand() {
    return run(async () => {
      if (!['effect-command', 'backup-command', 'rollback-command'].includes(phase) || !pending?.command) throw new Error('trial-command-unavailable');
      clipboard.writeText(pending.command);
    });
  }
  async function cancelPreparation() {
    return run(async () => {
      if (phase === 'effect-command') {
        pending = null; outcome = revision = null; phase = 'idle'; return;
      }
      if (phase !== 'backup-command') throw new Error('trial-cannot-cancel-issued-command');
      await fs.writeFile(path.join(pending.directory, 'cancelled.json'), JSON.stringify({ transactionId: pending.transactionId,
        reason: 'preparation-cancelled', retainedBackup: true }), { flag: 'wx', mode: 0o600 });
      pending = null; outcome = revision = null; phase = 'idle';
    });
  }
  return { getState, prepare, issue, read, saveRevision, recover, backupPath, copyCommand, cancelPreparation };
}

module.exports = { createResolveTrialSession };
