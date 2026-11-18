'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { createKeyring } = require('../src/security-controls');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identify = (bytes, metadata) => createMediaAssetIdentity({ size: bytes.length, sha256: sha(bytes) }, metadata);
const owner = { user: 'owner' }, viewer = { user: 'viewer' }, outsider = { user: 'outsider' };
async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-durable-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  const authorize = async (context, projectId, action) => {
    await Promise.resolve();
    if (!['project-a', 'project-b'].includes(projectId) || context.user === 'outsider' || context.user === 'viewer' && action !== 'read')
      throw Object.assign(new Error('denied'), { code: 'forbidden' });
    return { allowed: true };
  };
  const opts = { directory, keyring, authorize, chunkSize: 4, ...extra }; let store = await createDurableAssetService({ ...opts, initialize: true });
  t.after(() => store.close());
  return { directory, keyring, opts, get store() { return store; }, async reopen(changes = {}) {
    await store.close(); store = await createDurableAssetService({ ...opts, ...changes }); return store;
  } };
}
async function upload(store, bytes, projectId = 'project-a', metadata) {
  const identity = identify(bytes, metadata); const begin = await store.beginUpload(owner, projectId, identity);
  for (let index = 0; index < begin.chunks; index++) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await store.putChunk(owner, projectId, begin.uploadId, index, chunk, sha(chunk));
  }
  return { begin, identity, receipt: await store.completeUpload(owner, projectId, begin.uploadId) };
}

test('out-of-order chunks resume through restart, publish only after full hashing and retain exact metadata', async t => {
  const f = await fixture(t); const bytes = Buffer.from('abcdefghij'); const identity = identify(bytes, { assetClass: 'original', mediaType: 'video/quicktime' });
  const begin = await f.store.beginUpload(owner, 'project-a', identity); assert.deepEqual(begin.received, [false, false, false]);
  const middle = bytes.subarray(4, 8); assert.deepEqual(await f.store.putChunk(owner, 'project-a', begin.uploadId, 1, middle, sha(middle)), { receivedBytes: 4, totalBytes: 10, complete: false });
  await f.reopen(); assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [false, true, false]);
  assert.equal((await f.store.beginUpload(owner, 'project-a', identity)).uploadId, begin.uploadId);
  await assert.rejects(f.store.completeUpload(owner, 'project-a', begin.uploadId), { code: 'upload-incomplete' });
  await assert.rejects(f.store.getAsset(viewer, 'project-a', identity.contentId), { code: 'asset-not-found' });
  for (const index of [2, 0]) { const chunk = bytes.subarray(index * 4, index * 4 + 4); await f.store.putChunk(owner, 'project-a', begin.uploadId, index, chunk, sha(chunk)); }
  const receipt = await f.store.completeUpload(owner, 'project-a', begin.uploadId);
  assert.deepEqual(receipt, { assetId: identity.contentId, size: 10, chunkSize: 4, chunks: 3, verified: true });
  await f.reopen(); assert.deepEqual(await f.store.completeUpload(owner, 'project-a', begin.uploadId), receipt);
  assert.equal((await f.store.beginUpload(owner, 'project-a', identity)).complete, true);
  assert.deepEqual(await f.store.getAsset(viewer, 'project-a', identity.contentId), { assetId: identity.contentId, size: 10, chunkSize: 4, chunks: 3, identity });
  const downloaded = []; for (let index = 0; index < 3; index++) { const chunk = await f.store.readChunk(viewer, 'project-a', identity.contentId, index); assert.equal(sha(chunk.bytes), chunk.checksum); downloaded.push(chunk.bytes); }
  assert.deepEqual(Buffer.concat(downloaded), bytes);
  const persisted = await fs.readFile(path.join(f.directory, 'assets.enc.json'), 'utf8'); assert.equal(persisted.includes(identity.contentId), false);
  const chunkFile = await fs.readFile(path.join(f.directory, 'uploads', begin.uploadId, '0.enc.json'), 'utf8'); assert.equal(chunkFile.includes('abcd'), false);
});

test('content deduplication stays project-bound and exact identity metadata cannot be silently changed', async t => {
  const f = await fixture(t); const bytes = Buffer.from('same content'); const a = await upload(f.store, bytes);
  await assert.rejects(f.store.getAsset(owner, 'project-b', a.identity.contentId), { code: 'asset-not-found' });
  await assert.rejects(f.store.uploadStatus(owner, 'project-b', a.begin.uploadId), { code: 'upload-not-found' });
  const b = await upload(f.store, bytes, 'project-b'); assert.notEqual(b.begin.uploadId, a.begin.uploadId); assert.equal(a.receipt.assetId, b.receipt.assetId);
  assert.equal((await f.store.beginUpload(owner, 'project-a', a.identity)).uploadId, a.begin.uploadId);
  for (const changed of [{ ...a.identity, size: a.identity.size + 1 }, { ...a.identity, assetClass: 'proxy' }, { ...a.identity, mediaType: 'video/mp4' }])
    await assert.rejects(f.store.beginUpload(owner, 'project-a', changed), { code: 'asset-identity-collision' });
});

