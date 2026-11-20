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
  const workflow = createRevisionMediaWorkflow({ origin: 'https://personal.example.test', revisionClient, assetClient, now: () => 100000 });
  const publication = uploadMedia => ({ projectId: 'film', exportPath, branch: 'main', expectedHead: null, message: 'Exact media capture', idempotencyKey: 'first-publish', uploadMedia });
  const publish = async uploadMedia => { const input = publication(uploadMedia), review = await workflow.inspect(input); return workflow.publish({ ...input, reviewHash: review.reviewHash }); };
  const destinationDirectory = path.join(root, 'downloads'), workDirectory = path.join(root, 'work'); await fs.mkdir(destinationDirectory); await fs.mkdir(workDirectory);
  return { root, exportPath, sourceA, sourceB, xml, assets, assetClient, revisionClient, workflow, history, publication, publish, reads, createInputs, destinationDirectory, workDirectory,
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
  const input = { projectId: 'film', exportPath: bundle, branch: 'main', expectedHead: null,
    message: 'Exact bundle capture', idempotencyKey: 'bundle-publish', uploadMedia: true };
  const review = await f.workflow.inspect(input), result = await f.workflow.publish({ ...input, reviewHash: review.reviewHash });
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

function watchPublicationWrites(f) {
  const writes = [];
  for (const [client, methods] of [[f.revisionClient, ['putManifest', 'createRevision', 'compareAndSwapBranch']],
    [f.assetClient, ['beginUpload', 'putChunk', 'completeUpload', 'setPolicy']]]) {
    for (const name of methods) { const previous = client[name]; client[name] = (...args) => { writes.push(name); return previous(...args); }; }
  }
  return writes;
}
test('inspect is read-only and displays exact canonical metadata plus actual source basenames and deduplicated original bytes', async t => {
  const f = await fixture(t); await fs.copyFile(f.sourceA, f.sourceB); const writes = watchPublicationWrites(f), before = await fs.readFile(f.exportPath);
  const input = f.publication(true), review = await f.workflow.inspect(input), captured = await captureMediaRevision({ exportPath: f.exportPath });
  assert.deepEqual(writes, []); assert.equal((await f.assets.getUsage({}, 'film')).assetCount, 0);
  assert.equal(review.destination, 'https://personal.example.test'); assert.equal(review.accountId, 'owner'); assert.equal(review.projectId, 'film');
  assert.equal(review.branch, 'main'); assert.equal(review.expectedHead, null); assert.equal(review.message, input.message);
  assert.equal(review.source.filename, path.basename(f.exportPath)); assert.equal(review.source.sourceHash, sha(before));
  assert.deepEqual(review.manifest, captured.manifest); assert.equal(review.manifest.clips.length, 50);
  assert.equal(review.references, 2); assert.equal(review.uniqueAssets, 1); assert.equal(review.uniqueBytes, (await fs.stat(f.sourceA)).size);
  assert.equal(review.mediaBytesAuthorized, review.uniqueBytes); assert.equal(review.transferStarted, false);
  assert.deepEqual(review.assets[0].referenceIds, ['media-1', 'media-2']);
  assert.deepEqual(review.assets[0].sourceFilenames, [path.basename(f.sourceA), path.basename(f.sourceB)]);
  const { reviewHash, ...document } = review;
  assert.equal(reviewHash, require('../src/project-api-contracts').fingerprint(document));
  assert.doesNotMatch(JSON.stringify(review), /sourcePath|exportPath|accessToken|file:\/\/|\/private\/|\/Users\//);
  assert.deepEqual(await fs.readFile(f.exportPath), before);
});
test('missing or changed publication consent prevents every upload and metadata write for both media modes', async t => {
  const f = await fixture(t), writes = watchPublicationWrites(f);
  for (const uploadMedia of [true, false]) {
    const input = f.publication(uploadMedia);
    await assert.rejects(f.workflow.publish(input), { code: 'revision-media-review-required' });
    const review = await f.workflow.inspect(input);
    for (const patch of [{ message: 'Changed message' }, { branch: 'different' }, { expectedHead: 'changed-head' }, { uploadMedia: !uploadMedia }, { reviewHash: '0'.repeat(64) }])
      await assert.rejects(f.workflow.publish({ ...input, reviewHash: review.reviewHash, ...patch }), { code: 'revision-media-review-changed' });
    assert.deepEqual(writes, []);
  }
  assert.equal((await f.assets.getUsage({}, 'film')).assetCount, 0);
});
test('changing actual referenced bytes or export after inspect invalidates consent before any network write', async t => {
  const f = await fixture(t), input = f.publication(true), writes = watchPublicationWrites(f), review = await f.workflow.inspect(input);
  const original = await fs.readFile(f.sourceB); await fs.writeFile(f.sourceB, 'changed secret content');
  await assert.rejects(f.workflow.publish({ ...input, reviewHash: review.reviewHash }), { code: 'revision-media-review-changed' });
  assert.deepEqual(writes, []); await fs.writeFile(f.sourceB, original);
  await fs.writeFile(f.exportPath, f.xml.replace('Clip 1"', 'Changed metadata"'));
  await assert.rejects(f.workflow.publish({ ...input, reviewHash: review.reviewHash }), { code: 'revision-media-review-changed' }); assert.deepEqual(writes, []);
});
test('a different authenticated owner or destination cannot reuse a prior publication review', async t => {
  const f = await fixture(t), input = f.publication(true), writes = watchPublicationWrites(f), review = await f.workflow.inspect(input);
  f.setAccount('another-owner');
  await assert.rejects(f.workflow.publish({ ...input, reviewHash: review.reviewHash }), { code: 'revision-media-review-changed' });
  f.setAccount('owner'); const elsewhere = createRevisionMediaWorkflow({ origin: 'https://another.example.test', revisionClient: f.revisionClient, assetClient: f.assetClient });
  await assert.rejects(elsewhere.publish({ ...input, reviewHash: review.reviewHash }), { code: 'revision-media-review-changed' }); assert.deepEqual(writes, []);
});
test('metadata-only publication is reviewed separately, path text is refused, and an exact reviewed publication remains usable', async t => {
  const f = await fixture(t), input = f.publication(false), writes = watchPublicationWrites(f), review = await f.workflow.inspect(input);
  assert.equal(review.mediaBytesAuthorized, 0); assert.equal(review.uploadMedia, false);
  await assert.rejects(f.workflow.inspect({ ...input, message: 'Found /private/editor/secret.mov' }), { code: 'revision-media-input-invalid' });
  assert.deepEqual(writes, []);
  const result = await f.workflow.publish({ ...input, reviewHash: review.reviewHash }); assert.equal(result.uploaded.length, 0);
  assert.deepEqual(writes, ['putManifest', 'createRevision', 'compareAndSwapBranch']);
});
