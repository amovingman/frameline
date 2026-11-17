'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { discoverRenameTrials } = require('../src/resolve-trial-discovery');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, cancelPreparedRenameTrial } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveTrialSession } = require('../src/resolve-trial-session');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'trial-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'trials'); await fs.mkdir(directory, { mode: 0o700 });
  const fixtures = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const local = await fs.readFile(path.join(fixtures, 'live-rename-before-schema3.json'));
  const sources = { base: local, local, incoming: await fs.readFile(path.join(fixtures, 'live-rename-applied-schema3.json')) };
  const effects = await fs.readFile(path.join(fixtures, 'live-effects-enabled.json'));
  const plan = createResolvePreviewPlan(sources), audit = createResolveDecisionAudit(plan, sources, []);
  const store = createLocalMetadataStore(path.join(root, 'metadata'));
  let clipboard = 'User clipboard';
  const options = { enabled: true, directory, store, getReview: async () => ({ sources, plan, audit }),
    clipboard: { readText: () => clipboard, writeText: value => { clipboard = value; } } };
  return { root, directory, sources, effects, plan, audit, store, options };
}

async function exportFixture(trial) {
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const file = path.join(trial.directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
}

async function makeTrial(context, state) {
  const trial = await prepareReviewedRenameTrial({ sources: context.sources, plan: context.plan, audit: context.audit,
    destinationDir: context.directory, disposableProjectName: 'Frameline Restore Probe', effectObservationBytes: context.effects });
  if (state === 'cancelled') { await cancelPreparedRenameTrial(trial); return trial; }
  if (state === 'prepared') return trial;
  const manifest = createResolveRevisionManifest(JSON.parse(context.sources.local));
  const project = await context.store.getResolveProjectId(manifest.snapshot.project_id, manifest.snapshot.project_name);
  let revisions = await context.store.listRevisions(project.id);
  const head = revisions[0]?.id || (await context.store.saveRevision(project.id, manifest, 'Baseline')).id;
  const target = { branch: 'main', expectedHeadId: head };
  await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify(target), { mode: 0o600 });
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory, forceFailure: state !== 'manual' });
  if (['outcome', 'saved'].includes(state)) {
    await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back',
      snapshotBytes: context.sources.local, effectObservationBytes: context.effects });
    if (state === 'saved') trial.link = await saveRenameTrialRevision({ directory: trial.directory, store: context.store, ...target });
  }
  return trial;
}

test('startup discovery classifies retained work without copying commands or creating recovery barriers', async t => {
  const context = await setup(t);
  const trials = {};
  for (const state of ['prepared', 'unfinished', 'manual', 'outcome', 'saved', 'cancelled']) trials[state] = await makeTrial(context, state);
  const session = createResolveTrialSession(context.options);
  const state = await session.initialize();
  assert.equal(state.phase, 'idle');
  assert.equal(state.discovery.ready, true);
  assert.equal(state.discovery.items.length, 4);
  const states = new Map(state.discovery.items.map(item => [item.transactionId, item]));
  for (const [kind, action] of [['prepared', 'cancel'], ['unfinished', 'recover'], ['manual', 'reveal'], ['outcome', 'recover']]) {
    assert.equal(states.get(trials[kind].transactionId).state, kind);
    assert.equal(states.get(trials[kind].transactionId).action, action);
    assert.equal(states.get(trials[kind].transactionId).projectName, 'Frameline Restore Probe');
  }
  assert.equal(context.options.clipboard.readText(), 'User clipboard');
  const publicState = JSON.stringify(state);
  for (const forbidden of [context.root, 'sourceBase64', 'Gaussian Blur', 'snapshot', 'backupPath', 'before.drp']) assert(!publicState.includes(forbidden));
  await assert.rejects(fs.stat(path.join(trials.unfinished.directory, 'recovery-started.json')), { code: 'ENOENT' });
  assert.deepEqual((await session.initialize()).discovery, state.discovery);
});

test('selecting an opaque discovered record revalidates and prepares only a read-only inspection', async t => {
  const context = await setup(t), trial = await makeTrial(context, 'unfinished');
  const session = createResolveTrialSession(context.options);
  const initialized = await session.initialize(), item = initialized.discovery.items[0];
  assert.equal(item.transactionId, trial.transactionId);
  const active = await session.recoverDiscovered(item.recordId);
  assert.equal(active.phase, 'recovery-capture');
  assert.equal(active.transactionId, trial.transactionId);
  assert.match(context.options.clipboard.readText(), /FRAMELINE_EFFECT_PART_V1/);
  assert(!context.options.clipboard.readText().includes('SetName'));
  assert.equal(await session.discoveredRecordPath(item.recordId), trial.directory);
  assert.ok((await session.recoverDiscovered('../outside')).error);
  await assert.rejects(session.discoveredRecordPath('../outside'));
});

test('prepared cancellations retain records and permanently block later issuance', async t => {
  const context = await setup(t), trial = await makeTrial(context, 'prepared');
  const session = createResolveTrialSession(context.options), initialized = await session.initialize();
  assert.equal((await session.cancelDiscovered(initialized.discovery.items[0].recordId)).discovery.items.length, 0);
  assert.ok((await fs.stat(path.join(trial.directory, 'prepared.json'))).isFile());
  await exportFixture(trial);
  await assert.rejects(issueRenameTrial({ directory: trial.directory }), /trial-preparation-cancelled/);
  await assert.rejects(fs.stat(path.join(trial.directory, 'issued.json')), { code: 'ENOENT' });
  assert.equal((await session.refreshDiscovery()).discovery.items.length, 0);
  assert.equal(context.options.clipboard.readText(), 'User clipboard');
});

