'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { executeCommand, library } = require('./fixtures/resolve-editor-mock/execute-command');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialConsoleResult, readRenameTrialResult,
  prepareRenameTrialRecovery, readRenameTrialRecoveryCapture, issueRenameTrialRecovery,
  recordRenameTrialRecoveryResult, exportRenameTrialAudit,
  recordRenameTrialFileResult, recordRenameTrialRecoveryFileResult } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { validatePortableTrialAudit } = require('../src/resolve-portable-trial-audit');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveObservationManifest } = require('../src/resolve-revision-manifest');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');
const available = syncFs.existsSync(library), skip = available ? false : 'Installed vendor LuaJIT is required for emitted-command execution';
const fixturePath = path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json');

async function fixture(t, { forced = false, resultTransport, unicode = false } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-exact-command-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  if (unicode) for (const timeline of before.snapshot.timelines) for (const [index, item] of timeline.items.entries()) {
    item.name = `Café "夜🎬" ${index} ${'界'.repeat(300)}`;
  }
  const after = structuredClone(before);
  after.snapshot.timelines[0].items[0].name = unicode ? 'Reviewed "Été" 🎞️ 夜' : 'Exactly reviewed mock rename';
  const sources = { base: JSON.stringify(before.snapshot), local: JSON.stringify(before.snapshot), incoming: JSON.stringify(after.snapshot) };
  const plan = createResolvePreviewPlan(sources), audit = createResolveDecisionAudit(plan, sources, []);
  const trial = await prepareReviewedRenameTrial({ sources, plan, audit, destinationDir: root,
    disposableProjectName: before.snapshot.project_name, effectObservationBytes: JSON.stringify(before) });
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const filename = path.join(trial.directory, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
  const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: forced,
    ...(resultTransport ? { resultTransport } : {}) });
  return { trial, issued, before, after, root };
}
async function inspect(context, observation) {
  const recovery = await prepareRenameTrialRecovery({ directory: context.trial.directory });
  // Execute the exact read-only capture command against the same API boundary.
  const capture = executeCommand(recovery.command, observation); assert.equal(capture.ok, true, capture.error);
  const status = await readRenameTrialRecoveryCapture({ directory: context.trial.directory, attemptId: recovery.attemptId,
    consoleOutput: capture.consoleOutput });
  return { ...recovery, ...status };
}
const name = value => value.snapshot.timelines[0].items[0].name;

test('exact non-forced command renames, saves, closes and loads the saved state before applied acknowledgment', { skip }, async t => {
  const f = await fixture(t), run = executeCommand(f.issued.command, f.before);
  assert.equal(run.ok, true, run.error); assert.deepEqual(run.observation, f.after); assert.deepEqual(run.saved, f.after);
  assert.equal(run.counters.setName, 1); assert.equal(run.counters.save, 1); assert.equal(run.counters.close, 1); assert.equal(run.counters.load, 1);
  const result = await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput });
  assert.equal(result.status, 'applied'); assert.equal(result.validation, 'observed-fields-only');
  assert.equal((await readRenameTrialResult(f.trial.directory)).result.status, 'applied');
  validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
});

test('exact forced-failure command executes forward and reverse rename with two independent save/reopen cycles', { skip }, async t => {
  const f = await fixture(t, { forced: true }), run = executeCommand(f.issued.command, f.before);
  assert.equal(run.ok, true, run.error); assert.deepEqual(run.observation, f.before); assert.deepEqual(run.saved, f.before);
  for (const key of ['setName', 'save', 'close', 'load']) assert.equal(run.counters[key], 2, key);
  assert.equal((await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput })).status, 'rolled-back');
});

