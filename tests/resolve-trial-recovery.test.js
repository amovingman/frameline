'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareRenameTrial, issueRenameTrial, recordRenameTrialResult, readRenameTrialResult,
  prepareRenameTrialRecovery, readRenameTrialRecoveryCapture, issueRenameTrialRecovery,
  recordRenameTrialRecoveryResult } = require('../src/resolve-rename-trial');

async function fixture(t, guarded = true) {
  const destinationDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'trial-recovery-'));
  t.after(() => fs.rm(destinationDir, { recursive: true, force: true }));
  const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const beforeBytes = await fs.readFile(path.join(root, 'live-rename-before-schema3.json'));
  const effects = await fs.readFile(path.join(root, 'live-effects-enabled.json'));
  const afterBytes = await fs.readFile(path.join(root, 'live-rename-applied-schema3.json'));
  const trial = await prepareRenameTrial({ destinationDir, beforeBytes, afterBytes,
    disposableProjectName: 'Frameline Restore Probe', ...(guarded ? { effectObservationBytes: effects } : {}) });
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const file = path.join(trial.directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
  const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  const renamed = JSON.parse(effects); renamed.snapshot = JSON.parse(afterBytes);
  return { trial, issued, effects, renamed: JSON.stringify(renamed), beforeBytes };
}

function output(id, bytes, status) {
  const raw = bytes.toString('utf8').trimEnd(), parts = [];
  for (let n = 0; n < raw.length; n += 8192) parts.push(raw.slice(n, n + 8192));
  return parts.map((part, index) => status
    ? `FRAMELINE_RENAME_RECOVERY_CAPTURE_V1:${id}:${index + 1}:${part}`
    : `FRAMELINE_EFFECT_PART_V1:${id}:${index + 1}:${parts.length}:${part}`).concat(status
    ? [`FRAMELINE_RENAME_RECOVERY_RESULT_V1:${id}:${status}`] : []).join('\n');
}

async function inspected(context, bytes) {
  const recovery = await prepareRenameTrialRecovery({ directory: context.trial.directory });
  const classification = await readRenameTrialRecoveryCapture({ directory: context.trial.directory,
    attemptId: recovery.attemptId, consoleOutput: output(recovery.attemptId, bytes) });
  return { ...recovery, ...classification };
}

test('persistent recovery barrier retires original issuance and normal result recording', async t => {
  const context = await fixture(t), { trial, effects, beforeBytes } = context;
  const recovery = await prepareRenameTrialRecovery({ directory: trial.directory });
  assert.equal(recovery.transactionId, trial.transactionId);
  assert.equal(recovery.backup.archiveVerified, true);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }), /trial-recovery-active/);
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back',
    snapshotBytes: beforeBytes, effectObservationBytes: effects }), /trial-recovery-active/);
  assert.equal((await fs.stat(path.join(trial.directory, 'recovery-started.json'))).mode & 0o777, 0o600);
});

test('requires recovery-capable guarded issuance, an unchanged archive, and no completed result', async t => {
  const legacy = await fixture(t, false);
  await assert.rejects(prepareRenameTrialRecovery({ directory: legacy.trial.directory }), /does-not-support/);
  const context = await fixture(t), filename = path.join(context.trial.directory, 'issued.json');
  const issued = JSON.parse(await fs.readFile(filename)); delete issued.recoveryVersion;
  await fs.writeFile(filename, JSON.stringify(issued));
  await assert.rejects(prepareRenameTrialRecovery({ directory: context.trial.directory }), /does-not-support/);
  await assert.rejects(fs.stat(path.join(context.trial.directory, 'recovery-started.json')), { code: 'ENOENT' });
  const damaged = await fixture(t); await fs.appendFile(damaged.trial.backupPath, 'changed');
  await assert.rejects(prepareRenameTrialRecovery({ directory: damaged.trial.directory }), /export-hash-mismatch/);
  const completed = await fixture(t);
  await recordRenameTrialResult({ directory: completed.trial.directory, status: 'rolled-back',
    snapshotBytes: completed.beforeBytes, effectObservationBytes: completed.effects });
  await assert.rejects(prepareRenameTrialRecovery({ directory: completed.trial.directory }), /already-completed/);
});

