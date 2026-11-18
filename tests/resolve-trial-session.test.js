'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveReviewSession } = require('../src/resolve-review-session');
const { createResolveTrialSession } = require('../src/resolve-trial-session');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult } = require('../src/resolve-rename-trial');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-trial-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const d = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const local = await fs.readFile(path.join(d, 'live-rename-before-schema3.json'));
  const incoming = await fs.readFile(path.join(d, 'live-rename-applied-schema3.json'));
  const effects = await fs.readFile(path.join(d, 'live-properties-enabled.json'));
  const review = createResolveReviewSession({ artifactDirectory: path.join(root, 'reviews') });
  const sources = { base: local, local, incoming };
  review.load(sources);
  let copied = '';
  const clipboard = { readText: () => copied, writeText: value => { copied = value; } };
  const store = createLocalMetadataStore(path.join(root, 'metadata'));
  const options = { enabled: true, directory: path.join(root, 'trials'), store,
    clipboard, getReview: async () => review.getVerifiedReview(sources) };
  return { root, sources, effects, review, options, session: createResolveTrialSession(options) };
}

function captureOutput(id, bytes, kind = 'effect') {
  const raw = bytes.toString('utf8').trimEnd();
  const parts = [];
  for (let n = 0; n < raw.length; n += 8192) parts.push(raw.slice(n, n + 8192));
  return parts.map((part, index) => kind === 'effect'
    ? `FRAMELINE_EFFECT_PART_V1:${id}:${index + 1}:${parts.length}:${part}`
    : `FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${id}:${index + 1}:${part}`).join('\n');
}

async function startBackup(context) {
  const state = await context.session.prepare('Frameline Restore Probe', true);
  assert.equal(state.phase, 'effect-command');
  assert.equal(state.transactionId, null);
  context.options.clipboard.writeText(captureOutput(state.captureId, context.effects));
  const backup = await context.session.read();
  assert.equal(backup.phase, 'backup-command');
  assert.equal(backup.error, null);
  return backup;
}

