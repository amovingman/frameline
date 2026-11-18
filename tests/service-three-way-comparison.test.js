'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAsyncRevisionSyncService } = require('../src/revision-sync-async');
const { verifyServiceSyncBase } = require('../src/service-sync-base');
const { fingerprint } = require('../src/project-api-contracts');
const { createServiceThreeWayComparison: compare, verifyServiceThreeWayComparison } = require('../src/service-three-way-comparison');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = marker => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: sha(marker),
  sequence: { name: 'Film', frameDuration: '1/24s', durationFrames: 100 }, clips: [], media: [], warnings: [] });

async function fixture(t, { remoteBranch = 'main' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-three-way-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(directory), localId = (await store.getProjectId('/private/source.fcpxml')).id;
  const revision = await store.saveRevision(localId, manifest('base'), 'Base');
  const bundle = await store.exportRevisions(localId), history = createCloudHistoryStore();
  history.createProject({ projectId: 'remote', name: 'Film' }); if (remoteBranch !== 'main') history.createBranch('remote', remoteBranch);
  const sync = createAsyncRevisionSyncService(history);
  // Populate the real branch, while the desktop's captured cache uses local main.
  const remoteBundle = { ...bundle, branches: { ...bundle.branches, [remoteBranch]: revision.id } };
  await sync.push({ remoteProjectId: 'remote', branch: remoteBranch, bundle: remoteBundle, authorId: 'publisher' });
  const baseProof = { ...await sync.fetch({ remoteProjectId: 'remote', branch: remoteBranch }), checkedAt: 1000 };
  const scope = { originHash: '1'.repeat(64), accountId: 'viewer', localProjectId: localId,
    localBranch: 'main', remoteProjectId: 'remote', remoteBranch };
  const candidate = verifyServiceSyncBase({ scope, bundle, remote: baseProof, verifiedAt: 1000 });
  const baseEntry = await store.recordServiceSyncBase({ scope, candidate, proofSnapshotHash: sha(`${JSON.stringify(baseProof)}\n`),
    expectedHeadId: revision.id, expectedBaseVersion: 0 });
  async function incoming(document = manifest('incoming')) {
    const stored = history.putManifest('remote', document), head = history.getBranch('remote', remoteBranch).revisionId;
    const added = history.createRevision({ projectId: 'remote', parentRevisionId: head, manifestId: stored.id,
      authorId: 'incoming-publisher', sourceRevisionId: randomUUID(), message: 'Incoming' });
    history.compareAndSwapBranch({ projectId: 'remote', branch: remoteBranch, expectedRevisionId: head, revisionId: added.id });
    return { ...await sync.fetch({ remoteProjectId: 'remote', branch: remoteBranch }), branch: 'main', checkedAt: 2000 };
  }
  const input = { scope, baseEntry, bundle, baseProof, incoming: { ...baseProof, branch: 'main' }, local: manifest('local') };
  return { input, incoming, history, sync, store, localId, revision };
}

test('compares all four observed field statuses, omits unchanged fields and normalizes equivalent rational rates', async t => {
  const f = await fixture(t), local = manifest('local'); local.sequence.name = 'Local'; local.sequence.frameDuration = '2/48s'; local.sequence.durationFrames = 120;
  const remote = manifest('incoming'); remote.sequence.frameDuration = '1/30s'; remote.sequence.durationFrames = 120;
  const input = { ...f.input, local, incoming: await f.incoming(remote) }, before = structuredClone(input);
  const result = compare(input);
  assert.deepEqual(result.decisions, [
    { field: 'name', status: 'local-only', base: 'Film', local: 'Local', incoming: 'Film' },
    { field: 'frameDuration', status: 'incoming-only', base: '1/24s', local: '1/24s', incoming: '1/30s' },
    { field: 'durationFrames', status: 'already-applied', base: 100, local: 120, incoming: 120 }
  ]);
  assert.deepEqual(input, before); assert.deepEqual(compare(input), result); assert.equal(result.safeToApply, false); assert.equal(result.readOnly, true);
  assert.equal(verifyServiceThreeWayComparison(result, input).valid, true);
  const changed = structuredClone(result); changed.decisions[0].status = 'incoming-only'; assert.equal(verifyServiceThreeWayComparison(changed, input).valid, false);
  remote.sequence.name = 'Incoming'; const conflict = compare({ ...input, incoming: await f.incoming(remote) }); assert.equal(conflict.decisions[0].status, 'conflict');
  assert.notEqual(conflict.id, result.id);
  assert.deepEqual(compare(f.input).decisions, []);
  const equivalent = structuredClone(f.input); equivalent.local.sequence.frameDuration = '200/4800s'; assert.deepEqual(compare(equivalent).decisions, []);
});

test('incoming snapshot binding retains actual fetched cache identity across a local-to-remote branch remap', async t => {
  const f = await fixture(t, { remoteBranch: 'review' }); f.input.incoming = await f.incoming();
  const result = compare(f.input);
  assert.equal(result.binding.scope.remoteBranch, 'review'); assert.equal(result.binding.incomingSnapshotHash, sha(`${JSON.stringify(f.input.incoming)}\n`));
  assert.equal(result.binding.baseSourceHash, manifest('base').sourceHash); assert.equal(result.binding.localSourceHash, f.input.local.sourceHash);
  assert.equal(result.binding.incomingRevisionId, f.input.incoming.head); assert.equal(result.binding.incomingCheckedAt, 2000);
  assert.equal(result.binding.baseEntryHash, fingerprint(f.input.baseEntry));
  const wrong = structuredClone(f.input); wrong.incoming.branch = 'review'; assert.throws(() => compare(wrong), { code: 'service-comparison-incoming-invalid' });
});

test('clip positions, media availability and duplicate names remain bounded context without inferred edits', async t => {
  const f = await fixture(t), scan = f.input.local;
  scan.clips.push({ scanKey: 'position-1', name: 'Clip', mediaName: 'same.mov', offsetFrames: 0, durationFrames: 12,
    sourceInFrames: 0, enabled: true, identityStatus: 'unresolved' });
  scan.media.push({ name: 'same.mov', availability: 'local' }, { name: 'same.mov', availability: 'missing' }); scan.warnings.push('Nested content is not scanned');
  const result = compare(f.input);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.context.local, { clipCount: 1, mediaCount: 2, ambiguousMediaNames: true,
    availability: { local: 1, missing: 1, external: 0, unknown: 0, unavailable: 0 }, warningCount: 1 });
  assert.equal(result.context.base.ambiguousMediaNames, false); assert(result.warnings.some(value => value.includes('coverage warnings')));
  assert(!JSON.stringify(result).includes('same.mov')); assert(!JSON.stringify(result).includes('Nested content'));
  assert(result.gaps.includes('clip-edits-unavailable')); assert(result.gaps.includes('media-edit-classification-unavailable'));
});

