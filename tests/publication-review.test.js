'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createDesktopRevisionSync } = require('../src/desktop-revision-sync');
const { createDesktopResolveServiceSync } = require('../src/desktop-resolve-service-sync');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { createSyncQueue } = require('../src/sync-queue');
const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const manifest = marker => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: sha(marker),
  sequence: { name: 'Personal cut', frameDuration: '1/24s', durationFrames: 50 },
  clips: Array.from({ length: 50 }, (_, i) => ({ scanKey: `position-${i + 1}`, name: `小场景 ${i + 1}`, mediaName: 'Camera original',
    offsetFrames: i, durationFrames: 1, sourceInFrames: 0, enabled: true, identityStatus: 'unresolved' })), media: [], warnings: [] });
async function fixture(t, resolve = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-review-')), store = createLocalMetadataStore(path.join(root, 'local'));
  const snapshot = resolve ? JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8')) : null;
  const document = resolve ? createResolveRevisionManifest(snapshot) : manifest('first');
  const project = resolve ? await store.getResolveProjectId(snapshot.project_id) : await store.getProjectId('/private/disposable/cut.fcpxml');
  const first = await store.saveRevision(project.id, document, 'First revision');
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'remote', name: 'Owner service project' });
  let offline = false, clock = Date.now();
  const state = { origin: 'https://owner-service.example.test', status: 'connected', connected: true, account: { id: 'owner', email: 'private@example.test' },
    projects: [{ id: 'remote', name: 'Owner service project', role: 'owner', branches: ['main'] }] };
  const calls = [], connection = { getState: () => structuredClone(state), getClient: () => Object.fromEntries(
    ['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch', 'getRevision', 'getManifest', 'findRevisionBySource'].map(method => [method, async (...args) => {
      args.pop(); calls.push(method); if (offline) throw Object.assign(new Error('secret /private/path'), { code: 'sync-network-unavailable' });
      if (method === 'createRevision') args[0] = { ...args[0], authorId: state.account.id };
      return history[method](...args);
    }])) };
  const directory = path.join(root, 'controller');
  const controller = resolve ? createDesktopResolveServiceSync({ directory, connection, store, requirePublicationReview: true, now: () => clock })
    : createDesktopRevisionSync({ directory, connection, store, getSelection: () => ({ localProjectId: project.id, branch: 'main' }), requirePublicationReview: true, now: () => clock });
  if (resolve) await controller.select(project.id);
  await controller.bind({ remoteProjectId: 'remote', remoteBranch: 'main' }); calls.length = 0;
  t.after(async () => { await controller.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, controller, store, history, project, first, state, calls, document,
    offline: value => { offline = value; }, advance: value => { clock += value; } };
}
const consent = review => ({ reviewId: review.reviewId, sha256: review.sha256, confirmed: true });
const writes = calls => calls.filter(name => ['putManifest', 'createRevision', 'compareAndSwapBranch'].includes(name));
for (const resolve of [false, true]) test(`${resolve ? 'Resolve' : 'FCPXML'} publication requires a fresh exact disclosure, paginates all metadata and sends no media bytes`, async t => {
  const f = await fixture(t, resolve), c = f.controller;
  assert.equal((await c.push()).error, 'publication-review-required'); assert.deepEqual(writes(f.calls), []);
  f.calls.length = 0; const review = await c.previewPublication({ action: 'push' });
  assert.deepEqual(f.calls, []); assert.equal(review.mediaBytesIncluded, false);
  let text = review.text;
  for (let page = 1; page < review.pageCount; page++) text += (await c.getPublicationPage({ reviewId: review.reviewId, page })).text;
  assert.equal(sha(text), review.sha256); assert.equal(Buffer.byteLength(text), review.byteLength);
  const projection = JSON.parse(text); assert.deepEqual(projection.publications[0].revisions[0].manifest, f.document);
  assert.doesNotMatch(text, /accessToken|refreshToken|private@example|\/private\/|\/Users\//);
  assert.equal((await c.push({ ...consent(review), confirmed: false })).error, 'publication-review-required');
  assert.equal((await c.push(consent(review))).error ?? null, null);
  assert.ok(writes(f.calls).includes('createRevision'));
  assert.equal(f.history.listRevisions('remote').items.length, 1);
  const before = writes(f.calls).length;
  assert.equal((await c.push(consent(review))).error, 'publication-review-required'); assert.equal(writes(f.calls).length, before);
});
test('changed local history, account, queue or review age cannot publish unreviewed metadata', async t => {
  const f = await fixture(t), c = f.controller;
  const initial = await c.previewPublication({ action: 'push' });
  await f.store.saveRevision(f.project.id, manifest('second'), 'Later revision', f.first.id);
  assert.equal((await c.push(consent(initial))).error, 'publication-review-stale'); assert.deepEqual(writes(f.calls), []);
  const aged = await c.previewPublication({ action: 'push' }); f.advance(300001);
  assert.equal((await c.push(consent(aged))).error, 'publication-review-stale'); assert.deepEqual(writes(f.calls), []);
  const cancelled = await c.previewPublication({ action: 'push' }); c.dismissPublicationReview({ reviewId: cancelled.reviewId });
  assert.equal((await c.push(consent(cancelled))).error, 'publication-review-required');
  const replaced = await c.previewPublication({ action: 'push' }); f.state.account.id = 'other-owner'; c.connectionChanged();
  assert.equal((await c.push(consent(replaced))).error, 'service-project-unavailable'); assert.deepEqual(writes(f.calls), []);
});
test('queued retries require fresh consent for the complete exact pending set', async t => {
  const f = await fixture(t), c = f.controller; f.offline(true);
  const review = await c.previewPublication({ action: 'push' }); await c.push(consent(review));
  const state = await c.getState(), id = state.operations[0].id; f.offline(false); f.calls.length = 0;
  assert.equal((await c.retry(id)).error, 'publication-review-required'); assert.deepEqual(writes(f.calls), []);
  const retry = await c.previewPublication({ action: 'retry', operationId: id });
  const scopes = await fs.readdir(path.join(f.directory, 'scopes'));
  const queue = createSyncQueue({ directory: path.join(f.directory, 'scopes', scopes[0], 'queue') });
  const payload = queue.getPrivatePayloads()[0].payload;
  await f.store.saveRevision(f.project.id, manifest('queued-second'), 'New queued revision', f.first.id);
  payload.bundle = await f.store.exportRevisions(f.project.id); queue.enqueuePush(payload);
  assert.equal((await c.retry({ id, ...consent(retry) })).error, 'publication-review-stale'); assert.deepEqual(writes(f.calls), []);
  const approved = await c.previewPublication({ action: 'retry', operationId: id });
  assert.equal((await c.retry({ id, ...consent(approved) })).error ?? null, null);
  assert.equal((await c.getState()).operations.length, 0);
});

test('a same-account viewer downgrade cannot dispatch a previously reviewed queued publication', async t => {
  const f = await fixture(t), c = f.controller; c.connectionChanged(); f.offline(true);
  await c.push(consent(await c.previewPublication({ action: 'push' })));
  const id = (await c.getState()).operations[0].id; f.offline(false);
  const approved = await c.previewPublication({ action: 'retry', operationId: id });
  f.state.projects[0].role = 'viewer'; c.connectionChanged(); f.calls.length = 0;
  assert.equal((await c.retry({ id, ...consent(approved) })).error, 'service-viewer-read-only');
  assert.deepEqual(f.calls, []);
});

test('review and publication exclude unrelated branch metadata', async t => {
  const f = await fixture(t), c = f.controller;
  await f.store.createBranch(f.project.id, 'private-fork', f.first.id);
  await f.store.switchBranch(f.project.id, 'private-fork');
  await f.store.saveRevision(f.project.id, manifest('not-shared'), 'Unshared private note', f.first.id, 'private-fork');
  await f.store.switchBranch(f.project.id, 'main');
  const review = await c.previewPublication({ action: 'push' }); let text = review.text;
  for (let page = 1; page < review.pageCount; page++) text += (await c.getPublicationPage({ reviewId: review.reviewId, page })).text;
  assert.equal(review.revisionCount, 1); assert.ok(!text.includes('Unshared private note'));
  await c.push(consent(review)); assert.equal(f.history.listRevisions('remote').items.length, 1);
});
