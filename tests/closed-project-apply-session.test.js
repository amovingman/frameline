'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClosedProjectApplySession } = require('../src/closed-project-apply-session');
const sha = 'a'.repeat(64);
function fixture(options = {}) {
  const calls = [], saved = new Map();
  const record = { schemaVersion: 1, transactionId: 'txn-1', state: 'prepared',
    plan: { projectName: 'Personal edit', projectId: 'project-id', planId: sha,
      edit: { timelineId: 'timeline-id', itemId: 'item-id', oldName: 'Old', newName: 'New' } },
    source: { path: '/private/source/Project.db', sha256: sha },
    backup: { path: '/private/backup.db', sha256: sha, bytes: 123 },
    error: { message: '/private/error/path', stack: 'private' } };
  const service = {
    async prepare(plan) { calls.push(['prepare', plan]); saved.set(record.transactionId, structuredClone(record)); return record; },
    async apply(id) { calls.push(['apply', id]); saved.get(id).state = 'pending-editor-validation'; return saved.get(id); },
    async validate(id) { calls.push(['validate', id]); saved.get(id).state = 'completed'; return saved.get(id); },
    async rollback(id) { calls.push(['rollback', id]); saved.get(id).state = 'pending-rollback-editor-validation'; return saved.get(id); },
    async cancel(id) { calls.push(['cancel', id]); saved.get(id).state = 'cancelled'; return saved.get(id); },
    async inspect(id) { calls.push(['inspect', id]); return saved.get(id); },
    async recover(id) { calls.push(['recover', id]); return saved.get(id); }
  };
  const review = { secret: 'review-sources' }, source = { path: '/private/source/Project.db' }, plan = { secret: 'bound-plan' };
  const session = createClosedProjectApplySession({ transactionService: service,
    getVerifiedReview: async () => { calls.push(['review']); return review; },
    getSelectedNativeSource: async () => { calls.push(['source']); return source; },
    createPlan: async input => { calls.push(['plan', input]); return plan; },
    listTransactionIds: async () => [...saved.keys()], ...options });
  return { session, calls, saved, service, record, review, source, plan };
}
async function prepared(options) { const value = fixture(options); await value.session.initialize(); await value.session.prepare(); return value; }

test('review remains locked from construction until retained inventory has been inspected', async () => {
  let releaseInventory;
  const f = fixture({ listTransactionIds: () => new Promise(resolve => { releaseInventory = resolve; }) });
  f.saved.set('txn-1', { ...f.record, state: 'pending-editor-validation' });
  assert.equal(f.session.isReviewLocked(), true);
  assert.equal(f.session.getState().actions.prepare, false);
  const initializing = f.session.initialize();
  assert.equal(f.session.isReviewLocked(), true);
  releaseInventory(['txn-1']);
  const state = await initializing;
  assert.equal(state.initialized, true);
  assert.equal(state.reviewLocked, true);
  assert.equal(state.transaction.state, 'pending-editor-validation');
  assert.deepEqual(f.calls, [['inspect', 'txn-1']]);
  const empty = fixture();
  assert.equal(empty.session.isReviewLocked(), true);
  assert.equal((await empty.session.initialize()).reviewLocked, false);
});

test('prepare obtains trusted main-process inputs and exposes only detached public fields', async () => {
  const f = await prepared(), state = f.session.getState();
  assert.deepEqual(f.calls, [['review'], ['source'], ['plan', { review: f.review, source: f.source }], ['prepare', f.plan]]);
  assert.equal(state.transaction.edit.newName, 'New');
  assert.equal(state.reviewLocked, true); assert.equal(state.actions.apply, true);
  assert.doesNotMatch(JSON.stringify(state), /private|secret|stack|review-sources|bound-plan/);
  state.transaction.edit.newName = 'UI forgery'; f.record.plan.edit.newName = 'service forgery';
  assert.equal(f.session.getState().transaction.edit.newName, 'New');
});

test('review stays locked through publication and becomes unlocked only after verified completion', async () => {
  const f = await prepared();
  assert.equal((await f.session.prepare()).error, 'closed-apply-review-locked');
  const applied = await f.session.apply('txn-1');
  assert.equal(applied.transaction.state, 'pending-editor-validation');
  assert.equal(applied.reviewLocked, true); assert.equal(applied.actions.validate, true);
  const complete = await f.session.validate('txn-1');
  assert.equal(complete.transaction.state, 'completed'); assert.equal(complete.reviewLocked, false);
  assert.equal(complete.actions.prepare, true);
});

test('renderer cannot supply native paths, proof flags, arbitrary plans or an extra argument', async () => {
  const f = await prepared(), count = f.calls.length;
  for (const input of ['/tmp/Project.db', '../txn-1', '', { transactionId: 'txn-1', closed: true }]) {
    assert.equal((await f.session.apply(input)).error, 'closed-apply-input-invalid');
  }
  assert.equal((await f.session.validate('txn-1', { validated: true })).error, 'closed-apply-input-invalid');
  assert.equal((await f.session.prepare({ source: '/tmp/Project.db' })).error, 'closed-apply-input-invalid');
  assert.equal(f.calls.length, count);
});

test('concurrent requests are rejected without releasing the review lock', async () => {
  let release;
  const f = fixture({ getVerifiedReview: () => new Promise(resolve => { release = resolve; }) });
  await f.session.initialize(); const pending = f.session.prepare();
  assert.equal(f.session.isReviewLocked(), true);
  assert.equal((await f.session.prepare()).error, 'closed-apply-busy');
  release({}); await pending;
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 1);
});

