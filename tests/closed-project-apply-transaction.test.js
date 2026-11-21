'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createClosedProjectApplyTransaction } = require('../src/closed-project-apply-transaction');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oldBytes = Buffer.from('{"Name":"old","unknown":"opaque"}');
const newBytes = Buffer.from('{"Name":"new","unknown":"opaque"}');
function plan() {
  return { schemaVersion: 1, operation: 'closed-project-name-apply-plan', planId: hash('plan'),
    adapterProfile: 'resolve-free-21.1.2-closed-name-v1', projectId: 'project-uuid', projectName: 'Project',
    source: { sha256: hash(oldBytes), bytes: oldBytes.length, censusSha256: hash('census') },
    sourceBindings: { local: hash('local'), incoming: hash('incoming'), base: hash('base') },
    review: { planHash: hash('review-plan'), auditHash: hash('audit'), choices: [] },
    edit: { timelineId: 'timeline-uuid', itemId: 'item-uuid', trackId: 'track-uuid', sequenceId: 'sequence-uuid', kind: 'video', field: 'Name', oldName: 'old', newName: 'new' },
    mediaPolicy: 'unchanged-references', requires: { freshClosedSource: true, applicationSerializedPublication: true,
      fullCellComparison: true, editorReopen: true, postCloseValidation: true } };
}
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'closed-apply-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourcePath = path.join(base, 'Project.db'), directory = path.join(base, 'transactions');
  await fs.writeFile(sourcePath, oldBytes, { mode: 0o600 });
  const calls = [];
  const adapter = {
    async inspectSource() { return { path: sourcePath }; },
    async createBackup({ directory }) { calls.push('backup'); const file = path.join(directory, 'backup.db'); await fs.copyFile(sourcePath, file); await fs.chmod(file, 0o600); return { path: file }; },
    async createCandidate({ directory }) { calls.push('candidate'); const file = path.join(directory, 'candidate.db'); await fs.writeFile(file, newBytes, { mode: 0o600 }); return { path: file }; },
    async verifyPreservation({ plan, backup, candidate }) { calls.push('preservation'); return { verified: true, planId: plan.planId, sourceSha256: backup.sha256, candidateSha256: candidate.sha256, changedFields: 1, proofSha256: hash('preservation') }; },
    async publish({ plan, expectedSource, artifact, direction, transactionId }) {
      calls.push(`publish:${direction}`);
      assert.equal(hash(await fs.readFile(sourcePath)), expectedSource.sha256, 'adapter repeats stale check under owned lock');
      const staged = `${sourcePath}.new`; await fs.copyFile(artifact.path, staged); await fs.rename(staged, sourcePath);
      return { transactionId, planId: plan.planId, direction, sourceSha256: artifact.sha256, atomic: true,
        applicationSourceLockHeld: true, editorOfflineRechecked: true, concurrentWriterResistanceProven: false, metadataPreserved: true };
    },
    async verifyEditor({ plan, expectedSource, direction, transactionId }) {
      calls.push(`editor:${direction}`);
      return { verified: true, closed: true, metadataPreserved: true, proofSha256: hash('editor'), transactionId, planId: plan.planId,
        direction, sourceSha256: expectedSource.sha256, projectId: plan.projectId, timelineId: plan.edit.timelineId,
        itemId: plan.edit.itemId, name: direction === 'rollback' ? plan.edit.oldName : plan.edit.newName };
    }
  };
  const options = { directory, adapter, verifyPlan: async () => true };
  const service = createClosedProjectApplyTransaction(options);
  return { base, sourcePath, directory, adapter, calls, options, service, plan: plan() };
}

