'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { closedProjectFixture, sha } = require('./helpers/closed-project-apply-fixture');
const { createClosedProjectApplyAdapter } = require('../src/closed-project-apply-adapter');
const { createClosedProjectApplyTransaction } = require('../src/closed-project-apply-transaction');
async function setup(t) {
  const f = await closedProjectFixture(t), calls = [];
  let currentReview = f.review;
  const publisher = async ({ plan, sourcePath, expectedSource, artifact, transactionId, direction, originalMetadata }) => {
    calls.push(`publish:${direction}`);
    assert.deepEqual(originalMetadata, f.metadata);
    assert.equal(sha(await fs.readFile(sourcePath)), expectedSource.sha256);
    const staged = `${sourcePath}.stage`; await fs.copyFile(artifact.path, staged); await fs.rename(staged, sourcePath);
    return { transactionId, planId: plan.planId, direction, sourceSha256: artifact.sha256, atomic: true,
      applicationSourceLockHeld: true, editorOfflineRechecked: true, concurrentWriterResistanceProven: false, metadataPreserved: true };
  };
  const binding = { schemaVersion: 1, sourcePath: f.sourcePath, projectName: f.fixture.projectName,
    libraryRoot: f.root, configPath: path.join(f.root, 'dblist.conf'), configSha256: sha('fixture-config'),
    expectedCurrentDatabase: { DbType: 'Disk', DbName: 'Fixture Library' }, expectedCurrentFolder: 'Root' };
  async function openObservation(expectedSha256) {
    const bytes = await fs.readFile(f.sourcePath), stat = await fs.stat(f.sourcePath);
    assert.equal(sha(bytes), expectedSha256);
    return { schemaVersion: 1, actualOpenFileBindingVerified: true, concurrentWriterResistanceProven: false,
      process: { pid: 100, started: 'test', command: 'test-only-Resolve' }, configSha256: binding.configSha256,
      source: { path: f.sourcePath, sha256: sha(bytes), device: String(stat.dev), inode: String(stat.ino), size: bytes.length } };
  }
  const sourceBindingService = {
    async prepareClosedProjectSourceBinding() { return structuredClone(binding); },
    async observeLoadedProjectSource({ expectedSha256 }) { calls.push('observe-open'); return openObservation(expectedSha256); }
  };
  const companion = {
    async prepareClosedProjectApplyCompanion(binding) {
      calls.push('prepare-editor');
      // The real companion owns creation; precreating this directory is an error.
      await fs.mkdir(binding.directory, { mode: 0o700 });
      const preparationPath = path.join(binding.directory, 'preparation.json');
      await fs.writeFile(preparationPath, JSON.stringify(binding), { mode: 0o600 });
      return { preparationPath, scriptPath: path.join(binding.directory, 'check.lua') };
    },
    async readClosedProjectApplyCompanion(preparationPath, expected) {
      calls.push('read-editor');
      const binding = JSON.parse(await fs.readFile(preparationPath));
      for (const key of Object.keys(expected)) assert.deepEqual(binding[key], expected[key]);
      return { status: 'verified-open', transactionId: expected.transactionId, planId: expected.planId, actualOpenFileBindingVerified: true, sourceBinding: await openObservation(expected.expectedDatabaseSha256), hostAdmissionReceiptSha256: sha('host-admission') };
    }
  };
  const options = { directory: path.join(f.root, 'adapter'), getCurrentReview: () => currentReview, guard: f.guard, publishFile: publisher, companion, sourceBindingService };
  const adapter = createClosedProjectApplyAdapter(options);
  const service = createClosedProjectApplyTransaction({ directory: path.join(f.root, 'transactions'), adapter, verifyPlan: adapter.verifyPlan });
  return { ...f, options, adapter, service, calls, binding, setReview(value) { currentReview = value; } };
}

test('real native Name plan, exact backup, candidate census and authenticated adapter context work through Apply and rollback', async t => {
  const f = await setup(t), before = await fs.readFile(f.sourcePath);
  const plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const prepared = await f.service.prepare(plan), applied = await f.service.apply(prepared.transactionId);
  assert.equal(applied.state, 'pending-editor-validation');
  const check = { plan, transactionId: prepared.transactionId, direction: 'apply', expectedSource: applied.candidate };
  await f.adapter.prepareEditorCheck(check);
  assert.equal((await f.service.validate(prepared.transactionId)).state, 'completed');
  const rolled = await f.service.rollback(prepared.transactionId);
  await f.adapter.prepareEditorCheck({ plan, transactionId: prepared.transactionId, direction: 'rollback', expectedSource: rolled.source });
  assert.equal((await f.service.validate(prepared.transactionId)).state, 'rolled-back');
  assert.deepEqual(await fs.readFile(f.sourcePath), before);
  assert.deepEqual(await fs.readFile(applied.backup.path), before);
  assert.deepEqual(f.calls.filter(value => value.startsWith('publish')), ['publish:apply', 'publish:rollback']);
});

