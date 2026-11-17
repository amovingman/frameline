const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createContentAssetService } = require('../src/content-asset-service');
const { createMediaAssetIdentity, identifyMediaFile } = require('../src/media-asset-identity');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-assets-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyring = createKeyring({ current: Buffer.alloc(32, 7) }, 'current');
  const base = { directory, namespaceId: 'team-one', keyring, urlSecret: 'x'.repeat(32),
    origin: 'https://assets.example.test', chunkSize: 4, authorize: () => true, ...options };
  return { directory, base, service: createContentAssetService(base) };
}

test('streamed file identity supports resumable encrypted chunk upload and download', async t => {
  const { directory, base, service } = await fixture(t);
  const file = path.join(directory, 'source.mov'); await fs.writeFile(file, 'abcdefghij');
  const identity = await identifyMediaFile(file, { assetClass: 'original' });
  const upload = await service.beginUpload({ projectId: 'project-a', identity });
  assert.equal(upload.chunks, 3);
  await service.putChunk({ projectId: 'project-a', uploadId: upload.uploadId, index: 1,
    bytes: Buffer.from('efgh'), checksum: sha('efgh') });
  assert.deepEqual((await service.uploadStatus('project-a', upload.uploadId)).received, [false, true, false]);
  const resumed = createContentAssetService(base);
  await resumed.putChunk({ projectId: 'project-a', uploadId: upload.uploadId, index: 0,
    bytes: Buffer.from('abcd'), checksum: sha('abcd') });
  await resumed.putChunk({ projectId: 'project-a', uploadId: upload.uploadId, index: 2,
    bytes: Buffer.from('ij'), checksum: sha('ij') });
  const completed = await resumed.completeUpload('project-a', upload.uploadId);
  assert.equal(completed.verified, true);
  assert.deepEqual(await resumed.completeUpload('project-a', upload.uploadId), completed);
  assert.equal((await resumed.uploadStatus('project-a', upload.uploadId)).complete, true);
  const recovered = createContentAssetService(base);
  const chunks = [];
  for (let index = 0; index < 3; index++) chunks.push((await recovered.readChunk({ projectId: 'project-a', assetId: identity.contentId, index })).bytes);
  assert.equal(Buffer.concat(chunks).toString(), 'abcdefghij');
  const raw = await fs.readFile(path.join(directory, 'assets', sha('team-one'), identity.contentId.slice(7), '0.json'), 'utf8');
  assert.doesNotMatch(raw, /abcd|source\.mov/);
  await assert.rejects(recovered.readChunk({ projectId: 'project-b', assetId: identity.contentId, index: 0 }), { code: 'asset-not-found' });
});

test('same namespace deduplicates across projects; other namespace does not', async t => {
  const { directory, base, service } = await fixture(t);
  const bytes = Buffer.from('same'); const identity = createMediaAssetIdentity({ size: 4, sha256: sha(bytes) });
  const upload = await service.beginUpload({ projectId: 'a', identity });
  await service.putChunk({ projectId: 'a', uploadId: upload.uploadId, index: 0, bytes, checksum: sha(bytes) });
  await service.completeUpload('a', upload.uploadId);
  const deduped = await service.beginUpload({ projectId: 'b', identity });
  assert.equal(deduped.alreadyPresent, true);
  assert.equal((await service.readChunk({ projectId: 'b', assetId: identity.contentId, index: 0 })).bytes.toString(), 'same');
  const separate = createContentAssetService({ ...base, namespaceId: 'team-two', directory: path.join(directory, 'other') });
  assert.equal((await separate.beginUpload({ projectId: 'c', identity })).alreadyPresent, false);
});

test('bad chunks, incomplete files, cancellation, and encrypted tampering fail closed', async t => {
  const { directory, service } = await fixture(t);
  const identity = createMediaAssetIdentity({ size: 5, sha256: sha('abcde') });
  const upload = await service.beginUpload({ projectId: 'a', identity });
  await assert.rejects(service.putChunk({ projectId: 'a', uploadId: upload.uploadId, index: 0,
    bytes: Buffer.from('abcd'), checksum: sha('xxxx') }), { code: 'asset-chunk-invalid' });
  await assert.rejects(service.completeUpload('a', upload.uploadId), { code: 'upload-incomplete' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.putChunk({ projectId: 'a', uploadId: upload.uploadId, index: 0,
    bytes: Buffer.from('abcd'), checksum: sha('abcd'), signal: controller.signal }), { code: 'asset-cancelled' });
  await service.putChunk({ projectId: 'a', uploadId: upload.uploadId, index: 0, bytes: Buffer.from('abcd'), checksum: sha('abcd') });
  await service.putChunk({ projectId: 'a', uploadId: upload.uploadId, index: 1, bytes: Buffer.from('e'), checksum: sha('e') });
  await service.completeUpload('a', upload.uploadId);
  const chunkFile = path.join(directory, 'assets', sha('team-one'), identity.contentId.slice(7), '0.json');
  const record = JSON.parse(await fs.readFile(chunkFile, 'utf8')); record.ciphertext = Buffer.from('damage').toString('base64');
  await fs.writeFile(chunkFile, JSON.stringify(record));
  await assert.rejects(service.readChunk({ projectId: 'a', assetId: identity.contentId, index: 0 }));
});

test('bandwidth pacing, progress, project authorization, and signed URL expiry', async t => {
  let time = 1000; const progress = [];
  const { service } = await fixture(t, { now: () => time, maxBytesPerSecond: 4000,
    authorize: (projectId, action) => projectId === 'allowed' && ['read', 'write'].includes(action),
    onProgress: value => progress.push(value) });
  const identity = createMediaAssetIdentity({ size: 0, sha256: sha('') });
  await assert.rejects(service.beginUpload({ projectId: 'blocked', identity }), { code: 'asset-forbidden' });
  const upload = await service.beginUpload({ projectId: 'allowed', identity });
  await service.putChunk({ projectId: 'allowed', uploadId: upload.uploadId, index: 0,
    bytes: Buffer.alloc(0), checksum: sha('') });
  await service.completeUpload('allowed', upload.uploadId);
  assert.equal(progress.at(-1).totalBytes, 0);
  const url = service.signedUrl({ projectId: 'allowed', assetId: identity.contentId, method: 'GET', expiresAt: 2000 });
  assert.equal(service.verifySignedUrl(url, 'GET').projectId, 'allowed');
  assert.throws(() => service.verifySignedUrl(url, 'PUT'), { code: 'asset-url-invalid' });
  assert.throws(() => service.verifySignedUrl(url.replace('allowed', 'blocked'), 'GET'), { code: 'asset-url-invalid' });
  time = 2000;
  assert.throws(() => service.verifySignedUrl(url, 'GET'), { code: 'asset-url-invalid' });
});