test('scoped Apply retains exact backup and binds reviewed decisions; success needs separate editor verification', async t => {
  const f = await fixture(t);
  const prepared = await f.service.prepare(f.plan);
  assert.equal(prepared.state, 'prepared');
  assert.deepEqual(prepared.plan.review, f.plan.review);
  const applied = await f.service.apply(prepared.transactionId);
  assert.equal(applied.state, 'pending-editor-validation');
  assert.equal(f.calls.some(value => value.startsWith('editor')), false);
  assert.deepEqual(await fs.readFile(applied.backup.path), oldBytes);
  assert.deepEqual(await fs.readFile(f.sourcePath), newBytes);
  const completed = await f.service.validate(prepared.transactionId);
  assert.equal(completed.state, 'completed');
  assert.equal((await f.service.recover(prepared.transactionId)).recovery.classification, 'verified-complete');
  await assert.rejects(f.service.apply(prepared.transactionId), /apply-already-started/);
  assert.deepEqual(await f.service.validate(prepared.transactionId), completed);
  assert.deepEqual(await f.service.listTransactionIds(), [prepared.transactionId]);
});

test('plan validation rejects unsupported operations and verifier refusal before any backup', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare({ ...f.plan, edit: { ...f.plan.edit, field: 'Start' } }), /apply-unsupported-plan/);
  const denied = createClosedProjectApplyTransaction({ ...f.options, verifyPlan: () => false });
  await assert.rejects(denied.prepare(f.plan), /apply-plan-verification-failed/);
  assert.deepEqual(f.calls, []);
});

test('source changes after planning fail without candidate publication', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  await fs.writeFile(f.sourcePath, 'other project');
  await assert.rejects(f.service.apply(record.transactionId), /apply-source-changed/);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.service.inspect(record.transactionId)).state, 'failed');
  assert.equal((await f.service.recover(record.transactionId)).recovery.classification, 'diverged-manual-review');
});

test('current review verification runs again at Apply', async t => {
  const f = await fixture(t);
  let current = true;
  const service = createClosedProjectApplyTransaction({ ...f.options, verifyPlan: () => current });
  const record = await service.prepare(f.plan); current = false;
  await assert.rejects(service.apply(record.transactionId), /apply-plan-verification-failed/);
  assert.deepEqual(f.calls, []);
});

test('backup aliases, preservation failure and candidate tampering cannot publish', async t => {
  for (const mode of ['alias', 'preservation', 'tamper']) {
    await t.test(mode, async t => {
      const f = await fixture(t), record = await f.service.prepare(f.plan);
      if (mode === 'alias') f.adapter.createBackup = async () => ({ path: f.sourcePath });
      else {
        const original = f.adapter.verifyPreservation;
        f.adapter.verifyPreservation = async context => {
          const result = await original(context);
          if (mode === 'tamper') await fs.writeFile(context.candidate.path, 'tampered');
          return { ...result, verified: mode !== 'preservation' };
        };
      }
      await assert.rejects(f.service.apply(record.transactionId));
      assert.equal(f.calls.some(value => value.startsWith('publish')), false);
      assert.deepEqual(await fs.readFile(f.sourcePath), oldBytes);
    });
  }
});

test('stale source created during preservation check is rejected before publication', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const original = f.adapter.verifyPreservation;
  f.adapter.verifyPreservation = async context => { const proof = await original(context); await fs.writeFile(f.sourcePath, 'external edit'); return proof; };
  await assert.rejects(f.service.apply(record.transactionId), /apply-source-changed/);
  assert.equal(f.calls.some(value => value.startsWith('publish')), false);
});

test('source race at publication boundary is rejected by trusted adapter and never replayed', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const original = f.adapter.publish;
  f.adapter.publish = async context => { await fs.writeFile(f.sourcePath, 'external edit'); return original(context); };
  await assert.rejects(f.service.apply(record.transactionId));
  assert.equal((await f.service.inspect(record.transactionId)).state, 'publication-unverified');
  const resumed = createClosedProjectApplyTransaction(f.options);
  assert.equal((await resumed.recover(record.transactionId)).recovery.classification, 'diverged-manual-review');
  await assert.rejects(resumed.rollback(record.transactionId), /apply-rollback-not-ready/);
  await assert.rejects(resumed.apply(record.transactionId), /apply-already-started/);
  assert.equal((await fs.readFile(f.sourcePath)).toString(), 'external edit');
});

