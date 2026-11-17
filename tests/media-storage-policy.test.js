const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createContentAssetService } = require('../src/content-asset-service');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { classifyMediaAvailability, createProjectMediaPolicy, planRevisionDownloads,
  downloadRequiredMedia, evaluateRelinkCandidate, estimateUpload } = require('../src/media-storage-policy');

const sha = value => createHash('sha256').update(value).digest('hex');
const asset = (id, bytes, assetClass = 'original', required = true) => ({ id,
  contentId: `sha256:${sha(bytes)}`, size: Buffer.byteLength(bytes), assetClass, required });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-media-policy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createContentAssetService({ directory: path.join(root, 'assets'), namespaceId: 'team',
    keyring: createKeyring({ current: Buffer.alloc(32, 3) }, 'current'), urlSecret: 'x'.repeat(32),
    origin: 'https://assets.example.test', chunkSize: 4, authorize: () => true });
  async function seed(projectId, bytes, assetClass = 'original') {
    const identity = createMediaAssetIdentity({ sha256: sha(bytes), size: Buffer.byteLength(bytes) }, { assetClass });
    const upload = await service.beginUpload({ projectId, identity });
    if (!upload.alreadyPresent) {
      for (let i = 0; i < upload.chunks; i++) {
        const chunk = Buffer.from(bytes).subarray(i * 4, (i + 1) * 4);
        await service.putChunk({ projectId, uploadId: upload.uploadId, index: i, bytes: chunk, checksum: sha(chunk) });
      }
      await service.completeUpload(projectId, upload.uploadId);
    }
    return identity;
  }
  return { root, service, seed };
}

test('availability states use explicit evidence and distinguish local plus cloud', () => {
  assert.equal(classifyMediaAvailability({ cloudPresent: true, localVerified: true }).state, 'cloud-present');
  assert.equal(classifyMediaAvailability({ localVerified: true }).state, 'local-only');
  assert.equal(classifyMediaAvailability({ collaboratorPresent: true }).state, 'collaborator-only');
  assert.equal(classifyMediaAvailability().state, 'missing');
  assert.equal(classifyMediaAvailability({ excluded: true, cloudPresent: true }).state, 'excluded');
  assert.equal(classifyMediaAvailability({ archived: true, collaboratorPresent: true }).state, 'archived');
  assert.throws(() => classifyMediaAvailability({ cloudPresent: 'yes' }), { code: 'media-evidence-invalid' });
});

test('project sync classes default to none and require write authorization', () => {
  const policy = createProjectMediaPolicy({ authorize: (id, action) => id === 'film' && action === 'read' || id === 'film' && action === 'write' });
  assert.deepEqual(policy.get('film').syncClasses, []);
  assert.deepEqual(policy.set('film', ['proxy', 'audio']).syncClasses, ['audio', 'proxy']);
  assert.throws(() => policy.set('other', ['original']), { code: 'media-policy-forbidden' });
  assert.throws(() => policy.set('film', ['original', 'original']), { code: 'media-policy-invalid' });
  assert.deepEqual(createProjectMediaPolicy({ authorize: () => true, initialState: policy.snapshot() }).get('film').syncClasses, ['audio', 'proxy']);
});

test('selected revision plan downloads only required cloud assets and verifies bytes on disk', async t => {
  const { root, service, seed } = await fixture(t);
  await seed('film', 'camera-data');
  const original = asset('camera', 'camera-data');
  const optional = asset('optional', 'optional-data', 'graphics', false);
  const plan = planRevisionDownloads({ projectId: 'film', revisionId: 'revision-1', assets: [original, optional],
    availability: { camera: classifyMediaAvailability({ cloudPresent: true }) } });
  assert.equal(plan.ready, true); assert.equal(plan.items.length, 1); assert.equal(plan.downloadBytes, original.size);
  const destination = path.join(root, 'downloads'); await fs.mkdir(destination);
  const resolveRevisionAssets = async () => ({ id: 'revision-1', projectId: 'film', assets: [original, optional] });
  const first = await downloadRequiredMedia(plan, { destination, service, resolveRevisionAssets });
  assert.equal(first.results[0].status, 'downloaded');
  assert.equal(await fs.readFile(path.join(destination, original.contentId.slice(7)), 'utf8'), 'camera-data');
  assert.equal((await downloadRequiredMedia(plan, { destination, service, resolveRevisionAssets })).results[0].status, 'already-present');
  await assert.rejects(downloadRequiredMedia(plan, { destination, service,
    resolveRevisionAssets: async () => ({ id: 'revision-1', projectId: 'film', assets: [optional] }) }), { code: 'media-download-plan-stale' });
  const blocked = planRevisionDownloads({ projectId: 'film', revisionId: 'revision-1', assets: [original],
    availability: { camera: classifyMediaAvailability({ collaboratorPresent: true }) } });
  assert.equal(blocked.ready, false); assert.equal(blocked.items[0].reason, 'collaborator-only');
});

test('proxy cannot satisfy original relink; exact original bytes can', async t => {
  const { root } = await fixture(t);
  const filename = path.join(root, 'candidate.mov'); await fs.writeFile(filename, 'camera-data');
  const original = asset('camera', 'camera-data');
  assert.deepEqual(await evaluateRelinkCandidate({ required: original, candidatePath: filename, candidateClass: 'proxy' }),
    { id: 'camera', verified: false, reason: 'asset-class-mismatch' });
  assert.equal((await evaluateRelinkCandidate({ required: original, candidatePath: filename, candidateClass: 'original' })).verified, true);
  await fs.writeFile(filename, 'wrong');
  assert.equal((await evaluateRelinkCandidate({ required: original, candidatePath: filename, candidateClass: 'original' })).verified, false);
});

test('upload estimate explains policy exclusions, deduplication and project usage', async t => {
  const { service, seed } = await fixture(t);
  await seed('other-project', 'same');
  const policy = createProjectMediaPolicy({ authorize: () => true }); policy.set('film', ['original']);
  const estimate = await estimateUpload({ projectId: 'film', policy, service,
    assets: [asset('one', 'same'), asset('two', 'new!'), asset('three', 'new!'), asset('proxy', 'proxy', 'proxy')] });
  assert.equal(estimate.uploadBytes, 4);
  assert.equal(estimate.reusedBytes, 8);
  assert.equal(estimate.excludedBytes, 5);
  assert.equal(estimate.currentUsage.logicalBytes, 0);
  await seed('film', 'new!');
  assert.equal((await service.storageUsage('film')).logicalBytes, 4);
});