test('unacknowledged successful command recovers through explicit reverse-name action in a fresh Lua runtime', { skip }, async t => {
  const f = await fixture(t), forward = executeCommand(f.issued.command, f.before);
  assert.equal(forward.ok, true, forward.error); assert.deepEqual(forward.saved, f.after);
  // Discard the real command output: no normal result file has been recorded.
  await assert.rejects(fs.stat(path.join(f.trial.directory, 'result.json')), { code: 'ENOENT' });
  const inspected = await inspect(f, forward.saved); assert.equal(inspected.classification, 'renamed');
  const original = executeCommand(f.issued.command, forward.saved);
  assert.equal(original.ok, false); assert.equal(original.counters.editor, 0); assert.equal(original.counters.setName, 0);
  const args = { directory: f.trial.directory, attemptId: inspected.attemptId }, issued = await issueRenameTrialRecovery(args);
  assert.equal(issued.operation, 'restore-name');
  const restored = executeCommand(issued.command, forward.saved);
  assert.equal(restored.ok, true, restored.error); assert.deepEqual(restored.observation, f.before); assert.deepEqual(restored.saved, f.before);
  for (const key of ['setName', 'save', 'close', 'load']) assert.equal(restored.counters[key], 1, key);
  const recorded = await recordRenameTrialRecoveryResult({ ...args, consoleOutput: restored.consoleOutput });
  assert.equal(recorded.completed, true); assert.equal(recorded.result.status, 'restored');
  validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
  assert.deepEqual(await recordRenameTrialRecoveryResult({ ...args, consoleOutput: restored.consoleOutput }), recorded);
  const replay = executeCommand(issued.command, f.before);
  assert.equal(replay.ok, false); assert.equal(replay.counters.editor, 0); assert.equal(replay.counters.setName, 0);
});

test('never-run non-forced issuance verifies saved source without performing a rename', { skip }, async t => {
  const f = await fixture(t), inspected = await inspect(f, f.before); assert.equal(inspected.classification, 'source');
  const args = { directory: f.trial.directory, attemptId: inspected.attemptId }, issued = await issueRenameTrialRecovery(args);
  assert.equal(issued.operation, 'verify-source');
  const run = executeCommand(issued.command, f.before); assert.equal(run.ok, true, run.error);
  assert.equal(run.counters.setName, 0); for (const key of ['save', 'close', 'load']) assert.equal(run.counters[key], 1);
  assert.deepEqual(run.saved, f.before);
  const recorded = await recordRenameTrialRecoveryResult({ ...args, consoleOutput: run.consoleOutput });
  assert.equal(recorded.result.status, 'source-verified'); validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
});

test('stale represented source is refused before SetName and divergent recovery offers no mutation', { skip }, async t => {
  const f = await fixture(t), changed = structuredClone(f.before); changed.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  const run = executeCommand(f.issued.command, changed); assert.equal(run.ok, false); assert.match(run.error, /Stale source/);
  assert.equal(run.counters.setName, 0); assert.deepEqual(run.saved, changed);
  const inspected = await inspect(f, changed); assert.equal(inspected.classification, 'diverged');
  await assert.rejects(issueRenameTrialRecovery({ directory: f.trial.directory, attemptId: inspected.attemptId }), /manual-recovery-required/);
});

test('save and close failures roll back; reopen failure retains renamed saved state without a false result', { skip }, async t => {
  for (const options of [{ failSaveAt: 1 }, { failCloseAt: 1 }, { failSetNameAt: 1 }]) {
    const f = await fixture(t), run = executeCommand(f.issued.command, f.before, options);
    assert.equal(run.ok, true, run.error); assert.deepEqual(run.saved, f.before);
    assert.equal((await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput })).status, 'rolled-back');
  }
  const f = await fixture(t), failed = executeCommand(f.issued.command, f.before, { failLoadAt: 1 });
  assert.equal(failed.ok, false); assert.equal(failed.opened, false); assert.deepEqual(failed.saved, f.after);
  await assert.rejects(recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: failed.consoleOutput }));
  const inspected = await inspect(f, failed.saved); assert.equal(inspected.classification, 'renamed');
});

test('collateral Pan or effect changes never become applied or successfully restored observations', { skip }, async t => {
  for (const collateral of ['pan', 'effect']) {
    const f = await fixture(t), run = executeCommand(f.issued.command, f.before, { collateral });
    assert.equal(run.ok, true, run.error); assert.equal(name(run.observation), name(f.before));
    assert.notDeepEqual(run.observation, f.before);
    const result = await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput });
    assert.equal(result.status, 'recovery-required');
  }
});

test('recovery rechecks exact represented source before SetName and refuses tampered inspection bytes', { skip }, async t => {
  const f = await fixture(t), inspected = await inspect(f, f.after);
  const args = { directory: f.trial.directory, attemptId: inspected.attemptId }, issued = await issueRenameTrialRecovery(args);
  const changed = structuredClone(f.after); changed.items[0].properties.Pan.decimal = '1.3250000000000000e+01';
  const stale = executeCommand(issued.command, changed);
  assert.equal(stale.ok, false); assert.match(stale.error, /Recovery source changed/); assert.equal(stale.counters.setName, 0);
  const filename = path.join(f.trial.directory, 'recovery', inspected.attemptId, 'inspection.json');
  await fs.appendFile(filename, ' ');
  const tampered = executeCommand(issued.command, f.after);
  assert.equal(tampered.ok, false); assert.equal(tampered.counters.editor, 0); assert.equal(tampered.counters.setName, 0);
});

