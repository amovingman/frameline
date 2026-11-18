'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAsyncRevisionSyncService } = require('../src/revision-sync-async');
const { verifyServiceSyncBase } = require('../src/service-sync-base');
const manifest = marker => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: marker.repeat(64),
  sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-service-base-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(directory, options); const projectId = (await store.getProjectId('/private/source.fcpxml')).id;
  const first = await store.saveRevision(projectId, manifest('a'), 'First'); const second = await store.saveRevision(projectId, manifest('b'), 'Second', first.id);
  const bundle = await store.exportRevisions(projectId); const history = createCloudHistoryStore(); history.createProject({ projectId: 'remote', name: 'Film' });
  const sync = createAsyncRevisionSyncService(history); await sync.push({ remoteProjectId: 'remote', bundle, authorId: 'different-publisher' });
  const remote = { ...await sync.fetch({ remoteProjectId: 'remote' }), checkedAt: 1000 };
  const scope = { originHash: '1'.repeat(64), accountId: 'account', localProjectId: projectId, localBranch: 'main', remoteProjectId: 'remote', remoteBranch: 'main' };
  const candidate = verifyServiceSyncBase({ scope, bundle, remote, verifiedAt: 1000 });
  return { directory, store, projectId, first, second, bundle, history, sync, remote, scope, candidate,
    record(changes = {}, target = store) { return target.recordServiceSyncBase({ scope, candidate, proofSnapshotHash: '2'.repeat(64), expectedHeadId: second.id, expectedBaseVersion: 0, ...changes }); } };
}

test('verified service bases pair exact history while allowing a different authenticated publisher', async t => {
  const f = await fixture(t); assert.equal(f.candidate.localRevisionId, f.second.id); assert.equal(f.candidate.remoteRevisionId, f.remote.head);
  assert.equal(f.candidate.remoteAuthorId, 'different-publisher'); assert.equal(f.candidate.observedLocalHead, f.second.id);
  await f.store.recordSyncBase(f.projectId, 'main', f.first.id, f.second.id); const entry = await f.record(); assert.equal(entry.version, 1);
  assert.equal(await f.store.getSyncBase(f.projectId, 'main'), f.first.id); assert.deepEqual(await createLocalMetadataStore(f.directory).getServiceSyncBase(f.scope), entry);
  for (const scope of [{ ...f.scope, accountId: 'other' }, { ...f.scope, originHash: '3'.repeat(64) }, { ...f.scope, remoteBranch: 'review' }, { ...f.scope, remoteProjectId: 'another' }])
    assert.equal(await f.store.getServiceSyncBase(scope), null);
  const changed = await f.store.getServiceSyncBase(f.scope); changed.scope.accountId = 'mutated'; assert.equal((await f.store.getServiceSyncBase(f.scope)).scope.accountId, 'account');
  assert.doesNotMatch(JSON.stringify(entry), /source\.fcpxml|https:|file:/);
});

test('nearest verified common prefixes cover local-ahead, remote-ahead and diverged histories without importing remote work', async t => {
  const f = await fixture(t); const firstOnly = structuredClone(f.remote); firstOnly.revisions = firstOnly.revisions.slice(0, 1); firstOnly.head = firstOnly.revisions[0].id;
  firstOnly.manifests = firstOnly.manifests.filter(item => item.id === firstOnly.revisions[0].manifestId);
  assert.equal(verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote: firstOnly, verifiedAt: 1000 }).localRevisionId, f.first.id);
  const extraManifest = f.history.putManifest('remote', manifest('c')); const child = f.history.createRevision({ projectId: 'remote', manifestId: extraManifest.id,
    parentRevisionId: f.remote.head, authorId: 'remote-publisher', message: 'Remote child', sourceRevisionId: randomUUID() });
  f.history.compareAndSwapBranch({ projectId: 'remote', branch: 'main', expectedRevisionId: f.remote.head, revisionId: child.id });
  const ahead = await f.sync.fetch({ remoteProjectId: 'remote' }); const shared = verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote: ahead, verifiedAt: 1000 });
  assert.equal(shared.localRevisionId, f.second.id); assert.equal(shared.observedRemoteHead, child.id);
  const fork = structuredClone(firstOnly); fork.revisions.push({ ...child, parentRevisionId: firstOnly.head }); fork.head = child.id; fork.manifests.push(f.history.getManifest('remote', extraManifest.id));
  assert.equal(verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote: fork, verifiedAt: 1000 }).localRevisionId, f.first.id);
  const unrelated = { ...fork, revisions: [{ ...child, parentRevisionId: null }], manifests: [f.history.getManifest('remote', extraManifest.id)] };
  assert.equal(verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote: unrelated, verifiedAt: 1000 }), null);
  assert.equal(verifyServiceSyncBase({ scope: f.scope, bundle: { ...f.bundle, branches: { ...f.bundle.branches, main: null } }, remote: ahead, verifiedAt: 1000 }), null);
  assert.equal((await f.store.exportRevisions(f.projectId)).branches.main, f.second.id);
});