test('fresh capture classifies exact source and rejects mixed transfers before issuing any action', async t => {
  const context = await fixture(t);
  const recovery = await prepareRenameTrialRecovery({ directory: context.trial.directory });
  const args = { directory: context.trial.directory, attemptId: recovery.attemptId };
  await assert.rejects(issueRenameTrialRecovery(args), { code: 'ENOENT' });
  await assert.rejects(readRenameTrialRecoveryCapture({ ...args, consoleOutput: output('0'.repeat(32), context.effects) }));
  await assert.rejects(readRenameTrialRecoveryCapture({ ...args, consoleOutput: output(recovery.attemptId, context.effects).split('\n').slice(1).join('\n') }));
  assert.equal((await readRenameTrialRecoveryCapture({ ...args, consoleOutput: output(recovery.attemptId, context.effects) })).classification, 'source');
  assert.equal((await issueRenameTrialRecovery(args)).operation, 'verify-source');
});

test('diverged effects or project identity cannot authorize an automatic reverse rename', async t => {
  for (const kind of ['effect', 'project']) {
    const context = await fixture(t), observation = JSON.parse(context.effects);
    if (kind === 'effect') observation.items.flatMap(item => item.effects)[0].enabled = false;
    else observation.snapshot.project_id = 'other-project';
    const recovery = await inspected(context, JSON.stringify(observation));
    assert.equal(recovery.classification, 'diverged');
    await assert.rejects(issueRenameTrialRecovery({ directory: context.trial.directory, attemptId: recovery.attemptId }), /manual-recovery-required/);
    await assert.rejects(fs.stat(path.join(context.trial.directory, 'recovery', recovery.attemptId, 'issued.json')), { code: 'ENOENT' });
  }
});

test('records separately verified source after interruption while retaining partial original artifacts', async t => {
  const context = await fixture(t);
  await fs.writeFile(path.join(context.trial.directory, 'result-snapshot.json'), 'interrupted original artifact', { mode: 0o600 });
  const recovery = await inspected(context, context.effects);
  const args = { directory: context.trial.directory, attemptId: recovery.attemptId };
  await issueRenameTrialRecovery(args);
  const consoleOutput = output(recovery.attemptId, context.effects, 'source-verified');
  const recorded = await recordRenameTrialRecoveryResult({ ...args, consoleOutput });
  assert.equal(recorded.completed, true);
  assert.equal(recorded.result.status, 'source-verified');
  assert.equal(recorded.result.recovery.operation, 'verify-source');
  assert.equal(recorded.result.effectObservation.sourceSha256, recorded.result.effectObservation.resultingSha256);
  assert.deepEqual((await readRenameTrialResult(context.trial.directory)).snapshot, JSON.parse(context.beforeBytes));
  assert.equal(await fs.readFile(path.join(context.trial.directory, 'result-snapshot.json'), 'utf8'), 'interrupted original artifact');
  assert.deepEqual(await recordRenameTrialRecoveryResult({ ...args, consoleOutput }), recorded);
  await assert.rejects(prepareRenameTrialRecovery({ directory: context.trial.directory }), /already-completed/);
});

test('accepts a restored result only for the exact reverse operation and original full observation', async t => {
  const context = await fixture(t), recovery = await inspected(context, context.renamed);
  assert.equal(recovery.classification, 'renamed');
  const args = { directory: context.trial.directory, attemptId: recovery.attemptId };
  assert.equal((await issueRenameTrialRecovery(args)).operation, 'restore-name');
  await assert.rejects(recordRenameTrialRecoveryResult({ ...args, consoleOutput: output(recovery.attemptId, context.effects, 'source-verified') }), /result-mismatch/);
  await assert.rejects(recordRenameTrialRecoveryResult({ ...args, consoleOutput: output(recovery.attemptId, context.renamed, 'restored') }), /result-mismatch/);
  const changed = JSON.parse(context.effects); changed.items.flatMap(item => item.effects)[0].enabled = false;
  await assert.rejects(recordRenameTrialRecoveryResult({ ...args, consoleOutput: output(recovery.attemptId, JSON.stringify(changed), 'restored') }), /result-mismatch/);
  const recorded = await recordRenameTrialRecoveryResult({ ...args, consoleOutput: output(recovery.attemptId, context.effects, 'restored') });
  assert.equal(recorded.result.status, 'restored');
  const resultPath = path.join(context.trial.directory, 'recovery-result.json');
  const altered = JSON.parse(await fs.readFile(resultPath)); altered.recovery.operation = 'verify-source';
  await fs.writeFile(resultPath, JSON.stringify(altered));
  await assert.rejects(readRenameTrialResult(context.trial.directory), /binding-mismatch/);
});