test('recovery save/close/load failures never acknowledge a restored transaction', { skip }, async t => {
  for (const options of [{ failSaveAt: 1 }, { failCloseAt: 1 }, { failLoadAt: 1 }]) {
    const f = await fixture(t), inspected = await inspect(f, f.after);
    const args = { directory: f.trial.directory, attemptId: inspected.attemptId }, issued = await issueRenameTrialRecovery(args);
    const run = executeCommand(issued.command, f.after, options);
    if (options.failLoadAt) {
      assert.equal(run.ok, false); assert.equal(run.opened, false); assert.deepEqual(run.saved, f.before);
      await assert.rejects(recordRenameTrialRecoveryResult({ ...args, consoleOutput: run.consoleOutput }));
    } else {
      assert.equal(run.ok, true, run.error);
      const result = await recordRenameTrialRecoveryResult({ ...args, consoleOutput: run.consoleOutput });
      assert.equal(result.completed, false); assert.equal(result.status, 'recovery-required');
      assert.deepEqual(run.saved, options.failSaveAt ? f.after : f.before);
    }
    await assert.rejects(fs.stat(path.join(f.trial.directory, 'recovery-result.json')), { code: 'ENOENT' });
  }
});

test('partial result artifacts and altered issued mode reject copied commands before editor access in fresh VMs', { skip }, async t => {
  const f = await fixture(t);
  for (const name of ['result-snapshot.json', 'result-effects.json', 'recovery-result.json']) {
    const filename = path.join(f.trial.directory, name); await fs.writeFile(filename, 'interrupted', { mode: 0o600 });
    // bmd filesystem checks remain available even on the real Console surface
    // where io is nil. No host IO capability is granted to the command here.
    const run = executeCommand(f.issued.command, f.before, { noIo: true });
    assert.equal(run.ok, false); assert.equal(run.counters.editor, 0); assert.equal(run.counters.setName, 0);
    await fs.unlink(filename);
  }
  const filename = path.join(f.trial.directory, 'issued.json'), original = await fs.readFile(filename), modified = JSON.parse(original);
  modified.forceFailure = true; await fs.writeFile(filename, JSON.stringify(modified), { mode: 0o600 });
  const run = executeCommand(f.issued.command, f.before);
  assert.equal(run.ok, false); assert.equal(run.counters.editor, 0); assert.equal(run.counters.setName, 0);
});

test('Fusion reader failures fail closed and close opened files while Console io remains unavailable', { skip }, async t => {
  const f = await fixture(t);
  for (const options of [{ noFusion: true }, { readerSizeDelta: 1 }, { readerNoProgress: true },
    { readerStripsNewline: true }, { readerCloseFailure: true }]) {
    const run = executeCommand(f.issued.command, f.before, options);
    assert.equal(run.ok, false); assert.equal(run.counters.editor, 0); assert.equal(run.counters.setName, 0);
    assert.equal(run.counters.fileClose, run.counters.fileOpen);
    assert.deepEqual(run.saved, f.before);
  }
});

