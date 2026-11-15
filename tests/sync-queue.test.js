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
