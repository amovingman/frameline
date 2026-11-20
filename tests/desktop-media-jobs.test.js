const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { createDesktopMediaJobs } = require('../src/desktop-media-jobs');
const sha = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('derived PNG fixture')]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(controller, predicate) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { const state = await controller.getState(); if (predicate(state)) return state; await pause(15); }
  assert.fail('media job did not reach expected state');
}
const resultFor = (bytes, width = 640, height = 360) => ({ kind: 'thumbnail', mimeType: 'image/png', width, height,
  byteLength: bytes.length, sha256: sha(bytes), canonical: false });
async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-media-jobs-')));
  const directory = path.join(root, 'jobs'); const media = path.join(root, 'private picture.mov');
  const exportPath = path.join(root, 'private-edit.fcpxml'); await fs.writeFile(media, 'source media bytes');
  const xml = `<!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="Picture" start="3600s" duration="10s" hasVideo="1"><media-rep kind="original-media" src="${pathToFileURL(media).href.replaceAll('&', '&amp;')}"/></asset></resources><library><event><project><sequence format="f"><spine><asset-clip ref="a" offset="0s" start="3601s" duration="1s"/></spine></sequence></project></event></library></fcpxml>`;
  await fs.writeFile(exportPath, xml); let selected = { projectId: 'film', sourceHash: sha(xml), exportPath };
  let calls = 0; const observed = [];
  const render = async (input, controls) => {
    calls++; await controls.progress(50); await controls.progress(10);
    await fs.writeFile(input.outputPath, png); return resultFor(png, input.width, input.height);
  };
  const renderer = { getAvailability: async () => ({ available: true }), inspect: async () => ({ kind: 'image', width: 640, height: 360, frameRate: 24 }),
    renderThumbnail: render, renderProxy: render, renderStoryboard: render, ...overrides };
  const controllers = [];
  const make = () => { const instance = createDesktopMediaJobs({ directory, getSelection: () => selected, renderer, onChange: state => observed.push(state) }); controllers.push(instance); return instance; };
  const controller = make(); await controller.initialize();
  t.after(async () => { for (const instance of controllers) await instance.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, media, exportPath, xml, controller, make, renderer, observed, get calls() { return calls; }, setSelection: value => { selected = value; } };
}
async function enable(controller) { await controller.setPolicy({ enabled: true, rightsConfirmed: true }); }