test('actual applied and restored command results save idempotent audited history with pinned-head protection', { skip }, async t => {
  for (const recovery of [false, true]) {
    const f = await fixture(t), run = executeCommand(f.issued.command, f.before);
    assert.equal(run.ok, true, run.error);
    if (recovery) {
      const inspection = await inspect(f, run.saved), args = { directory: f.trial.directory, attemptId: inspection.attemptId };
      const issued = await issueRenameTrialRecovery(args), restored = executeCommand(issued.command, run.saved);
      assert.equal(restored.ok, true, restored.error);
      await recordRenameTrialRecoveryResult({ ...args, consoleOutput: restored.consoleOutput });
    } else await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput });
    const store = createLocalMetadataStore(path.join(f.root, 'metadata')),
      project = await store.getResolveProjectId(f.before.snapshot.project_id, f.before.snapshot.project_name),
      parent = await store.saveRevision(project.id, createResolveObservationManifest(f.before), 'Before exact command');
    const target = { directory: f.trial.directory, store, branch: 'main', expectedHeadId: parent.id };
    const link = await saveRenameTrialRevision(target);
    assert.equal(link.status, recovery ? 'restored' : 'applied');
    assert.deepEqual(await saveRenameTrialRevision(target), link);
    const rows = await store.listRevisions(project.id, 'main'); assert.equal(rows.length, 2); assert.equal(rows[0].id, link.revisionId);
    const record = await store.getRevision(project.id, link.revisionId);
    validatePortableTrialAudit(record.manifest.transactionAudit);
    assert.equal(record.parentRevisionId, parent.id);
  }
  const f = await fixture(t), run = executeCommand(f.issued.command, f.before);
  await recordRenameTrialConsoleResult({ directory: f.trial.directory, consoleOutput: run.consoleOutput });
  const store = createLocalMetadataStore(path.join(f.root, 'metadata')),
    project = await store.getResolveProjectId(f.before.snapshot.project_id, f.before.snapshot.project_name),
    parent = await store.saveRevision(project.id, createResolveObservationManifest(f.before), 'Before exact command');
  await store.saveRevision(project.id, createResolveObservationManifest(f.before), 'Intervening saved observation', parent.id);
  await assert.rejects(saveRenameTrialRevision({ directory: f.trial.directory, store, branch: 'main', expectedHeadId: parent.id }), { code: 'revision-head-changed' });
  assert.equal((await store.listRevisions(project.id, 'main')).length, 2);
});

const transportPath = (f, attemptId = null) => path.join(f.trial.directory, ...(attemptId ? ['recovery', attemptId] : []), 'transport-output.json');

test('retained forward result survives actual emitted save/reopen with every Console result discarded', { skip }, async t => {
  const f = await fixture(t, { resultTransport: 'retained-file' });
  const run = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true });
  assert.equal(run.ok, true, run.error); assert.equal(run.consoleOutput, ''); assert.deepEqual(run.saved, f.after);
  assert.equal(run.counters.setName, 1); assert(run.counters.writeLine >= 2); assert(run.counters.flush >= 2);
  const filename = transportPath(f), bytes = await fs.readFile(filename);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600); assert(bytes.length > 0);
  const result = await recordRenameTrialFileResult({ directory: f.trial.directory });
  assert.equal(result.status, 'applied'); validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
  assert.deepEqual(await recordRenameTrialFileResult({ directory: f.trial.directory }), result);
  const replay = executeCommand(f.issued.command, f.after, { discardConsoleOnClose: true });
  assert.equal(replay.ok, false); assert.equal(replay.counters.editor, 0); assert.equal(replay.counters.setName, 0);
  assert.deepEqual(await fs.readFile(filename), bytes);
});

test('retained recovery acknowledges discarded restore output and refuses the retired forward receipt', { skip }, async t => {
  const f = await fixture(t, { resultTransport: 'retained-file' });
  const forward = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true });
  assert.equal(forward.ok, true, forward.error); assert.equal(forward.consoleOutput, '');
  const inspection = await inspect(f, forward.saved), args = { directory: f.trial.directory, attemptId: inspection.attemptId };
  await assert.rejects(recordRenameTrialFileResult({ directory: f.trial.directory }), /recovery-active/);
  const issued = await issueRenameTrialRecovery({ ...args, resultTransport: 'retained-file' });
  const restored = executeCommand(issued.command, forward.saved, { discardConsoleOnClose: true });
  assert.equal(restored.ok, true, restored.error); assert.equal(restored.consoleOutput, ''); assert.deepEqual(restored.saved, f.before);
  const receipt = await recordRenameTrialRecoveryFileResult(args); assert.equal(receipt.completed, true); assert.equal(receipt.result.status, 'restored');
  assert.deepEqual(await recordRenameTrialRecoveryFileResult(args), receipt); validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
  const bytes = await fs.readFile(transportPath(f, inspection.attemptId)), replay = executeCommand(issued.command, f.before);
  assert.equal(replay.ok, false); assert.equal(replay.counters.editor, 0); assert.equal(replay.counters.setName, 0);
  assert.deepEqual(await fs.readFile(transportPath(f, inspection.attemptId)), bytes);
});

