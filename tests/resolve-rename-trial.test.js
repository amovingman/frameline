'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { prepareRenameTrial, prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, recordRenameTrialConsoleResult, describeRenameTrial } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const { readRenameTrialResult } = require('../src/resolve-rename-trial');
const { saveRenameTrialRevision } = require('../src/resolve-trial-history');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { createHash } = require('node:crypto');
const syncFs = require('node:fs');

const luaLibrary = process.env.FRAMELINE_LUA_LIBRARY || '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';

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

test('issued commands reject completed or partially recorded outcomes in a fresh Lua runtime before editor access',
  { skip: !syncFs.existsSync(luaLibrary) && 'Set FRAMELINE_LUA_LIBRARY to execute the Lua mock on this host' }, async t => {
    const options = await fixture(t);
    const trial = await prepareRenameTrial(options);
    await exportFixture(trial);
    const issued = await issueRenameTrial({ directory: trial.directory, forceFailure: true });
    function runGuard(expected, calls, filesystem = true) {
      const script = `local calls=0;resolve={Fusion=function() return {OpenFile=function(_,filename,mode)
        assert(mode==1);local h=io.open(filename,'rb');if not h then return nil end;
        return {GetFileSize=function() local p=h:seek();local n=h:seek('end');h:seek('set',p);return n end,
          ReadLine=function() local parts={};while true do local ch=h:read(1);if not ch then break end;parts[#parts+1]=ch;if ch=='\\n' then break end end;if #parts==0 then return nil end;return table.concat(parts) end,
          Close=function() h:close() end} end} end,GetProjectManager=function() calls=calls+1;error('Unexpected editor access') end};
        ${filesystem ? "bmd={fileexists=function(filename) local f=io.open(filename,'rb');if not f then return false end;f:close();return true end};" : 'bmd=nil;'}
        local ok,err=pcall(function() ${issued.command} end);
        assert(not ok and tostring(err):find(${JSON.stringify(expected)},1,true),tostring(err));assert(calls==${calls});`;
      return spawnSync('python3', [path.join(__dirname, '../phase-0/run-lua-observation-mock.py'), luaLibrary],
        { input: script, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    }
    // This mock reads the actual transaction filesystem. Each invocation starts
    // a new Lua VM, with no process-local consumed table or open editor project.
    for (const name of ['result.json', 'result-snapshot.json', 'result-effects.json',
      'recovery-result.json', 'recovery-result-snapshot.json', 'recovery-result-effects.json']) {
      const filename = path.join(trial.directory, name);
      await fs.writeFile(filename, 'incomplete', { mode: 0o600 });
      const run = runGuard('Trial outcome already recorded', 0);
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      await fs.unlink(filename);
    }
    const unavailable = runGuard('Trial filesystem guard unavailable', 0, false);
    assert.equal(unavailable.status, 0, unavailable.stderr);
    const untouched = runGuard('Unexpected editor access', 1);
    assert.equal(untouched.status, 0, untouched.stderr);
  });

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

test('explicit experiment intent persists before issuance and cannot switch modes when a command is issued or reloaded', async t => {
  for (const mode of ['forced-rollback', 'rename-verify']) {
    const options = await reviewedFixture(t);
    options.effectObservationBytes = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-effects-enabled.json'));
    const trial = await prepareReviewedRenameTrial({ ...options, experimentMode: mode }); assert.equal(trial.mode, mode);
    assert.equal(JSON.parse(await fs.readFile(path.join(trial.directory, 'prepared.json'))).experimentMode, mode);
    assert.equal((await describeRenameTrial(trial.directory)).mode, mode);
    await exportFixture(trial);
    await fs.writeFile(path.join(trial.directory, 'history-target.json'), JSON.stringify({ branch: 'main', expectedHeadId: require('node:crypto').randomUUID() }), { mode: 0o600 });
    await assert.rejects(issueRenameTrial({ directory: trial.directory, forceFailure: mode !== 'forced-rollback' }), /issued-mode-mismatch/);
    await assert.rejects(fs.stat(path.join(trial.directory, 'issued.json')), { code: 'ENOENT' });
    await issueRenameTrial({ directory: trial.directory, forceFailure: mode === 'forced-rollback' });
    assert.equal((await describeRenameTrial(trial.directory)).mode, mode);
    const observation = JSON.parse(options.effectObservationBytes); observation.snapshot = JSON.parse(mode === 'rename-verify' ? options.afterBytes : options.beforeBytes);
    await recordRenameTrialResult({ directory: trial.directory, status: mode === 'rename-verify' ? 'applied' : 'rolled-back',
      snapshotBytes: mode === 'rename-verify' ? options.afterBytes : options.beforeBytes, effectObservationBytes: JSON.stringify(observation) });
    assert.equal((await readRenameTrialResult(trial.directory)).mode, mode); assert.equal((await describeRenameTrial(trial.directory)).mode, mode);
    const filename = path.join(trial.directory, 'prepared.json'), prepared = JSON.parse(await fs.readFile(filename));
    prepared.experimentMode = mode === 'rename-verify' ? 'forced-rollback' : 'rename-verify'; await fs.writeFile(filename, JSON.stringify(prepared));
    await assert.rejects(readRenameTrialResult(trial.directory), /invalid-issued-trial/);
  }
  const invalid = await fixture(t); await assert.rejects(prepareRenameTrial({ ...invalid, experimentMode: 'unsupported' }), /invalid-trial-option/);
  assert.deepEqual(await fs.readdir(invalid.destinationDir), []);
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

async function effectFixture(t) {
  return { ...await fixture(t), effectObservationBytes: await fs.readFile(path.join(__dirname,
    '../phase-0/resolve-xml-proof/live-effects-enabled.json')) };
}

test('binds the effect supplement to the exact represented source before creating a trial', async t => {
  const options = await effectFixture(t);
  const wrong = JSON.parse(options.effectObservationBytes);
  wrong.snapshot.timelines[0].items[0].name = 'Unrelated current name';
  await assert.rejects(prepareRenameTrial({ ...options, effectObservationBytes: JSON.stringify(wrong) }), /effect-source-snapshot-mismatch/);
  await assert.rejects(prepareRenameTrial({ ...options, effectObservationBytes: options.beforeBytes }), /invalid-effect-observation/);
  assert.deepEqual(await fs.readdir(options.destinationDir), []);
  const trial = await prepareRenameTrial(options);
  await exportFixture(trial);
  const filename = path.join(trial.directory, 'prepared.json');
  const prepared = JSON.parse(await fs.readFile(filename));
  prepared.effectGuard.sourceSha256 = '0'.repeat(64);
  await fs.writeFile(filename, JSON.stringify(prepared));
  await assert.rejects(issueRenameTrial({ directory: trial.directory }), /effect-source-hash-mismatch/);
  await assert.rejects(fs.stat(path.join(trial.directory, 'issued.json')), { code: 'ENOENT' });
});

test('a guarded rollback requires matching effect metadata even when schema-3 fields are unchanged', async t => {
  const options = await effectFixture(t);
  const trial = await prepareRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  const input = { directory: trial.directory, status: 'rolled-back', snapshotBytes: options.beforeBytes };
  await assert.rejects(recordRenameTrialResult(input), /missing-effect-result/);
  for (const field of ['enabled', 'typeId', 'name']) {
    const changed = JSON.parse(options.effectObservationBytes);
    const effect = changed.items.flatMap(item => item.effects)[0];
    effect[field] = field === 'enabled' ? false : 'Different effect';
    await assert.rejects(recordRenameTrialResult({ ...input, effectObservationBytes: JSON.stringify(changed) }), /trial-effect-result-mismatch/);
  }
  await assert.rejects(fs.stat(path.join(trial.directory, 'result.json')), { code: 'ENOENT' });
  const result = await recordRenameTrialResult({ ...input, effectObservationBytes: options.effectObservationBytes });
  assert.equal(result.effectObservation.sourceSha256, result.effectObservation.resultingSha256);
  assert.equal(result.effectObservation.validation, 'observed-effect-metadata-only');
  assert.deepEqual((await readRenameTrialResult(trial.directory)).snapshot, JSON.parse(options.beforeBytes));
  assert.equal((await fs.stat(path.join(trial.directory, 'result-effects.json'))).mode & 0o777, 0o600);
});

test('guarded Console results retain the full observation and a separately usable history snapshot', async t => {
  const options = await reviewedFixture(t);
  options.effectObservationBytes = (await effectFixture(t)).effectObservationBytes;
  const trial = await prepareReviewedRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  const observation = JSON.parse(options.effectObservationBytes);
  observation.snapshot = JSON.parse(options.afterBytes);
  const raw = JSON.stringify(observation);
  const lines = [];
  for (let offset = 0; offset < raw.length; offset += 8192) {
    lines.push(`FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${trial.transactionId}:${lines.length + 1}:${raw.slice(offset, offset + 8192)}`);
  }
  lines.push(`FRAMELINE_RENAME_TRIAL_RESULT_V1:${trial.transactionId}:applied`);
  const result = await recordRenameTrialConsoleResult({ directory: trial.directory, consoleOutput: lines.join('\n') });
  assert.equal(result.review.auditHash, options.audit.auditHash);
  assert.equal(result.effectObservation.resultingSha256, createHash('sha256').update(`${raw}\n`).digest('hex'));
  const { snapshot } = await readRenameTrialResult(trial.directory);
  assert.deepEqual(snapshot, JSON.parse(options.afterBytes));
  const store = createLocalMetadataStore(path.join(options.destinationDir, 'history'));
  const manifest = createResolveRevisionManifest(JSON.parse(options.beforeBytes));
  const project = await store.getResolveProjectId(manifest.snapshot.project_id, manifest.snapshot.project_name);
  const baseline = await store.saveRevision(project.id, manifest, 'Before guarded trial');
  const target = { directory: trial.directory, store, branch: 'main', expectedHeadId: baseline.id };
  const link = await saveRenameTrialRevision(target);
  assert.deepEqual((await store.getRevision(project.id, link.revisionId)).manifest.snapshot, snapshot);
  await fs.appendFile(path.join(trial.directory, 'result-effects.json'), '\n');
  await assert.rejects(saveRenameTrialRevision(target), /trial-effect-result-mismatch/);
  assert.equal((await store.listRevisions(project.id)).length, 2);
});

test('rechecks effect semantics on reload even if a modified result file has a matching new hash', async t => {
  const options = await effectFixture(t);
  const trial = await prepareRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back',
    snapshotBytes: options.beforeBytes, effectObservationBytes: options.effectObservationBytes });
  const changed = JSON.parse(options.effectObservationBytes);
  changed.items.flatMap(item => item.effects)[0].enabled = false;
  const bytes = JSON.stringify(changed);
  await fs.writeFile(path.join(trial.directory, 'result-effects.json'), bytes);
  const filename = path.join(trial.directory, 'result.json');
  const result = JSON.parse(await fs.readFile(filename));
  result.effectObservation.resultingSha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(filename, JSON.stringify(result));
  await assert.rejects(readRenameTrialResult(trial.directory), /trial-effect-result-mismatch/);
});

test('retains unresolved effect changes for recovery without advancing history', async t => {
  const options = await effectFixture(t);
  const trial = await prepareRenameTrial(options);
  await exportFixture(trial);
  await issueRenameTrial({ directory: trial.directory });
  const disabled = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-effects-disabled.json'));
  const result = await recordRenameTrialResult({ directory: trial.directory, status: 'recovery-required',
    snapshotBytes: options.beforeBytes, effectObservationBytes: disabled });
  assert.notEqual(result.effectObservation.sourceSha256, result.effectObservation.resultingSha256);
  assert.equal((await readRenameTrialResult(trial.directory)).result.status, 'recovery-required');
  await assert.rejects(saveRenameTrialRevision({ directory: trial.directory }), /trial-recovery-required/);
  const unguarded = await prepareRenameTrial({ ...options, effectObservationBytes: undefined });
  await exportFixture(unguarded);
  await issueRenameTrial({ directory: unguarded.directory });
  await assert.rejects(recordRenameTrialResult({ directory: unguarded.directory, status: 'rolled-back',
    snapshotBytes: options.beforeBytes, effectObservationBytes: options.effectObservationBytes }), /unexpected-effect-result/);
});
