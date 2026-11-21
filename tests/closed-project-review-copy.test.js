'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createClosedProjectReviewCopy } = require('../src/closed-project-review-copy');
const { createClosedProjectApplyPlan } = require('../src/closed-project-apply-plan');
const nativeStore = require('../src/closed-project-native-store');
const { closedProjectFixture, sha } = require('./helpers/closed-project-apply-fixture');
async function setup(t) {
  const f = await closedProjectFixture(t), sourceRoot = path.join(f.root, 'source-library'), destinationRoot = path.join(f.root, 'review-library');
  for (const root of [sourceRoot, destinationRoot]) await fs.mkdir(path.join(root, 'Resolve Projects/Users/guest/Projects'), { recursive: true, mode: 0o700 });
  const config = path.join(f.root, 'dblist.conf'); await fs.writeFile(config, `Source:${sourceRoot}::::DISK\nReview:${destinationRoot}:*:::DISK\n`, { mode: 0o600 });
  const binding = { schemaVersion: 1, sourcePath: f.sourcePath, projectName: f.fixture.projectName, libraryRoot: sourceRoot,
    configPath: config, configSha256: sha(await fs.readFile(config)), expectedCurrentDatabase: { DbName: 'Source', DbType: 'Disk' }, expectedCurrentFolder: 'Root' };
  let syncBase = { selectedBranch: 'main', head: 'source-head', syncBase: 'shared-base' }, checkpoint = async () => {}, verify = true;
  let observationOverride = null;
  const guard = { ...f.guard, async inspect(options) { const result = await f.guard.inspect(options); return observationOverride ? observationOverride(result, options) : result; },
    async inspectFileMetadata(filename) { const s = await fs.stat(filename); return { ...f.metadata, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid }; } };
  let preparedPlan;
  const originalAdapter = {
    async createPlan({ review }) { const d = await f.directory('initial-native-snapshot'), capture = await nativeStore.inspectClosedDatabase({ sourcePath: f.sourcePath, directory: d, projectId: f.fixture.projectId, projectName: f.fixture.projectName }); preparedPlan = createClosedProjectApplyPlan({ ...review, databaseBytes: capture.databaseBytes, censusBytes: capture.censusBytes }); return preparedPlan; },
    async verifyPlan(plan) { assert.deepEqual(plan, preparedPlan); if (!verify) throw Error('review-stale'); return true; }
  };
  const options = { directory: path.join(f.root, 'service'), getCurrentReview: async () => f.review, getSyncBase: async () => structuredClone(syncBase), guard, originalAdapter,
    sourceBindingService: { async prepareClosedProjectSourceBinding() { return structuredClone(binding); }, async observeLoadedProjectSource() { throw Error('unused-in-copy-planning'); } },
    mediaPolicy: async ({ plan }) => ({ policy: 'unchanged-references', verified: true, sourceSha256: plan.source.sha256, bindingSha256: sha('media-binding') }),
    verifyEditor: async ({ record }) => ({ transactionId: record.transactionId, planId: record.plan.planId, verified: true, closed: true, actualOpenFileBindingVerified: true, metadataPreserved: true,
      sourceSha256: record.candidate.sha256, proofSha256: sha('test-only-native-proof'), projectId: record.plan.projectId,
      timelineId: record.plan.edit.timelineId, itemId: record.plan.edit.itemId, name: record.plan.edit.newName }),
    onCheckpoint: (...args) => checkpoint(...args)
  };
  const service = createClosedProjectReviewCopy(options);
  return { ...f, options, service, sourceRoot, destinationRoot, binding, guard,
    prepare: () => service.prepare({ review: f.review, sourcePath: f.sourcePath, destinationLibraryRoot: destinationRoot }),
    setSyncBase: value => { syncBase = value; }, setCheckpoint: value => { checkpoint = value; }, setReviewVerified: value => { verify = value; },
    overrideObservation: value => { observationOverride = value; } };
}
test('review copy preserves the original and sync base while applying exactly the same native Name plan', async t => {
  const f = await setup(t), source = await fs.readFile(f.sourcePath), before = await fs.stat(f.sourcePath);
  const prepared = await f.prepare(); assert.equal(prepared.state, 'prepared'); assert.deepEqual(prepared.timelineIds, JSON.parse(f.review.sources.local).timelines.map(t => t.id).sort());
  assert.equal(await fs.stat(prepared.destination.projectDirectory).catch(e => e.code), 'ENOENT');
  const copied = await f.service.publish(prepared.transactionId); assert.equal(copied.state, 'published-awaiting-editor');
  assert.equal(copied.destination.binding.expectedCurrentDatabase.DbName, 'Review'); assert.equal(copied.plan.planId, prepared.plan.planId);
  assert.equal(sha(await fs.readFile(copied.destination.path)), copied.candidate.sha256); assert.deepEqual(await fs.readFile(f.sourcePath), source);
  const after = await fs.stat(f.sourcePath); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  const completed = await f.service.validate(prepared.transactionId); assert.equal(completed.state, 'completed'); assert.equal(completed.resultingRevision.mode, 'review-copy');
  assert.equal(completed.originalUnchanged, true); assert.equal(completed.syncBaseUnchanged, true);
  assert.equal((await f.service.validate(prepared.transactionId)).journal.head, completed.journal.head);
});
test('configured destination collision never replaces an existing project', async t => {
  const f = await setup(t), prepared = await f.prepare(); await fs.mkdir(prepared.destination.projectDirectory); const unrelated = path.join(prepared.destination.projectDirectory, 'owner.txt'); await fs.writeFile(unrelated, 'owner');
  await assert.rejects(f.service.publish(prepared.transactionId), /destination-changed/); assert.equal(await fs.readFile(unrelated, 'utf8'), 'owner');
  assert.equal((await f.service.inspect(prepared.transactionId)).state, 'failed');
});
test('same library, unconfigured library and existing project refuse preparation', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.prepare({ review: f.review, sourcePath: f.sourcePath, destinationLibraryRoot: f.sourceRoot }), /different-canonical-library/);
  // A separate service is needed because the test adapter owns one snapshot path.
  const g = await setup(t), unrelated = await g.directory('unconfigured');
  await assert.rejects(g.service.prepare({ review: g.review, sourcePath: g.sourcePath, destinationLibraryRoot: unrelated }), /destination-library-unconfigured/);
});
test('changed sync base, current review and candidate bytes stop before publication', async t => {
  for (const mode of ['sync', 'review', 'candidate']) {
    const f = await setup(t), prepared = await f.prepare();
    if (mode === 'sync') f.setSyncBase({ selectedBranch: 'main', head: 'new-head' });
    if (mode === 'review') f.setReviewVerified(false);
    if (mode === 'candidate') await fs.appendFile(prepared.candidate.path, 'tamper');
    await assert.rejects(f.service.publish(prepared.transactionId)); assert.equal(await fs.lstat(prepared.destination.projectDirectory).catch(e => e.code), 'ENOENT');
  }
});
test('interrupted publication retains owned output and recovery never replays or deletes it', async t => {
  const f = await setup(t), prepared = await f.prepare(); f.setCheckpoint(async phase => { if (phase === 'directory-created') throw Error('simulated-interruption'); });
  await assert.rejects(f.service.publish(prepared.transactionId), /simulated-interruption/);
  const restarted = createClosedProjectReviewCopy(f.options), recovered = await restarted.recover(prepared.transactionId);
  assert.equal(recovered.recovery.classification, 'incomplete-owned-copy'); assert.equal(recovered.recovery.neverReplayPublication, true);
  assert.deepEqual(await fs.readdir(prepared.destination.projectDirectory), []); await assert.rejects(restarted.publish(prepared.transactionId), /already-started/);
});
test('lost acknowledgement after file publication recovers the candidate without copying again', async t => {
  const f = await setup(t), prepared = await f.prepare(); f.setCheckpoint(async phase => { if (phase === 'file-published') throw Error('ack-lost'); });
  await assert.rejects(f.service.publish(prepared.transactionId), /ack-lost/);
  const restarted = createClosedProjectReviewCopy(f.options), recovered = await restarted.recover(prepared.transactionId);
  assert.equal(recovered.recovery.classification, 'candidate-needs-editor-validation'); assert.equal(recovered.recovery.mayValidate, true);
  const finished = await restarted.validate(prepared.transactionId); assert.equal(finished.state, 'completed');
});
test('authenticated journals, divergent output and missing native proof fail closed', async t => {
  const f = await setup(t), prepared = await f.prepare(), copied = await f.service.publish(prepared.transactionId);
  await fs.appendFile(copied.destination.path, 'user-edit'); assert.equal((await f.service.recover(prepared.transactionId)).recovery.classification, 'unowned-or-diverged-copy');
  await assert.rejects(f.service.validate(prepared.transactionId), /validation-not-ready/);
  const event = path.join(f.options.directory, 'transactions', prepared.transactionId, '000000.json'); const value = JSON.parse(await fs.readFile(event)); value.record.plan.edit.newName = 'Forged'; await fs.writeFile(event, JSON.stringify(value));
  await assert.rejects(f.service.inspect(prepared.transactionId), /journal-invalid/);
});
test('source replacement with identical bytes is refused by original inode identity', async t => {
  const f = await setup(t), prepared = await f.prepare(), replacement = f.sourcePath + '.new'; await fs.copyFile(f.sourcePath, replacement); await fs.rename(replacement, f.sourcePath);
  await assert.rejects(f.service.publish(prepared.transactionId), /original-identity-changed/);
});
test('native verification cannot complete with only a matching name or omitted actual-file proof', async t => {
  const f = await setup(t), prepared = await f.prepare(); await f.service.publish(prepared.transactionId);
  const service = createClosedProjectReviewCopy({ ...f.options, verifyEditor: async () => ({ verified: true, closed: true, name: prepared.plan.edit.newName }) });
  await assert.rejects(service.validate(prepared.transactionId), /editor-proof-unverified/); assert.equal((await service.inspect(prepared.transactionId)).state, 'validation-failed');
});
test('prepared copy cancellation retains private artifacts and performs no project write', async t => {
  const f = await setup(t), record = await f.prepare(), cancelled = await f.service.cancel(record.transactionId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(sha(await fs.readFile(record.candidate.path)), record.candidate.sha256);
  assert.equal(await fs.stat(record.destination.projectDirectory).catch(e => e.code), 'ENOENT'); await assert.rejects(f.service.publish(record.transactionId), /already-started/);
});
test('interruption before candidate work leaves discoverable preparation intent and can be safely cancelled', async t => {
  const f = await setup(t); f.setCheckpoint(async phase => { if (phase === 'preparation-intent') throw Error('interrupted-preparation'); });
  await assert.rejects(f.prepare(), /interrupted-preparation/); const ids = await f.service.listTransactionIds(); assert.equal(ids.length, 1);
  const record = await f.service.inspect(ids[0]); assert.equal(record.failedPhase, 'preparing'); assert.equal(record.candidate, null);
  assert.equal((await f.service.recover(ids[0])).recovery.classification, 'destination-absent'); assert.equal((await f.service.cancel(ids[0])).state, 'cancelled');
});
test('destination library must already be selected so opening the copy cannot drift the configuration binding', async t => {
  const f = await setup(t), config = f.binding.configPath;
  await fs.writeFile(config, `Source:${f.sourceRoot}:*:::DISK\nReview:${f.destinationRoot}::::DISK\n`); f.binding.configSha256 = sha(await fs.readFile(config));
  await assert.rejects(f.prepare(), /destination-library-not-selected/);
});
test('a foreign Project.db appearing after owned directory creation is never replaced', async t => {
  const f = await setup(t), record = await f.prepare();
  f.setCheckpoint(async phase => { if (phase === 'directory-created') await fs.writeFile(record.destination.path, 'foreign project', { flag: 'wx', mode: 0o600 }); });
  await assert.rejects(f.service.publish(record.transactionId), /output-directory-changed/);
  assert.equal(await fs.readFile(record.destination.path, 'utf8'), 'foreign project');
  assert.equal((await f.service.recover(record.transactionId)).recovery.classification, 'unowned-or-diverged-copy');
});
test('source mutation after publication intent is detected before the candidate becomes visible', async t => {
  const f = await setup(t), record = await f.prepare();
  f.setCheckpoint(async phase => { if (phase === 'publication-intent') await fs.appendFile(f.sourcePath, 'external edit'); });
  await assert.rejects(f.service.publish(record.transactionId));
  assert.equal(await fs.lstat(record.destination.path).catch(e => e.code), 'ENOENT');
  assert.equal((await fs.readFile(f.sourcePath)).subarray(-13).toString(), 'external edit');
  assert.equal((await f.service.inspect(record.transactionId)).state, 'publication-unverified');
});
test('overlapping publish calls serialize per transaction and cannot duplicate a project', async t => {
  const f = await setup(t), record = await f.prepare(); let release, started;
  const held = new Promise(r => { release = r; }), began = new Promise(r => { started = r; });
  f.setCheckpoint(async phase => { if (phase === 'publication-intent') { started(); await held; } });
  const first = f.service.publish(record.transactionId); await began;
  const second = createClosedProjectReviewCopy(f.options); await assert.rejects(second.publish(record.transactionId), /operation-in-progress/);
  release(); assert.equal((await first).state, 'published-awaiting-editor');
  assert.deepEqual(await fs.readdir(record.destination.projectDirectory), ['Project.db']);
});
test('the same reviewed source can prepare into another selected library without reusing a stale configuration context', async t => {
  const f = await setup(t), service = createClosedProjectReviewCopy({ ...f.options, originalAdapter: undefined });
  const first = await service.prepare({ review: f.review, sourcePath: f.sourcePath, destinationLibraryRoot: f.destinationRoot }); await service.cancel(first.transactionId);
  const third = path.join(f.root, 'third-library'); await fs.mkdir(path.join(third, 'Resolve Projects/Users/guest/Projects'), { recursive: true, mode: 0o700 });
  await fs.writeFile(f.binding.configPath, `Source:${f.sourceRoot}::::DISK\nReview:${f.destinationRoot}::::DISK\nThird:${third}:*:::DISK\n`); f.binding.configSha256 = sha(await fs.readFile(f.binding.configPath));
  const second = await service.prepare({ review: f.review, sourcePath: f.sourcePath, destinationLibraryRoot: third });
  assert.equal(first.plan.planId, second.plan.planId); assert.notEqual(first.sourcePlanNamespace, second.sourcePlanNamespace);
  assert.equal((await service.publish(second.transactionId)).state, 'published-awaiting-editor');
});
test('fresh configured empty library creates Projects only after durable publication intent', async t => {
  const f = await setup(t), projects = path.join(f.destinationRoot, 'Resolve Projects/Users/guest/Projects');
  await fs.rmdir(projects); await fs.writeFile(path.join(path.dirname(projects), 'User.db'), 'fixture-user-db', { mode: 0o600 });
  const record = await f.prepare(); assert.equal(record.destination.projectsMissingInitially, true); assert.equal(await fs.lstat(projects).catch(e => e.code), 'ENOENT');
  const copied = await f.service.publish(record.transactionId); assert.equal(copied.state, 'published-awaiting-editor'); assert.ok(copied.ownedProjectsDirectoryIdentity);
  assert.equal(sha(await fs.readFile(copied.destination.path)), copied.candidate.sha256);
});
test('actual process death after copy publication retains intent and stale locks recover without replay', async t => {
  const { spawnSync } = require('node:child_process');
  const f = await setup(t), record = await f.prepare(), script = path.join(f.root, 'crash-copy.cjs');
  await fs.writeFile(script, `
const fs=require('node:fs/promises'),{createHash}=require('node:crypto');
const {createClosedProjectReviewCopy}=require(${JSON.stringify(path.resolve(__dirname, '../src/closed-project-review-copy'))});
const input=JSON.parse(process.argv[2]),record=input.record,hash=b=>createHash('sha256').update(b).digest('hex');
const guard={async inspect({sourcePath,expectedSourceHash}){const bytes=await fs.readFile(sourcePath),s=await fs.stat(sourcePath);if(expectedSourceHash&&hash(bytes)!==expectedSourceHash)throw Error('stale');return{schemaVersion:1,sourcePath,sha256:hash(bytes),size:bytes.length,identity:{device:String(s.dev),inode:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs},directoryIdentity:{},metadata:record.original.metadata,installedBuild:{version:'test-only'},freshObservationOnly:true,safeToApply:false};},async inspectFileMetadata(file){const s=await fs.stat(file);return{...record.original.metadata,mode:s.mode&0o7777,uid:s.uid,gid:s.gid};}};
const service=createClosedProjectReviewCopy({directory:input.directory,getCurrentReview:async()=>{throw Error('unused');},getSyncBase:async()=>record.syncBase,guard,originalAdapter:{verifyPlan:async()=>true},sourceBindingService:{prepareClosedProjectSourceBinding:async()=>record.original.binding},mediaPolicy:async()=>record.mediaPolicy,onCheckpoint:async phase=>{if(phase==='file-published')process.exit(73);}});
service.publish(record.transactionId).catch(e=>{console.error(e);process.exit(1);});
`, { mode: 0o600 });
  const child = spawnSync(process.execPath, [script, JSON.stringify({ directory: f.options.directory, record })], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 73, child.stderr); const recovered = await f.service.recover(record.transactionId);
  assert.equal(recovered.state, 'publishing'); assert.equal(recovered.recovery.classification, 'candidate-needs-editor-validation');
  assert.equal((await f.service.validate(record.transactionId)).state, 'completed');
  assert.equal(sha(await fs.readFile(f.sourcePath)), record.original.sha256); assert.deepEqual(await fs.readdir(record.destination.projectDirectory), ['Project.db']);
});
test('a complete native receipt borrowed from another transaction or plan cannot complete this copy', async t => {
  const f = await setup(t), prepared = await f.prepare(); await f.service.publish(prepared.transactionId);
  for (const foreign of [{ transactionId: '00000000-0000-4000-8000-000000000001' }, { planId: '0'.repeat(64) }]) {
    const service = createClosedProjectReviewCopy({ ...f.options, verifyEditor: async args => ({ ...await f.options.verifyEditor(args), ...foreign }) });
    await assert.rejects(service.validate(prepared.transactionId), /editor-proof-unverified/);
  }
  assert.equal((await f.service.validate(prepared.transactionId)).state, 'completed');
});
