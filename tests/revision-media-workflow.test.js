'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createKeyring } = require('../src/security-controls');
const { createRevisionMediaWorkflow } = require('../src/revision-media-workflow');
const { createMediaBoundScanManifest, captureMediaRevision } = require('../src/media-revision-manifest');
const engine = require('../src/asset-file-transfer');
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { missing = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'revision-media-workflow-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceA = path.join(root, 'private-original-a.mov'), sourceB = path.join(root, 'private-original-b.mov');
  await fs.writeFile(sourceA, 'original a bytes'); if (!missing) await fs.writeFile(sourceB, 'original b bytes');
  const exportPath = path.join(root, 'private-edit.fcpxml');
  const resources = [sourceA, sourceB].map((filename, index) => `<asset id="a${index}" name="Original ${index}" src="${pathToFileURL(filename).href}" start="0s" duration="1s" hasVideo="1"/>`).join('');
  const clips = Array.from({ length: 50 }, (_, index) => `<asset-clip ref="a${index % 2}" name="Clip ${index + 1}" offset="${index}s" start="0s" duration="1s"/>`).join('');
  const xml = `<fcpxml version="1.10"><resources><format id="format" frameDuration="1/24s"/>${resources}</resources><library><event><project><sequence format="format" duration="50s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`;
  await fs.writeFile(exportPath, xml);
  const assets = await createDurableAssetService({ directory: path.join(root, 'service-assets'), keyring: createKeyring({ current: randomBytes(32) }, 'current'),
    initialize: true, chunkSize: 4, authorize: async () => ({ allowed: true, actorId: 'owner' }), authorizePolicy: async () => ({ allowed: true, actorId: 'owner' }) });
  t.after(() => assets.close()); await assets.setPolicy({}, 'film', { expectedVersion: 0, syncClasses: ['original'] });
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'film', name: 'Personal film' });
  let account = 'owner', role = 'owner'; const createInputs = [], reads = [];
  const revisionClient = {
    getAccount: async () => ({ id: account, status: 'active' }), listProjects: async () => ({ projects: [{ id: 'film', role, branches: ['main'] }] }),
    putManifest: async (...args) => history.putManifest(...args),
    createRevision: async input => { createInputs.push(input); return history.createRevision({ ...input, authorId: account }); },
    compareAndSwapBranch: async input => history.compareAndSwapBranch(input), getRevision: async (...args) => history.getRevision(...args), getManifest: async (...args) => history.getManifest(...args)
  };
  const assetClient = Object.fromEntries(['getPolicy', 'setPolicy', 'getAvailability', 'getAsset', 'beginUpload', 'putChunk', 'completeUpload'].map(method => [method, (...args) => assets[method]({}, ...args)]));
  assetClient.readChunk = (...args) => { reads.push(args[1]); return assets.readChunk({}, ...args); };
  const workflow = createRevisionMediaWorkflow({ revisionClient, assetClient, now: () => 100000 });
  const publish = uploadMedia => workflow.publish({ projectId: 'film', exportPath, branch: 'main', expectedHead: null, message: 'Exact media capture', idempotencyKey: 'first-publish', uploadMedia });
  const destinationDirectory = path.join(root, 'downloads'), workDirectory = path.join(root, 'work'); await fs.mkdir(destinationDirectory); await fs.mkdir(workDirectory);
  return { root, exportPath, sourceA, sourceB, xml, assets, assetClient, revisionClient, workflow, history, publish, reads, createInputs, destinationDirectory, workDirectory,
    setAccount(value) { account = value; }, setRole(value) { role = value; } };
}