test('adapter restart retains private bindings; completed candidate still requires actual readback and final metadata', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const prepared = await f.service.prepare(plan), applied = await f.service.apply(prepared.transactionId);
  const restarted = createClosedProjectApplyAdapter(f.options);
  await assert.rejects(restarted.verifyEditor({ plan, transactionId: prepared.transactionId, direction: 'apply', expectedSource: applied.candidate }), /ENOENT/);
  const check = { plan, transactionId: prepared.transactionId, direction: 'apply', expectedSource: applied.candidate };
  const first = await restarted.prepareEditorCheck(check);
  assert.deepEqual(await restarted.prepareEditorCheck(check), first);
  assert.equal(f.calls.filter(value => value === 'prepare-editor').length, 1);
  f.metadata.extendedAttributes.push({ name: 'changed', valueHex: '01', bytes: 1 });
  await assert.rejects(restarted.verifyEditor(check), /apply-source-metadata-changed/);
});

test('changed current review cannot reuse retained reviewed plan', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  f.setReview({ ...f.review, sources: { ...f.review.sources, incoming: Buffer.concat([f.review.sources.incoming, Buffer.from(' ')]) } });
  await assert.rejects(f.service.prepare(plan), /invalid-reviewed-rename/);
  assert.equal(f.calls.some(value => value.startsWith('publish')), false);
});

test('retained context tampering cannot redirect source or trusted metadata', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const file = path.join(f.options.directory, 'plans', plan.planId, 'context.json');
  const envelope = JSON.parse(await fs.readFile(file));
  const context = JSON.parse(envelope.body); context.sourcePath = path.join(f.root, 'other.db');
  envelope.body = JSON.stringify(context); await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(f.adapter.inspectSource({ plan }), /apply-context-invalid/);
  assert.equal(f.calls.some(value => value.startsWith('publish')), false);
});

test('plan field mutation fails authenticated host binding even if planId is retained', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  await assert.rejects(f.adapter.inspectSource({ plan: { ...plan, edit: { ...plan.edit, newName: 'injected' } } }), /apply-context-plan-mismatch/);
});

test('interactive admission observes actual opened source; passive reads never issue an admission ticket', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const record = await f.service.prepare(plan), applied = await f.service.apply(record.transactionId);
  const check = { plan, transactionId: record.transactionId, direction: 'apply', expectedSource: applied.candidate };
  await f.adapter.prepareEditorCheck(check);
  let admitted = false;
  const original = f.options.companion.readClosedProjectApplyCompanion;
  f.options.companion.readClosedProjectApplyCompanion = async (...args) => admitted ? original(...args) : { status: 'pending', started: true };
  f.options.companion.admitClosedProjectApplyCompanion = async (file, { observeSource, expectedBinding }) => {
    const observation = await observeSource({ binding: expectedBinding.sourceBinding, expectedSha256: expectedBinding.expectedDatabaseSha256 });
    assert.equal(observation.actualOpenFileBindingVerified, true); admitted = true;
    return { admitted: true, receiptSha256: sha('host-admission') };
  };
  assert.equal((await f.adapter.readEditorCheck(check)).status, 'pending');
  assert.equal(f.calls.includes('observe-open'), false);
  assert.equal((await f.adapter.readEditorCheck({ ...check, admit: true })).status, 'verified-open');
  assert.equal(f.calls.filter(value => value === 'observe-open').length, 1);
  assert.equal((await f.service.validate(record.transactionId)).state, 'completed');
  assert.equal(f.calls.filter(value => value === 'observe-open').length, 1);
});

test('an editor UUID/Name echo without actual open-file admission cannot complete', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const record = await f.service.prepare(plan), applied = await f.service.apply(record.transactionId);
  const check = { plan, transactionId: record.transactionId, direction: 'apply', expectedSource: applied.candidate };
  await f.adapter.prepareEditorCheck(check);
  f.options.companion.readClosedProjectApplyCompanion = async () => ({ status: 'verified-open', editorVerified: true });
  await assert.rejects(f.adapter.verifyEditor(check), /apply-editor-readback-required/);
});