test('a new inspection retires previous capture/action attempts across desktop sessions', async t => {
  const context = await fixture(t), first = await inspected(context, context.renamed);
  const old = { directory: context.trial.directory, attemptId: first.attemptId };
  await issueRenameTrialRecovery(old);
  const next = await prepareRenameTrialRecovery({ directory: context.trial.directory });
  assert.notEqual(first.attemptId, next.attemptId);
  await assert.rejects(issueRenameTrialRecovery(old), /attempt-retired/);
  await assert.rejects(readRenameTrialRecoveryCapture({ ...old, consoleOutput: output(first.attemptId, context.effects) }), /attempt-retired/);
  await assert.rejects(recordRenameTrialRecoveryResult({ ...old, consoleOutput: output(first.attemptId, context.effects, 'restored') }), /attempt-retired/);
  assert.equal((await fs.stat(path.join(context.trial.directory, 'recovery', first.attemptId, 'retired.json'))).mode & 0o777, 0o600);
});

test('failed recovery retains its observation, allows a new inspection, and creates no final outcome', async t => {
  const context = await fixture(t), recovery = await inspected(context, context.renamed);
  const args = { directory: context.trial.directory, attemptId: recovery.attemptId };
  await issueRenameTrialRecovery(args);
  const failed = await recordRenameTrialRecoveryResult({ ...args, consoleOutput: output(recovery.attemptId, context.renamed, 'recovery-required') });
  assert.equal(failed.completed, false);
  await assert.rejects(readRenameTrialResult(context.trial.directory), { code: 'ENOENT' });
  const next = await inspected(context, context.effects);
  await issueRenameTrialRecovery({ directory: context.trial.directory, attemptId: next.attemptId });
  const final = await recordRenameTrialRecoveryResult({ directory: context.trial.directory, attemptId: next.attemptId,
    consoleOutput: output(next.attemptId, context.effects, 'source-verified') });
  assert.equal(final.completed, true);
  assert.ok((await fs.stat(path.join(context.trial.directory, 'recovery', recovery.attemptId, 'failure-effects.json'))).isFile());
});

test('changed receipts, symlinked observations, or backup damage prevent recovery issuance', async t => {
  const context = await fixture(t), recovery = await inspected(context, context.renamed);
  const args = { directory: context.trial.directory, attemptId: recovery.attemptId };
  const folder = path.join(context.trial.directory, 'recovery', recovery.attemptId);
  const filename = path.join(folder, 'inspection-record.json');
  const original = await fs.readFile(filename);
  const changed = JSON.parse(original); changed.classification = 'source';
  await fs.writeFile(filename, JSON.stringify(changed));
  await assert.rejects(issueRenameTrialRecovery(args), /binding-mismatch/);
  await fs.writeFile(filename, original);
  const observation = path.join(folder, 'inspection.json'), retained = `${observation}.retained`;
  await fs.rename(observation, retained); await fs.symlink(retained, observation);
  await assert.rejects(issueRenameTrialRecovery(args));
  await fs.unlink(observation); await fs.rename(retained, observation);
  await fs.appendFile(context.trial.backupPath, 'changed');
  await assert.rejects(issueRenameTrialRecovery(args), /export-hash-mismatch/);
  await assert.rejects(fs.stat(path.join(folder, 'issued.json')), { code: 'ENOENT' });
});