test('publish failure after replacement recovers exact candidate without repeating the write', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const original = f.adapter.publish;
  f.adapter.publish = async context => { await original(context); throw new Error('adapter-disconnected'); };
  await assert.rejects(f.service.apply(record.transactionId), /adapter-disconnected/);
  const resumed = createClosedProjectApplyTransaction(f.options);
  const recovered = await resumed.recover(record.transactionId);
  assert.equal(recovered.recovery.classification, 'candidate-needs-editor-validation');
  assert.equal(recovered.recovery.mayValidate, true);
  assert.equal(f.calls.filter(value => value === 'publish:apply').length, 1);
  assert.equal((await resumed.validate(record.transactionId)).state, 'completed');
});

test('editor claims must bind transaction, project/item/name, exact bytes and fresh post-close file', async t => {
  for (const mode of ['wrong-name', 'wrong-transaction', 'changed-file']) {
    await t.test(mode, async t => {
      const f = await fixture(t), record = await f.service.prepare(f.plan);
      await f.service.apply(record.transactionId);
      const original = f.adapter.verifyEditor;
      f.adapter.verifyEditor = async context => {
        const proof = await original(context);
        if (mode === 'changed-file') await fs.writeFile(f.sourcePath, 'editor normalization');
        return { ...proof, ...(mode === 'wrong-name' ? { name: 'other' } : {}), ...(mode === 'wrong-transaction' ? { transactionId: 'other' } : {}) };
      };
      await assert.rejects(f.service.validate(record.transactionId));
      assert.equal((await f.service.inspect(record.transactionId)).state, 'validation-failed');
      assert.deepEqual(await fs.readFile((await f.service.inspect(record.transactionId)).backup.path), oldBytes);
    });
  }
});

test('rollback is candidate-guarded, keeps backup, requires its own editor check and cannot replay', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const applied = await f.service.apply(record.transactionId);
  const rolled = await f.service.rollback(record.transactionId);
  assert.equal(rolled.state, 'pending-rollback-editor-validation');
  assert.deepEqual(await fs.readFile(f.sourcePath), oldBytes);
  assert.deepEqual(await fs.readFile(applied.backup.path), oldBytes);
  assert.equal((await f.service.recover(record.transactionId)).recovery.classification, 'original-needs-editor-validation');
  assert.equal((await f.service.validate(record.transactionId)).state, 'rolled-back');
  await assert.rejects(f.service.rollback(record.transactionId), /apply-rollback-not-ready/);
  await assert.rejects(f.service.apply(record.transactionId), /apply-already-started/);
});

test('failed rollback editor validation retries validation of original, never applies candidate again', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  await f.service.apply(record.transactionId); await f.service.rollback(record.transactionId);
  const original = f.adapter.verifyEditor;
  f.adapter.verifyEditor = async () => { throw new Error('editor-unavailable'); };
  await assert.rejects(f.service.validate(record.transactionId), /editor-unavailable/);
  f.adapter.verifyEditor = original;
  assert.equal((await f.service.validate(record.transactionId)).state, 'rolled-back');
  assert.equal(f.calls.filter(value => value === 'publish:apply').length, 1);
});

test('journal edits, reordered records and symlink substitution fail closed', async t => {
  for (const mode of ['edit', 'reorder', 'symlink']) {
    await t.test(mode, async t => {
      const f = await fixture(t), record = await f.service.prepare(f.plan);
      const file = path.join(f.directory, record.transactionId, '000000.json');
      if (mode === 'edit') {
        const event = JSON.parse(await fs.readFile(file, 'utf8')); event.record.plan.edit.newName = 'attacker';
        await fs.writeFile(file, JSON.stringify(event));
      } else if (mode === 'reorder') await fs.rename(file, path.join(path.dirname(file), '000001.json'));
      else { const moved = `${file}.original`; await fs.rename(file, moved); await fs.symlink(moved, file); }
      await assert.rejects(f.service.inspect(record.transactionId));
      assert.deepEqual(await fs.readFile(f.sourcePath), oldBytes);
    });
  }
});

test('different transactions for one source cannot run concurrently', async t => {
  const f = await fixture(t), a = await f.service.prepare(f.plan), b = await f.service.prepare(f.plan);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const original = f.adapter.createBackup;
  f.adapter.createBackup = async context => { entered(); await blocked; return original(context); };
  const running = f.service.apply(a.transactionId); await waiting;
  const other = createClosedProjectApplyTransaction(f.options);
  await assert.rejects(other.apply(b.transactionId), /apply-operation-in-progress/);
  release(); await running;
  assert.equal((await f.service.inspect(b.transactionId)).state, 'prepared');
});

