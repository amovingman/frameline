'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopClosedProjectApply } = require('../src/desktop-closed-project-apply');
const id = '00000000-0000-4000-8000-000000000001';
function fixture(options = {}) {
  const calls = [], records = new Map(), checks = new Map();
  let open = false;
  const plan = { projectName: 'Personal edit', projectId: 'project-id', planId: 'a'.repeat(64),
    edit: { itemId: 'item-id', timelineId: 'timeline-id', oldName: 'Before', newName: 'After' } };
  const original = { schemaVersion: 1, transactionId: id, state: 'prepared', plan,
    source: { path: '/private/source/Project.db', sha256: 'a'.repeat(64), bytes: 1 },
    candidate: { path: '/private/candidate.db', sha256: 'b'.repeat(64), bytes: 1 },
    backup: { path: '/private/backup.db', sha256: 'a'.repeat(64), bytes: 1 } };
  function offline() { if (open) throw Object.assign(new Error('private path omitted'), { code: 'closed-project-resolve-running' }); }
  const adapter = {
    async createPlan(input) { calls.push(['plan', input]); offline(); return plan; },
    async prepareEditorCheck(input) { calls.push(['prepare-check', input]); offline(); const result = { menuName: 'Frameline Verify Applied Name test', status: 'pending' }; checks.set(input.transactionId, result); return result; },
    async readEditorCheck(input) { calls.push(['read-check', input]); const result = checks.get(input.transactionId); if (!result) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return result; }
  };
  const transaction = {
    async listTransactionIds() { return [...records.keys()]; },
    async inspect(value) { calls.push(['inspect', value]); return structuredClone(records.get(value)); },
    async prepare(value) { calls.push(['prepare', value]); records.set(id, structuredClone(original)); return records.get(id); },
    async apply(value) { calls.push(['apply', value]); offline(); records.get(value).state = 'pending-editor-validation'; return records.get(value); },
    async recover(value) { calls.push(['recover', value]); offline(); return { ...records.get(value), recovery: { mayValidate: true, mayRollback: true, classification: records.get(value).state === 'pending-rollback-editor-validation' ? 'original-needs-editor-validation' : 'candidate-needs-editor-validation' } }; },
    async validate(value) { calls.push(['validate', value]); offline(); assert.equal(checks.get(value)?.status, 'verified-open'); records.get(value).state = records.get(value).state === 'pending-rollback-editor-validation' ? 'rolled-back' : 'completed'; return records.get(value); },
    async rollback(value) { calls.push(['rollback', value]); offline(); records.get(value).state = 'pending-rollback-editor-validation'; return records.get(value); },
    async cancel(value) { calls.push(['cancel', value]); records.get(value).state = 'cancelled'; return records.get(value); }
  };
  const factory = () => createDesktopClosedProjectApply({ directory: '/private/test-apply',
    getVerifiedReview: async () => ({ secret: 'review-source-bytes' }), chooseSource: async () => '/private/source/Project.db',
    reveal: async value => calls.push(['reveal', value]), adapter, transactionService: transaction, ...options });
  return { controller: factory(), factory, calls, records, checks, adapter, transaction, original,
    setOpen: value => { open = value; } };
}
async function applied(options) { const f = fixture(options); await f.controller.action('initialize'); await f.controller.action('prepare'); await f.controller.action('apply', id); return f; }

test('desktop flow holds review lock until native readback and separate closed-file validation finish', async () => {
  const f = await applied(); let state = f.controller.getState();
  assert.equal(state.transaction.state, 'pending-editor-validation'); assert.equal(state.editorCheck.status, 'ready');
  assert.equal(state.editorCheck.menuName, 'Frameline Verify Applied Name test'); assert.equal(state.reviewLocked, true);
  assert.doesNotMatch(JSON.stringify(state), /\/private\/|review-source-bytes/);
  f.setOpen(true); f.checks.get(id).status = 'verified-open';
  const before = f.calls.length; state = await f.controller.action('read-check', id);
  assert.deepEqual(f.calls.slice(before).map(call => call[0]), ['inspect', 'read-check', 'inspect']);
  assert.equal(state.editorCheck.status, 'verified-open'); assert.equal(state.reviewLocked, true);
  f.setOpen(false); state = await f.controller.action('validate', id);
  assert.equal(state.transaction.state, 'completed'); assert.equal(state.reviewLocked, false); assert.equal(state.editorCheck, null);
});

