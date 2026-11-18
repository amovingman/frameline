'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialConsoleResult,
  readRenameTrialResult, prepareRenameTrialRecovery, readRenameTrialRecoveryCapture,
  issueRenameTrialRecovery, recordRenameTrialRecoveryResult, cancelPreparedRenameTrial,
  validatePrivateTrialDirectory } = require('./resolve-rename-trial');
const { discoverRenameTrials } = require('./resolve-trial-discovery');
const { saveRenameTrialRevision } = require('./resolve-trial-history');
const { createResolveRevisionManifest } = require('./resolve-revision-manifest');
const { compareResolveRevisionManifests } = require('./resolve-revision-comparison');
const { inspectResolveProjectExport } = require('./resolve-project-export');
const { createEffectCaptureCommand, readEffectConsoleResult } = require('./resolve-effect-console');
const { parseEffectObservation, describeEffectCoverage } = require('./resolve-effect-observation');
const { resolveReviewedRename } = require('./resolve-rename-review');
const { createHash } = require('node:crypto');

function createResolveTrialSession({ enabled = false, directory, store, getReview, clipboard } = {}) {
  let pending = null, phase = 'idle', error = null, busy = false, outcome = null, revision = null;
  let discovery = { ready: false, items: [], scanned: 0, total: 0, hasMore: false, error: null };
  let discoveryCursor = null, discovered = new Map();
  function getState() {
    return { enabled, phase, busy, transactionId: pending?.transactionId || null, projectName: pending?.projectName || null,
      captureId: pending?.captureId || null, effectGuard: pending?.effectGuard || null,
      recovery: pending?.attemptId ? { attemptId: pending.attemptId,
        classification: pending.classification || null, operation: pending.operation || null } : null,
      backup: pending?.backup || null, outcome: outcome ? { status: outcome.status,
        snapshotSha256: outcome.resultingSnapshotSha256, auditHash: outcome.review?.auditHash || null,
        effectObservation: outcome.effectObservation || null } : null,
      revisionId: revision?.revisionId || null, branch: pending?.target?.branch || null, error,
      discovery: { ...discovery, items: discovery.items.map(item => ({ ...item })) } };
  }
  async function refreshDiscovery(append = false) {
    return run(async () => {
      if (typeof append !== 'boolean' || (append && !discovery.hasMore)) throw new Error('invalid-discovery-page');
      try {
        const page = await discoverRenameTrials({ directory, store, cursor: append ? discoveryCursor : null });
        if (!append) discovered = new Map();
        for (const [id, selection] of page.selections) discovered.set(id, selection);
        const items = new Map((append ? discovery.items : []).map(item => [item.recordId, item]));
        for (const item of page.items) items.set(item.recordId, item);
        discovery = { ready: true, items: [...items.values()], scanned: (append ? discovery.scanned : 0) + page.scanned,
          total: page.total, hasMore: page.hasMore, error: null };
        discoveryCursor = page.cursor;
      } catch {
        discovery = { ...discovery, ready: true, error: 'Retained drill records could not be inspected. Keep the records and retry.' };
      }
    });
  }
  function initialize() { return discovery.ready ? Promise.resolve(getState()) : refreshDiscovery(); }
  function forgetDiscovered(transactionId) {
    for (const item of discovery.items.filter(value => value.transactionId === transactionId)) discovered.delete(item.recordId);
    discovery.items = discovery.items.filter(value => value.transactionId !== transactionId);
  }
  async function recoverDiscovered(recordId) {
    const selection = discovered.get(recordId);
    if (!selection || selection.action !== 'recover') return run(async () => { throw new Error('invalid-discovered-trial'); });
    return recover(selection.directory);
  }
  async function cancelDiscovered(recordId) {
    return run(async () => {
      const selection = discovered.get(recordId);
      if (!['idle', 'saved'].includes(phase) || selection?.action !== 'cancel') throw new Error('trial-not-ready');
      const cancelled = await cancelPreparedRenameTrial({ directory: selection.directory });
      forgetDiscovered(cancelled.transactionId);
    });
  }
  async function discoveredRecordPath(recordId) {
    const selection = discovered.get(recordId);
    if (!enabled || !selection || selection.action === 'none') throw new Error('invalid-discovered-trial');
    await validatePrivateTrialDirectory(directory);
    await validatePrivateTrialDirectory(selection.directory);
    return selection.directory;
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
        : failure.message === 'richer-capture-required' ? 'New drills require clip properties and track state. Run the newly copied capture and read its output again.'
        : failure.message === 'incomplete-property-capture' ? 'Some clip properties or track states could not be read. Keep the project unchanged and retry the capture before preparing a drill.'
        : phase === 'effect-command' ? 'The effect capture could not be verified. Run the copied capture in Resolve’s Lua Console, copy all output, and read it again.'
        : failure.message === 'trial-does-not-support-interrupted-recovery' ? 'This older or unsupported drill cannot retire its copied command. Keep the backup and inspect the disposable project manually.'
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
      const capture = await createEffectCaptureCommand(projectName, { includeProperties: true });
      pending = { ...capture, projectName, auditHash: review.audit.auditHash };
      outcome = revision = null; phase = 'effect-command';
      clipboard.writeText(capture.command);
    });
  }
  async function prepareBackup() {
    const review = await getReview();
    if (review.audit.auditHash !== pending.auditHash) throw new Error('complete-current-review-required');
    const effectObservationBytes = readEffectConsoleResult({ captureId: pending.captureId, output: clipboard.readText() });
    const observed = parseEffectObservation(effectObservationBytes);
    const coverage = describeEffectCoverage(observed);
    if (coverage.schemaVersion !== 2) throw new Error('richer-capture-required');
    if (coverage.unavailablePropertyReads || coverage.unavailableTrackStateReads
      || observed.items.some(item => Object.keys(item.properties).length === 0)) throw new Error('incomplete-property-capture');
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
    pending = { ...trial, target, projectName: before.snapshot.project_name, auditHash: review.audit.auditHash,
      effectGuard: { sourceSha256: createHash('sha256').update(effectObservationBytes).digest('hex'), coverage } };
    outcome = revision = null; phase = 'backup-command';
    clipboard.writeText(trial.command);
  }
  async function issue() {
    return run(async () => {
      if (phase === 'recovery-ready') {
        const issued = await issueRenameTrialRecovery({ directory: pending.directory, attemptId: pending.attemptId });
        pending.command = issued.command; pending.operation = issued.operation;
        phase = 'recovery-command'; clipboard.writeText(issued.command); return;
      }
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
      if (phase === 'recovery-capture') {
        const inspection = await readRenameTrialRecoveryCapture({ directory: pending.directory,
          attemptId: pending.attemptId, consoleOutput: clipboard.readText() });
        pending.classification = inspection.classification;
        phase = inspection.classification === 'diverged' ? 'recovery-required' : 'recovery-ready'; return;
      }
      if (phase === 'recovery-command') {
        const recorded = await recordRenameTrialRecoveryResult({ directory: pending.directory,
          attemptId: pending.attemptId, consoleOutput: clipboard.readText() });
        if (recorded.completed) { outcome = recorded.result; phase = 'verified'; }
        else phase = 'recovery-required';
        return;
      }
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
      forgetDiscovered(pending.transactionId);
    });
  }
  async function recover(selected) {
    return run(async () => {
      if (pending && phase !== 'saved') throw new Error('trial-already-active');
      if (typeof selected !== 'string' || path.dirname(selected) !== path.resolve(directory)) throw new Error('invalid-trial-directory');
      let result, snapshot, observationCoverage;
      try { ({ result, snapshot, observationCoverage } = await readRenameTrialResult(selected)); }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      const handle = await fs.open(path.join(selected, 'history-target.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let target;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 1024) throw new Error('invalid-history-target');
        target = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      if (typeof target.branch !== 'string' || typeof target.expectedHeadId !== 'string') throw new Error('invalid-history-target');
      if (!result) {
        const recovery = await prepareRenameTrialRecovery({ directory: selected });
        pending = { ...recovery, target }; outcome = revision = null;
        phase = 'recovery-capture'; clipboard.writeText(recovery.command); return;
      }
      pending = { directory: selected, transactionId: result.transactionId, backup: result.backup,
        backupPath: result.backupPath, target, projectName: snapshot.project_name, auditHash: result.review?.auditHash,
        ...(result.recovery ? { attemptId: result.recovery.attemptId, operation: result.recovery.operation } : {}),
        effectGuard: result.effectObservation ? { sourceSha256: result.effectObservation.sourceSha256, coverage: observationCoverage } : null };
      outcome = result; revision = null; phase = 'verified';
    });
  }
  async function inspectRecovery() {
    return run(async () => {
      if (!['recovery-capture', 'recovery-ready', 'recovery-command', 'recovery-required'].includes(phase)) throw new Error('trial-not-recovering');
      const recovery = await prepareRenameTrialRecovery({ directory: pending.directory });
      pending = { ...recovery, target: pending.target }; outcome = revision = null;
      phase = 'recovery-capture'; clipboard.writeText(recovery.command);
    });
  }
  async function backupPath() {
    if (!enabled || !pending?.backup) throw new Error('verified-backup-required');
    await inspectResolveProjectExport(pending.backupPath, pending.backup.sha256);
    return pending.backupPath;
  }
  async function copyCommand() {
    return run(async () => {
      if (!['effect-command', 'backup-command', 'rollback-command', 'recovery-capture', 'recovery-command'].includes(phase)
        || !pending?.command) throw new Error('trial-command-unavailable');
      clipboard.writeText(pending.command);
    });
  }
  async function cancelPreparation() {
    return run(async () => {
      if (phase === 'effect-command') {
        pending = null; outcome = revision = null; phase = 'idle'; return;
      }
      if (phase !== 'backup-command') throw new Error('trial-cannot-cancel-issued-command');
      await cancelPreparedRenameTrial({ directory: pending.directory });
      forgetDiscovered(pending.transactionId);
      pending = null; outcome = revision = null; phase = 'idle';
    });
  }
  return { getState, initialize, refreshDiscovery, recoverDiscovered, cancelDiscovered, discoveredRecordPath,
    prepare, issue, read, saveRevision, recover, inspectRecovery, backupPath, copyCommand, cancelPreparation };
}

module.exports = { createResolveTrialSession };
