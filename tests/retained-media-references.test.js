'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { retainedMediaReferences, assertRetainedMediaIdentities } = require('../src/retained-media-references');
const { createCloudHistoryStore } = require('../src/cloud-history-store');

const manifest = () => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
  sourceHash: 'a'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
const bound = () => ({ ...manifest(), schemaVersion: 3,
  mediaDependencies: { version: 1, coverage: 'complete', assets: [] } });
function revision(history, document) {
  const { id: manifestId } = history.putManifest('film', document);
  return history.createRevision({ projectId: 'film', manifestId, authorId: 'owner', message: 'Retained revision' });
}
test('all immutable revisions remain protected even when no branch points to them', () => {
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'film', name: 'Film' });
  assert.equal(retainedMediaReferences(history, 'film').complete, true);
  const first = revision(history, bound());
  const snapshot = retainedMediaReferences(history, 'film');
  assert.equal(snapshot.complete, true); assert.equal(snapshot.revisions[0].revisionId, first.id);
  assert.equal(history.getBranch('film', 'main').revisionId, null);
  const second = revision(history, manifest());
  const legacy = retainedMediaReferences(history, 'film');
  assert.equal(legacy.complete, false); assert.equal(legacy.revisions.length, 2);
  assert.notEqual(legacy.stateHash, snapshot.stateHash);
  assert.ok(legacy.revisions.some(item => item.revisionId === second.id));
});

test('metadata-only revisions cannot introduce conflicting identities for the same retained content', () => {
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'film', name: 'Film' });
  const first = bound(), identity = { version: 1, algorithm: 'sha256', contentId: `sha256:${'b'.repeat(64)}`, size: 8, assetClass: 'original', mediaType: null };
  first.mediaDependencies.assets.push({ referenceId: 'media-1', identity, required: true }); revision(history, first);
  assertRetainedMediaIdentities(history, 'film', first);
  for (const patch of [{ assetClass: 'proxy' }, { mediaType: 'video/mp4' }, { size: 9 }]) {
    const conflicting = structuredClone(first); Object.assign(conflicting.mediaDependencies.assets[0].identity, patch);
    assert.throws(() => assertRetainedMediaIdentities(history, 'film', conflicting), { code: 'asset-revision-identity-mismatch' });
  }
});

test('history lease excludes concurrent publishers across independent runtime instances', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-media-lease-')));
  const keyring = createKeyring({ test: Buffer.alloc(32, 8) }, 'test');
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true });
  const other = await createDurableCollaborationService({ directory, keyring, lockTimeoutMs: 0 });
  t.after(async () => { await runtime.close(); await other.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const account = await runtime.identity.createAccount('owner@example.test', 'disposable media password');
  const session = await runtime.identity.signIn(account.email, 'disposable media password');
  const context = { accessToken: session.accessToken, requestId: 'media-lease' };
  const team = await runtime.teams.create(context, 'Personal project');
  await runtime.projects.create(context, { projectId: 'film', name: 'Film', teamId: team.id });
  let releaseLease, enteredLease;
  const entered = new Promise(resolve => { enteredLease = resolve; });
  const release = new Promise(resolve => { releaseLease = resolve; });
  const leased = runtime.withRevisionReferences(context, 'film', async (snapshot, authority) => {
    assert.equal(snapshot.complete, true); assert.deepEqual(snapshot.revisions, []);
    assert.equal(authority.authorize('write').actorId, account.id);
    assert.equal(authority.authorizePolicy().actorId, account.id);
    assert.deepEqual(authority.getInitialPolicy().syncClasses, []);
    enteredLease(); await release; return snapshot.stateHash;
  });
  await entered;
  await assert.rejects(other.service.putManifest(context, 'film', bound()), { code: 'collaboration-service-busy' });
  releaseLease(); await leased;
  const stored = await other.service.putManifest(context, 'film', bound());
  await other.service.createRevision(context, { projectId: 'film', manifestId: stored.id, message: 'After cleanup' });
  await runtime.withRevisionReferences(context, 'film', snapshot => {
    assert.equal(snapshot.complete, true); assert.equal(snapshot.revisions.length, 1);
    return true;
  });
  const input = { projectId: 'film', manifestId: stored.id, message: 'Guarded publication', requireMedia: true };
  await assert.rejects(runtime.createRevisionWithAssetGuard(context, input, (document, options) => {
    assert.equal(document.schemaVersion, 3); assert.equal(options.requireMedia, true);
    throw Object.assign(new Error('asset-revision-media-missing'), { code: 'asset-revision-media-missing' });
  }), { code: 'asset-revision-media-missing' });
  await runtime.withRevisionReferences(context, 'film', snapshot => {
    assert.equal(snapshot.revisions.length, 1); return true;
  });
  await runtime.createRevisionWithAssetGuard(context, input, (document, options) => {
    assert.deepEqual(document.mediaDependencies.assets, []); assert.equal(options.requireMedia, true);
  });
  await assert.rejects(runtime.withRevisionReferences({ accessToken: 'forged' }, 'film', () => true), { code: 'access-token-invalid' });
});