test('a record issued after discovery cannot be cancelled from a stale prepared row', async t => {
  const context = await setup(t), trial = await makeTrial(context, 'prepared');
  const session = createResolveTrialSession(context.options), initialized = await session.initialize();
  await exportFixture(trial); await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  const result = await session.cancelDiscovered(initialized.discovery.items[0].recordId);
  assert.ok(result.error);
  await assert.rejects(fs.stat(path.join(trial.directory, 'cancelled.json')), { code: 'ENOENT' });
});

test('corrupt or symlinked records stay visible without leaking their unverified contents', async t => {
  const context = await setup(t), trial = await makeTrial(context, 'prepared');
  await fs.writeFile(path.join(trial.directory, 'prepared.json'), 'private media path /outside/user/project');
  const external = path.join(context.root, 'external'); await fs.mkdir(external, { mode: 0o700 });
  const linked = 'rename-1794000000000-' + 'e'.repeat(32); await fs.symlink(external, path.join(context.directory, linked));
  const session = createResolveTrialSession(context.options), result = await session.initialize();
  assert.equal(result.discovery.items.length, 2);
  const corrupt = result.discovery.items.find(item => item.transactionId === trial.transactionId);
  const symlink = result.discovery.items.find(item => item.transactionId === 'e'.repeat(32));
  assert.equal(corrupt.state, 'unreadable'); assert.equal(corrupt.projectName, null); assert.equal(corrupt.action, 'reveal');
  assert.equal(symlink.action, 'none');
  assert(!JSON.stringify(result).includes('/outside/user/project'));
  await assert.rejects(session.discoveredRecordPath(symlink.recordId));
  assert.deepEqual(await fs.readdir(external), []);
});

test('damaged archives and broken history links cannot disappear as completed drills', async t => {
  const context = await setup(t), saved = await makeTrial(context, 'saved');
  const session = createResolveTrialSession(context.options);
  assert.equal((await session.initialize()).discovery.items.length, 0);
  await fs.unlink(path.join(saved.directory, 'revision-link.json'));
  assert.equal((await session.refreshDiscovery()).discovery.items[0].state, 'outcome');
  await fs.writeFile(path.join(saved.directory, 'revision-link.json'), JSON.stringify(saved.link), { mode: 0o600 });
  const revisionFile = path.join(context.root, 'metadata', 'revisions', saved.link.projectId, `${saved.link.revisionId}.json`);
  await fs.appendFile(revisionFile, '\n');
  assert.equal((await session.refreshDiscovery()).discovery.items[0].state, 'unreadable');
  const unfinished = await makeTrial(context, 'unfinished');
  const listed = await session.refreshDiscovery(), item = listed.discovery.items.find(value => value.transactionId === unfinished.transactionId);
  await fs.appendFile(unfinished.backupPath, 'changed');
  assert.ok((await session.recoverDiscovered(item.recordId)).error);
  await assert.rejects(fs.stat(path.join(unfinished.directory, 'recovery-started.json')), { code: 'ENOENT' });
});

test('discovery pages older records deterministically and does not duplicate rows when newer folders appear', async t => {
  const context = await setup(t);
  for (let index = 1; index <= 21; index++) await fs.mkdir(path.join(context.directory,
    `rename-${1794000000000 + index}-${String(index).padStart(32, '0')}`), { mode: 0o700 });
  const session = createResolveTrialSession(context.options), first = await session.initialize();
  assert.equal(first.discovery.scanned, 20); assert.equal(first.discovery.items.length, 20); assert.equal(first.discovery.hasMore, true);
  const newer = `rename-1794999999999-${'f'.repeat(32)}`; await fs.mkdir(path.join(context.directory, newer), { mode: 0o700 });
  const second = await session.refreshDiscovery(true);
  assert.equal(second.discovery.scanned, 21); assert.equal(second.discovery.items.length, 21); assert.equal(second.discovery.hasMore, false);
  assert.equal(new Set(second.discovery.items.map(item => item.recordId)).size, 21);
  assert(!second.discovery.items.some(item => item.transactionId === 'f'.repeat(32)));
  assert((await session.refreshDiscovery()).discovery.items.some(item => item.transactionId === 'f'.repeat(32)));
});

test('missing roots are empty, unsafe roots report an error, and disabled sessions never scan', async t => {
  const context = await setup(t);
  const missing = path.join(context.root, 'missing');
  assert.equal((await discoverRenameTrials({ directory: missing, store: context.store })).items.length, 0);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await fs.chmod(context.directory, 0o755);
  const session = createResolveTrialSession(context.options);
  assert.match((await session.initialize()).discovery.error, /could not be inspected/);
  const disabled = createResolveTrialSession({ ...context.options, enabled: false });
  const state = await disabled.initialize();
  assert.equal(state.discovery.ready, false); assert.equal(state.enabled, false);
  assert.equal(context.options.clipboard.readText(), 'User clipboard');
});