test('all operations await live authorization and viewers cannot create, inspect partial state or complete uploads', async t => {
  const f = await fixture(t); const bytes = Buffer.from('safe'); const a = await upload(f.store, bytes);
  for (const denied of [viewer, outsider]) for (const call of [() => f.store.beginUpload(denied, 'project-a', a.identity),
    () => f.store.uploadStatus(denied, 'project-a', a.begin.uploadId), () => f.store.putChunk(denied, 'project-a', a.begin.uploadId, 0, bytes, sha(bytes)),
    () => f.store.completeUpload(denied, 'project-a', a.begin.uploadId)]) await assert.rejects(call(), { code: 'forbidden' });
  await assert.rejects(f.store.getAsset(outsider, 'project-a', a.identity.contentId), { code: 'forbidden' });
  await assert.rejects(f.store.readChunk(outsider, 'project-a', a.identity.contentId, 0), { code: 'forbidden' });
  await f.reopen({ authorize: async () => false }); await assert.rejects(f.store.getAsset(owner, 'project-a', a.identity.contentId), { code: 'asset-forbidden' });
});

test('authorization is rechecked before index commit and denied commits leave resumable unlisted chunks', async t => {
  let deny = false, checks = 0; const f = await fixture(t, { authorize: async () => ({ allowed: !deny || ++checks < 3 }) });
  const bytes = Buffer.from('safe'); const begin = await f.store.beginUpload(owner, 'project-a', identify(bytes)); deny = true;
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)), { code: 'asset-forbidden' });
  deny = false; assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [false]);
  await f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)); assert.equal((await f.store.completeUpload(owner, 'project-a', begin.uploadId)).verified, true);
});

test('bad chunks and declared full-file hashes cannot publish content; empty assets verify as one empty chunk', async t => {
  const f = await fixture(t); const bytes = Buffer.from('safe'); const wrong = { ...identify(bytes), contentId: `sha256:${'0'.repeat(64)}` };
  const begin = await f.store.beginUpload(owner, 'project-a', wrong);
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, '0'.repeat(64)), { code: 'asset-chunk-invalid' });
  await f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes));
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 0, Buffer.from('else'), sha(Buffer.from('else'))), { code: 'asset-chunk-conflict' });
  await assert.rejects(f.store.completeUpload(owner, 'project-a', begin.uploadId), { code: 'asset-content-mismatch' });
  await assert.rejects(f.store.getAsset(owner, 'project-a', wrong.contentId), { code: 'asset-not-found' });
  const empty = await upload(f.store, Buffer.alloc(0)); assert.equal(empty.receipt.chunks, 1); assert.equal(empty.receipt.size, 0);
  assert.equal((await f.store.readChunk(viewer, 'project-a', empty.identity.contentId, 0)).bytes.length, 0);
});

test('aborting an upload or streaming completion preserves acknowledged chunks and never publishes partial content', async t => {
  const f = await fixture(t); const bytes = Buffer.from('abcdefgh'); const identity = identify(bytes); const begin = await f.store.beginUpload(owner, 'project-a', identity);
  await f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes.subarray(0, 4), sha(bytes.subarray(0, 4)));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 1, bytes.subarray(4), sha(bytes.subarray(4)), { signal: cancelled.signal }), { code: 'asset-cancelled' });
  assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [true, false]);
  await f.store.putChunk(owner, 'project-a', begin.uploadId, 1, bytes.subarray(4), sha(bytes.subarray(4)));
  const during = new AbortController(); const storage = { ...fs, async open(filename, ...args) { const handle = await fs.open(filename, ...args); if (filename.endsWith('0.enc.json')) during.abort(); return handle; } };
  await f.reopen({ storage });
  await assert.rejects(f.store.completeUpload(owner, 'project-a', begin.uploadId, { signal: during.signal }), { code: 'asset-cancelled' });
  assert.equal((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).complete, false);
  assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [true, true]);
});

