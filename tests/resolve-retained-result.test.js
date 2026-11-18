'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareReviewedRenameTrial, issueRenameTrial, prepareRenameTrialRecovery, readRenameTrialRecoveryCapture,
  issueRenameTrialRecovery, recordRenameTrialFileResult, recordRenameTrialRecoveryFileResult,
  recordRetainedRenameTrialOutcomeIfComplete, readRenameTrialResult, describeRenameTrial, exportRenameTrialAudit,
  recordRenameTrialConsoleResult, recordRenameTrialResult, recordRenameTrialRecoveryResult } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { validatePortableTrialAudit } = require('../src/resolve-portable-trial-audit');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');
const fixtureRoot = path.join(__dirname, '../phase-0/resolve-xml-proof');

function output(marker, id, value, status) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value), parts = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(bytes.slice(offset, offset + 8192));
  return parts.map((part, index) => `${marker}_CAPTURE_V1:${id}:${index + 1}:${part}`).concat(`${marker}_RESULT_V1:${id}:${status}`).join('\n') + '\n';
}
function captureOutput(id, value) {
  const bytes = JSON.stringify(value), parts = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(bytes.slice(offset, offset + 8192));
  return parts.map((part, index) => `FRAMELINE_EFFECT_PART_V1:${id}:${index + 1}:${parts.length}:${part}`).join('\n');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'retained-result-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'live-properties-enabled.json'))), after = structuredClone(before);
  after.snapshot.timelines[0].items[0].name = 'Retained verified rename';
  const sources = { base: JSON.stringify(before.snapshot), local: JSON.stringify(before.snapshot), incoming: JSON.stringify(after.snapshot) };
  const plan = createResolvePreviewPlan(sources), audit = createResolveDecisionAudit(plan, sources, []);
  const trial = await prepareReviewedRenameTrial({ sources, plan, audit, effectObservationBytes: JSON.stringify(before), destinationDir: root,
    disposableProjectName: before.snapshot.project_name, experimentMode: 'rename-verify' });
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const filename = path.join(trial.directory, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
  await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify({ branch: 'main', expectedHeadId: randomUUID() }), { mode: 0o600 });
  const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: false, resultTransport: 'retained-file' });
  return { trial, issued, before, after };
}
async function packet(folder, consoleOutput) {
  const filename = path.join(folder, 'transport-state.json'), state = JSON.parse(await fs.readFile(filename)); state.state = 'started';
  await fs.writeFile(filename, `${JSON.stringify(state)}\n`); const { state: _state, ...metadata } = state;
  const result = { ...metadata, output: consoleOutput }; await fs.writeFile(path.join(folder, 'transport-output.json'), `${JSON.stringify(result)}\n`);
  return result;
}
async function recovery(f, observation = f.after) {
  const request = await prepareRenameTrialRecovery({ directory: f.trial.directory });
  await readRenameTrialRecoveryCapture({ directory: f.trial.directory, attemptId: request.attemptId, consoleOutput: captureOutput(request.attemptId, observation) });
  await issueRenameTrialRecovery({ directory: f.trial.directory, attemptId: request.attemptId, resultTransport: 'retained-file' });
  return { ...request, folder: path.join(f.trial.directory, 'recovery', request.attemptId) };
}

test('retained forward slots remain unacknowledged until an exact complete result is explicitly read, then retry idempotently', async t => {
  const f = await fixture(t), directory = f.trial.directory;
  assert.equal(f.issued.resultTransport, 'retained-file'); assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'issued.json'))).recoveryVersion, 3);
  assert.equal((await fs.stat(path.join(directory, 'transport-state.json'))).mode & 0o777, 0o600);
  assert.equal(await recordRetainedRenameTrialOutcomeIfComplete({ directory }), null);
  await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-incomplete' });
  await packet(directory, output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied'));
  const description = await describeRenameTrial(directory); assert.equal(description.transportOutputAvailable, true); assert.equal(description.state, 'unfinished');
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
  const recorded = await recordRenameTrialFileResult({ directory }); assert.equal(recorded.status, 'applied');
  assert.deepEqual(await recordRenameTrialFileResult({ directory }), recorded); assert.equal((await readRenameTrialResult(directory)).mode, 'rename-verify');
  validatePortableTrialAudit(await exportRenameTrialAudit(directory));
});

