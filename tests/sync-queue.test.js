const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createSyncQueue } = require('../src/sync-queue');

function bundle() {
  const projectId = randomUUID(); const id = randomUUID();
  const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
    sourceHash: '1'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 },
    clips: [], media: [], warnings: [] };
  const record = { id, projectId, parentRevisionId: null, author: 'Local editor', createdAt: new Date(0).toISOString(),
    message: 'Revision 1', editorVersion: null, manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
  const bytes = `${JSON.stringify(record, null, 2)}\n`; const { manifest: ignored, ...summary } = record;
  summary.recordHash = createHash('sha256').update(bytes).digest('hex');
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: id }, records: [{ summary, bytes }] };
}

test('offline pushes persist, deduplicate, and retry idempotently after connectivity returns', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-sync-queue-')); let clock = 0;
  try {
    const input = { remoteProjectId: 'remote-1', branch: 'main', bundle: bundle(), authorId: 'user-1' };
    let calls = 0;
    const sync = { push(received) {
      calls += 1; assert.deepEqual(received, input);
      if (calls === 1) throw Object.assign(new Error('offline'), { code: 'sync-network-unavailable' });
      return { pushed: 1 };
    } };
    let queue = createSyncQueue({ directory, now: () => clock, baseDelayMs: 1000, maxDelayMs: 8000 });
    assert.equal(queue.enqueuePush(input).queued, true);
    assert.equal(queue.enqueuePush(input).queued, false);
    assert.deepEqual(queue.process({ online: false, sync }),
      { processed: 0, completed: 0, retrying: 0, blocked: 0, pending: 1 });
    assert.equal(calls, 0);
    assert.equal(queue.process({ online: true, sync }).retrying, 1);
    assert.equal(queue.inspect()[0].attempts, 1);
    queue = createSyncQueue({ directory, now: () => clock, baseDelayMs: 1000, maxDelayMs: 8000 });
    assert.equal(queue.process({ online: true, sync }).processed, 0);
    clock = 1000;
    const completed = queue.process({ online: true, sync });
    assert.equal(completed.completed, 1); assert.equal(completed.pending, 0);
    assert.deepEqual(queue.inspect(), []); assert.equal(calls, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('non-network sync failures remain blocked for explicit reconciliation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-sync-queue-'));
  try {
    const queue = createSyncQueue({ directory });
    queue.enqueuePush({ remoteProjectId: 'remote-1', bundle: bundle(), authorId: 'user-1' });
    const result = queue.process({ online: true, sync: { push() {
      throw Object.assign(new Error('conflict'), { code: 'sync-branch-conflict' });
    } } });
    assert.equal(result.blocked, 1); assert.equal(queue.inspect()[0].status, 'blocked');
    assert.equal(queue.inspect()[0].lastError, 'sync-branch-conflict');
    assert.equal(queue.inspect()[0].recoverable, true);
    assert.deepEqual(queue.inspect()[0].actions, ['retry', 'cancel', 'fetch']);
    assert.equal(queue.retry(queue.inspect()[0].id).status, 'queued');
    assert.equal(queue.inspect()[0].lastError, null);
    assert.equal(queue.cancel(queue.inspect()[0].id).canceled, true);
    assert.deepEqual(queue.inspect(), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('exposes durable progress and rejects unavailable retry or cancel actions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-sync-queue-'));
  try {
    const queue = createSyncQueue({ directory });
    const input = { remoteProjectId: 'remote-1', bundle: bundle(), authorId: 'user-1' };
    const queued = queue.enqueuePush(input); const seen = [];
    const result = queue.process({ online: true, sync: { push(_payload, options) {
      options.onProgress({ completed: 0, total: 1 });
      throw Object.assign(new Error('offline'), { code: 'sync-network-unavailable' });
    } }, onProgress: value => seen.push(value) });
    assert.equal(result.retrying, 1);
    assert.deepEqual(queue.inspect()[0].progress, { completed: 0, total: 1 });
    assert.deepEqual(seen, [{ id: queued.id, completed: 0, total: 1 }]);
    assert.throws(() => queue.retry('missing'), { code: 'sync-operation-unavailable' });
    assert.throws(() => queue.cancel('missing'), { code: 'sync-operation-unavailable' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const acknowledgment = { status: 'in-sync', pushed: 1, remoteHead: 'remote-revision' };
function asyncFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-async-sync-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queue = createSyncQueue({ directory }); const input = { remoteProjectId: 'remote-1', bundle: bundle(), authorId: 'user-1' };
  return { queue, input, directory, id: queue.enqueuePush(input).id };
}

test('async processing persists the attempt before remote work and removes only after awaited acknowledgment', async t => {
  const { queue, id, directory } = asyncFixture(t); const response = deferred(); let calls = 0;
  const sync = { async push() { calls++; return response.promise; } };
  const pending = queue.processAsync({ online: true, sync });
  assert.equal(queue.inspect()[0].id, id); assert.equal(queue.inspect()[0].attempts, 1);
  assert.equal(createSyncQueue({ directory }).inspect()[0].attempts, 1);
  await assert.rejects(queue.processAsync({ online: true, sync }), { code: 'sync-process-busy' });
  assert.throws(() => queue.process({ online: true, sync }), { code: 'sync-process-busy' });
  response.resolve(acknowledgment); const result = await pending;
  assert.equal(result.completed, 1); assert.equal(result.pending, 0); assert.equal(calls, 1);
});

test('async progress and completion preserve concurrently enqueued work and canceled siblings', async t => {
  const { queue, input, id } = asyncFixture(t); const response = deferred(); let report;
  const sibling = queue.enqueuePush({ ...input, remoteProjectId: 'remote-2' }).id;
  const pending = queue.processAsync({ online: true, sync: { async push(_payload, opts) { report = opts.onProgress; return response.promise; } } });
  const added = queue.enqueuePush({ ...input, remoteProjectId: 'remote-3' }).id; queue.cancel(sibling);
  report({ completed: 1, total: 1 });
  assert.deepEqual(queue.inspect().map(value => value.id), [id, added]);
  response.resolve(acknowledgment); const result = await pending;
  assert.equal(result.completed, 1); assert.deepEqual(queue.inspect().map(value => value.id), [added]);
});

test('cancel aborts active transport and a late acknowledgment cannot delete a re-enqueued identical intent', async t => {
  const { queue, input, id } = asyncFixture(t); const response = deferred(); let options;
  const pending = queue.processAsync({ online: true, sync: { async push(_payload, opts) { options = opts; return response.promise; } } });
  queue.cancel(id); assert.equal(options.signal.aborted, true); assert.equal(queue.enqueuePush(input).queued, true);
  options.onProgress({ completed: 1, total: 1 }); response.resolve(acknowledgment);
  assert.equal((await pending).completed, 0); assert.equal(queue.inspect()[0].attempts, 0);
  assert.deepEqual(queue.inspect()[0].progress, { completed: 0, total: 1 });
});

test('async rejected network acknowledgments persist retry delay across restart', async t => {
  const { queue, id, directory } = asyncFixture(t);
  const first = await queue.processAsync({ online: true, sync: { async push() { throw Object.assign(new Error('disconnected'), { code: 'ECONNRESET' }); } } });
  assert.equal(first.retrying, 1); const resumed = createSyncQueue({ directory });
  assert.equal(resumed.inspect()[0].status, 'retry-wait'); assert.equal(resumed.inspect()[0].attempts, 1); resumed.retry(id);
  assert.equal((await resumed.processAsync({ online: true, sync: { async push() { return acknowledgment; } } })).completed, 1);
});

test('external cancellation retains the durable intent for safe retry and stops additional requests', async t => {
  const { queue, input, id } = asyncFixture(t); const controller = new AbortController(); let calls = 0;
  queue.enqueuePush({ ...input, remoteProjectId: 'remote-2' });
  const result = await queue.processAsync({ online: true, signal: controller.signal, sync: { async push(_payload, opts) {
    calls++; controller.abort(); assert.equal(opts.signal.aborted, true); throw Object.assign(new Error('cancelled'), { code: 'sync-cancelled' });
  } } });
  assert.equal(result.pending, 2); assert.equal(result.blocked, 0); assert.equal(calls, 1);
  assert.equal(queue.inspect().find(value => value.id === id).status, 'queued');
});

test('invalid asynchronous acknowledgment and unsafe error codes never complete or expose private data', async t => {
  const { queue, id } = asyncFixture(t);
  assert.equal((await queue.processAsync({ online: true, sync: { async push() {} } })).blocked, 1);
  assert.equal(queue.inspect()[0].lastError, 'sync-ack-invalid'); queue.retry(id);
  await queue.processAsync({ online: true, sync: { async push() { throw Object.assign(new Error('/Users/private'), { code: '/Users/private/token' }); } } });
  assert.equal(queue.inspect()[0].lastError, 'sync-failed'); assert.doesNotMatch(JSON.stringify(queue.inspect()), /Users|private|token/);
});

test('legacy synchronous processing retains a Promise-returning push for explicit async retry', async t => {
  const { queue } = asyncFixture(t);
  const result = queue.process({ online: true, sync: { async push() { return acknowledgment; } } });
  assert.equal(result.completed, 0); assert.equal(result.blocked, 1); assert.equal(queue.inspect()[0].lastError, 'sync-async-required');
});

test('an entirely offline async pass performs no requests', async t => {
  const { queue } = asyncFixture(t); let calls = 0;
  const result = await queue.processAsync({ online: false, sync: { async push() { calls++; } } });
  assert.equal(result.pending, 1); assert.equal(result.processed, 0); assert.equal(calls, 0);
});

test('duplicate and private-code journal tampering is rejected before asynchronous transport', async t => {
  const { queue, directory } = asyncFixture(t); const filename = path.join(directory, 'sync-queue.json');
  const original = JSON.parse(fs.readFileSync(filename, 'utf8')); const duplicate = structuredClone(original);
  duplicate.items.push(structuredClone(duplicate.items[0])); fs.writeFileSync(filename, JSON.stringify(duplicate));
  await assert.rejects(queue.processAsync({ online: true, sync: { async push() { assert.fail('must not contact service'); } } }), { code: 'sync-queue-corrupt' });
  original.items[0].lastError = '/Users/private/token'; fs.writeFileSync(filename, JSON.stringify(original));
  assert.throws(() => queue.inspect(), { code: 'sync-queue-corrupt' });
});

test('legacy errors with private path codes leave a readable path-free blocked journal', t => {
  const { queue, directory } = asyncFixture(t);
  const result = queue.process({ online: true, sync: { push() {
    throw Object.assign(new Error('/Users/private/media.mov'), { code: '/Users/private/token' });
  } } });
  assert.equal(result.blocked, 1); assert.equal(result.pending, 1);
  const state = createSyncQueue({ directory }).inspect();
  assert.equal(state[0].status, 'blocked'); assert.equal(state[0].lastError, 'sync-failed');
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'sync-queue.json'), 'utf8'), /Users|private|token/);
});