test('cooperative fresh-state transactions merge multiple instances and deduplicate simultaneous begins', async t => {
  const f = await fixture(t); const other = await createDurableAssetService(f.opts); t.after(() => other.close()); const identity = identify(Buffer.from('abcdefgh'));
  const [a, b] = await Promise.all([f.store.beginUpload(owner, 'project-a', identity), other.beginUpload(owner, 'project-a', identity)]); assert.equal(a.uploadId, b.uploadId);
  await Promise.all([f.store.putChunk(owner, 'project-a', a.uploadId, 0, Buffer.from('abcd'), sha(Buffer.from('abcd'))),
    other.putChunk(owner, 'project-a', b.uploadId, 1, Buffer.from('efgh'), sha(Buffer.from('efgh')))]);
  assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', a.uploadId)).received, [true, true]);
  assert.equal((await other.completeUpload(owner, 'project-a', a.uploadId)).verified, true);
});

test('missing state, changed chunk configuration and broad index permissions fail closed without replacement', async t => {
  const f = await fixture(t); const index = path.join(f.directory, 'assets.enc.json'); const before = await fs.readFile(index);
  await assert.rejects(createDurableAssetService({ ...f.opts, chunkSize: 8 }), { code: 'asset-state-invalid' });
  assert.deepEqual(await fs.readFile(index), before); await fs.chmod(index, 0o644);
  await assert.rejects(createDurableAssetService(f.opts), { code: 'asset-state-invalid' }); await fs.chmod(index, 0o600);
  await fs.unlink(index); await assert.rejects(f.store.beginUpload(owner, 'project-a', identify(Buffer.from('safe'))), { code: 'asset-state-invalid' });
  await assert.rejects(createDurableAssetService(f.opts), { code: 'asset-state-invalid' }); await assert.rejects(fs.stat(index), { code: 'ENOENT' });
});

test('tampered chunks and corrupt encrypted index references are refused before bytes can be trusted', async t => {
  const f = await fixture(t); const a = await upload(f.store, Buffer.from('abcdefgh')); const filename = path.join(f.directory, 'uploads', a.begin.uploadId, '0.enc.json');
  const chunk = await fs.readFile(filename); await fs.writeFile(filename, '{}');
  await assert.rejects(f.store.readChunk(viewer, 'project-a', a.identity.contentId, 0), { code: 'asset-chunk-corrupt' }); await fs.writeFile(filename, chunk);
  const indexPath = path.join(f.directory, 'assets.enc.json'); const original = JSON.parse(await fs.readFile(indexPath));
  const edits = [value => { value.uploads[0].id = '../private'; }, value => { value.uploads.push(structuredClone(value.uploads[0])); },
    value => { value.assets[0].projectId = 'project-b'; }, value => { value.uploads[0].identity.localPath = '/Users/private'; }, value => { value.schemaVersion = 2; }];
  for (const edit of edits) { const envelope = structuredClone(original); const value = f.keyring.decrypt(envelope.record); edit(value); envelope.record = f.keyring.encrypt(value); await fs.writeFile(indexPath, JSON.stringify(envelope));
    await assert.rejects(createDurableAssetService(f.opts), error => ['asset-state-invalid', 'asset-state-newer-version'].includes(error.code)); }
  await fs.writeFile(indexPath, JSON.stringify(original));
  await fs.unlink(filename); await fs.symlink(indexPath, filename);
  await assert.rejects(f.store.readChunk(viewer, 'project-a', a.identity.contentId, 0), { code: 'asset-chunk-corrupt' });
});

test('post-rename index uncertainty latches the writer and a fresh reopen safely recovers the committed chunk', async t => {
  let failRename = false; const storage = { ...fs, async rename(from, to) { await fs.rename(from, to); if (failRename && to.endsWith('assets.enc.json')) throw Object.assign(new Error('uncertain'), { code: 'EIO' }); } };
  const f = await fixture(t, { storage }); const bytes = Buffer.from('safe'); const begin = await f.store.beginUpload(owner, 'project-a', identify(bytes)); failRename = true;
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)), { code: 'asset-storage-uncertain' });
  await assert.rejects(f.store.uploadStatus(owner, 'project-a', begin.uploadId), { code: 'asset-storage-uncertain' });
  failRename = false; await f.reopen(); assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [true]);
  assert.equal((await f.store.completeUpload(owner, 'project-a', begin.uploadId)).verified, true);
});

