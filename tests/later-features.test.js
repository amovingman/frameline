const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');
const { createBranchProtection } = require('../src/branch-protection');
const { createNotificationPreferences } = require('../src/notification-preferences');
const { createProjectPresets } = require('../src/project-presets');
const { verifySharedStorageCandidate } = require('../src/shared-storage-candidate');
const { createAssetLifecyclePolicy } = require('../src/asset-lifecycle-policy');
const { assessLiveCoediting, assessCloudRendering } = require('../src/later-feature-gates');

test('protected branch requires independent approval and rechecks reviewer access', () => {
  const history = createCloudHistoryStore();
  history.createProject({ projectId: 'film', name: 'Film' });
  const manifest = history.putManifest('film', { schemaVersion: 1, clips: [] });
  const revision = history.createRevision({ projectId: 'film', manifestId: manifest.id,
    authorId: 'editor', message: 'Cut', parentRevisionId: null });
  const roles = new Map([['owner', 'manage'], ['editor', 'request'], ['reviewer', 'approve']]);
  const protection = createBranchProtection({ authorize: (actor, project, action) =>
    project === 'film' && (roles.get(actor) === action || actor === 'owner'),
  getHead: (project, branch) => history.getBranch(project, branch).revisionId });
  protection.setPolicy({ actorId: 'owner', projectId: 'film', branch: 'main', requiredApprovals: 1 });
  const access = { authorize: () => ({ allowed: true }) };
  const identity = { authenticate: token => ({ userId: token }) };
  const service = createAuthorizedProjectService({ history, access, identity, branchProtection: protection });
  const input = { projectId: 'film', branch: 'main', expectedRevisionId: null, revisionId: revision.id };
  assert.throws(() => service.updateBranch({ accessToken: 'editor' }, input), { code: 'branch-approval-required' });
  assert.equal(history.getBranch('film', 'main').revisionId, null);
  const request = protection.request({ actorId: 'editor', projectId: 'film', branch: 'main', revisionId: revision.id });
  assert.throws(() => protection.approve({ actorId: 'editor', requestId: request.id }), { code: 'approval-forbidden' });
  protection.approve({ actorId: 'reviewer', requestId: request.id });
  roles.delete('reviewer');
  assert.throws(() => service.updateBranch({ accessToken: 'editor' }, input), { code: 'branch-approval-required' });
  roles.set('reviewer', 'approve');
  service.updateBranch({ accessToken: 'editor' }, input);
  assert.equal(history.getBranch('film', 'main').revisionId, revision.id);
  assert.throws(() => service.updateBranch({ accessToken: 'editor' }, input), { code: 'approval-head-stale' });
});

test('digest preferences plan only authorized unread activity without sending', () => {
  const now = Date.UTC(2026, 10, 17, 13);
  const preferences = createNotificationPreferences({ now: () => now,
    authorize: (actor, project, action) => actor === 'editor' && project === 'film' && action === 'read' });
  const events = [{ id: 'event-1', projectId: 'film', type: 'revision.created', at: now - 3600000, read: false }];
  assert.equal(preferences.plan('editor', 'film', events).ready, false);
  preferences.set('editor', 'film', { mode: 'daily', digestHourUtc: 12 });
  assert.deepEqual(preferences.plan('editor', 'film', events).counts, { 'revision.created': 1 });
  assert.equal(preferences.plan('editor', 'film', events).ready, true);
  preferences.markDelivered('editor', 'film', events[0].at);
  assert.equal(preferences.plan('editor', 'film', events).count, 0);
  assert.equal(preferences.plan('editor', 'film', [{ ...events[0], id: 'event-2', at: now + 3600000 }]).count, 0);
  assert.throws(() => preferences.set('viewer', 'film', { mode: 'immediate' }), { code: 'notification-preferences-forbidden' });
  assert.throws(() => createNotificationPreferences({ authorize: () => true, initialState: { version: 1,
    entries: { '["editor","film"]': { mode: 'daily', digestHourUtc: 25, lastDeliveredAt: null } } } }),
  { code: 'notification-preferences-invalid' });
});

test('team preset emits a bounded plan without writing a project', () => {
  const presets = createProjectPresets({ authorize: (actor, team, action) => team === 'team'
    && (actor === 'owner' || actor === 'editor' && action === 'read') });
  const saved = presets.save({ actorId: 'owner', teamId: 'team', name: 'Short film',
    branches: ['sound', 'picture'], syncClasses: ['proxy'] });
  const plan = presets.plan({ actorId: 'editor', teamId: 'team', presetId: saved.id, projectId: 'film' });
  assert.deepEqual(plan.branchesToCreate, ['picture', 'sound']);
  assert.equal(plan.applied, false);
  assert.throws(() => presets.save({ actorId: 'owner', teamId: 'team', name: '/private/project', branches: [] }),
    { code: 'preset-invalid' });
});

test('shared storage candidate stays within a selected root and verifies bytes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-shared-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'camera.mov'); await fs.writeFile(candidate, 'camera bytes');
  const expected = { size: 12, sha256: createHash('sha256').update('camera bytes').digest('hex') };
  assert.equal((await verifySharedStorageCandidate({ root, candidate, expected })).verified, true);
  await assert.rejects(verifySharedStorageCandidate({ root, candidate: path.join(os.tmpdir(), 'outside.mov'), expected }),
    { code: 'shared-storage-outside-root' });
  const linked = path.join(root, 'linked.mov'); await fs.symlink(candidate, linked);
  assert.equal((await verifySharedStorageCandidate({ root, candidate: linked, expected })).verified, false);
});

test('deletion planning blocks retained, shared, and held assets', async () => {
  const a = `sha256:${'a'.repeat(64)}`, b = `sha256:${'b'.repeat(64)}`, c = `sha256:${'c'.repeat(64)}`;
  const policy = createAssetLifecyclePolicy({ authorizeOwner: actor => actor === 'owner',
    exportProjectReport: async projectId => ({ projectId, assets: [
      { assetId: a, referencedBy: ['revision-1'], sharedProjects: false, eligible: false },
      { assetId: b, referencedBy: [], sharedProjects: true, eligible: true },
      { assetId: c, referencedBy: [], sharedProjects: false, eligible: true }
    ] }) });
  policy.setHold({ actorId: 'owner', projectId: 'film', assetId: c, reason: 'manual' });
  const blocked = await policy.planDeletion({ actorId: 'owner', projectId: 'film', assetIds: [a, b, c] });
  assert.deepEqual(blocked.items.map(item => item.reason), ['retained-revision', 'shared-project', 'active-hold']);
  assert.equal(blocked.deletionPerformed, false);
  policy.releaseHold({ actorId: 'owner', projectId: 'film', assetId: c });
  assert.equal((await policy.planDeletion({ actorId: 'owner', projectId: 'film', assetIds: [c] })).ready, true);
  await assert.rejects(policy.planDeletion({ actorId: 'editor', projectId: 'film', assetIds: [c] }),
    { code: 'asset-lifecycle-forbidden' });
});

test('later capabilities stay disabled even when research gates are supplied', () => {
  assert.ok(assessLiveCoediting().blockers.includes('stableIdentity-unproven'));
  assert.ok(assessCloudRendering().blockers.includes('mediaRights-unproven'));
  assert.equal(assessLiveCoediting({ firstAdapterReliable: true, stableIdentity: true, editorEventApi: true,
    transactionalRecovery: true, userResearch: true }).productEnabled, false);
  assert.equal(assessCloudRendering({ explicitOptIn: true, mediaRights: true, processorContract: true,
    dataRegion: true, costLimit: true, outputProvenance: true }).productEnabled, false);
});
