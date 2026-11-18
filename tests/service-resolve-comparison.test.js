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
const { createResolveRevisionManifest, createResolveObservationManifest } = require('../src/resolve-revision-manifest');
const { verifyServiceSyncBase } = require('../src/service-sync-base');
const { createServiceResolveComparison: compare } = require('../src/service-resolve-comparison');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const capture = (changes = {}) => ({ mode: 'verified-capture', generation: 1, requestId: 'a'.repeat(32), requestSha256: 'b'.repeat(64), acceptedAt: 2000, ...changes });
const options = { now: () => 2000 };
const rich = () => clone(require('../phase-0/resolve-xml-proof/live-properties-enabled.json'));
async function fixture(t, { base = createResolveObservationManifest(rich()), branch = 'main' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-resolve-comparison-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(directory), projectId = (await store.getResolveProjectId(base.snapshot.project_id)).id;
  const revision = await store.saveRevision(projectId, base, 'Base'); const bundle = await store.exportRevisions(projectId);
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'remote', name: 'Film' }); if (branch !== 'main') history.createBranch('remote', branch);
  const sync = createAsyncRevisionSyncService(history);
  await sync.push({ remoteProjectId: 'remote', bundle: { ...bundle, branches: { ...bundle.branches, [branch]: revision.id } }, branch, authorId: 'publisher' });
  const baseProof = { ...await sync.fetch({ remoteProjectId: 'remote', branch }), checkedAt: 1000 };
  const scope = { originHash: '1'.repeat(64), accountId: 'viewer', localProjectId: projectId, localBranch: 'main', remoteProjectId: 'remote', remoteBranch: branch };
  const candidate = verifyServiceSyncBase({ scope, bundle, remote: baseProof, verifiedAt: 1000 });
  const baseEntry = await store.recordServiceSyncBase({ scope, candidate, expectedHeadId: revision.id, expectedBaseVersion: 0, proofSnapshotHash: sha(`${JSON.stringify(baseProof)}\n`) });
  const input = { scope, baseEntry, bundle, baseProof, incoming: { ...baseProof, branch: 'main' }, local: base };
  async function incoming(manifest) {
    const stored = history.putManifest('remote', manifest), parent = history.getBranch('remote', branch).revisionId;
    const added = history.createRevision({ projectId: 'remote', manifestId: stored.id, parentRevisionId: parent, authorId: 'other-publisher', sourceRevisionId: randomUUID(), message: 'Incoming' });
    history.compareAndSwapBranch({ projectId: 'remote', branch, expectedRevisionId: parent, revisionId: added.id });
    return { ...await sync.fetch({ remoteProjectId: 'remote', branch }), branch: 'main', checkedAt: 2000 };
  }
  return { input, incoming, store, projectId, revision };
}

test('rich service review retains property-only changes, conflicts, decimal equality and exact source bindings', async t => {
  const f = await fixture(t, { branch: 'review' }), incoming = rich(), local = rich();
  incoming.items[0].properties.Pan.decimal = '2.0000000000000000e+01'; local.items[0].properties.Pan.decimal = '1.0000000000000000e+01';
  local.items[0].properties.Tilt.decimal = '3.0000000000000000e+00'; incoming.items[0].properties.ZoomX.decimal = '1.0000000000000000e+000';
  const input = { ...f.input, local: createResolveObservationManifest(local), incoming: await f.incoming(createResolveObservationManifest(incoming)) };
  const before = clone(input), result = compare(input, capture(), options);
  assert.equal(result.plan.schemaVersion, 2); assert.equal(result.readOnly, true); assert.equal(result.safeToApply, false);
  assert.deepEqual(result.plan.classification.decisions.map(item => [item.field, item.status]), [['properties.Pan', 'conflict'], ['properties.Tilt', 'local-only']]);
  assert.equal(result.binding.localVerification.requestId, 'a'.repeat(32)); assert.equal(result.binding.scope.remoteBranch, 'review');
  assert.equal(result.sources.local, JSON.stringify(local)); assert.equal(result.binding.sourceHashes.local, sha(result.sources.local));
  assert.equal(result.plan.binding.hashes.local, result.binding.sourceHashes.local); assert.deepEqual(input, before);
  assert.deepEqual(compare(input, capture(), options), result); assert.notEqual(compare(input, capture({ generation: 2 }), options).id, result.id);
});

test('saved-head requires exact local manifest identity and mixed snapshots retain explicit rich coverage gaps', async t => {
  const f = await fixture(t), original = compare(f.input, { mode: 'saved-head' });
  assert.equal(original.binding.localVerification.mode, 'saved-head');
  const local = createResolveRevisionManifest(rich().snapshot), result = compare({ ...f.input, local }, capture(), options);
  assert.equal(JSON.parse(result.sources.local).schema_version, 3);
  assert(result.plan.classification.observationCoverage.gaps.some(item => item.field === 'properties.Pan'));
  assert.deepEqual(result.plan.classification.decisions, []);
  assert.throws(() => compare({ ...f.input, local }, { mode: 'saved-head' }), { code: 'service-resolve-comparison-verification-invalid' });
  const snapshot = rich().snapshot, first = await fixture(t, { base: createResolveRevisionManifest(snapshot) });
  assert.equal(compare(first.input, { mode: 'saved-head' }).plan.schemaVersion, 1);
});