test('retained transport establishes write/flush/close/readback before any SetName', { skip }, async t => {
  for (const options of [{ noWriter: true }, { writerWriteFailureAt: 1 }, { writerShortAt: 1 }, { writerFalseWriteAt: 1 },
    { writerFalseFlushAt: 1 }, { writerFlushFailureAt: 1 }, { writerCloseFailureAt: 1 }, { writerReadbackMismatch: true }]) {
    const f = await fixture(t, { resultTransport: 'retained-file' }), run = executeCommand(f.issued.command, f.before, options);
    assert.equal(run.ok, false); assert.equal(run.counters.setName, 0); assert.deepEqual(run.saved, f.before);
    assert.equal(run.counters.fileClose, run.counters.fileOpen);
    await assert.rejects(recordRenameTrialFileResult({ directory: f.trial.directory }));
    await assert.rejects(fs.stat(path.join(f.trial.directory, 'result.json')), { code: 'ENOENT' });
  }
});

test('missing, empty, truncated, oversized or foreign retained output cannot acknowledge an editor result', { skip }, async t => {
  for (const kind of ['missing', 'empty', 'partial', 'oversized', 'transaction', 'issued', 'token', 'mode', 'kind']) {
    const f = await fixture(t, { resultTransport: 'retained-file' }), run = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true });
    assert.equal(run.ok, true, run.error);
    const filename = transportPath(f), original = await fs.readFile(filename);
    if (kind === 'missing') await fs.unlink(filename);
    else if (kind === 'empty') await fs.truncate(filename, 0);
    else if (kind === 'partial') await fs.truncate(filename, Math.floor(original.length / 2));
    else if (kind === 'oversized') await fs.truncate(filename, 48 * 1024 * 1024 + 1);
    else {
      const value = JSON.parse(original);
      if (kind === 'transaction') value.transactionId = '0'.repeat(32);
      else if (kind === 'issued') value.issuedSha256 = '0'.repeat(64);
      else if (kind === 'token') value.transportToken = '0'.repeat(32);
      else if (kind === 'mode') value.forceFailure = !value.forceFailure;
      else value.kind = 'recovery';
      await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    }
    await assert.rejects(recordRenameTrialFileResult({ directory: f.trial.directory }));
    await assert.rejects(fs.stat(path.join(f.trial.directory, 'result.json')), { code: 'ENOENT' });
    await fs.writeFile(filename, original, { mode: 0o600 });
    assert.equal((await recordRenameTrialFileResult({ directory: f.trial.directory })).status, 'applied');
  }
});

test('started or partial retained transport refuses replay in a fresh Lua runtime', { skip }, async t => {
  for (const options of [{ writerShortAt: 2 }, { writerWriteFailureAt: 2 }, { writerOpenFailAt: 2 }]) {
    const f = await fixture(t, { resultTransport: 'retained-file' });
    const interrupted = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true, ...options });
    assert.equal(interrupted.ok, false); assert.equal(interrupted.counters.setName, 1); assert.deepEqual(interrupted.saved, f.after);
    assert.equal(interrupted.counters.writerOpen, 2);
    assert.equal(interrupted.counters.writeLine, options.writerOpenFailAt ? 1 : 2);
    await assert.rejects(recordRenameTrialFileResult({ directory: f.trial.directory }));
    const before = await fs.readFile(transportPath(f)), replay = executeCommand(f.issued.command, f.after);
    assert.equal(replay.ok, false); assert.equal(replay.counters.editor, 0); assert.equal(replay.counters.setName, 0);
    assert.deepEqual(await fs.readFile(transportPath(f)), before);
    const inspection = await inspect(f, interrupted.saved); assert.equal(inspection.classification, 'renamed');
  }
});

test('retained ready-state and issued transport descriptor substitutions refuse before editor access', { skip }, async t => {
  for (const kind of ['state', 'token']) {
    const f = await fixture(t, { resultTransport: 'retained-file' });
    const filename = path.join(f.trial.directory, kind === 'state' ? 'transport-state.json' : 'issued.json');
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (kind === 'state') value.unexpected = true;
    else value.resultTransport.token = '0'.repeat(32);
    await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    const run = executeCommand(f.issued.command, f.before);
    assert.equal(run.ok, false); assert.equal(run.counters.editor, 0); assert.equal(run.counters.setName, 0);
    assert.deepEqual(run.saved, f.before);
  }
});

test('complete retained final observations remain independently ACKable after final Lua flush/close/readback errors', { skip }, async t => {
  for (const options of [{ writerFalseFlushAt: 2 }, { writerCloseFailureAt: 2 }, { writerReadbackMismatchAt: 2 }]) {
    const f = await fixture(t, { resultTransport: 'retained-file' });
    const run = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true, ...options });
    assert.equal(run.ok, false); assert.equal(run.counters.setName, 1); assert.deepEqual(run.saved, f.after);
    assert.equal(run.counters.writeLine, 2);
    // A Lua reporting error is not proof that complete bytes failed to persist.
    // The host reopens/syncs and validates the exact final observation itself.
    const result = await recordRenameTrialFileResult({ directory: f.trial.directory });
    assert.equal(result.status, 'applied'); validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
  }
});