test('strict identities, configured limits, encryption key changes and orderly close are enforced', async t => {
  const f = await fixture(t); const bytes = Buffer.from('safe'), valid = identify(bytes);
  for (const value of [{ ...valid, source: '/private' }, { ...valid, assetClass: 'unsupported' }, { ...valid, size: 4 * 65536 + 1 }, { ...valid, contentId: valid.contentId.toUpperCase() }])
    await assert.rejects(f.store.beginUpload(owner, 'project-a', value), { code: 'asset-identity-invalid' });
  const previous = await fs.readFile(path.join(f.directory, 'assets.enc.json')); const newRing = { ...f.keyring, encrypt: value => ({ ...f.keyring.encrypt(value), keyId: 'different-key' }) };
  await f.reopen({ keyring: newRing }); await assert.rejects(f.store.beginUpload(owner, 'project-a', valid), { code: 'asset-storage-unavailable' });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), previous);
  await f.store.close(); await assert.rejects(f.store.beginUpload(owner, 'project-a', valid), { code: 'asset-service-closed' });
});

test('chunk acknowledgment follows file sync, chunk rename, directory sync and durable index publication', async t => {
  const events = []; const storage = { ...fs,
    async open(filename, ...args) {
      const handle = await fs.open(filename, ...args);
      return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args), writeFile: (...args) => handle.writeFile(...args),
        close: () => handle.close(), async sync() { events.push({ kind: 'sync', filename }); await handle.sync(); } };
    },
    async rename(from, to) { events.push({ kind: 'rename', from, to }); await fs.rename(from, to); }
  };
  const f = await fixture(t, { storage }); const bytes = Buffer.from('safe'); const begin = await f.store.beginUpload(owner, 'project-a', identify(bytes)); events.length = 0;
  const realDirectory = await fs.realpath(f.directory);
  await f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)); events.push({ kind: 'ack' });
  const chunkRename = events.findIndex(value => value.kind === 'rename' && value.to.endsWith('0.enc.json'));
  const indexRename = events.findIndex(value => value.kind === 'rename' && value.to.endsWith('assets.enc.json'));
  assert.ok(chunkRename > 0 && indexRename > chunkRename);
  assert.ok(events.slice(0, chunkRename).some(value => value.kind === 'sync' && value.filename === events[chunkRename].from));
  assert.ok(events.slice(chunkRename + 1, indexRename).some(value => value.kind === 'sync' && value.filename === path.join(realDirectory, 'uploads', begin.uploadId)));
  assert.ok(events.slice(chunkRename + 1, indexRename).some(value => value.kind === 'sync' && value.filename === events[indexRename].from));
  assert.ok(events.slice(indexRename + 1, -1).some(value => value.kind === 'sync' && value.filename === realDirectory));
});

test('pre-publication chunk sync failure preserves the old index and safely permits retry', async t => {
  let failSync = false; const storage = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    if (!filename.includes(`${path.sep}uploads${path.sep}`) || !filename.endsWith('.tmp')) return handle;
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() {
      if (failSync) throw Object.assign(new Error('/private/storage'), { code: 'EIO' }); await handle.sync();
    } };
  } };
  const f = await fixture(t, { storage }); const bytes = Buffer.from('safe'); const begin = await f.store.beginUpload(owner, 'project-a', identify(bytes));
  const index = path.join(f.directory, 'assets.enc.json'); const before = await fs.readFile(index); failSync = true;
  await assert.rejects(f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)), { code: 'asset-storage-unavailable' });
  assert.deepEqual(await fs.readFile(index), before); assert.deepEqual((await f.store.uploadStatus(owner, 'project-a', begin.uploadId)).received, [false]);
  failSync = false; await f.store.putChunk(owner, 'project-a', begin.uploadId, 0, bytes, sha(bytes)); assert.equal((await f.store.completeUpload(owner, 'project-a', begin.uploadId)).verified, true);
});

test('hostile encryption output and undeclared key changes cannot replace a readable asset index', async t => {
  const f = await fixture(t); const original = await fs.readFile(path.join(f.directory, 'assets.enc.json')); const valid = identify(Buffer.from('safe'));
  for (const encrypt of [value => ({ ...f.keyring.encrypt(value), keyId: 'bad/key' }),
    value => f.keyring.encrypt({ ...value, generation: value.generation + 1 })]) {
    await f.reopen({ keyring: { ...f.keyring, encrypt } });
    await assert.rejects(f.store.beginUpload(owner, 'project-a', valid), { code: 'asset-state-invalid' });
    assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), original);
  }
  const nextRing = { encrypt: value => ({ ...f.keyring.encrypt(value), keyId: 'rotated' }),
    decrypt: value => f.keyring.decrypt(value.keyId === 'rotated' ? { ...value, keyId: 'fixture' } : value) };
  await f.reopen({ keyring: nextRing });
  await assert.rejects(f.store.beginUpload(owner, 'project-a', valid), { code: 'asset-key-rotation-required' });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'assets.enc.json')), original);
});