test('original receipt proof, local ancestry and exact bytes must revalidate before comparison', async t => {
  const f = await fixture(t);
  for (const edit of [value => { value.scope.accountId = 'different'; }, value => { value.baseEntry.version = 0; },
    value => { value.baseEntry.proofHash = '0'.repeat(64); }, value => { value.baseEntry.proofSnapshotHash = '0'.repeat(64); },
    value => { value.bundle.records[0].bytes += 'tamper'; }, value => { value.bundle.branches.main = null; },
    value => { value.baseProof.revisions[0].authorId = 'changed'; }, value => { value.baseEntry.localRevisionId = randomUUID(); }]) {
    const input = structuredClone(f.input); edit(input); assert.throws(() => compare(input), { code: 'service-comparison-base-invalid' });
  }
  const bundle = structuredClone(f.input.bundle), other = { ...JSON.parse(bundle.records[0].bytes), id: randomUUID(), message: 'Unrelated root' };
  const bytes = `${JSON.stringify(other)}\n`, { manifest: _manifest, ...summary } = other;
  bundle.records.push({ summary: { ...summary, recordHash: sha(bytes) }, bytes }); bundle.branches.main = other.id;
  assert.throws(() => compare({ ...f.input, bundle }), { code: 'service-comparison-base-invalid' });
});

test('local saved descendants and unsaved source observations can differ while preserving the recorded common base', async t => {
  const f = await fixture(t); const later = await f.store.saveRevision(f.localId, manifest('saved-child'), 'Local child', f.revision.id);
  const local = manifest('unsaved-current-source'); local.sequence.name = 'Unsaved name';
  const result = compare({ ...f.input, bundle: await f.store.exportRevisions(f.localId), local, incoming: await f.incoming() });
  assert.equal(result.binding.localHead, later.id); assert.equal(result.binding.baseLocalRevisionId, f.revision.id);
  assert.equal(result.binding.localSourceHash, local.sourceHash); assert.equal(result.decisions[0].status, 'local-only');
  assert.equal((await f.store.exportRevisions(f.localId)).branches.main, later.id);
});