test('explicit recovery discovers only the active completed recovery transport and never acknowledges a retired original or attempt', async t => {
  const f = await fixture(t), directory = f.trial.directory;
  await packet(directory, output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied'));
  const older = await recovery(f);
  await packet(older.folder, output('FRAMELINE_RENAME_RECOVERY', older.attemptId, f.before, 'restored'));
  await assert.rejects(recordRenameTrialFileResult({ directory }), /trial-recovery-active/);
  const active = await recovery(f, f.before);
  await assert.rejects(recordRenameTrialRecoveryFileResult({ directory, attemptId: older.attemptId }), /attempt-retired/);
  assert.equal(await recordRetainedRenameTrialOutcomeIfComplete({ directory }), null);
  await packet(active.folder, output('FRAMELINE_RENAME_RECOVERY', active.attemptId, f.before, 'source-verified'));
  assert.equal((await describeRenameTrial(directory)).transportOutputAvailable, true);
  const recovered = await recordRetainedRenameTrialOutcomeIfComplete({ directory }); assert.equal(recovered.completed, true); assert.equal(recovered.result.status, 'source-verified');
  assert.deepEqual(await recordRenameTrialRecoveryFileResult({ directory, attemptId: active.attemptId }), recovered);
  validatePortableTrialAudit(await exportRenameTrialAudit(directory));
});

test('partial transport is never an outcome but can be explicitly retired for an independent fresh inspection', async t => {
  const f = await fixture(t), directory = f.trial.directory;
  await fs.writeFile(path.join(directory, 'transport-output.json'), '{"partial":');
  await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' });
  assert.deepEqual(await recordRetainedRenameTrialOutcomeIfComplete({ directory }), { completed: false, needsInspection: true, status: 'retained-result-unverified' });
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
  const next = await prepareRenameTrialRecovery({ directory }); assert(next.attemptId);
  await assert.rejects(recordRenameTrialFileResult({ directory }), /trial-recovery-active/);
});

test('foreign identity, schema, mode or token and a wrong verified source fail closed without clipboard fallback or canonical results', async t => {
  const f = await fixture(t), directory = f.trial.directory, text = output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied');
  const good = await packet(directory, text), filename = path.join(directory, 'transport-output.json');
  for (const edit of [value => { value.transactionId = '0'.repeat(32); }, value => { value.issuedSha256 = '0'.repeat(64); },
    value => { value.forceFailure = true; }, value => { value.transportToken = '0'.repeat(32); }, value => { value.schemaVersion = 99; }, value => { value.privatePath = '/private/secret'; }]) {
    const changed = structuredClone(good); edit(changed); await fs.writeFile(filename, JSON.stringify(changed));
    await assert.rejects(recordRetainedRenameTrialOutcomeIfComplete({ directory }), { code: 'trial-retained-result-binding-mismatch' });
  }
  await packet(directory, output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.before, 'applied'));
  await assert.rejects(recordRenameTrialFileResult({ directory }), /trial-result-mismatch/);
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
});

test('symlinked, insecure, oversized and changing output files cannot be acknowledged', async t => {
  const f = await fixture(t), directory = f.trial.directory, filename = path.join(directory, 'transport-output.json');
  await packet(directory, output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied')); const original = await fs.readFile(filename);
  const retained = `${filename}.retained`; await fs.rename(filename, retained); await fs.symlink(retained, filename);
  await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' }); await fs.unlink(filename); await fs.rename(retained, filename);
  await fs.chmod(filename, 0o644); await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' }); await fs.chmod(filename, 0o600);
  await fs.truncate(filename, 48 * 1024 * 1024 + 1); await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' }); await fs.writeFile(filename, original);
  const open = fs.open; let armed = true;
  fs.open = async function (name, ...args) {
    const handle = await open(name, ...args); if (name !== filename || !armed) return handle;
    return new Proxy(handle, { get(target, key) { if (key === 'read') return async (...values) => { const value = await target.read(...values); if (armed) { armed = false; await fs.appendFile(filename, ' '); } return value; };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  };
  try { await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' }); } finally { fs.open = open; }
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
});

test('output fsync failure prevents ACK and exact byte retry succeeds after storage recovers', async t => {
  const f = await fixture(t), directory = f.trial.directory, filename = path.join(directory, 'transport-output.json');
  await packet(directory, output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied'));
  const open = fs.open;
  fs.open = async function (name, ...args) {
    const handle = await open(name, ...args); if (name !== filename) return handle;
    return new Proxy(handle, { get(target, key) { if (key === 'sync') return async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  };
  try { await assert.rejects(recordRenameTrialFileResult({ directory }), { code: 'trial-retained-result-corrupt' }); } finally { fs.open = open; }
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
  assert.equal((await recordRenameTrialFileResult({ directory })).status, 'applied');
});

test('retained issuance cannot downgrade to clipboard or direct recording and its audit provenance survives immutable history transfer', async t => {
  const f = await fixture(t), directory = f.trial.directory;
  const consoleOutput = output('FRAMELINE_RENAME_TRIAL', f.trial.transactionId, f.after, 'applied');
  await assert.rejects(recordRenameTrialConsoleResult({ directory, consoleOutput }), /result-transport-mismatch/);
  await assert.rejects(recordRenameTrialResult({ directory, status: 'applied', snapshotBytes: JSON.stringify(f.after.snapshot), effectObservationBytes: JSON.stringify(f.after) }), /result-transport-mismatch/);
  await assert.rejects(fs.stat(path.join(directory, 'result.json')), { code: 'ENOENT' });
  await packet(directory, consoleOutput); await recordRenameTrialFileResult({ directory });
  const portable = await exportRenameTrialAudit(directory); assert.equal(portable.provenance, 'retained-internal-script-observation');
  const changed = structuredClone(portable); changed.provenance = 'copied-console-observation';
  assert.throws(() => validatePortableTrialAudit(changed), { code: 'invalid-portable-trial-audit' });
  const store = createLocalMetadataStore(path.join(path.dirname(directory), 'history')), project = await store.getResolveProjectId(f.before.snapshot.project_id);
  const first = await store.saveRevision(project.id, createResolveRevisionManifest(f.before.snapshot), 'Before');
  const link = await saveRenameTrialRevision({ directory, store, branch: 'main', expectedHeadId: first.id });
  const saved = await store.getRevision(project.id, link.revisionId); assert.equal(saved.manifest.transactionAudit.provenance, portable.provenance);
  const bundle = await store.exportRevisions(project.id), target = createLocalMetadataStore(path.join(path.dirname(directory), 'imported'));
  const destination = await target.getResolveProjectId(f.before.snapshot.project_id), imported = await target.importRevisions(destination.id, bundle);
  const head = (await target.listRevisions(destination.id, imported.branches[0]))[0];
  assert.deepEqual((await target.getRevision(destination.id, head.id)).manifest.transactionAudit, portable);
  const r = await fixture(t), attempt = await recovery(r);
  await assert.rejects(recordRenameTrialRecoveryResult({ directory: r.trial.directory, attemptId: attempt.attemptId,
    consoleOutput: output('FRAMELINE_RENAME_RECOVERY', attempt.attemptId, r.before, 'restored') }), /result-transport-mismatch/);
});