test('retained recovery rejects foreign attempt/issuance bindings and handles never-run source verification', { skip }, async t => {
  for (const kind of ['attempt', 'recovery-issued']) {
    const f = await fixture(t, { resultTransport: 'retained-file' });
    const inspection = await inspect(f, f.after), args = { directory: f.trial.directory, attemptId: inspection.attemptId };
    const issued = await issueRenameTrialRecovery({ ...args, resultTransport: 'retained-file' });
    const run = executeCommand(issued.command, f.after, { discardConsoleOnClose: true }); assert.equal(run.ok, true, run.error);
    const filename = transportPath(f, inspection.attemptId), original = await fs.readFile(filename), modified = JSON.parse(original);
    if (kind === 'attempt') modified.attemptId = '0'.repeat(32); else modified.recoveryIssuedSha256 = '0'.repeat(64);
    await fs.writeFile(filename, JSON.stringify(modified), { mode: 0o600 });
    await assert.rejects(recordRenameTrialRecoveryFileResult(args));
    await assert.rejects(fs.stat(path.join(f.trial.directory, 'recovery-result.json')), { code: 'ENOENT' });
    await fs.writeFile(filename, original, { mode: 0o600 });
    assert.equal((await recordRenameTrialRecoveryFileResult(args)).result.status, 'restored');
  }
  const f = await fixture(t, { resultTransport: 'retained-file' }), inspection = await inspect(f, f.before),
    args = { directory: f.trial.directory, attemptId: inspection.attemptId };
  const issued = await issueRenameTrialRecovery({ ...args, resultTransport: 'retained-file' });
  const noWriter = executeCommand(issued.command, f.before, { noWriter: true });
  assert.equal(noWriter.ok, false); assert.equal(noWriter.counters.setName, 0); assert.deepEqual(noWriter.saved, f.before);
  const run = executeCommand(issued.command, f.before, { discardConsoleOnClose: true });
  assert.equal(run.ok, true, run.error); assert.equal(run.consoleOutput, ''); assert.equal(run.counters.setName, 0);
  assert.equal((await recordRenameTrialRecoveryFileResult(args)).result.status, 'source-verified');
});

test('retained forced rollback records only the independently reopened original observation', { skip }, async t => {
  const f = await fixture(t, { forced: true, resultTransport: 'retained-file' });
  const run = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true });
  assert.equal(run.ok, true, run.error); assert.equal(run.consoleOutput, ''); assert.deepEqual(run.saved, f.before);
  for (const key of ['setName', 'save', 'close', 'load']) assert.equal(run.counters[key], 2, key);
  const result = await recordRenameTrialFileResult({ directory: f.trial.directory });
  assert.equal(result.status, 'rolled-back'); validatePortableTrialAudit(await exportRenameTrialAudit(f.trial.directory));
});

test('retained transport round-trips quoted Unicode observations across UTF-8 byte chunks and escaped marker newlines', { skip }, async t => {
  const f = await fixture(t, { resultTransport: 'retained-file', unicode: true });
  const run = executeCommand(f.issued.command, f.before, { discardConsoleOnClose: true });
  assert.equal(run.ok, true, run.error); assert.deepEqual(run.saved, f.after); assert.equal(run.consoleOutput, '');
  const bytes = await fs.readFile(transportPath(f)), envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert(envelope.output.includes('\n')); assert(envelope.output.includes('Café')); assert(envelope.output.includes('\\"'));
  const chunks = envelope.output.split('\n').filter(line => line.startsWith('FRAMELINE_RENAME_TRIAL_CAPTURE_V1:'));
  assert(chunks.length > 2);
  for (const line of chunks) {
    const payload = line.split(':').slice(3).join(':'), encoded = Buffer.from(payload);
    assert(encoded.length <= 8192); assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(encoded), payload);
    assert(!payload.includes('\ufffd'));
  }
  assert.equal((await recordRenameTrialFileResult({ directory: f.trial.directory })).status, 'applied');
  assert.deepEqual((await readRenameTrialResult(f.trial.directory)).snapshot, f.after.snapshot);
});
