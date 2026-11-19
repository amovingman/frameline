'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { fingerprint } = require('../src/project-api-contracts');
const { createDesktopSharedStorage } = require('../src/desktop-shared-storage');
const { createSharedStorageStore } = require('../src/shared-storage-store');
const { validateStorageRequest, storageRequestSummary } = require('../src/shared-storage-protocol');
const { verifyStorageAsset } = require('../src/shared-storage-volume');
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-storage-')));
  const root = path.join(directory, 'volume'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'picture'));
  const media = path.join(root, 'picture', 'take.mov'); await fs.writeFile(media, 'camera bytes');
  const request = { schemaVersion: 1, projectId: 'film', sourceHash: 'a'.repeat(64), assets: [
    { id: 'clip-1', relativePath: 'picture/take.mov', assetClass: 'original', expected: { size: 12, sha256: sha('camera bytes') } }
  ] };
  const requestFile = path.join(directory, 'request.json'); await fs.writeFile(requestFile, JSON.stringify(request));
  const stateDirectory = path.join(directory, 'private'); const events = []; let controller;
  const open = () => controller = createDesktopSharedStorage({ directory: stateDirectory, now: () => 1000, onChange: state => events.push(state), ...options });
  open(); t.after(async () => { await controller.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const initialize = async () => {
    await controller.initialize(); await controller.register(root, 'Studio storage'); await controller.importRequest(requestFile);
    return controller.getState();
  };
  const input = () => { const s = controller.getState(), volume = s.volumes.find(v => v.id === s.selectedId);
    return { volumeId: volume?.id, volumeVersion: volume?.version, requestHash: s.request?.requestHash,
      reportHash: s.report?.reportHash, proposalHash: s.proposal?.proposalHash }; };
  return { directory, root, media, request, requestFile, stateDirectory, events, initialize, input,
    get controller() { return controller; }, async restart() { await controller.dispose(); open(); return controller.initialize(); },
    async writeRequest(value = request) { await fs.writeFile(requestFile, JSON.stringify(value)); return controller.importRequest(requestFile); } };
}

test('request contract canonicalizes order and binds project, source, class, size and bytes', () => {
  const request = { schemaVersion: 1, projectId: 'film', sourceHash: 'a'.repeat(64), assets: [
    { id: 'b', relativePath: 'b.mov', assetClass: 'original', expected: { size: 0, sha256: sha('') } },
    { id: 'a', relativePath: 'a.mov', assetClass: 'proxy', expected: { size: 0, sha256: sha('') } }
  ] };
  const first = storageRequestSummary(request); assert.deepEqual(first.assets.map(a => a.id), ['a', 'b']);
  assert.equal(first.requestHash, storageRequestSummary({ ...request, assets: [...request.assets].reverse() }).requestHash);
  for (const patch of [{ projectId: 'other' }, { sourceHash: 'b'.repeat(64) }, { assets: [{ ...request.assets[0], assetClass: 'proxy' }, request.assets[1]] }]) {
    assert.notEqual(storageRequestSummary({ ...request, ...patch }).requestHash, first.requestHash);
  }
  assert.equal(JSON.stringify(first).includes('relativePath'), false);
});
test('request rejects traversal, absolute paths, duplicate IDs/locations, invalid identity and unknown fields', () => {
  const good = { schemaVersion: 1, projectId: 'film', sourceHash: 'a'.repeat(64), assets: [
    { id: 'clip', relativePath: 'folder/take.mov', assetClass: 'original', expected: { size: 1, sha256: sha('x') } }
  ] };
  for (const relativePath of ['../take.mov', '/take.mov', 'a//b', 'a/./b', 'a/../b', 'C:/b', 'a\\b', 'a\u0000b']) {
    assert.throws(() => validateStorageRequest({ ...good, assets: [{ ...good.assets[0], relativePath }] }), { code: 'shared-storage-request-invalid' });
  }
  for (const value of [{ ...good, extra: true }, { ...good, assets: [] }, { ...good, schemaVersion: 2 },
    { ...good, assets: [good.assets[0], { ...good.assets[0], id: 'other' }] },
    { ...good, assets: [good.assets[0], { ...good.assets[0], relativePath: 'other.mov' }] },
    { ...good, assets: [{ ...good.assets[0], expected: { size: -1, sha256: sha('x') } }] }]) {
    assert.throws(() => validateStorageRequest(value), { code: 'shared-storage-request-invalid' });
  }
});
test('registration is private, path-free and survives restart without probing or writing on the volume', async t => {
  const f = await fixture(t); await f.initialize(); const s = f.controller.getState();
  assert.equal(s.volumes[0].status, 'online'); assert.equal(s.volumes[0].label, 'Studio storage');
  assert.doesNotMatch(JSON.stringify(s), /frameline-storage-|picture\/take/);
  assert.deepEqual(await fs.readdir(f.root), ['picture']);
  assert.equal((await fs.stat(f.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.stateDirectory, 'storage.json'))).mode & 0o777, 0o600);
  await f.restart(); assert.equal(f.controller.getState().volumes[0].status, 'unchecked');
  assert.equal(f.controller.getState().request, null); assert.equal(f.controller.getState().selectedId, null);
});
test('registry supports rename and forget without deleting media and rejects stale or duplicate registrations', async t => {
  const f = await fixture(t); await f.initialize(); const original = f.input();
  assert.equal((await f.controller.register(f.root, 'Second')).error, 'shared-storage-already-registered');
  assert.equal((await f.controller.rename({ ...original, label: 'Sound room' })).volumes[0].label, 'Sound room');
  assert.equal((await f.controller.rename({ ...original, label: '/private/path' })).error, 'shared-storage-label-invalid');
  assert.equal((await f.controller.forget({ ...original, volumeVersion: 9 })).error, 'shared-storage-selection-changed');
  assert.equal((await f.controller.forget(original)).volumes.length, 0);
  assert.equal(await fs.readFile(f.media, 'utf8'), 'camera bytes');
});
test('explicit volume checks distinguish offline, replaced roots and verified reconnection', async t => {
  const f = await fixture(t); await f.initialize(); const original = f.input(), moved = path.join(f.directory, 'moved-volume');
  await fs.rename(f.root, moved);
  let s = await f.controller.check(original); assert.equal(s.error, 'shared-storage-offline'); assert.equal(s.volumes[0].status, 'offline');
  await fs.mkdir(f.root); s = await f.controller.check(original);
  assert.equal(s.error, 'shared-storage-volume-changed'); assert.equal(s.volumes[0].status, 'changed');
  assert.equal((await f.controller.reconnect(original, f.root)).error, 'shared-storage-volume-changed');
  s = await f.controller.reconnect(original, moved); assert.equal(s.error, null); assert.equal(s.volumes[0].version, 2);
  assert.equal((await f.controller.verify(original)).error, 'shared-storage-selection-changed');
  assert.equal((await f.controller.verify(f.input())).report.items[0].verified, true);
});
test('registration and file checks reject symlinks including directory ancestors', async t => {
  const f = await fixture(t); await f.initialize();
  const linked = path.join(f.directory, 'linked'); await fs.symlink(f.root, linked);
  assert.equal((await f.controller.register(linked, 'Linked')).error, 'shared-storage-unavailable');
  await fs.rename(path.join(f.root, 'picture'), path.join(f.directory, 'outside'));
  await fs.symlink(path.join(f.directory, 'outside'), path.join(f.root, 'picture'));
  const s = await f.controller.verify(f.input()); assert.equal(s.report.items[0].reason, 'symlink-unsupported');
  assert.equal(s.report.items[0].verified, false);
});
test('batch verification reports exact hash/size/missing/nonfile failures without paths', async t => {
  const f = await fixture(t); await f.initialize();
  const originals = clone(f.request.assets[0]); f.request.assets = [originals,
    { ...clone(originals), id: 'missing', relativePath: 'missing.mov' },
    { ...clone(originals), id: 'wrong-size', relativePath: 'small.mov' },
    { ...clone(originals), id: 'wrong-hash', relativePath: 'wrong.mov' },
    { ...clone(originals), id: 'directory', relativePath: 'picture' }];
  await fs.writeFile(path.join(f.root, 'small.mov'), 'x'); await fs.writeFile(path.join(f.root, 'wrong.mov'), 'wrong bytes!'); await f.writeRequest();
  const s = await f.controller.verify(f.input()); assert.equal(s.error, null);
  assert.deepEqual(Object.fromEntries(s.report.items.map(i => [i.id, i.reason])), {
    'clip-1': 'size-and-hash-match', missing: 'candidate-missing', 'wrong-size': 'size-mismatch', 'wrong-hash': 'hash-mismatch', directory: 'not-regular-file'
  });
  assert.equal(s.progress.completed, 5); assert.doesNotMatch(JSON.stringify(s), /frameline-storage-|\.mov|relativePath/);
  assert.equal((await f.controller.prepareProposal(f.input())).error, 'shared-storage-report-required');
});
test('reports survive restart as historical evidence, requiring a new matching request and fresh verification', async t => {
  const f = await fixture(t); await f.initialize(); const completed = await f.controller.verify(f.input()), volumeId = completed.selectedId;
  await f.restart(); let s = await f.controller.select(volumeId);
  assert.equal(s.report, null); assert.equal(s.historicalReport.reportHash, completed.report.reportHash); assert.equal(s.proposal, null);
  assert.equal((await f.controller.prepareProposal(f.input())).error, 'shared-storage-selection-changed');
  await f.controller.importRequest(f.requestFile); s = await f.controller.verify(f.input()); assert.equal(s.report.items[0].verified, true);
});
test('relink proposal rechecks bytes, keeps classes and exact source binding and exports only the reviewed artifact', async t => {
  const f = await fixture(t); await f.initialize(); await f.controller.verify(f.input());
  const before = f.input().reportHash; let s = await f.controller.prepareProposal(f.input());
  assert.equal(s.error, null); assert.equal(s.proposal.reviewedReportHash, before);
  assert.equal(s.proposal.readOnly, true); assert.equal(s.proposal.executable, false); assert.equal(s.proposal.assets[0].assetClass, 'original');
  assert.equal(s.proposal.sourceHash, f.request.sourceHash);
  const destination = path.join(f.directory, 'proposal.json'); const reviewed = s.proposal;
  s = await f.controller.exportProposal(f.input(), destination); assert.equal(s.error, null);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), reviewed);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(destination, 'utf8'), /frameline-storage-|relativePath|take.mov/);
  assert.equal(await fs.readFile(f.media, 'utf8'), 'camera bytes');
  assert.equal((await f.controller.exportProposal(f.input(), destination)).error, 'shared-storage-destination-exists');
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), reviewed);
});
test('changed bytes, wrong reviewed hashes, volume selection and invalid imports invalidate proposals', async t => {
  const f = await fixture(t); await f.initialize(); await f.controller.verify(f.input());
  assert.equal((await f.controller.prepareProposal({ ...f.input(), reportHash: 'b'.repeat(64) })).error, 'shared-storage-report-required');
  await f.controller.prepareProposal(f.input()); const original = f.input();
  await fs.writeFile(f.media, 'changed data');
  const destination = path.join(f.directory, 'stale.json');
  const stale = await f.controller.exportProposal(original, destination); assert.equal(stale.error, 'shared-storage-proposal-stale'); assert.equal(stale.proposal, null);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await f.controller.importRequest(f.requestFile); await f.controller.verify(f.input());
  await fs.writeFile(f.requestFile, '{"bad":true}'); const invalid = await f.controller.importRequest(f.requestFile);
  assert.equal(invalid.request, null); assert.equal(invalid.report, null); assert.equal(invalid.error, 'shared-storage-request-invalid');
});
test('cancellation streams progress, prevents concurrent actions and never publishes a partial report', async t => {
  let notify, resume;
  const began = new Promise(resolve => notify = resolve), gate = new Promise(resolve => resume = resolve);
  const f = await fixture(t, { verifyAsset: async (volume, asset, options) => { notify(); await gate; return verifyStorageAsset(volume, asset, options); } });
  await f.initialize(); const work = f.controller.verify(f.input()); await began;
  assert.equal((await f.controller.select(null)).error, 'shared-storage-busy');
  f.controller.cancel(); resume(); const s = await work;
  assert.equal(s.error, 'shared-storage-cancelled'); assert.equal(s.report, null); assert.equal(s.interrupted, null);
  assert.equal(s.busy, false); assert.equal(s.proposal, null);
});
test('file mutation and root substitution during streaming discard matching bytes', async t => {
  for (const replaceRoot of [false, true]) await t.test(String(replaceRoot), async t => {
    const f = await fixture(t); await f.initialize();
    const privateState = await createSharedStorageStore({ directory: f.stateDirectory }).load(); const volume = privateState.volumes[0];
    let changed = false;
    const check = verifyStorageAsset(volume, f.request.assets[0], { onProgress: async () => {
      if (changed) return; changed = true;
      if (replaceRoot) { await fs.rename(f.root, path.join(f.directory, 'old')); await fs.mkdir(f.root); }
      else await fs.writeFile(f.media, 'changed data');
    } });
    if (replaceRoot) await assert.rejects(check, { code: 'shared-storage-volume-changed' });
    else assert.equal((await check).reason, 'file-changed');
  });
});
test('interrupted checks are retained across restart and recover only through a fresh explicit check', async t => {
  const f = await fixture(t); await f.initialize(); const volumeId = f.input().volumeId;
  const store = createSharedStorageStore({ directory: f.stateDirectory });
  await store.transact(state => { state.pending = { volumeId, requestHash: fingerprint(validateStorageRequest(f.request)), startedAt: 999 }; });
  await f.restart(); assert.equal(f.controller.getState().interrupted.volumeId, volumeId);
  await f.controller.select(volumeId); await f.controller.importRequest(f.requestFile);
  const s = await f.controller.verify(f.input()); assert.equal(s.interrupted, null); assert.equal(s.report.items[0].verified, true);
});
test('private registry rejects tampering, symlinks, unsafe permissions, newer schemas and missing initialized state', async t => {
  for (const kind of ['report', 'symlink', 'mode', 'future', 'missing']) await t.test(kind, async t => {
    const f = await fixture(t); await f.initialize(); await f.controller.verify(f.input()); await f.controller.dispose();
    const filename = path.join(f.stateDirectory, 'storage.json');
    if (kind === 'mode') await fs.chmod(filename, 0o644);
    else if (kind === 'symlink') { await fs.rename(filename, path.join(f.directory, 'outside.json')); await fs.symlink(path.join(f.directory, 'outside.json'), filename); }
    else if (kind === 'missing') await fs.rm(filename);
    else { const state = JSON.parse(await fs.readFile(filename, 'utf8')); if (kind === 'report') state.reports[0].items[0].verified = false;
      else state.schemaVersion = 2; await fs.writeFile(filename, JSON.stringify(state)); }
    const store = createSharedStorageStore({ directory: f.stateDirectory });
    await assert.rejects(store.load(), error => error.code.startsWith('shared-storage-'));
  });
});
test('two registry instances serialize mutations without losing volumes', async t => {
  const f = await fixture(t); await f.initialize();
  const a = createSharedStorageStore({ directory: f.stateDirectory }), b = createSharedStorageStore({ directory: f.stateDirectory });
  await Promise.all([a.transact(state => { state.volumes[0].label = 'Updated label'; }), b.transact(state => { state.volumes[0].version++; })]);
  const s = await a.load(); assert.equal(s.volumes[0].label, 'Updated label'); assert.equal(s.volumes[0].version, 2);
});
test('uncertain durable publication blocks further operations in the same store', async t => {
  const f = await fixture(t); await f.initialize();
  const storage = Object.create(fs); let shouldFail = true;
  storage.rename = async (...args) => { await fs.rename(...args); if (shouldFail) { shouldFail = false; throw new Error('lost acknowledgment'); } };
  const store = createSharedStorageStore({ directory: f.stateDirectory, storage });
  await assert.rejects(store.transact(state => { state.volumes[0].label = 'Possibly saved'; }), { code: 'shared-storage-storage-uncertain' });
  await assert.rejects(store.load(), { code: 'shared-storage-storage-uncertain' });
  assert.equal((await createSharedStorageStore({ directory: f.stateDirectory }).load()).volumes[0].label, 'Possibly saved');
});