test('actual capture publishes an immutable canonical revision with unique assets and idempotent branch acknowledgment', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.exportPath); const first = await f.publish(true), second = await f.publish(true);
  assert.equal(first.revisionId, second.revisionId); assert.equal(first.manifestId, second.manifestId); assert.equal(first.coverage, 'complete');
  assert.equal(first.uniqueAssets, 2); assert.equal(f.createInputs[0].requireMedia, true);
  const revision = f.history.getRevision('film', first.revisionId), manifest = f.history.getManifest('film', revision.manifestId).document;
  assert.equal(manifest.clips.length, 50); assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.mediaDependencies.assets.length, 2);
  assert.equal(manifest.sourceHash, sha(before)); assert.deepEqual(await fs.readFile(f.exportPath), before);
  assert.doesNotMatch(JSON.stringify({ first, manifest }), /\/private\/|\/Users\/|sourcePath|accessToken/);
});
test('selected revision availability combines verified local, service and explicitly scoped reported copies across all six states', async t => {
  const f = await fixture(t); const published = await f.publish(false), input = { projectId: 'film', revisionId: published.revisionId, localFiles: [f.sourceA] };
  let report = await f.workflow.availability(input); assert.equal(report.scope, 'checked-locations');
  assert.equal(report.items.find(item => item.localVerified).state, 'local-only'); assert.ok(report.items.some(item => item.state === 'missing'));
  const missing = report.items.find(item => !item.localVerified), capture = await captureMediaRevision({ exportPath: f.exportPath });
  const identity = capture.manifest.mediaDependencies.assets.find(item => item.identity.contentId === missing.contentId).identity;
  const collaboratorObservation = { schemaVersion: 1, source: 'owner-attested-collaborator', projectId: 'film', revisionId: published.revisionId,
    manifestId: published.manifestId, observedAt: 99000, expiresAt: 110000, assets: [identity] };
  report = await f.workflow.availability({ ...input, collaboratorObservation });
  assert.equal(report.items.find(item => item.contentId === missing.contentId).state, 'collaborator-only'); assert.equal(report.ready, false);
  for (const source of capture.sources) await engine.uploadAssetFile({ client: f.assetClient, projectId: 'film', filename: source.sourcePath, identity: source.identity });
  report = await f.workflow.availability(input); assert.ok(report.items.every(item => item.state === 'cloud-present')); assert.equal(report.ready, true);
  await f.assets.setArchived({}, 'film', identity.contentId, { expectedArchived: false, archived: true });
  report = await f.workflow.availability(input); assert.equal(report.items.find(item => item.contentId === identity.contentId).state, 'archived');
  await f.workflow.setPolicy({ projectId: 'film', input: { expectedVersion: 1, syncClasses: [] } });
  report = await f.workflow.availability(input); assert.ok(report.items.every(item => item.state === 'excluded'));
});
test('expired, fabricated-type and foreign-revision collaborator reports fail rather than claiming availability', async t => {
  const f = await fixture(t), revision = await f.publish(false);
  const base = { schemaVersion: 1, source: 'owner-attested-collaborator', projectId: 'film', revisionId: revision.revisionId,
    manifestId: revision.manifestId, observedAt: 99000, expiresAt: 110000, assets: [] };
  for (const patch of [{ source: 'live-authenticated' }, { revisionId: 'different' }, { projectId: 'another' }, { expiresAt: 100000 }, { expiresAt: 99000 + 86400001 }])
    await assert.rejects(f.workflow.availability({ projectId: 'film', revisionId: revision.revisionId, collaboratorObservation: { ...base, ...patch } }), { code: 'revision-media-observation-invalid' });
});
test('downloads use only canonical required identities, rehash local copies, preserve collisions and repeat without new chunk requests', async t => {
  const f = await fixture(t), revision = await f.publish(true), capture = await captureMediaRevision({ exportPath: f.exportPath });
  const extra = path.join(f.root, 'unrelated.mov'); await fs.writeFile(extra, 'unrelated bytes');
  const extraIdentity = (await engine.inspectAssetFile(extra, { assetClass: 'original' })).identity;
  await engine.uploadAssetFile({ client: f.assetClient, projectId: 'film', filename: extra, identity: extraIdentity });
  const input = { projectId: 'film', revisionId: revision.revisionId, destinationDirectory: f.destinationDirectory, workDirectory: f.workDirectory, localFiles: [f.sourceA] };
  const result = await f.workflow.download(input); assert.equal(result.results.length, 2); assert.equal(result.complete, true);
  const downloaded = result.results.find(item => item.status === 'downloaded'); assert.ok(downloaded); assert.ok(result.results.some(item => item.status === 'verified-local'));
  assert.ok(f.reads.every(assetId => assetId === downloaded.contentId)); assert.ok(!f.reads.includes(extraIdentity.contentId));
  const firstReads = f.reads.length; assert.equal((await f.workflow.download(input)).results.find(item => item.contentId === downloaded.contentId).status, 'already-present'); assert.equal(f.reads.length, firstReads);
  const target = path.join(f.destinationDirectory, downloaded.contentId.slice(7)); await fs.writeFile(target, 'private existing bytes');
  await assert.rejects(f.workflow.download(input), { code: 'asset-destination-exists' }); assert.equal(await fs.readFile(target, 'utf8'), 'private existing bytes');
  assert.equal(capture.manifest.clips.length, 50);
});
test('incomplete canonical coverage reports honestly and refuses selected-revision downloads', async t => {
  const f = await fixture(t, { missing: true }), revision = await f.publish(false);
  await assert.rejects(f.publish(true), { code: 'revision-media-coverage-incomplete' });
  assert.equal((await f.assets.getUsage({}, 'film')).assetCount, 0);
  const report = await f.workflow.availability({ projectId: 'film', revisionId: revision.revisionId, localFiles: [f.sourceA] });
  assert.equal(report.coverage, 'incomplete'); assert.equal(report.ready, false);
  await assert.rejects(f.workflow.download({ projectId: 'film', revisionId: revision.revisionId, destinationDirectory: f.destinationDirectory, workDirectory: f.workDirectory,
    localFiles: [f.sourceA] }), { code: 'revision-media-coverage-incomplete' }); assert.deepEqual(await fs.readdir(f.destinationDirectory), []);
});
test('hash-tampered service manifests, nonowner contexts and offline evidence never become missing-state reports', async t => {
  const f = await fixture(t), revision = await f.publish(false), input = { projectId: 'film', revisionId: revision.revisionId };
  f.setRole('viewer'); await assert.rejects(f.workflow.availability(input), { code: 'revision-media-owner-required' }); f.setRole('owner');
  const original = f.revisionClient.getManifest; f.revisionClient.getManifest = async (...args) => ({ ...await original(...args), document: { private: 'unbound' } });
  await assert.rejects(f.workflow.availability(input), { code: 'revision-media-manifest-invalid' }); f.revisionClient.getManifest = original;
  f.assetClient.getAvailability = async () => { throw Object.assign(new Error('offline'), { code: 'asset-network-unavailable' }); };
  await assert.rejects(f.workflow.availability(input), { code: 'asset-network-unavailable' });
});
test('cancellation retains resumable verified chunks without publishing an incomplete destination', async t => {
  const f = await fixture(t), revision = await f.publish(true), controller = new AbortController();
  const input = { projectId: 'film', revisionId: revision.revisionId, destinationDirectory: f.destinationDirectory, workDirectory: f.workDirectory };
  await assert.rejects(f.workflow.download(input, { signal: controller.signal, onProgress(value) { if (value.phase === 'downloading' && value.bytes === 4) controller.abort(); } }));
  assert.deepEqual(await fs.readdir(f.destinationDirectory), []);
  assert.equal((await f.workflow.download(input)).complete, true);
});
test('reusing a publication key after an export change refuses a new canonical revision and preserves the confirmed head', async t => {
  const f = await fixture(t), first = await f.publish(false);
  await fs.writeFile(f.exportPath, f.xml.replace('Clip 1"', 'Changed clip 1"'));
  await assert.rejects(f.publish(false), { code: 'idempotency-key-reused' });
  assert.equal(f.history.getBranch('film', 'main').revisionId, first.revisionId);
});
test('an account switch after availability preparation prevents any selected-revision download', async t => {
  const f = await fixture(t), revision = await f.publish(true); let accounts = 0;
  f.revisionClient.getAccount = async () => ({ id: ++accounts >= 4 ? 'different-owner' : 'owner', status: 'active' });
  await assert.rejects(f.workflow.download({ projectId: 'film', revisionId: revision.revisionId,
    destinationDirectory: f.destinationDirectory, workDirectory: f.workDirectory }), { code: 'revision-media-owner-required' });
  assert.deepEqual(await fs.readdir(f.destinationDirectory), []); assert.equal(f.reads.length, 0);
});
test('the owner can publish a real FCPXML bundle through its verified Info.fcpxml without changing bundle bytes', async t => {
  const f = await fixture(t), bundle = path.join(f.root, 'editor-export.fcpxmld'); await fs.mkdir(bundle);
  const info = path.join(bundle, 'Info.fcpxml'); await fs.copyFile(f.exportPath, info);
  const result = await f.workflow.publish({ projectId: 'film', exportPath: bundle, branch: 'main', expectedHead: null,
    message: 'Exact bundle capture', idempotencyKey: 'bundle-publish', uploadMedia: true });
  assert.equal(result.coverage, 'complete'); assert.equal(result.uniqueAssets, 2); assert.equal(result.sourceHash, sha(f.xml));
  assert.equal(await fs.readFile(info, 'utf8'), f.xml); assert.deepEqual(await fs.readdir(bundle), ['Info.fcpxml']);
});
test('a newly archived asset cannot publish a download assembled from previously received chunks', async t => {
  const f = await fixture(t), revision = await f.publish(true); let archived = false;
  await assert.rejects(f.workflow.download({ projectId: 'film', revisionId: revision.revisionId,
    destinationDirectory: f.destinationDirectory, workDirectory: f.workDirectory }, { async onProgress(progress) {
    if (!archived && progress.phase === 'writing') {
      archived = true; const report = await f.workflow.availability({ projectId: 'film', revisionId: revision.revisionId });
      await f.assets.setArchived({}, 'film', report.items[0].contentId, { expectedArchived: false, archived: true });
    }
  } }), { code: 'asset-archived' });
  assert.equal(archived, true); assert.deepEqual(await fs.readdir(f.destinationDirectory), []);
});