test('proof identity ignores unrelated local branches and can be reproduced by rewinding only the observed branch head', async t => {
  const f = await fixture(t); await f.store.createBranch(f.projectId, 'alternate', f.second.id); await f.store.saveRevision(f.projectId, manifest('c'), 'Alternate', f.second.id, 'alternate');
  let bundle = await f.store.exportRevisions(f.projectId); assert.deepEqual(verifyServiceSyncBase({ scope: f.scope, bundle, remote: f.remote, verifiedAt: 1000 }), f.candidate);
  await f.store.switchBranch(f.projectId, 'main'); const newer = await f.store.saveRevision(f.projectId, manifest('d'), 'New local', f.second.id);
  bundle = await f.store.exportRevisions(f.projectId); const changed = verifyServiceSyncBase({ scope: f.scope, bundle, remote: f.remote, verifiedAt: 1000 }); assert.equal(changed.observedLocalHead, newer.id); assert.notEqual(changed.proofHash, f.candidate.proofHash);
  bundle.branches.main = f.candidate.observedLocalHead; assert.deepEqual(verifyServiceSyncBase({ scope: f.scope, bundle, remote: f.remote, verifiedAt: 1000 }), f.candidate);
});

test('full remote proof validation rejects source-ID collisions, gaps, extra private fields and mismatched scope', async t => {
  const f = await fixture(t); const edits = [value => { value.revisions[0].message = 'Changed'; }, value => { value.revisions[0].sourceRevisionId = f.second.id; },
    value => { value.revisions[1].parentRevisionId = null; }, value => { value.revisions[1].sourceRevisionId = value.revisions[0].sourceRevisionId; },
    value => { value.manifests[0].document.sequence.name = 'Changed'; }, value => { value.revisions[0].privatePath = '/Users/private'; },
    value => { value.branch = 'wrong'; }, value => { value.remoteProjectId = 'wrong'; }, value => { value.checkedAt = -1; }];
  for (const edit of edits) { const remote = structuredClone(f.remote); edit(remote); assert.throws(() => verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote, verifiedAt: 1000 }), { code: 'sync-history-invalid' }); }
  for (const edit of [value => { value.records[0].bytes += 'tamper'; }, value => { value.privatePath = '/Users/private'; },
    value => { value.records[0].summary.privatePath = '/Users/private'; }, value => { value.records[0].privatePath = '/Users/private'; }]) {
    const wrong = structuredClone(f.bundle); edit(wrong); assert.throws(() => verifyServiceSyncBase({ scope: f.scope, bundle: wrong, remote: f.remote, verifiedAt: 1000 }), { code: 'sync-history-invalid' });
  }
});