test('rejected effect is reconciled read-only without replaying it or restoring the backup', async () => {
  const f = await prepared();
  f.service.apply = async id => { f.calls.push(['apply', id]); f.saved.get(id).state = 'pending-editor-validation'; throw new Error('/secret/failure'); };
  const result = await f.session.apply('txn-1');
  assert.equal(result.error, 'closed-apply-action-failed');
  assert.equal(result.transaction.state, 'pending-editor-validation'); assert.equal(result.reviewLocked, true);
  assert.deepEqual(f.calls.slice(-2), [['apply', 'txn-1'], ['recover', 'txn-1']]);
  assert.equal(result.transaction.backup.retained, true);
});

test('unreadable recovery after an uncertain effect keeps the transaction locked', async () => {
  const f = await prepared();
  f.service.apply = async () => { throw new Error('interrupted'); };
  f.service.recover = async () => { throw new Error('unreadable journal'); };
  const result = await f.session.apply('txn-1');
  assert.equal(result.reviewLocked, true); assert.equal(result.actions.prepare, false);
});

test('inspecting an unrelated completed record cannot clear an uncertain publication lock', async () => {
  const f = await prepared();
  f.saved.set('txn-2', { ...f.record, transactionId: 'txn-2', state: 'completed' });
  f.service.apply = async () => { throw new Error('interrupted'); };
  const recover = f.service.recover;
  f.service.recover = async id => { if (id === 'txn-1') throw new Error('unreadable'); return recover(id); };
  await f.session.apply('txn-1');
  assert.equal((await f.session.recover('txn-2')).reviewLocked, true);
});

test('an uncertain prepare is discovered on inventory retry without issuing a second preparation', async () => {
  const f = fixture(); await f.session.initialize();
  f.service.prepare = async () => { f.saved.set('txn-1', structuredClone(f.record)); throw new Error('after retained write'); };
  assert.equal((await f.session.prepare()).reviewLocked, true);
  const state = await f.session.initialize();
  assert.equal(state.retained.length, 1); assert.equal(state.transaction.state, 'prepared');
  assert.equal(state.actions.cancel, true); assert.equal(state.reviewLocked, true);
});

test('startup inspects retained transactions without replaying an effect', async () => {
  const f = fixture(); f.saved.set('txn-1', { ...f.record, state: 'pending-editor-validation' });
  const state = await f.session.initialize();
  assert.deepEqual(f.calls, [['inspect', 'txn-1']]); assert.equal(state.reviewLocked, true);
  assert.equal(state.transaction.transactionId, 'txn-1');
});

test('unreadable inventory blocks a fresh apply until a successful retry', async () => {
  let unavailable = true;
  const f = fixture({ listTransactionIds: async () => { if (unavailable) throw new Error('/secret/path'); return []; } });
  assert.equal((await f.session.initialize()).reviewLocked, true);
  assert.equal((await f.session.prepare()).error, 'closed-apply-not-initialized');
  unavailable = false;
  assert.equal((await f.session.initialize()).reviewLocked, false);
});

test('guarded recovery may permit replan when independently verified source remained original', async () => {
  const f = await prepared();
  f.saved.get('txn-1').state = 'failed';
  f.saved.get('txn-1').recovery = { classification: 'original-safe-replan', mayValidate: false, mayRollback: false };
  const state = await f.session.recover('txn-1');
  assert.equal(state.reviewLocked, false); assert.equal(state.actions.prepare, true);
});

test('recovery of one completed record cannot unlock another unfinished transaction', async () => {
  const f = fixture();
  f.saved.set('txn-1', { ...f.record, state: 'pending-editor-validation' });
  f.saved.set('txn-2', { ...f.record, transactionId: 'txn-2', state: 'completed' });
  await f.session.initialize();
  assert.equal((await f.session.recover('txn-2')).reviewLocked, true);
});

test('service record mismatch is not accepted as verified success', async () => {
  const f = await prepared();
  f.service.validate = async () => ({ ...f.record, transactionId: 'txn-forged', state: 'completed' });
  const result = await f.session.validate('txn-1');
  assert.equal(result.error, 'closed-apply-record-invalid'); assert.equal(result.reviewLocked, true);
  assert.equal(result.retained.length, 1);
});

test('cancel is a durable service action available only before publication', async () => {
  const f = await prepared(); const state = await f.session.cancel('txn-1');
  assert.equal(state.transaction.state, 'cancelled'); assert.equal(state.reviewLocked, false);
  assert.equal((await f.session.apply('txn-1')).error, 'closed-apply-action-unavailable');
});

test('view callback failure cannot change verified transaction outcome', async () => {
  const f = await prepared({ onChange: () => { throw new Error('render failed'); } });
  await f.session.apply('txn-1');
  assert.equal((await f.session.validate('txn-1')).transaction.state, 'completed');
});

test('native result revision exposes hashes and audit linkage while retaining paths and raw choices in main', async () => {
  const f = await prepared();
  f.saved.get('txn-1').resultingRevision = { revisionId: sha, sourceSha256: sha, parentSourceSha256: sha,
    planId: sha, editorProofSha256: sha, createdAt: '2026-11-21T00:00:00.000Z', direction: 'apply',
    review: { auditHash: sha, choices: [{ secret: 'raw-choice' }] }, backup: { path: '/private/backup' } };
  const state = await f.session.inspect('txn-1');
  assert.equal(state.transaction.resultingRevision.revisionId, sha);
  assert.equal(state.transaction.resultingRevision.choiceCount, 1);
  assert.doesNotMatch(JSON.stringify(state), /private|raw-choice/);
});