async function fakeExport(directory) {
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const filename = path.join(directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', path.join(directory, 'before.drp'), 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: directory }).status, 0);
}

test('desktop drill session binds review, gates stages, sanitizes state, and saves/reloads a verified history link', async t => {
  const context = await setup(t);
  const { session, options, sources, effects } = context;
  assert.ok((await session.prepare('Frameline Restore Probe', false)).error);
  await startBackup(context);
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  await fakeExport(folder);
  const issued = await session.issue();
  assert.equal(issued.phase, 'rollback-command');
  assert.equal(issued.backup.archiveVerified, true);
  assert.ok(!JSON.stringify(issued).includes(folder));
  assert.equal(issued.command, undefined);
  assert.equal(issued.effectGuard.sourceSha256, '903af23882b20e93beb42532b7ac101917d045d7d06d749352b080f9e7d66e21');
  assert.equal(issued.effectGuard.coverage.schemaVersion, 2);
  assert.equal(issued.effectGuard.coverage.propertyKeyCount, 43);
  assert.equal(issued.effectGuard.coverage.trackCount, 2);
  assert.match(options.clipboard.readText(), /Intentional trial failure/);
  const changed = JSON.parse(effects);
  changed.items.flatMap(item => item.effects)[0].enabled = false;
  options.clipboard.writeText(`${captureOutput(issued.transactionId, JSON.stringify(changed), 'trial')}\nFRAMELINE_RENAME_TRIAL_RESULT_V1:${issued.transactionId}:rolled-back`);
  const rejected = await session.read();
  assert.equal(rejected.phase, 'rollback-command');
  assert.equal(rejected.outcome, null);
  assert.ok(rejected.error);
  assert.ok((await session.saveRevision()).error);
  options.clipboard.writeText(`${captureOutput(issued.transactionId, effects, 'trial')}\nFRAMELINE_RENAME_TRIAL_RESULT_V1:${issued.transactionId}:rolled-back`);
  assert.equal((await session.read()).phase, 'verified');
  const saved = await session.saveRevision();
  assert.equal(saved.phase, 'saved');
  assert.ok(saved.revisionId);
  assert.equal(saved.outcome.effectObservation.resultingSha256, saved.effectGuard.sourceSha256);
  assert(!JSON.stringify(saved).includes('Gaussian Blur'));
  assert(!JSON.stringify(saved).includes('sourceBase64'));
  assert.equal(await session.backupPath(), path.join(folder, 'before.drp'));
  const restarted = createResolveTrialSession(options);
  assert.equal((await restarted.recover(folder)).phase, 'verified');
  assert.deepEqual(restarted.getState().effectGuard, saved.effectGuard);
  assert.equal((await restarted.saveRevision()).revisionId, saved.revisionId);
  const project = await options.store.getResolveProjectId(JSON.parse(sources.local).project_id);
  assert.equal((await options.store.listRevisions(project.id)).length, 2);
});

test('disabled sessions expose no commands and source changes prevent issuance', async t => {
  const context = await setup(t);
  const { options, session, sources, review } = context;
  const disabled = createResolveTrialSession({ ...options, enabled: false });
  assert.equal((await disabled.prepare('Frameline Restore Probe', true)).enabled, false);
  assert.equal(options.clipboard.readText(), '');
  await startBackup(context);
  sources.local = Buffer.concat([sources.local, Buffer.from('\n')]);
  assert.throws(() => review.getVerifiedReview(sources));
  const blocked = await session.issue();
  assert.equal(blocked.phase, 'backup-command');
  assert.match(blocked.error, /Sources changed/);
});

test('concurrent desktop actions do not issue a second transaction', async t => {
  const { options } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const getReview = options.getReview;
  const session = createResolveTrialSession({ ...options, getReview: async () => { await gate; return getReview(); } });
  const preparing = session.prepare('Frameline Restore Probe', true);
  assert.match((await session.prepare('Frameline Restore Probe', true)).error, /already running/);
  release();
  assert.equal((await preparing).phase, 'effect-command');
  await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' });
});

test('backup preparation can be cancelled while retaining records and without exposing a mutation command', async t => {
  const context = await setup(t);
  const { session, options } = context;
  await session.prepare('Frameline Restore Probe', true);
  assert.equal((await session.cancelPreparation()).phase, 'idle');
  await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' });
  await startBackup(context);
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  assert.equal((await session.cancelPreparation()).phase, 'idle');
  assert.ok((await fs.stat(path.join(folder, 'cancelled.json'))).isFile());
  assert.ok((await session.copyCommand()).error);
  assert.equal((await session.prepare('Frameline Restore Probe', true)).phase, 'effect-command');
});

test('rejects incomplete, unrelated, and stale effect captures before backup or history creation', async t => {
  const { session, options, effects } = await setup(t);
  assert.ok((await session.prepare('Frameline Different project', true)).error);
  assert.equal(options.clipboard.readText(), '');
  const state = await session.prepare('Frameline Restore Probe', true);
  const captureCommand = options.clipboard.readText();
  assert.equal((await session.issue()).phase, 'effect-command');
  for (const output of [captureOutput('0'.repeat(32), effects), captureOutput(state.captureId, effects).split('\n').slice(1).join('\n')]) {
    options.clipboard.writeText(output);
    assert.ok((await session.read()).error);
  }
  const stale = JSON.parse(effects);
  stale.snapshot.timelines[0].items[0].name = 'Changed local name';
  options.clipboard.writeText(captureOutput(state.captureId, JSON.stringify(stale)));
  assert.match((await session.read()).error, /differs from the reviewed/);
  assert.deepEqual(await fs.readdir(options.directory), []);
  assert.deepEqual(await options.store.listResolveProjects(), []);
  assert.equal((await session.copyCommand()).error, null);
  assert.equal(options.clipboard.readText(), captureCommand);
  options.clipboard.writeText(captureOutput(state.captureId, effects));
  assert.equal((await session.read()).phase, 'backup-command');
});

test('a changed review invalidates the pending effect capture', async t => {
  const { session, options, sources, effects } = await setup(t);
  const state = await session.prepare('Frameline Restore Probe', true);
  sources.local = Buffer.concat([sources.local, Buffer.from('\n')]);
  options.clipboard.writeText(captureOutput(state.captureId, effects));
  const failed = await session.read();
  assert.equal(failed.phase, 'effect-command');
  assert.match(failed.error, /Sources changed/);
  await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' });
});

test('new desktop drills require richer captures and reject unavailable reads before creating trial or history records', async t => {
  const { session, options, effects } = await setup(t);
  const prepared = await session.prepare('Frameline Restore Probe', true);
  assert.match(options.clipboard.readText(), /base,\{types=/);
  const legacy = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-effects-enabled.json'));
  options.clipboard.writeText(captureOutput(prepared.captureId, legacy));
  assert.match((await session.read()).error, /New drills require clip properties/);
  for (const alter of [value => { value.items[0].propertyReadStatus = 'unavailable'; value.items[0].properties = {}; },
    value => { value.items[0].properties = {}; },
    value => { value.tracks[0].enabled = null; }]) {
    const observation = JSON.parse(effects); alter(observation);
    options.clipboard.writeText(captureOutput(prepared.captureId, JSON.stringify(observation)));
    const failed = await session.read(); assert.equal(failed.phase, 'effect-command');
    assert.match(failed.error, /could not be read/);
    await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' });
    assert.deepEqual(await options.store.listResolveProjects(), []);
  }
  options.clipboard.writeText(captureOutput(prepared.captureId, effects));
  const accepted = await session.read(); assert.equal(accepted.phase, 'backup-command');
  assert.equal(accepted.effectGuard.coverage.unavailablePropertyReads, 0);
  assert.equal(accepted.effectGuard.coverage.unavailableTrackStateReads, 0);
  assert(!JSON.stringify(accepted).includes('Pan'));
});

test('completed schema-1 effect drills retain their original coverage when reopened', async t => {
  const { session, options, sources } = await setup(t);
  const effects = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-effects-enabled.json'));
  await fs.mkdir(options.directory, { mode: 0o700 });
  const trial = await prepareReviewedRenameTrial({ ...await options.getReview(), destinationDir: options.directory,
    disposableProjectName: 'Frameline Restore Probe', effectObservationBytes: effects });
  const manifest = createResolveRevisionManifest(JSON.parse(sources.local));
  const project = await options.store.getResolveProjectId(manifest.snapshot.project_id, manifest.snapshot.project_name);
  const baseline = await options.store.saveRevision(project.id, manifest, 'Legacy effect baseline');
  await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify({ branch: 'main', expectedHeadId: baseline.id }), { mode: 0o600 });
  await fakeExport(trial.directory); await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: sources.local, effectObservationBytes: effects });
  const recovered = await session.recover(trial.directory);
  assert.equal(recovered.phase, 'verified'); assert.equal(recovered.effectGuard.coverage.schemaVersion, 1);
  assert.equal(recovered.effectGuard.coverage.propertyKeyCount, null); assert.equal(recovered.effectGuard.coverage.trackCount, null);
  assert.equal(recovered.effectGuard.sourceSha256, '696ee1b32e09ff410f54ed4905c2423cc228437654511117f86d31ad4070f585');
});

