'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createDurableAssetService } = require('../src/durable-asset-service');
const { createMediaAssetIdentity } = require('../src/media-asset-identity');
const { createMediaBoundScanManifest } = require('../src/media-revision-manifest');
const { scanXml } = require('../src/fcpxml-adapter');
const { createServiceBackup, verifyServiceBackup, restoreServiceBackup, recordOwnerIncident } = require('../src/service-backup');
const { acquireMetadataLock } = require('../src/metadata-lock');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { withAssets = true, pending = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'service-backup-'))), directory = path.join(root, 'live-history'), assetsDirectory = path.join(root, 'live-assets');
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true, assetPolicyDefaultsEnabled: withAssets });
  await runtime.identity.createAccount('owner@backup.example.test', 'Disposable backup account password');
  const session = await runtime.identity.signIn('owner@backup.example.test', 'Disposable backup account password'), context = { accessToken: session.accessToken };
  const team = await runtime.teams.create(context, 'Owner backup'); await runtime.projects.create(context, { projectId: 'film', teamId: team.id, name: 'Fixture' });
  let assets = null;
  if (withAssets) {
    assets = await createDurableAssetService({ directory: assetsDirectory, keyring, initialize: true, chunkSize: 4, ownerBoundaryDeduplication: true,
      authorize: (...args) => runtime.service.authorizeAsset(...args), authorizePolicy: (...args) => runtime.service.authorizeAssetPolicy(...args),
      withRevisionReferences: (...args) => runtime.withRevisionReferences(...args), getInitialPolicy: (...args) => runtime.projects.getInitialAssetPolicy(...args),
      storage: pending ? { ...fs, async unlink(filename) { if (filename.endsWith('.enc.json')) throw new Error('injected cleanup interruption'); return fs.unlink(filename); } } : fs });
    await assets.setPolicy(context, 'film', { expectedVersion: 0, syncClasses: ['original'] });
  }
  async function upload(text, complete = true) {
    const bytes = Buffer.from(text), identity = createMediaAssetIdentity({ size: bytes.length, sha256: sha(bytes) }, { assetClass: 'original' });
    const started = await assets.beginUpload(context, 'film', identity);
    for (let index = 0; index < (complete ? started.chunks : 1); index++) { const chunk = bytes.subarray(index * 4, index * 4 + 4); await assets.putChunk(context, 'film', started.uploadId, index, chunk, sha(chunk)); }
    if (complete) await assets.completeUpload(context, 'film', started.uploadId);
    return { identity, bytes, uploadId: started.uploadId };
  }
  let retained, partial, garbage, revision;
  if (assets) {
    retained = await upload('retained media bytes'); partial = await upload('partial resumable media', false);
    const scan = scanXml('<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="Fixture"/></resources><library><event><project><sequence format="f" duration="1s"><spine><asset-clip ref="a" offset="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>');
    const manifest = createMediaBoundScanManifest(scan, { coverage: 'complete', assets: [{ referenceId: 'media-1', identity: retained.identity, required: true }] });
    const stored = await runtime.service.putManifest(context, 'film', manifest);
    revision = await assets.withPublicationGuard(context, 'film', check => runtime.createRevisionWithAssetGuard(context, { projectId: 'film', manifestId: stored.id,
      message: 'Retained backup fixture', sourceRevisionId: 'source-1', idempotencyKey: 'revision-1', requireMedia: true }, check));
    await runtime.service.updateBranch(context, { projectId: 'film', branch: 'main', expectedRevisionId: null, revisionId: revision.id, idempotencyKey: 'branch-1' });
    await assets.submitVerificationJob(context, 'film', { assetId: retained.identity.contentId, idempotencyKey: 'verification-1' });
    if (pending) {
      garbage = await upload('pending physical garbage');
      await assets.setRetentionPolicy(context, 'film', { expectedVersion: 0, minimumArchiveAgeMs: 0, idempotencyKey: 'retention-1' });
      await assets.setArchived(context, 'film', garbage.identity.contentId, { expectedArchived: false, archived: true });
      const report = await assets.getOwnerAssetReport(context, 'film', { afterAssetId: null, limit: 100 });
      const plan = await assets.planGarbageCollection(context, 'film', { assetIds: [garbage.identity.contentId], expectedStateHash: report.stateHash });
      await assets.garbageCollect(context, 'film', { assetIds: [garbage.identity.contentId], expectedStateHash: report.stateHash, planId: plan.planId, idempotencyKey: 'garbage-1' });
    }
  }
  const source = { directory, ...(assets ? { assetsDirectory } : {}), keyring };
  t.after(async () => { await assets?.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, assetsDirectory, keyring, runtime, assets, context, session, retained, partial, garbage, revision, source, upload };
}
test('consistent encrypted backup verifies and exclusively restores full state without changing source or restoring keys', async t => {
  const f = await fixture(t, { pending: true });
  const beforeHistory = await fs.readFile(path.join(f.directory, 'collaboration.enc.json')), beforeAssets = await fs.readFile(path.join(f.assetsDirectory, 'assets.enc.json'));
  const destination = path.join(f.root, 'snapshot'); const progress = [];
  const created = await createServiceBackup({ ...f.source, destination, onProgress: value => progress.push(value) });
  assert.equal(created.assetsIncluded, true); assert.deepEqual(created.schemas, { collaboration: 7, assets: 5 }); assert.equal(created.containsSessions, true);
  assert.equal(created.requiresSeparateKeys, true); assert.deepEqual(await verifyServiceBackup({ backupDirectory: destination, keyring: f.keyring }), created);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'collaboration.enc.json')), beforeHistory); assert.deepEqual(await fs.readFile(path.join(f.assetsDirectory, 'assets.enc.json')), beforeAssets);
  const restoredRoot = path.join(f.root, 'restored'); assert.deepEqual(await restoreServiceBackup({ backupDirectory: destination, keyring: f.keyring, destination: restoredRoot, expectedSha256: created.sha256, confirmed: true }), created);
  assert.deepEqual(await fs.readFile(path.join(restoredRoot, 'collaboration/collaboration.enc.json')), beforeHistory);
  assert.deepEqual(await fs.readFile(path.join(restoredRoot, 'assets/assets.enc.json')), beforeAssets);
  assert.equal((await fs.stat(path.join(restoredRoot, 'assets/assets.enc.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(restoredRoot)).mode & 0o777, 0o700);
  assert.equal(JSON.stringify([created, progress]).includes(f.root), false);
  assert.equal((await fs.readFile(path.join(destination, 'backup.json'), 'utf8')).includes('owner@'), false);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['assets', 'backup.json', 'collaboration']);
  const restored = await createDurableCollaborationService({ directory: path.join(restoredRoot, 'collaboration'), keyring: f.keyring });
  try { assert.equal((await restored.identity.authenticate(f.session.accessToken)).userId, (await f.runtime.identity.authenticate(f.session.accessToken)).userId); }
  finally { await restored.close(); }
});
test('pure verification preserves legitimate missing pending-deletion chunks and never hydrates original runtime cleanup', async t => {
  const f = await fixture(t, { pending: true });
  const filename = path.join(f.assetsDirectory, 'assets.enc.json'), state = f.keyring.decrypt(JSON.parse(await fs.readFile(filename)).record), blob = state.garbageCollection.pending[0].blob;
  await fs.unlink(path.join(f.assetsDirectory, 'uploads', blob.id, '0.enc.json')); const before = await fs.readFile(filename);
  const backupDirectory = path.join(f.root, 'snapshot'); await createServiceBackup({ ...f.source, destination: backupDirectory });
  await verifyServiceBackup({ backupDirectory, keyring: f.keyring });
  assert.deepEqual(await fs.readFile(filename), before); assert.equal(f.keyring.decrypt(JSON.parse(await fs.readFile(filename)).record).garbageCollection.pending.length, 1);
});
test('metadata-only snapshot is explicit and does not imply an asset backup', async t => {
  const f = await fixture(t, { withAssets: false }); const destination = path.join(f.root, 'snapshot');
  const created = await createServiceBackup({ ...f.source, destination }); assert.equal(created.assetsIncluded, false); assert.equal(created.schemas.assets, null);
  assert.deepEqual(await verifyServiceBackup({ backupDirectory: destination, keyring: f.keyring }), created);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['backup.json', 'collaboration']);
});
test('existing destinations and alias/nested roots are never overwritten', async t => {
  const f = await fixture(t); const existing = path.join(f.root, 'existing'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'unrelated'), 'keep');
  await assert.rejects(createServiceBackup({ ...f.source, destination: existing }), { code: 'backup-destination-exists' });
  assert.equal(await fs.readFile(path.join(existing, 'unrelated'), 'utf8'), 'keep');
  await assert.rejects(createServiceBackup({ ...f.source, destination: path.join(f.directory, 'snapshot') }), { code: 'backup-destination-invalid' });
  const linked = path.join(f.root, 'linked'); await fs.symlink(f.directory, linked);
  await assert.rejects(createServiceBackup({ ...f.source, directory: linked, destination: path.join(f.root, 'snapshot') }), { code: 'backup-source-invalid' });
});
test('unknown source files and missing acknowledged live chunks fail closed without deleting evidence', async t => {
  const f = await fixture(t); const unrelated = path.join(f.assetsDirectory, 'keep.txt'); await fs.writeFile(unrelated, 'unknown');
  await assert.rejects(createServiceBackup({ ...f.source, destination: path.join(f.root, 'snapshot') }), { code: 'backup-source-unclassified' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unknown'); await fs.unlink(unrelated);
  await fs.unlink(path.join(f.assetsDirectory, 'uploads', f.retained.uploadId, '0.enc.json'));
  await assert.rejects(createServiceBackup({ ...f.source, destination: path.join(f.root, 'snapshot') }), { code: 'backup-source-invalid' });
});
test('cancellation cleans only owned incomplete files and releases both service locks', async t => {
  const f = await fixture(t); const abort = new AbortController(); const destination = path.join(f.root, 'cancelled'); let copied = false;
  await assert.rejects(createServiceBackup({ ...f.source, destination, signal: abort.signal, onProgress: value => {
    if (value.phase === 'copying' && value.bytesRead > 0) { copied = true; abort.abort(); }
  } }), { code: 'backup-cancelled' });
  assert.equal(copied, true); await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await f.runtime.projects.list(f.context); await f.assets.getUsage(f.context, 'film');
  assert.equal((await createServiceBackup({ ...f.source, destination })).verified, true);
});
test('changed source ciphertext and wrong keys cannot become a verified backup', async t => {
  const f = await fixture(t); let changed = false; const file = path.join(f.assetsDirectory, 'uploads', f.retained.uploadId, '0.enc.json');
  const original = await fs.readFile(file);
  await assert.rejects(createServiceBackup({ ...f.source, destination: path.join(f.root, 'changed'), onProgress: async value => {
    if (!changed && value.phase === 'copying') { changed = true; await fs.appendFile(file, ' '); }
  } }), { code: 'backup-source-changed' });
  await fs.writeFile(file, original);
  await assert.rejects(createServiceBackup({ ...f.source, keyring: createKeyring({ other: randomBytes(32) }, 'other'), destination: path.join(f.root, 'wrong-key') }), { code: 'backup-key-unavailable' });
});
test('manifest alteration, missing ciphertext, unsafe links and stale restore review are rejected', async t => {
  const f = await fixture(t); const backupDirectory = path.join(f.root, 'snapshot'); const created = await createServiceBackup({ ...f.source, destination: backupDirectory });
  await assert.rejects(restoreServiceBackup({ backupDirectory, keyring: f.keyring, destination: path.join(f.root, 'unreviewed'), confirmed: true, expectedSha256: 'a'.repeat(64) }), { code: 'backup-review-required' });
  const filename = path.join(backupDirectory, 'backup.json'); const original = await fs.readFile(filename); const manifest = JSON.parse(original); manifest.files[0].path = '../outside';
  await fs.writeFile(filename, JSON.stringify(manifest)); await assert.rejects(verifyServiceBackup({ backupDirectory, keyring: f.keyring }), { code: 'backup-invalid' });
  await fs.writeFile(filename, original);
  const file = manifest.files.find(row => row.path.includes('/uploads/')).path; const actual = path.join(backupDirectory, file), bytes = await fs.readFile(actual); await fs.unlink(actual); await fs.symlink(path.join(f.assetsDirectory, 'uploads', path.basename(path.dirname(file)), path.basename(file)), actual);
  await assert.rejects(verifyServiceBackup({ backupDirectory, keyring: f.keyring }));
  await fs.unlink(actual); await fs.writeFile(actual, bytes, { mode: 0o600 });
  assert.equal((await verifyServiceBackup({ backupDirectory, keyring: f.keyring })).sha256, created.sha256);
});
test('owner incident records accept safe enums and generic codes without freeform private content', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owner-incidents-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const record = { category: 'security', severity: 'high', stage: 'contained', buildVersion: '0.1.0', errorCodes: ['access-token-invalid'], backupSha256: null };
  const saved = await recordOwnerIncident({ directory: path.join(root, 'private'), record, now: () => 1000 });
  assert.equal(saved.record.responsibility, 'project-owner'); assert.equal(saved.record.recordedAt, '1970-01-01T00:00:01.000Z');
  const filename = path.join(root, 'private', `incident-${saved.incidentId}.json`); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  for (const patch of [{ notes: '/private/path' }, { errorCodes: ['Bearer-secret'] }, { buildVersion: '/private/path' }, { category: 'email@example.test' }]) await assert.rejects(recordOwnerIncident({ directory: path.join(root, 'private'), record: { ...record, ...patch } }), { code: 'incident-record-invalid' });
});
test('both snapshot locks fence concurrent service mutations and waiting lock acquisition is cancellable', async t => {
  const f = await fixture(t); let queued = false, lateSession; let mutation;
  const created = await createServiceBackup({ ...f.source, destination: path.join(f.root, 'consistent'), onProgress: value => {
    if (!queued && value.phase === 'validating') {
      queued = true; mutation = f.runtime.identity.signIn('owner@backup.example.test', 'Disposable backup account password').then(value => { lateSession = value; });
    }
  } });
  await mutation; assert.equal(created.verified, true);
  const restoredRoot = path.join(f.root, 'restored'); await restoreServiceBackup({ backupDirectory: path.join(f.root, 'consistent'), keyring: f.keyring,
    destination: restoredRoot, expectedSha256: created.sha256, confirmed: true });
  const restored = await createDurableCollaborationService({ directory: path.join(restoredRoot, 'collaboration'), keyring: f.keyring });
  try { await restored.identity.authenticate(f.session.accessToken); await assert.rejects(restored.identity.authenticate(lateSession.accessToken), { code: 'access-token-invalid' }); }
  finally { await restored.close(); }
  const release = await acquireMetadataLock(f.assetsDirectory); const controller = new AbortController();
  const pending = createServiceBackup({ ...f.source, destination: path.join(f.root, 'waiting'), signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'backup-cancelled' }); setTimeout(() => controller.abort(), 30);
  try { await rejected; } finally { await release(); }
});
test('read-only backup validation preserves an older collaboration schema without migrating the original', async t => {
  const f = await fixture(t); await f.assets.close(); await f.runtime.close();
  const filename = path.join(f.directory, 'collaboration.enc.json'), wrapper = JSON.parse(await fs.readFile(filename));
  const state = f.keyring.decrypt(wrapper.record); state.schemaVersion = 6; delete state.projectPresets; wrapper.record = f.keyring.encrypt(state);
  await fs.writeFile(filename, JSON.stringify(wrapper)); const before = await fs.readFile(filename);
  const destination = path.join(f.root, 'legacy-snapshot'); const result = await createServiceBackup({ ...f.source, destination });
  assert.equal(result.schemas.collaboration, 6); await verifyServiceBackup({ backupDirectory: destination, keyring: f.keyring });
  assert.deepEqual(await fs.readFile(filename), before); assert.deepEqual(await fs.readFile(path.join(destination, 'collaboration/collaboration.enc.json')), before);
});
test('late source changes are fenced and unrelated destination evidence survives cancellation cleanup', async t => {
  const f = await fixture(t); const original = path.join(f.assetsDirectory, 'uploads', f.retained.uploadId, '0.enc.json'); let changed = false;
  await assert.rejects(createServiceBackup({ ...f.source, destination: path.join(f.root, 'late-change'), onProgress: async value => {
    if (!changed && value.phase === 'copying' && value.bytesRead === value.totalBytes) { changed = true; await fs.appendFile(original, ' '); }
  } }), { code: 'backup-source-changed' });
  const bytes = await fs.readFile(original); await fs.writeFile(original, bytes.subarray(0, bytes.length - 1));
  const destination = path.join(f.root, 'unrelated-evidence'), controller = new AbortController(); let added = false;
  await assert.rejects(createServiceBackup({ ...f.source, destination, signal: controller.signal, onProgress: async value => {
    if (!added && value.phase === 'copying' && value.bytesRead > 0) { added = true; await fs.writeFile(path.join(destination, 'keep.txt'), 'unrelated evidence'); controller.abort(); }
  } }), { code: 'backup-cancelled' });
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'unrelated evidence');
  assert.deepEqual(await fs.readdir(destination), ['keep.txt']);
});
test('post-seal flush uncertainty preserves completed backup and restore evidence for verification instead of deleting it', async t => {
  const f = await fixture(t), originalOpen = fs.open, backupDirectory = path.join(f.root, 'baseline');
  const baseline = await createServiceBackup({ ...f.source, destination: backupDirectory });
  async function failRootFlush(destination, operation) {
    fs.open = async (filename, ...args) => {
      const handle = await originalOpen(filename, ...args);
      if (filename !== destination) return handle;
      return { async sync() { throw Object.assign(new Error('injected post-seal flush'), { code: 'EIO' }); }, close: () => handle.close() };
    };
    try { await assert.rejects(operation(), { code: 'backup-storage-uncertain' }); } finally { fs.open = originalOpen; }
    assert.ok((await fs.stat(destination)).isDirectory()); await assert.rejects(fs.stat(path.join(destination, 'owner.json')), { code: 'ENOENT' });
  }
  const ambiguousBackup = path.join(f.root, 'ambiguous-backup');
  await failRootFlush(ambiguousBackup, () => createServiceBackup({ ...f.source, destination: ambiguousBackup }));
  assert.equal((await verifyServiceBackup({ backupDirectory: ambiguousBackup, keyring: f.keyring })).verified, true);
  await assert.rejects(createServiceBackup({ ...f.source, destination: ambiguousBackup }), { code: 'backup-destination-exists' });
  const ambiguousRestore = path.join(f.root, 'ambiguous-restore');
  await failRootFlush(ambiguousRestore, () => restoreServiceBackup({ backupDirectory, keyring: f.keyring, destination: ambiguousRestore, confirmed: true, expectedSha256: baseline.sha256 }));
  assert.equal(JSON.parse(await fs.readFile(path.join(ambiguousRestore, 'restore.json'))).sha256, baseline.sha256);
  assert.deepEqual(await fs.readFile(path.join(ambiguousRestore, 'collaboration/collaboration.enc.json')), await fs.readFile(path.join(backupDirectory, 'collaboration/collaboration.enc.json')));
});