test('a deeper incoming common prefix is compared against the recorded base, while older fetched heads cannot precede a newer base', async t => {
  const f = await fixture(t), document = manifest('saved-child'); document.sequence.name = 'Shared child';
  const later = await f.store.saveRevision(f.localId, document, 'Shared child', f.revision.id), bundle = await f.store.exportRevisions(f.localId);
  await f.sync.push({ remoteProjectId: 'remote', bundle, authorId: 'publisher' });
  const incoming = { ...await f.sync.fetch({ remoteProjectId: 'remote' }), checkedAt: 2000 };
  const result = compare({ ...f.input, bundle, incoming });
  assert.equal(result.binding.baseLocalRevisionId, f.revision.id); assert.equal(result.binding.localHead, later.id);
  assert.equal(result.binding.incomingRevisionId, incoming.head); assert.equal(result.decisions[0].status, 'incoming-only');
  const candidate = verifyServiceSyncBase({ scope: f.input.scope, bundle, remote: incoming, verifiedAt: 2000 });
  const baseEntry = await f.store.recordServiceSyncBase({ scope: f.input.scope, candidate,
    proofSnapshotHash: sha(`${JSON.stringify(incoming)}\n`), expectedHeadId: later.id, expectedBaseVersion: 1 });
  assert.throws(() => compare({ ...f.input, bundle, baseEntry, baseProof: incoming }), { code: 'service-comparison-incoming-invalid' });
});

test('incoming history must retain the full verified base prefix and cannot select an earlier or unrelated head', async t => {
  const f = await fixture(t); f.input.incoming = await f.incoming();
  for (const edit of [value => { value.incoming.revisions[0].authorId = 'rewritten-publisher'; },
    value => { value.incoming.revisions[0].createdAt = '2000-01-01T00:00:00.000Z'; },
    value => { value.incoming.revisions[0].id = 'rewritten-id'; value.incoming.revisions[1].parentRevisionId = 'rewritten-id'; },
    value => { value.incoming.revisions[0].message = 'Collision'; }, value => { value.incoming.remoteProjectId = 'other'; },
    value => { value.incoming.revisions[1].parentRevisionId = null; }, value => { value.incoming.manifests[0].document.sequence.name = 'Tampered'; },
    value => { value.incoming.privatePath = '/private/location'; }, value => { value.incoming.revisions = []; value.incoming.manifests = []; value.incoming.head = null; }]) {
    const input = structuredClone(f.input); edit(input); assert.throws(() => compare(input), { code: 'service-comparison-incoming-invalid' });
  }
  const input = structuredClone(f.input); input.incoming.revisions.shift(); input.incoming.revisions[0].parentRevisionId = null;
  input.incoming.manifests = input.incoming.manifests.filter(item => item.id === input.incoming.revisions[0].manifestId);
  assert.throws(() => compare(input), { code: 'service-comparison-incoming-invalid' });
});

test('unknown fields, malformed current scans and excessive output fail safely without leaking input data', async t => {
  const f = await fixture(t);
  assert.throws(() => compare({ ...f.input, privatePath: '/private/secret' }), { code: 'service-comparison-invalid' });
  const invalid = structuredClone(f.input); invalid.local.media.push({ name: 'media', availability: 'invented' });
  assert.throws(() => compare(invalid), { code: 'service-comparison-invalid' });
  const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
  const snapshot = require('../phase-0/resolve-xml-proof/live-mapping-before-schema3.json');
  assert.throws(() => compare({ ...f.input, local: createResolveRevisionManifest(snapshot) }), { code: 'service-comparison-unsupported' });
  const huge = structuredClone(f.input); huge.local.sequence.name = 'x'.repeat(1024 * 1024);
  assert.throws(() => compare(huge), { code: 'service-comparison-too-large' });
  const original = compare(f.input); f.input.local.sourceHash = 'f'.repeat(64); const changed = compare(f.input);
  assert.notEqual(original.id, changed.id); assert.deepEqual(original.decisions, changed.decisions);
});