test('prepared cancellation is durable and cannot cancel a published transaction', async t => {
  const f = await fixture(t), a = await f.service.prepare(f.plan), b = await f.service.prepare(f.plan);
  assert.equal((await f.service.cancel(a.transactionId)).state, 'cancelled');
  await assert.rejects(f.service.apply(a.transactionId), /apply-already-started/);
  await f.service.apply(b.transactionId);
  await assert.rejects(f.service.cancel(b.transactionId), /apply-cancellation-not-ready/);
});

test('actual process death after atomic replacement leaves recoverable intent and retains backup', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const modulePath = require.resolve('../src/closed-project-apply-transaction');
  const script = `
    const fs=require('node:fs/promises'); const path=require('node:path');
    const {createClosedProjectApplyTransaction}=require(${JSON.stringify(modulePath)});
    const source=${JSON.stringify(f.sourcePath)}, directory=${JSON.stringify(f.directory)};
    const adapter={
      inspectSource:async()=>({path:source}),
      createBackup:async({directory})=>{const file=path.join(directory,'backup.db');await fs.copyFile(source,file);return {path:file}},
      createCandidate:async({directory})=>{const file=path.join(directory,'candidate.db');await fs.writeFile(file,${JSON.stringify(newBytes.toString())},{mode:0o600});return {path:file}},
      verifyPreservation:async({plan,backup,candidate})=>({verified:true,planId:plan.planId,sourceSha256:backup.sha256,candidateSha256:candidate.sha256,changedFields:1,proofSha256:'${hash('proof')}'}),
      publish:async({artifact})=>{await fs.copyFile(artifact.path,source+'.stage');await fs.rename(source+'.stage',source);process.exit(73)},
      verifyEditor:async()=>{throw Error('never called')}
    };
    createClosedProjectApplyTransaction({directory,adapter,verifyPlan:()=>true}).apply('${record.transactionId}').catch(e=>{process.stderr.write(e.stack);process.exit(2)});
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 73, child.stderr);
  const restarted = createClosedProjectApplyTransaction(f.options);
  assert.equal((await restarted.inspect(record.transactionId)).state, 'publishing');
  assert.equal((await restarted.recover(record.transactionId)).recovery.classification, 'candidate-needs-editor-validation');
  await assert.rejects(restarted.apply(record.transactionId), /apply-already-started/);
  assert.equal((await restarted.validate(record.transactionId)).state, 'completed');
  assert.deepEqual(await fs.readFile((await restarted.inspect(record.transactionId)).backup.path), oldBytes);
});

test('same-byte source replacement after prepare is stale by identity', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  const replacement = `${f.sourcePath}.replacement`;
  await fs.writeFile(replacement, oldBytes, { mode: 0o600 }); await fs.rename(replacement, f.sourcePath);
  await assert.rejects(f.service.apply(record.transactionId), /apply-source-identity-changed/);
  assert.deepEqual(f.calls, []);
});

test('missing metadata proof cannot complete even when editor IDs and project bytes match', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  await f.service.apply(record.transactionId);
  const original = f.adapter.verifyEditor;
  f.adapter.verifyEditor = async context => { const proof = await original(context); delete proof.metadataPreserved; return proof; };
  await assert.rejects(f.service.validate(record.transactionId), /apply-editor-proof-unverified/);
  assert.equal((await f.service.inspect(record.transactionId)).state, 'validation-failed');
});

test('read-only inventory keeps unreadable records visible without hiding corruption', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  await fs.writeFile(path.join(f.directory, record.transactionId, '000000.json'), '{broken');
  const items = await f.service.list();
  assert.equal(items.length, 1); assert.equal(items[0].state, 'unreadable');
  assert.equal(items[0].transactionId, record.transactionId);
  assert.equal(items[0].error, 'apply-invalid-journal');
});

test('native outcome revision records exact bytes, reviewed choices, parent, proof and retained backup without inventing an API snapshot', async t => {
  const f = await fixture(t);
  f.plan.review.choices = [{ timelineId: 'timeline-uuid', itemId: 'item-uuid', field: 'name', choice: 'use-incoming', selectedValue: 'new' }];
  const record = await f.service.prepare(f.plan); await f.service.apply(record.transactionId);
  const complete = await f.service.validate(record.transactionId), revision = complete.resultingRevision;
  assert.equal(revision.kind, 'closed-project-native-revision');
  assert.equal(revision.revisionId, hash(newBytes));
  assert.equal(revision.sourceSha256, hash(newBytes));
  assert.equal(revision.parentSourceSha256, hash(oldBytes));
  assert.equal(revision.bytes, newBytes.length);
  assert.equal(revision.planId, f.plan.planId);
  assert.deepEqual(revision.review, { ...f.plan.review, sourceBindings: f.plan.sourceBindings });
  assert.equal(revision.editorProofSha256, complete.editorProof.proofSha256);
  assert.deepEqual(revision.backup, { path: complete.backup.path, sha256: hash(oldBytes), bytes: oldBytes.length });
  assert.equal(typeof revision.createdAt, 'string');
  assert.equal(Object.hasOwn(revision, 'snapshot'), false);
  assert.deepEqual(complete.nativeRevisions, [revision]);
  const restarted = createClosedProjectApplyTransaction(f.options);
  const events = complete.journal.events, editorCalls = f.calls.filter(value => value.startsWith('editor')).length;
  assert.deepEqual(await restarted.validate(record.transactionId), complete);
  assert.equal((await restarted.inspect(record.transactionId)).journal.events, events);
  assert.equal(f.calls.filter(value => value.startsWith('editor')).length, editorCalls);
  await restarted.rollback(record.transactionId);
  const rollback = await restarted.validate(record.transactionId);
  assert.equal(rollback.resultingRevision.revisionId, hash(oldBytes));
  assert.equal(rollback.resultingRevision.parentSourceSha256, hash(newBytes));
  assert.equal(rollback.resultingRevision.direction, 'rollback');
  assert.deepEqual(rollback.nativeRevisions, [revision, rollback.resultingRevision]);
  assert.deepEqual(await restarted.validate(record.transactionId), rollback);
});

test('128 MiB private backup is accepted independently of the 16 MiB journal record cap', async t => {
  const f = await fixture(t), bytes = 128 * 1024 * 1024;
  const handle = await fs.open(f.sourcePath, 'w');
  try { await handle.truncate(bytes); await handle.sync(); } finally { await handle.close(); }
  const zeroChunk = Buffer.alloc(1024 * 1024), digest = createHash('sha256');
  for (let index = 0; index < 128; index++) digest.update(zeroChunk);
  const expected = digest.digest('hex');
  f.plan.source = { ...f.plan.source, sha256: expected, bytes };
  const prepared = await f.service.prepare(f.plan), applied = await f.service.apply(prepared.transactionId);
  assert.equal(applied.state, 'pending-editor-validation');
  assert.equal(applied.backup.bytes, bytes); assert.equal(applied.backup.sha256, expected);
  assert.equal((await fs.stat(applied.backup.path)).size, bytes);
});

test('rollback cannot adopt an intervening edit as its expected source after journaling intent', async t => {
  const f = await fixture(t), record = await f.service.prepare(f.plan);
  await f.service.apply(record.transactionId);
  const original = f.adapter.inspectSource;
  let changed = false;
  f.adapter.inspectSource = async context => {
    const current = await f.service.inspect(record.transactionId);
    if (!changed && current.state === 'rollback-publishing') {
      changed = true;
      await fs.writeFile(f.sourcePath, 'intervening edit after rollback intent');
    }
    return original(context);
  };
  await assert.rejects(f.service.rollback(record.transactionId), /apply-source-changed/);
  assert.equal(changed, true);
  assert.equal(f.calls.includes('publish:rollback'), false);
  assert.equal((await fs.readFile(f.sourcePath)).toString(), 'intervening edit after rollback intent');
  assert.equal((await f.service.recover(record.transactionId)).recovery.classification, 'diverged-manual-review');
});