test('head and base CAS, local record validation and monotonic ancestry prevent stale or regressing receipts', async t => {
  const f = await fixture(t); const entry = await f.record(); const other = createLocalMetadataStore(f.directory);
  await assert.rejects(f.record({}, other), { code: 'sync-base-version-changed' });
  const prior = structuredClone(f.remote); prior.revisions = prior.revisions.slice(0, 1); prior.head = prior.revisions[0].id; prior.manifests = prior.manifests.filter(item => item.id === prior.revisions[0].manifestId);
  const older = verifyServiceSyncBase({ scope: f.scope, bundle: f.bundle, remote: prior, verifiedAt: 1000 });
  await assert.rejects(f.record({ candidate: older, expectedBaseVersion: 1 }), { code: 'sync-base-regression' });
  const third = await f.store.saveRevision(f.projectId, manifest('c'), 'Third', f.second.id);
  await assert.rejects(f.record({ expectedBaseVersion: 1 }), { code: 'revision-head-changed' });
  const current = verifyServiceSyncBase({ scope: f.scope, bundle: await f.store.exportRevisions(f.projectId), remote: f.remote, verifiedAt: 1001 });
  await assert.rejects(f.record({ candidate: { ...current, recordHash: '0'.repeat(64) }, expectedHeadId: third.id, expectedBaseVersion: 1 }), { code: 'sync-base-invalid' });
  const updated = await f.record({ candidate: current, expectedHeadId: third.id, expectedBaseVersion: 1 }); assert.equal(updated.version, 2); assert.equal(updated.localRevisionId, entry.localRevisionId);
  await f.store.createBranch(f.projectId, 'new-branch', third.id); assert.equal(await f.store.getSyncBase(f.projectId, 'new-branch'), null);
  assert.equal(await f.store.getServiceSyncBase({ ...f.scope, localBranch: 'new-branch' }), null);
});

test('schema4 migration preserves legacy branch bases but never turns them into service proof', async t => {
  const f = await fixture(t); await f.store.recordSyncBase(f.projectId, 'main', f.first.id, f.second.id);
  const filename = path.join(f.directory, 'metadata.json'); const legacy = JSON.parse(await fs.readFile(filename)); legacy.schemaVersion = 4;
  for (const project of Object.values(legacy.projects)) delete project.serviceSyncBases;
  await fs.writeFile(filename, JSON.stringify(legacy)); const migrated = createLocalMetadataStore(f.directory);
  assert.equal(await migrated.getSyncBase(f.projectId, 'main'), f.first.id); assert.equal(await migrated.getServiceSyncBase(f.scope), null);
  const saved = JSON.parse(await fs.readFile(filename)); assert.equal(saved.schemaVersion, 5); assert.deepEqual(Object.values(saved.projects)[0].serviceSyncBases, []);
});

test('metadata proof acknowledgment follows directory fsync and uncertain primary replacement latches the writer', async t => {
  let armed = false; const events = []; const storage = { ...fs, async open(filename, ...args) { const handle = await fs.open(filename, ...args);
    if (!armed) return handle; return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args), readFile: (...args) => handle.readFile(...args),
      writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() { events.push({ sync: filename }); return handle.sync(); } }; },
    async rename(from, to) { await fs.rename(from, to); events.push({ rename: to }); if (armed && to.endsWith('metadata.json')) throw Object.assign(new Error('uncertain'), { code: 'EIO' }); } };
  const f = await fixture(t, { storage }); armed = true;
  await assert.rejects(f.record(), { code: 'metadata-storage-uncertain' }); await assert.rejects(f.store.getServiceSyncBase(f.scope), { code: 'metadata-storage-uncertain' });
  const recovered = await createLocalMetadataStore(f.directory).getServiceSyncBase(f.scope); assert.equal(recovered.proofHash, f.candidate.proofHash);
  assert.ok(events.some(event => event.rename?.endsWith('metadata.json')));
});

test('pre-publication failures preserve the previous base and retry completes only after directory flush', async t => {
  let failSync = false; const events = []; const storage = { ...fs, async open(filename, ...args) { const handle = await fs.open(filename, ...args);
    return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args), readFile: (...args) => handle.readFile(...args),
      writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() {
        if (failSync && filename.endsWith('.tmp')) throw new Error('disk'); events.push({ sync: filename }); return handle.sync(); } }; },
    async rename(from, to) { await fs.rename(from, to); events.push({ rename: to }); } };
  const f = await fixture(t, { storage }); const filename = path.join(f.directory, 'metadata.json'); const before = await fs.readFile(filename); failSync = true;
  await assert.rejects(f.record(), { code: 'metadata-unavailable' }); assert.deepEqual(await fs.readFile(filename), before); assert.equal(await f.store.getServiceSyncBase(f.scope), null);
  failSync = false; events.length = 0; const entry = await f.record(); events.push({ ack: true });
  const rename = events.findIndex(event => event.rename === filename); assert.ok(rename >= 0);
  assert.ok(events.slice(rename + 1, -1).some(event => event.sync === f.directory)); assert.equal(entry.version, 1);
});
