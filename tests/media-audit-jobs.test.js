'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { createMediaAuditJobs } = require('../src/media-audit-jobs');
const { createMediaJobQueue } = require('../src/media-job-queue');
const { auditFcpxmlMedia } = require('../src/fcpxml-media-audit');
const { fingerprintFile } = require('../src/local-media-readiness');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'media-jobs-ui-'));
  const mediaPath = path.join(root, 'fixture.bin'); await fs.writeFile(mediaPath, Buffer.alloc(1024 * 1024, 5));
  const sourcePath = path.join(root, 'edit.fcpxml');
  const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><asset id="a1" name="Fixture"><media-rep kind="original-media" src="${pathToFileURL(mediaPath).href}"/></asset></resources><library><event><project><sequence><spine><asset-clip ref="a1"/></spine></sequence></project></event></library></fcpxml>`;
  await fs.writeFile(sourcePath, xml);
  const selection = { projectId: 'project-1', sourceHash: sha(xml), sourcePath, copyPath: sourcePath };
  const directory = path.join(root, 'jobs'); const instances = [];
  const create = options => { const jobs = createMediaAuditJobs({ directory, getSelection: () => selection, ...options }); instances.push(jobs); return jobs; };
  t.after(async () => { for (const jobs of instances) await jobs.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, sourcePath, mediaPath, selection, create };
}

test('file hashing and real media auditing report byte progress and stop after cancellation without publishing a result', async t => {
  const { mediaPath, sourcePath, selection } = await setup(t);
  const controller = new AbortController(); let read = 0;
  await assert.rejects(fingerprintFile(mediaPath, { signal: controller.signal, onProgress: value => {
    read = value.bytesRead; if (read > 0) controller.abort();
  } }), { code: 'fingerprint-cancelled' });
  assert(read > 0 && read < 1024 * 1024);
  const auditAbort = new AbortController();
  await assert.rejects(auditFcpxmlMedia({ exportPath: sourcePath, expectedSourceHash: selection.sourceHash,
    signal: auditAbort.signal, onProgress: p => { if (p.phase === 'hashing' && p.bytesRead > 0) auditAbort.abort(); } }), { code: 'media-job-cancelled' });
  await assert.rejects(auditFcpxmlMedia({ exportPath: sourcePath, onProgress: p => {
    if (p.phase === 'hashing') throw Error('Progress storage failed');
  } }), { code: 'media-job-progress-failed' });
  assert.equal((await fingerprintFile(mediaPath)).size, 1024 * 1024);
  let grew = false;
  await assert.rejects(fingerprintFile(mediaPath, { onProgress: async progress => {
    if (!grew && progress.bytesRead > 0) { grew = true; await fs.appendFile(mediaPath, 'growth'); }
  } }), { code: 'file-changed' });
});

test('real completed audit survives restart privately and explicit repeated audit rereads changed media', async t => {
  const { root, directory, mediaPath, create } = await setup(t), events = [];
  const jobs = create({ onChange: state => events.push(state) });
  await jobs.start('source'); await jobs.waitForIdle();
  const first = await jobs.getState();
  assert.equal(first.jobs[0].status, 'completed'); assert.equal(first.reports.source.report.counts.fingerprinted, 1);
  assert.equal(first.jobs[0].progress, 100);
  const restarted = create();
  const recovered = await restarted.getState();
  assert.equal(recovered.jobs[0].status, 'completed');
  assert.deepEqual(recovered.reports.source.report, first.reports.source.report);
  const journal = await fs.readFile(path.join(directory, 'media-jobs.json'), 'utf8');
  assert(!journal.includes(root)); assert(!JSON.stringify(first).includes(root));
  assert.equal((await fs.stat(path.join(directory, 'media-jobs.json'))).mode & 0o777, 0o600);
  await fs.writeFile(mediaPath, 'New media bytes'); await jobs.start('source'); await jobs.waitForIdle();
  const updated = await jobs.getState(); assert.equal(updated.total, 1);
  assert.equal(updated.reports.source.report.assets[0].fingerprint.sha256, sha('New media bytes'));
  assert.notEqual(updated.reports.source.report.assets[0].fingerprint.sha256, first.reports.source.report.assets[0].fingerprint.sha256);
});

test('running audit cancellation is durable, and a new explicit audit can restart it', async t => {
  const { create } = await setup(t), started = deferred();
  let slow = true;
  const jobs = create({ audit: async options => {
    if (!slow) return auditFcpxmlMedia(options);
    await options.onProgress({ phase: 'hashing', checked: 0, total: 1, bytesRead: 1, totalBytes: 100 });
    started.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('cancelled'); error.code = 'media-job-cancelled'; throw error;
  } });
  await jobs.start('source'); await started.promise;
  const state = await jobs.getState(); assert.equal(state.jobs[0].status, 'running');
  await jobs.cancel(state.jobs[0].id);
  assert.equal((await jobs.getState()).jobs[0].status, 'cancelled');
  assert.equal((await create().getState()).jobs[0].status, 'cancelled');
  slow = false; await jobs.start('source'); await jobs.waitForIdle();
  assert.equal((await jobs.getState()).jobs[0].status, 'completed');
});

test('interrupted audit waits for matching selected project and source bytes before restarting', async t => {
  const { directory, selection, create } = await setup(t);
  const queue = createMediaJobQueue({ directory, handlers: {} });
  const job = await queue.enqueue({ kind: 'asset-check', projectId: selection.projectId, sourceId: `source:${selection.sourceHash}` });
  const filename = path.join(directory, 'media-jobs.json'), disk = JSON.parse(await fs.readFile(filename));
  Object.assign(disk.jobs[0], { status: 'running', attempts: 1, progress: 47 }); await fs.writeFile(filename, JSON.stringify(disk));
  let bound = null; const jobs = create({ getSelection: () => bound });
  const waiting = await jobs.getState(); assert.equal(waiting.jobs[0].status, 'queued'); assert.equal(waiting.jobs[0].canResume, false);
  await assert.rejects(jobs.resume(job.id), { code: 'media-audit-source-required' });
  bound = { ...selection, sourceHash: '0'.repeat(64) };
  await assert.rejects(jobs.resume(job.id), { code: 'media-audit-source-required' });
  bound = selection; await jobs.resume(job.id); await jobs.waitForIdle();
  assert.equal((await jobs.getState()).jobs[0].status, 'completed');
});

test('queue can cancel a waiting job during another worker and preserves that update across progress writes', async t => {
  const { directory } = await setup(t), started = deferred(), release = deferred();
  const queue = createMediaJobQueue({ directory, handlers: { hash: async (_job, controls) => {
    await controls.progress(10); started.resolve(); await release.promise; await controls.progress(80); return { done: true };
  } } });
  const first = await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'a' });
  const second = await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'b' });
  const work = queue.runNext({ jobId: first.id }); await started.promise;
  assert.equal((await queue.cancel(second.id)).status, 'cancelled');
  const third = await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'c' });
  release.resolve(); await work;
  const rows = await queue.inspect(); assert.equal(rows.find(row => row.id === second.id).status, 'cancelled');
  assert.equal(rows.find(row => row.id === third.id).status, 'queued');
  assert.equal(rows.find(row => row.id === first.id).status, 'completed');
});

test('source changes pause work and invalid completed reports are withheld', async t => {
  const { create, directory, selection } = await setup(t), started = deferred();
  let bound = selection;
  const jobs = create({ getSelection: () => bound, audit: async options => {
    started.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('cancelled'); error.code = 'media-job-cancelled'; throw error;
  } });
  await jobs.start('source'); await started.promise; bound = null; jobs.selectionChanged(); await jobs.waitForIdle();
  assert.equal((await jobs.getState()).jobs[0].status, 'queued');
  const normal = create(); await normal.start('source'); await normal.waitForIdle();
  const journal = JSON.parse(await fs.readFile(path.join(directory, 'media-jobs.json')));
  await fs.appendFile(path.join(directory, 'reports', `${journal.jobs[0].result.reportHash}.json`), ' ');
  const state = await normal.getState(); assert.equal(state.jobs[0].reportUnavailable, true); assert.deepEqual(state.reports, {});
});

test('copy audits verify the handoff before hashing and again before publishing', async t => {
  const { create } = await setup(t); let checked = 0, audited = 0;
  const jobs = create({ verifyCopy: async () => { checked++; return true; }, audit: async options => {
    audited++; return auditFcpxmlMedia(options);
  } });
  await jobs.start('copy'); await jobs.waitForIdle();
  assert.equal(checked, 2); assert.equal(audited, 1);
  assert.equal((await jobs.getState()).reports.copy.report.counts.fingerprinted, 1);
  checked = 0;
  const invalidated = create({ verifyCopy: async () => ++checked === 1 });
  await invalidated.start('copy'); await invalidated.waitForIdle();
  const state = await invalidated.getState();
  assert.equal(checked, 2); assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error, 'stale-export'); assert.deepEqual(state.reports, {});
  let reads = 0;
  const refused = create({ verifyCopy: async () => false, audit: async () => { reads++; throw Error('Unexpected read'); } });
  await refused.start('copy'); await refused.waitForIdle();
  assert.equal(reads, 0); assert.equal((await refused.getState()).jobs[0].error, 'media-audit-copy-unverified');
});

test('duplicate state delivery keeps its run ID while a real rerun of unchanged bytes gets a new run ID', async t => {
  const { create } = await setup(t), jobs = create();
  await jobs.start('source'); await jobs.waitForIdle();
  const first = await jobs.getState(), repeat = await jobs.getState();
  assert.equal(first.reports.source.runId, repeat.reports.source.runId);
  await jobs.restart(first.jobs[0].id); await jobs.waitForIdle();
  const rerun = await jobs.getState();
  assert.notEqual(first.reports.source.runId, rerun.reports.source.runId);
  assert.deepEqual(first.reports.source.report, rerun.reports.source.report);
});

test('simultaneous explicit starts coalesce the terminal restart into one new worker run', async t => {
  const { create } = await setup(t); let reads = 0;
  const jobs = create({ audit: async options => { reads++; return auditFcpxmlMedia(options); } });
  await jobs.start('source'); await jobs.waitForIdle();
  await Promise.all([jobs.start('source'), jobs.start('source')]); await jobs.waitForIdle();
  const state = await jobs.getState();
  assert.equal(state.total, 1); assert.equal(state.jobs[0].status, 'completed'); assert.equal(reads, 2);
});

test('selection changes during start leave an acknowledged queued check for explicit restart', async t => {
  const { create } = await setup(t); let reads = 0;
  const jobs = create({ audit: async options => { reads++; return auditFcpxmlMedia(options); } });
  const starting = jobs.start('source'); jobs.selectionChanged(); await starting; await jobs.waitForIdle();
  const paused = await jobs.getState();
  assert.equal(reads, 0); assert.equal(paused.jobs[0].status, 'queued'); assert.equal(paused.busy, false);
  assert.equal(paused.jobs[0].canResume, true);
  await jobs.resume(paused.jobs[0].id); await jobs.waitForIdle(); assert.equal(reads, 1);
});

test('dispose waits for in-flight journal controls and never schedules their work after returning', async t => {
  const { create } = await setup(t); let reads = 0;
  const jobs = create({ audit: async options => { reads++; return auditFcpxmlMedia(options); } });
  const starting = jobs.start('source'); await jobs.dispose(); await starting;
  assert.equal(reads, 0); assert.equal(jobs.isBusy(), false);
  const disk = await jobs.getState(); assert.equal(disk.jobs[0].status, 'queued'); assert.equal(disk.busy, false);
  const restartable = create({ audit: async options => { reads++; return auditFcpxmlMedia(options); } });
  await restartable.resume(disk.jobs[0].id); await restartable.waitForIdle(); assert.equal(reads, 1);
  const restarting = restartable.restart(disk.jobs[0].id); await restartable.dispose(); await restarting;
  assert.equal(reads, 1); assert.equal(restartable.isBusy(), false);
  assert.equal((await restartable.getState()).jobs[0].status, 'queued');
});

test('a waiting copy can be cancelled immediately while the source audit remains active', { timeout: 5000 }, async t => {
  const { create } = await setup(t), entered = deferred(), release = deferred(); let reads = 0;
  const jobs = create({ verifyCopy: async () => true, audit: async options => {
    reads++; entered.resolve(); await release.promise; return auditFcpxmlMedia(options);
  } });
  await jobs.start('source'); await entered.promise; await jobs.start('copy');
  try {
    const state = await jobs.getState(), copy = state.jobs.find(job => job.target === 'copy');
    await jobs.cancel(copy.id);
    const cancelled = await jobs.getState();
    assert.equal(cancelled.jobs.find(job => job.target === 'copy').status, 'cancelled');
    assert.equal(cancelled.jobs.find(job => job.target === 'source').status, 'running');
  } finally { release.resolve(); }
  await jobs.waitForIdle(); assert.equal(reads, 1);
});

test('malformed journal fields and duplicate IDs fail closed without exposing their values', async t => {
  const { create, directory } = await setup(t), jobs = create();
  await jobs.start('source'); await jobs.waitForIdle();
  const filename = path.join(directory, 'media-jobs.json'), original = JSON.parse(await fs.readFile(filename));
  for (const mutate of [value => { value.jobs[0].updatedAt = '/Users/private'; },
    value => { value.jobs[0].progress = 101; }, value => { value.jobs[0].attempts = -1; },
    value => { value.jobs[0].options = { frame: '/Users/private' }; }, value => value.jobs.push(value.jobs[0])]) {
    const changed = structuredClone(original); mutate(changed); await fs.writeFile(filename, JSON.stringify(changed));
    await assert.rejects(create().getState(), error => error.code === 'media-job-queue-corrupt' && !error.message.includes('/Users/'));
  }
  await fs.writeFile(filename, JSON.stringify(original));
});

test('worker progress and failure codes cannot introduce paths into public state or the journal', async t => {
  const { create, directory } = await setup(t), entered = deferred(), release = deferred();
  const jobs = create({ audit: async options => {
    await options.onProgress({ phase: 'hashing', checked: 0, total: 1, bytesRead: 1, totalBytes: 2, path: '/Users/private' });
    entered.resolve(); await release.promise; const error = new Error('/Users/private'); error.code = '/Users/private'; throw error;
  } });
  await jobs.start('source'); await entered.promise;
  try {
    assert.deepEqual((await jobs.getState()).jobs[0].detail, { phase: 'hashing', checked: 0, total: 1, bytesRead: 1, totalBytes: 2 });
  } finally { release.resolve(); }
  await jobs.waitForIdle();
  assert.equal((await jobs.getState()).jobs[0].error, 'media-audit-failed');
  assert(!(await fs.readFile(path.join(directory, 'media-jobs.json'), 'utf8')).includes('/Users/private'));
});

test('malformed completed receipts are withheld and unrelated option-bearing jobs are never adopted', async t => {
  const { create, directory, selection } = await setup(t), jobs = create();
  await jobs.start('source'); await jobs.waitForIdle();
  const filename = path.join(directory, 'media-jobs.json'), original = JSON.parse(await fs.readFile(filename));
  for (const mutate of [value => { value.jobs[0].result.runId = '/Users/private'; },
    value => { value.jobs[0].result.sourceHash = '0'.repeat(64); }, value => { value.jobs[0].result.assetCount = 2; }]) {
    const changed = structuredClone(original); mutate(changed); await fs.writeFile(filename, JSON.stringify(changed));
    const state = await jobs.getState();
    assert.deepEqual(state.reports, {}); assert.equal(state.jobs[0].reportUnavailable, true);
    assert(!JSON.stringify(state).includes('/Users/private'));
  }
  await fs.writeFile(filename, JSON.stringify(original));
  const queue = createMediaJobQueue({ directory, handlers: {} });
  const unrelated = await queue.enqueue({ kind: 'asset-check', projectId: selection.projectId,
    sourceId: `source:${selection.sourceHash}`, options: { frame: 1 } });
  assert.equal((await jobs.getState()).total, 1);
  await jobs.start('source'); await jobs.waitForIdle();
  assert.equal((await queue.inspect()).find(job => job.id === unrelated.id).status, 'queued');
});