test('hash/check run locally with previews off; public states exclude locations; private metadata is restricted', async t => {
  const f = await fixture(t); const { controller } = f;
  assert.equal((await controller.getState()).policy.enabled, false);
  assert.equal((await controller.getState()).metrics.estimatedMonthlyStorageCostUSD, null);
  await controller.chooseSource(f.media);
  const first = await controller.enqueue({ kind: 'hash' });
  const duplicate = await controller.enqueue({ kind: 'hash' }); assert.equal(duplicate.lastEnqueuedId, first.lastEnqueuedId);
  let state = await until(controller, value => value.jobs[0].status === 'completed');
  assert.equal(state.jobs[0].result.sha256, sha('source media bytes')); assert.equal(state.jobs[0].attempts, 1);
  await controller.enqueue({ kind: 'asset-check' }); state = await until(controller, value => value.jobs.every(job => job.status === 'completed'));
  assert.equal(state.jobs[1].result.inspection, 'decoded'); assert.equal(state.jobs[1].result.verified, true); assert.equal(state.jobs[1].result.byteLength, 18);
  assert.equal(f.calls, 0); assert.equal(JSON.stringify(state).includes(f.root), false); assert.equal(JSON.stringify(state).includes('file:'), false);
  assert.equal((await fs.stat(path.join(f.directory, 'desktop-media-jobs.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(f.exportPath, 'utf8'), f.xml); assert.equal(await fs.readFile(f.media, 'utf8'), 'source media bytes');
});
test('rights are explicit per project and per rendering job; real cache bytes and optional estimate are observable', async t => {
  const f = await fixture(t); const { controller } = f; await controller.chooseSource(f.media);
  await assert.rejects(controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }), { code: 'policy-disabled' });
  await controller.setPolicy({ enabled: true, rightsConfirmed: false });
  await assert.rejects(controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }), { code: 'policy-disabled' });
  await enable(controller); await assert.rejects(controller.enqueue({ kind: 'thumbnail' }), { code: 'preview-rights-required' });
  const job = await controller.enqueue({ kind: 'thumbnail', frame: 24, rightsConfirmed: true });
  const completed = await until(controller, value => value.jobs[0].status === 'completed');
  assert.equal(completed.jobs[0].result.canonical, false); assert.equal(completed.metrics.cacheBytes, png.length);
  assert.ok(completed.metrics.processingMs > 0);
  const artifact = await controller.getArtifact(job.lastEnqueuedId); assert.equal(artifact.sha256, sha(png)); assert.equal(artifact.canonical, false);
  await controller.setPolicy({ enabled: true, costPerGiBMonthUSD: 0.2 });
  assert.equal((await controller.getState()).metrics.estimatedMonthlyStorageCostUSD, png.length / 1024 ** 3 * 0.2);
  // Unindexed artifacts retained after a crash still occupy measurable disk bytes.
  await fs.writeFile(path.join(path.dirname(artifact.path), `${randomUUID()}.png`), 'orphan');
  assert.equal((await controller.getState()).metrics.cacheBytes, png.length + 6);
  const progress = f.observed.flatMap(value => value.jobs.filter(item => item.id === job.lastEnqueuedId).map(item => item.progress));
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  await controller.setPolicy({ enabled: false });
  await assert.rejects(controller.getArtifact(job.lastEnqueuedId), { code: 'policy-disabled' });
  assert.equal((await controller.getState()).jobs[0].result, null);
  f.setSelection({ projectId: 'another', sourceHash: sha(f.xml), exportPath: f.exportPath }); await controller.selectionChanged();
  assert.equal((await controller.getState()).policy.enabled, false); assert.equal((await controller.getState()).jobs.length, 0);
});
test('storyboard uses selected export automatically, exact relative source time, and verifies dependencies before reveal', async t => {
  let captured;
  const f = await fixture(t, { renderStoryboard: async (input, controls) => {
    captured = input; await controls.progress(50); await fs.writeFile(input.outputPath, png); return resultFor(png, input.width, input.height);
  } });
  await enable(f.controller);
  const enqueued = await f.controller.enqueue({ kind: 'timeline-preview', rightsConfirmed: true });
  const state = await until(f.controller, value => value.jobs[0].status === 'completed');
  assert.equal(captured.clips[0].seconds, 1); assert.equal(state.jobs[0].result.clipCount, 1);
  assert.equal(state.jobs[0].result.previewType, 'storyboard');
  await f.controller.getArtifact(enqueued.lastEnqueuedId);
  await fs.writeFile(f.media, 'changed media');
  await assert.rejects(f.controller.getArtifact(enqueued.lastEnqueuedId), { code: 'source-changed' });
});
test('policy revocation and selection changes fence late provider results and never publish partial files', async t => {
  let started; const began = new Promise(resolve => { started = resolve; }); let finish;
  const delay = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { renderThumbnail: async input => { started(); await delay; await fs.writeFile(input.outputPath, png); return resultFor(png); } });
  await f.controller.chooseSource(f.media); await enable(f.controller);
  const item = await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }); await began;
  await f.controller.setPolicy({ enabled: false }); finish();
  await until(f.controller, value => value.jobs[0].status === 'cancelled'); await pause(100);
  assert.equal((await f.controller.getState()).metrics.cacheBytes, 0);
  await assert.rejects(f.controller.getArtifact(item.lastEnqueuedId));
  const staging = path.join(f.directory, 'artifacts', 'staging'); assert.deepEqual(await fs.readdir(staging), []);
});
test('durable interrupted and queued jobs remain paused until explicit Resume; one runtime owns the queue', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const f = await fixture(t, { renderThumbnail: async (input, { signal }) => {
    calls++; if (calls === 1) { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { code: 'render-cancelled' })), { once: true })); }
    await fs.writeFile(input.outputPath, png); return resultFor(png);
  } });
  await f.controller.chooseSource(f.media); await enable(f.controller);
  const first = await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }); await began;
  const second = await f.controller.enqueue({ kind: 'proxy', rightsConfirmed: true });
  const competitor = f.make(); await assert.rejects(competitor.initialize(), { code: 'metadata-locked' });
  await f.controller.dispose();
  const restarted = f.make(); await restarted.initialize();
  assert.deepEqual((await restarted.getState()).jobs.map(job => job.status), ['paused', 'paused']);
  await pause(50); assert.equal(calls, 1);
  await restarted.resume(first.lastEnqueuedId);
  await until(restarted, value => value.jobs[0].status === 'completed');
  assert.equal((await restarted.getState()).jobs[1].status, 'paused');
  await restarted.resume(second.lastEnqueuedId); await until(restarted, value => value.jobs.every(job => job.status === 'completed'));
});
test('bounded retries, explicit restart, sanitized errors, source replacement and artifact tampering', async t => {
  let succeeds = false;
  const f = await fixture(t, { renderThumbnail: async input => {
    if (!succeeds) throw Object.assign(new Error('/secret/path credential'), { code: '/private/token' });
    await fs.writeFile(input.outputPath, png); return resultFor(png);
  } });
  await f.controller.chooseSource(f.media); await enable(f.controller);
  const item = await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true });
  await until(f.controller, value => value.jobs[0].status === 'failed');
  for (let i = 0; i < 2; i++) { await f.controller.retry(item.lastEnqueuedId); await until(f.controller, value => value.jobs[0].status === 'failed'); }
  await assert.rejects(f.controller.retry(item.lastEnqueuedId), { code: 'media-job-attempt-limit' });
  assert.equal((await f.controller.getState()).jobs[0].error, 'media-job-failed');
  succeeds = true; await f.controller.restart(item.lastEnqueuedId); await until(f.controller, value => value.jobs[0].status === 'completed');
  const artifact = await f.controller.getArtifact(item.lastEnqueuedId); await fs.writeFile(artifact.path, 'tampered');
  await assert.rejects(f.controller.getArtifact(item.lastEnqueuedId), { code: 'artifact-changed' });
  await fs.writeFile(`${f.media}.new`, 'source media bytes'); await fs.rename(`${f.media}.new`, f.media);
  await assert.rejects(f.controller.enqueue({ kind: 'asset-check' }), { code: 'source-changed' });
});
test('selection changes abort running work and stale source bytes cannot publish', async t => {
  let begun; let complete;
  const started = new Promise(resolve => { begun = resolve; });
  const pending = new Promise(resolve => { complete = resolve; });
  const f = await fixture(t, { renderThumbnail: async input => { begun(); await pending; await fs.writeFile(input.outputPath, png); return resultFor(png); } });
  await f.controller.chooseSource(f.media); await enable(f.controller);
  await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }); await started;
  f.setSelection(null); await f.controller.selectionChanged(); complete();
  await pause(100); assert.equal((await f.controller.getState()).available, false);
  f.setSelection({ projectId: 'film', sourceHash: sha(f.xml), exportPath: f.exportPath }); await f.controller.selectionChanged();
  assert.equal((await f.controller.getState()).jobs[0].status, 'paused');
  await fs.writeFile(f.media, 'source replaced');
  await assert.rejects(f.controller.resume((await f.controller.getState()).jobs[0].id), { code: 'source-changed' });
  assert.equal((await f.controller.getState()).metrics.cacheBytes, 0);
});
test('unavailable native helper leaves streaming hash/check usable with explicit decoder status', async t => {
  const f = await fixture(t, { getAvailability: async () => ({ available: false }), inspect: async () => { throw new Error('must not inspect'); } });
  await f.controller.chooseSource(f.media); await f.controller.enqueue({ kind: 'asset-check' });
  const state = await until(f.controller, value => value.jobs[0].status === 'completed');
  assert.equal(state.renderingAvailable, false); assert.equal(state.jobs[0].result.inspection, 'unavailable');
});
test('corrupt private journal fails closed before path-bearing errors or result objects can reach renderer', async t => {
  const f = await fixture(t); await f.controller.chooseSource(f.media); await f.controller.enqueue({ kind: 'hash' });
  await until(f.controller, value => value.jobs[0].status === 'completed'); await f.controller.dispose();
  const filename = path.join(f.directory, 'desktop-media-jobs.json'); const original = JSON.parse(await fs.readFile(filename));
  for (const mutate of [
    value => { value.jobs[0].result.path = '/private/secret'; },
    value => { value.jobs[0].error = '/private/secret'; },
    value => { value.jobs[0].status = 'invented'; },
    value => { value.jobs[0].progress = 101; },
    value => { value.jobs.push({ ...value.jobs[0] }); },
  ]) {
    const value = structuredClone(original); mutate(value); await fs.writeFile(filename, JSON.stringify(value));
    await assert.rejects(f.make().initialize(), { code: 'media-state-invalid' });
  }
  await fs.writeFile(filename, JSON.stringify(original)); const restored = f.make();
  assert.equal((await restored.initialize()).jobs[0].result.sha256, sha('source media bytes'));
});
test('still image proxy is a verified PNG in separate cache and output hardlinks are refused', async t => {
  const f = await fixture(t); await f.controller.chooseSource(f.media); await enable(f.controller);
  const proxy = await f.controller.enqueue({ kind: 'proxy', rightsConfirmed: true });
  await until(f.controller, value => value.jobs[0].status === 'completed');
  assert.equal((await f.controller.getArtifact(proxy.lastEnqueuedId)).mimeType, 'image/png');
  const mode = (await fs.stat(f.media)).mode;
  f.renderer.renderThumbnail = async input => { await fs.link(f.media, input.outputPath); return resultFor(await fs.readFile(f.media)); };
  await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true });
  const state = await until(f.controller, value => value.jobs[1].status === 'failed');
  assert.ok(['invalid-render-output', 'source-changed'].includes(state.jobs[1].error)); assert.equal((await fs.stat(f.media)).mode, mode);
  assert.equal(await fs.readFile(f.media, 'utf8'), 'source media bytes'); assert.equal(state.jobs[1].result, null);
});
test('background journal write failure is observable, pauses work and recovers only after explicit resume', async t => {
  let begun; let finish;
  const started = new Promise(resolve => { begun = resolve; }); const delayed = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { renderThumbnail: async (input, controls) => {
    begun(); await delayed; await controls.progress(70); await fs.writeFile(input.outputPath, png); return resultFor(png);
  } });
  try {
    await f.controller.chooseSource(f.media); await enable(f.controller);
    await f.controller.enqueue({ kind: 'thumbnail', rightsConfirmed: true }); await started;
    // Flush earlier fingerprint-progress writes before replacing the journal.
    await f.controller.getState();
    const filename = path.join(f.directory, 'desktop-media-jobs.json'); const retained = `${filename}.retained`;
    await fs.rename(filename, retained); await fs.mkdir(filename); // Atomic rename is now refused, like an unavailable journal.
    finish();
    const failed = await until(f.controller, value => value.error === 'media-storage-unavailable');
    assert.equal(failed.jobs[0].status, 'paused'); assert.equal(failed.jobs[0].result, null);
    await assert.rejects(f.controller.enqueue({ kind: 'hash' }), { code: 'media-storage-unavailable' });
    await f.controller.dispose(); await fs.rmdir(filename); await fs.rename(retained, filename);
    const restarted = f.make(); const restored = await restarted.initialize();
    assert.equal(restored.error, null); assert.equal(restored.jobs[0].status, 'paused');
  } finally {
    // Fixture cleanup must never wait forever on the delayed mock renderer.
    finish();
  }
});