test('configured library identity drift refuses a retained plan before backup or publication', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const record = await f.service.prepare(plan);
  f.binding.configSha256 = sha('changed configuration');
  await assert.rejects(f.service.apply(record.transactionId), /apply-source-library-binding-changed/);
  assert.equal(f.calls.some(value => value.startsWith('publish')), false);
});

test('explicit offline preparation replaces a failed one-use check while retaining old evidence and authenticated pointer history', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const record = await f.service.prepare(plan), applied = await f.service.apply(record.transactionId);
  const check = { plan, transactionId: record.transactionId, direction: 'apply', expectedSource: applied.candidate };
  const first = await f.adapter.prepareEditorCheck(check), originalBytes = await fs.readFile(first.preparationPath);
  const originalRead = f.options.companion.readClosedProjectApplyCompanion;
  f.options.companion.readClosedProjectApplyCompanion = async (file, binding) => file === first.preparationPath
    ? { status: 'native-error', stage: 'editor-identity', doNotReplay: true } : originalRead(file, binding);
  const second = await f.adapter.prepareEditorCheck(check);
  assert.notEqual(second.preparationPath, first.preparationPath);
  assert.deepEqual(await fs.readFile(first.preparationPath), originalBytes);
  assert.equal((await f.adapter.readEditorCheck(check)).status, 'verified-open');
  assert.equal((await f.service.validate(record.transactionId)).state, 'completed');
  const parent = path.dirname(path.dirname(second.preparationPath));
  const pointers = (await fs.readdir(parent)).filter(value => value.startsWith('current-')).sort();
  assert.deepEqual(pointers, ['current-000000.json', 'current-000001.json']);
  const latest = JSON.parse(JSON.parse(await fs.readFile(path.join(parent, pointers[1]))).body);
  assert.equal(latest.reason, 'native-error'); assert.match(latest.previous, /^[a-f0-9]{64}$/);
});

test('started or unreadable abandoned checks can only get a new attempt after a fresh offline guard', async t => {
  for (const mode of ['started', 'unreadable']) {
    await t.test(mode, async t => {
      const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
      const record = await f.service.prepare(plan), applied = await f.service.apply(record.transactionId);
      const check = { plan, transactionId: record.transactionId, direction: 'apply', expectedSource: applied.candidate };
      const first = await f.adapter.prepareEditorCheck(check);
      f.options.companion.readClosedProjectApplyCompanion = async () => {
        if (mode === 'unreadable') throw new SyntaxError('Partial result after interruption');
        return { status: 'pending', started: true, doNotReplay: true };
      };
      const originalGuard = f.guard.inspect;
      f.guard.inspect = async () => { throw new Error('closed-project-resolve-running'); };
      await assert.rejects(f.adapter.prepareEditorCheck(check), /closed-project-resolve-running/);
      assert.equal(f.calls.filter(value => value === 'prepare-editor').length, 1);
      f.guard.inspect = originalGuard;
      const second = await f.adapter.prepareEditorCheck(check);
      assert.notEqual(second.preparationPath, first.preparationPath);
      assert.equal((await fs.stat(first.preparationPath)).isFile(), true);
    });
  }
});

test('an unused check is reused, and a tampered current pointer cannot authorize a new attempt or readback', async t => {
  const f = await setup(t), plan = await f.adapter.createPlan({ review: f.review, source: f.sourcePath });
  const record = await f.service.prepare(plan), applied = await f.service.apply(record.transactionId);
  const check = { plan, transactionId: record.transactionId, direction: 'apply', expectedSource: applied.candidate };
  const first = await f.adapter.prepareEditorCheck(check);
  f.options.companion.readClosedProjectApplyCompanion = async () => ({ status: 'pending', started: false, doNotReplay: false });
  assert.deepEqual(await f.adapter.prepareEditorCheck(check), first);
  assert.equal(f.calls.filter(value => value === 'prepare-editor').length, 1);
  const pointerPath = path.join(path.dirname(path.dirname(first.preparationPath)), 'current-000000.json');
  const wrapper = JSON.parse(await fs.readFile(pointerPath));
  wrapper.body = wrapper.body.replace('"reason":"initial"', '"reason":"tampered"');
  await fs.writeFile(pointerPath, JSON.stringify(wrapper));
  await assert.rejects(f.adapter.readEditorCheck(check), /apply-context-invalid/);
  await assert.rejects(f.adapter.prepareEditorCheck(check), /apply-context-invalid/);
});