test('completed counts-only drills remain recoverable without claiming an effect guard', async t => {
  const { session, options, sources } = await setup(t);
  await fs.mkdir(options.directory, { mode: 0o700 });
  const trial = await prepareReviewedRenameTrial({ ...await options.getReview(), destinationDir: options.directory,
    disposableProjectName: 'Frameline Restore Probe' });
  const before = createResolveRevisionManifest(JSON.parse(sources.local));
  const project = await options.store.getResolveProjectId(before.snapshot.project_id, before.snapshot.project_name);
  const baseline = await options.store.saveRevision(project.id, before, 'Legacy drill baseline');
  await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify({ branch: 'main', expectedHeadId: baseline.id }), { mode: 0o600 });
  await fakeExport(trial.directory);
  await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: sources.local });
  const recovered = await session.recover(trial.directory);
  assert.equal(recovered.phase, 'verified');
  assert.equal(recovered.effectGuard, null);
  assert.equal(recovered.outcome.effectObservation, null);
  assert.equal((await session.saveRevision()).phase, 'saved');
});

function recoveryOutput(id, bytes, status) {
  return captureOutput(id, bytes, 'trial').replaceAll('FRAMELINE_RENAME_TRIAL_CAPTURE_V1:', 'FRAMELINE_RENAME_RECOVERY_CAPTURE_V1:')
    + `\nFRAMELINE_RENAME_RECOVERY_RESULT_V1:${id}:${status}`;
}

