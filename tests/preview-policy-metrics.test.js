const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMediaJobQueue } = require('../src/media-job-queue');
const { createPreviewPolicy } = require('../src/preview-policy');

test('previews require project opt-in and rights, separate from canonical jobs', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'preview-policy-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const queue = createMediaJobQueue({ directory, handlers: { thumbnail: async () => ({ canonical: false }) } });
  const policy = createPreviewPolicy({ authorize: (id) => id === 'film' });
  const job = { kind: 'thumbnail', projectId: 'film', sourceId: 'clip', options: { rightsConfirmed: true } };
  assert.equal(policy.enabled('film'), false);
  await assert.rejects(policy.enqueue(queue, job), { code: 'preview-disabled' });
  policy.setEnabled('film', true);
  await assert.rejects(policy.enqueue(queue, { ...job, options: {} }), { code: 'preview-rights-required' });
  assert.equal((await policy.enqueue(queue, job)).created, true);
  assert.equal((await queue.runNext()).result.canonical, false);
  assert.deepEqual(policy.snapshot().enabledProjects, ['film']);
});

test('job metrics report backlog, failures, time and estimated storage cost', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'job-metrics-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1000;
  const queue = createMediaJobQueue({ directory, now: () => clock, handlers: {
    hash: async () => { clock += 20; return { ok: true }; },
    proxy: async () => { const e = new Error(); e.code = 'worker-failed'; throw e; }
  } });
  await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'one' });
  await queue.enqueue({ kind: 'proxy', projectId: 'film', sourceId: 'two' });
  assert.equal((await queue.metrics()).backlog, 2);
  await queue.runNext(); await queue.runNext();
  const result = await queue.metrics({ storedBytes: 1024 ** 3, costPerGbMonth: 2 });
  assert.equal(result.failureCount, 1);
  assert.equal(result.averageProcessingMs, 20);
  assert.equal(result.estimatedMonthlyStorageCost, 2);
});