test('restarting while Resolve is open restores retained script instructions without requiring offline recovery', async () => {
  const f = await applied(); f.setOpen(true); const restarted = f.factory(), before = f.calls.length;
  const state = await restarted.action('initialize');
  assert.equal(state.error, null); assert.equal(state.initialized, true); assert.equal(state.reviewLocked, true);
  assert.equal(state.editorCheck.menuName, 'Frameline Verify Applied Name test'); assert.equal(state.editorCheck.status, 'pending');
  assert(!f.calls.slice(before).some(call => ['recover', 'prepare-check', 'apply'].includes(call[0])));
});

test('cancelled file picker leaves no transaction, error or lingering review lock', async () => {
  const f = fixture({ chooseSource: async () => null }); await f.controller.action('initialize');
  const state = await f.controller.action('prepare');
  assert.equal(state.error, null); assert.equal(state.reviewLocked, false); assert.equal(state.transaction, null);
  assert.equal(f.calls.length, 0);
});

test('desktop rejects renderer proofs, paths, extra arguments and unsupported actions before calling trusted dependencies', async () => {
  const f = await applied(), before = f.calls.length;
  for (const [method, args] of [['read-check', [id, { closed: true }]], ['prepare-check', ['/private/Project.db']],
    ['prepare', [{ plan: 'caller plan' }]], ['validate', [{ transactionId: id, verified: true }]], ['arbitrary-method', []]]) {
    assert.equal((await f.controller.action(method, ...args)).errorCode, 'closed-apply-input-invalid');
  }
  assert.equal(f.calls.length, before);
});

test('offline refusal gives an actionable message without exposing exception paths', async () => {
  const f = fixture(); await f.controller.action('initialize'); f.setOpen(true);
  const state = await f.controller.action('prepare');
  assert.equal(state.errorCode, 'closed-project-resolve-running'); assert.match(state.error, /Quit Resolve completely/);
  assert.doesNotMatch(JSON.stringify(state), /private path|\/private\//); assert.equal(state.reviewLocked, false);
});

test('rollback prepares and reads a distinct original-name verification direction', async () => {
  const f = await applied(); await f.controller.action('recover', id);
  const state = await f.controller.action('rollback', id);
  assert.equal(state.transaction.state, 'pending-rollback-editor-validation');
  assert.equal(f.calls.filter(call => call[0] === 'prepare-check').at(-1)[1].direction, 'rollback');
  assert.equal(f.calls.filter(call => call[0] === 'prepare-check').at(-1)[1].expectedSource.sha256, 'a'.repeat(64));
  f.setOpen(true); await f.controller.action('read-check', id);
  assert.equal(f.calls.filter(call => call[0] === 'read-check').at(-1)[1].direction, 'rollback');
});

test('missing readback after interruption offers preparation without making a native proof claim', async () => {
  const f = fixture(); f.records.set(id, { ...f.original, state: 'pending-editor-validation' });
  const state = await f.controller.action('initialize');
  assert.equal(state.error, null); assert.equal(state.editorCheck.status, 'not-prepared');
  assert.equal(state.editorCheck.menuName, null); assert.equal(state.reviewLocked, true);
});

test('reveal resolves the retained private backup in main and UI callback errors do not alter completion', async () => {
  const f = await applied({ onChange: () => { throw new Error('view failure'); } });
  const state = await f.controller.action('reveal', id);
  assert.equal(state.error, null); assert.deepEqual(f.calls.findLast(call => call[0] === 'reveal'), ['reveal', '/private/backup.db']);
  assert.doesNotMatch(JSON.stringify(state), /\/private\//);
});