test('a restarted desktop inspects an issued drill, restores the expected rename, and saves its verified outcome', async t => {
  const context = await setup(t), { session, options, effects, sources } = context;
  await startBackup(context);
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  await fakeExport(folder); await session.issue();
  const restarted = createResolveTrialSession({ ...options, getReview: async () => { throw new Error('No review is loaded after restart'); } });
  const initial = await restarted.recover(folder);
  assert.equal(initial.phase, 'recovery-capture');
  assert.equal(initial.projectName, 'Frameline Restore Probe');
  assert.ok(initial.recovery.attemptId);
  const renamed = JSON.parse(effects); renamed.snapshot = JSON.parse(sources.incoming);
  options.clipboard.writeText(captureOutput(initial.captureId, JSON.stringify(renamed)));
  const inspected = await restarted.read();
  assert.equal(inspected.phase, 'recovery-ready');
  assert.equal(inspected.recovery.classification, 'renamed');
  assert.equal((await restarted.issue()).phase, 'recovery-command');
  assert.equal((await restarted.cancelPreparation()).phase, 'recovery-command');
  assert.ok(restarted.getState().error);
  options.clipboard.writeText(recoveryOutput(initial.recovery.attemptId, effects, 'restored'));
  assert.equal((await restarted.read()).outcome.status, 'restored');
  const saved = await restarted.saveRevision();
  assert.equal(saved.phase, 'saved');
  assert.ok(saved.revisionId);
  assert(!JSON.stringify(saved).includes(folder));
  assert(!JSON.stringify(saved).includes('Gaussian Blur'));
  const again = createResolveTrialSession(options);
  assert.equal((await again.recover(folder)).outcome.status, 'restored');
  assert.equal((await again.saveRevision()).revisionId, saved.revisionId);
});

test('a restarted recovery retires prior attempts and requires another live inspection', async t => {
  const context = await setup(t), { session, options, effects } = context;
  await startBackup(context);
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  await fakeExport(folder); await session.issue();
  const first = createResolveTrialSession(options);
  const pending = await first.recover(folder);
  options.clipboard.writeText(captureOutput(pending.captureId, effects));
  assert.equal((await first.read()).phase, 'recovery-ready');
  await first.issue();
  const second = createResolveTrialSession(options);
  const fresh = await second.recover(folder);
  assert.equal(fresh.phase, 'recovery-capture');
  assert.notEqual(fresh.recovery.attemptId, pending.recovery.attemptId);
  const changed = JSON.parse(effects); changed.items.flatMap(item => item.effects)[0].enabled = false;
  options.clipboard.writeText(captureOutput(fresh.captureId, JSON.stringify(changed)));
  assert.equal((await second.read()).phase, 'recovery-required');
  assert.ok((await second.issue()).error);
  assert.ok((await second.saveRevision()).error);
  assert.equal((await second.inspectRecovery()).phase, 'recovery-capture');
});
