const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createContentAssetService } = require('../src/content-asset-service');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { createMediaJobQueue } = require('../src/media-job-queue');
const { createMediaPreviewHandlers } = require('../src/media-preview-worker');

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-lifecycle-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assetDirectory = path.join(directory, 'assets');
  const service = createContentAssetService({ directory: assetDirectory, namespaceId: 'team',
    keyring: createKeyring({ key: Buffer.alloc(32, 4) }, 'key'), urlSecret: 'x'.repeat(32),
    origin: 'https://assets.example.test', chunkSize: 8, authorize: () => true,
    authorizeOwner: projectId => projectId === 'owner-project',
    verifyRevision: (projectId, revisionId, ids) => projectId === 'owner-project'
      && revisionId === 'rev-1' && ids.length === 1 });
  async function seed(projectId, bytes) {
    const identity = createMediaAssetIdentity({ size: Buffer.byteLength(bytes), sha256: sha(bytes) });
    const upload = await service.beginUpload({ projectId, identity });
    if (!upload.alreadyPresent) {
      for (let index = 0; index < upload.chunks; index++) {
        const chunk = Buffer.from(bytes).subarray(index * 8, (index + 1) * 8);
        await service.putChunk({ projectId, uploadId: upload.uploadId, index, bytes: chunk, checksum: sha(chunk) });
      }
      await service.completeUpload(projectId, upload.uploadId);
    }
    return identity.contentId;
  }
  return { directory, assetDirectory, service, seed };
}

test('retained revision blocks GC, while unreferenced exclusive bytes can be removed', async t => {
  const { service, seed } = await fixture(t);
  const retained = await seed('owner-project', 'retained');
  const disposable = await seed('owner-project', 'disposable');
  assert.equal((await service.retainRevisionAssets('owner-project', 'rev-1', [retained])).created, true);
  assert.equal((await service.retainRevisionAssets('owner-project', 'rev-1', [retained])).created, false);
  await assert.rejects(service.retainRevisionAssets('owner-project', 'rev-1', [disposable]), { code: 'asset-revision-immutable' });
  const report = await service.exportProjectReport('owner-project');
  assert.equal(report.revisionCount, 1);
  assert.equal(report.assets.find(item => item.assetId === retained).eligible, false);
  assert.equal(report.deletableBytes, Buffer.byteLength('disposable'));
  await assert.rejects(service.garbageCollect('owner-project', [retained]), { code: 'asset-retained-by-revision' });
  assert.deepEqual((await service.garbageCollect('owner-project', [disposable])).physicallyDeleted, [disposable]);
  assert.equal((await service.readChunk({ projectId: 'owner-project', assetId: retained, index: 0 })).bytes.toString(), 'retained');
  await assert.rejects(service.readChunk({ projectId: 'owner-project', assetId: disposable, index: 0 }), { code: 'asset-not-found' });
});

test('owner report is scoped; shared asset release preserves other project bytes', async t => {
  const { service, seed } = await fixture(t);
  const shared = await seed('owner-project', 'shared');
  await seed('another-project', 'shared');
  await assert.rejects(service.exportProjectReport('another-project'), { code: 'asset-owner-required' });
  const report = await service.exportProjectReport('owner-project');
  assert.equal(report.assets[0].sharedProjects, true);
  assert.equal(report.deletableBytes, 0);
  assert.deepEqual((await service.garbageCollect('owner-project', [shared])).physicallyDeleted, []);
  assert.equal((await service.readChunk({ projectId: 'another-project', assetId: shared, index: 0 })).bytes.toString(), 'shared');
});

test('durable jobs deduplicate inputs, show progress, retry failure, and recover running work', async t => {
  const { directory } = await fixture(t);
  const jobDirectory = path.join(directory, 'jobs'); let attempts = 0;
  const handlers = { hash: async (_job, controls) => {
    attempts++; await controls.progress(50);
    if (attempts === 1) { const error = new Error('retry'); error.code = 'worker-unavailable'; throw error; }
    return { sha256: sha('bytes') };
  } };
  const queue = createMediaJobQueue({ directory: jobDirectory, handlers });
  const first = await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'asset-1' });
  assert.equal(first.created, true);
  assert.equal((await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'asset-1' })).created, false);
  assert.equal((await queue.runNext()).status, 'failed');
  assert.equal((await queue.inspect())[0].progress, 50);
  await queue.retry(first.id);
  assert.equal((await queue.runNext()).status, 'completed');
  assert.equal((await queue.enqueue({ kind: 'hash', projectId: 'film', sourceId: 'asset-1' })).status, 'completed');
  const second = await queue.enqueue({ kind: 'proxy', projectId: 'film', sourceId: 'asset-2' });
  const filename = path.join(jobDirectory, 'media-jobs.json'); const state = JSON.parse(await fs.readFile(filename));
  state.jobs.find(job => job.id === second.id).status = 'running'; await fs.writeFile(filename, JSON.stringify(state));
  const restarted = createMediaJobQueue({ directory: jobDirectory, handlers });
  assert.equal((await restarted.inspect()).find(job => job.id === second.id).status, 'queued');
  assert.equal((await restarted.runNext()).status, 'failed');
});

test('preview jobs require rights and provider; output is marked noncanonical', async t => {
  const { directory } = await fixture(t); const saved = [];
  const handlers = createMediaPreviewHandlers({ renderThumbnail: async () => ({ mimeType: 'image/png', bytes: Buffer.from('png-data') }),
    renderTimeline: async () => ({ mimeType: 'image/jpeg', bytes: Buffer.from('preview-data') }),
    savePreview: async item => { saved.push(item); return { id: `preview-${saved.length}` }; } });
  const queue = createMediaJobQueue({ directory: path.join(directory, 'jobs'), handlers });
  const denied = await queue.enqueue({ kind: 'thumbnail', projectId: 'film', sourceId: 'clip-1' });
  assert.equal((await queue.runNext()).error, 'preview-rights-required');
  await queue.retry(denied.id);
  const allowed = await queue.enqueue({ kind: 'thumbnail', projectId: 'film', sourceId: 'clip-1', options: { rightsConfirmed: true } });
  // The failed, rights-free job remains queued first; cancel it to run the authorized one.
  await queue.cancel(denied.id);
  assert.equal((await queue.runNext()).status, 'completed');
  assert.equal(saved[0].canonical, false);
  assert.equal((await queue.inspect()).find(job => job.id === allowed.id).result.canonical, false);
  await queue.enqueue({ kind: 'timeline-preview', projectId: 'film', sourceId: 'sequence-1', options: { rightsConfirmed: true } });
  assert.equal((await queue.runNext()).status, 'completed');
  assert.equal(saved.length, 2);
});