test('capture receipts reject unsupported modes, extra fields, expiry, future times and malformed provenance', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { mode: 'saved-head', includeObservations: false }, capture({ generation: 0 }),
    capture({ requestId: randomUUID() }), capture({ requestSha256: '/private/secret' }), capture({ acceptedAt: -1 }), { ...capture(), path: '/private/secret' }])
    assert.throws(() => compare(f.input, value, options), { code: 'service-resolve-comparison-verification-invalid' });
  for (const now of [1999, 302001]) assert.throws(() => compare(f.input, capture(), { now: () => now }), { code: 'service-resolve-comparison-capture-expired' });
  assert(compare(f.input, capture(), { now: () => 302000 }).id);
});

test('wrong embedded project/build and non-Resolve incoming documents are refused', async t => {
  const f = await fixture(t), other = rich(); other.snapshot.project_id = 'other-project';
  assert.throws(() => compare({ ...f.input, local: createResolveObservationManifest(other) }, capture(), options), { code: 'service-resolve-comparison-invalid' });
  const invalid = clone(f.input); invalid.local.snapshot.resolve_version = '99.0';
  assert.throws(() => compare(invalid, capture(), options), { code: 'service-comparison-invalid' });
  const scan = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: 'f'.repeat(64), sequence: { name: 'Film', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
  const mixed = await f.incoming(scan);
  assert.throws(() => compare({ ...f.input, incoming: mixed }, capture(), options), { code: 'service-resolve-comparison-unsupported' });
});

test('shared binder refuses corrupted original proofs, current local bytes and rewritten incoming base prefixes', async t => {
  const f = await fixture(t);
  for (const edit of [value => { value.baseEntry.proofHash = '0'.repeat(64); }, value => { value.baseProof.revisions[0].authorId = 'other'; }, value => { value.bundle.records[0].bytes += 'x'; }]) {
    const input = clone(f.input); edit(input); assert.throws(() => compare(input, capture(), options), { code: 'service-comparison-base-invalid' });
  }
  const incoming = clone(f.input.incoming); incoming.revisions[0].authorId = 'rewritten';
  assert.throws(() => compare({ ...f.input, incoming }, capture(), options), { code: 'service-comparison-incoming-invalid' });
});

function auditedManifest() {
  const observation = clone(require('../phase-0/resolve-xml-proof/live-effects-enabled.json')), snapshot = observation.snapshot;
  const base = clone(snapshot), incoming = clone(snapshot); base.timelines[0].items[0].name = 'Earlier'; incoming.timelines[0].items[0].name = 'Incoming rename';
  const sources = { base: JSON.stringify(base), local: JSON.stringify(snapshot), incoming: JSON.stringify(incoming) }, plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources), audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(item => ({ conflictId: item.id, choice: 'take-incoming' })));
  const derived = resolveReviewedRename({ sources, plan, audit }), effectBytes = `${JSON.stringify(observation, null, 2)}\n`;
  const transactionId = 'c'.repeat(32), at = '2026-11-18T00:00:00.000Z', resultSnapshot = sources.local;
  const portable = { schemaVersion: 1, kind: 'resolve-rename-trial-audit', readOnly: true, safeToApply: false, nativeBackupIncluded: false,
    provenance: 'copied-console-observation', transactionId, sources, review: audit,
    issuedRecord: JSON.stringify({ transactionId, backup: { schemaVersion: 1, sha256: 'd'.repeat(64), size: 100, mode: 0o600, timelineCount: 1, archiveVerified: true }, forceFailure: true, issuedAt: at }),
    outcome: { status: 'rolled-back', recordedAt: at, sourceSha256: sha(derived.beforeBytes), incomingSha256: sha(derived.afterBytes), resultingSnapshotSha256: sha(resultSnapshot), validation: 'observed-fields-only',
      effectObservation: { sourceSha256: sha(effectBytes), resultingSha256: sha(effectBytes), validation: 'observed-effect-metadata-only' } }, resultSnapshot,
    effects: { before: effectBytes, after: effectBytes }, recovery: null };
  return createResolveRevisionManifest(snapshot, portable);
}

test('legacy audited manifests retain raw rich observation bytes and distinguish their hashes from snapshot hashes', async t => {
  const manifest = auditedManifest(), f = await fixture(t, { base: manifest }), result = compare(f.input, { mode: 'saved-head' });
  assert.equal(result.sources.base, manifest.transactionAudit.effects.after); assert(result.sources.base.endsWith('\n'));
  assert.equal(result.binding.baseSourceHash, manifest.sourceHash); assert.equal(result.binding.sourceHashes.base, sha(manifest.transactionAudit.effects.after));
  assert.notEqual(result.binding.baseSourceHash, result.binding.sourceHashes.base); assert.equal(result.plan.schemaVersion, 2);
});

test('oversized source bytes are refused before preview construction and invalid clock options fail closed', async t => {
  const f = await fixture(t), snapshot = rich().snapshot;
  snapshot.project_name = 'x'.repeat(20 * 1024 * 1024);
  const local = createResolveRevisionManifest(snapshot);
  assert.throws(() => compare({ ...f.input, local }, capture(), options), { code: 'service-resolve-comparison-too-large' });
  for (const invalid of [null, { now: 2000 }, { now: () => NaN }, { now: () => { throw new Error('/private/secret'); } }, { extra: true }])
    assert.throws(() => compare(f.input, capture(), invalid), { code: 'service-resolve-comparison-verification-invalid' });
});
