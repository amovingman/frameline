const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAccessControl } = require('../src/access-control');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createProjectShareLinks } = require('../src/project-share-links');
const { createProjectActivity } = require('../src/project-activity');
const { createMediaAssetIdentity, identifyMediaFile, sameMediaContent } = require('../src/media-asset-identity');
const { createIdentityService } = require('../src/identity-service');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');

function fixture() {
  let time = 1000;
  const owner = 'owner', editor = 'editor', viewer = 'viewer';
  const access = createAccessControl({ now: () => time });
  const team = access.createTeam(owner, 'Team'); access.registerProject(owner, 'project-1', team.id);
  for (const [user, email, role] of [[editor, 'editor@example.test', 'editor'], [viewer, 'viewer@example.test', 'viewer']]) {
    const invite = access.inviteProject(owner, 'project-1', email, role);
    access.acceptInvitation(invite.token, user, email);
  }
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'project-1', name: 'Film' });
  const manifest = history.putManifest('project-1', { version: 1, clips: [] });
  const revision = history.createRevision({ projectId: 'project-1', manifestId: manifest.id, authorId: owner, message: 'First' });
  return { owner, editor, viewer, access, history, revision, now: () => time, advance: n => { time += n; } };
}

test('read-only share link copies once, expires, revokes, and cannot cross projects', async () => {
  const { owner, editor, access, history, revision, now, advance } = fixture();
  const shares = createProjectShareLinks({ history, access, origin: 'https://example.test', now, maxTtlMs: 200 });
  assert.throws(() => shares.create(editor, 'project-1', revision.id, 100), { code: 'forbidden' });
  assert.throws(() => shares.create(owner, 'project-1', revision.id, 201), { code: 'share-expiration-invalid' });
  assert.throws(() => createProjectShareLinks({ history, access, origin: 'http://example.test' }), { code: 'secure-transport-required' });
  let copied;
  const result = await shares.copy(owner, 'project-1', revision.id, 100, value => { copied = value; });
  assert.equal(result.copied, true);
  const token = new URL(copied).hash.slice('#token='.length);
  assert.equal(shares.read(token).revision.id, revision.id);
  assert.equal(shares.read(token).permission, 'read');
  assert.doesNotMatch(JSON.stringify(shares.list(owner, 'project-1')), new RegExp(token));
  assert.throws(() => shares.read('x'.repeat(43)), { code: 'share-link-invalid' });
  shares.revoke(owner, 'project-1', result.id);
  assert.throws(() => shares.read(token), { code: 'share-link-invalid' });
  const second = shares.create(owner, 'project-1', revision.id, 100);
  advance(100);
  assert.throws(() => shares.read(new URL(second.url).hash.slice(7)), { code: 'share-link-invalid' });
  const third = shares.create(owner, 'project-1', revision.id, 100);
  access.deleteProject(owner, 'project-1');
  assert.throws(() => shares.read(new URL(third.url).hash.slice(7)), { code: 'share-link-invalid' });
});

test('activity history, recipient notifications and read receipts are scoped and verifiable', () => {
  const { owner, editor, viewer, access, now } = fixture();
  const activity = createProjectActivity({ access, now });
  const observed = []; const unsubscribe = activity.subscribe(event => observed.push(event.type));
  const event = activity.record({ projectId: 'project-1', actorId: owner, type: 'revision.created',
    subjectId: 'rev-1', recipientIds: [editor, viewer, editor] });
  assert.deepEqual(observed, ['revision.created']); unsubscribe();
  assert.equal(activity.list(viewer, 'project-1').length, 1);
  assert.equal(activity.notifications(editor, 'project-1')[0].read, false);
  activity.markRead(editor, 'project-1', event.id);
  assert.equal(activity.notifications(editor, 'project-1')[0].read, true);
  assert.equal(activity.notifications(viewer, 'project-1')[0].read, false);
  assert.equal(activity.verify(), true);
  assert.equal(createProjectActivity({ access, now, initialState: activity.snapshot() }).verify(), true);
  assert.throws(() => activity.list('outsider', 'project-1'), { code: 'forbidden' });
  assert.throws(() => activity.record({ projectId: 'project-1', actorId: owner, type: 'unknown' }), { code: 'activity-event-invalid' });
});

test('authorized commits and branch changes enter activity and collaborator inbox', () => {
  const identity = createIdentityService();
  const owner = identity.createAccount('owner@team.test', 'secure password');
  const editor = identity.createAccount('editor@team.test', 'secure password');
  const access = createAccessControl(); const team = access.createTeam(owner.id, 'Team');
  access.registerProject(owner.id, 'project-1', team.id);
  const invite = access.inviteProject(owner.id, 'project-1', 'editor@team.test', 'editor');
  access.acceptInvitation(invite.token, editor.id, 'editor@team.test');
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'project-1', name: 'Film' });
  const activity = createProjectActivity({ access });
  const service = createAuthorizedProjectService({ history, access, identity, activity });
  const ownerSession = identity.signIn('owner@team.test', 'secure password');
  const editorSession = identity.signIn('editor@team.test', 'secure password');
  const ownerContext = { accessToken: ownerSession.accessToken };
  const editorContext = { accessToken: editorSession.accessToken };
  const manifest = service.putManifest(ownerContext, 'project-1', { schemaVersion: 1 });
  const revision = service.createRevision(ownerContext, { projectId: 'project-1', manifestId: manifest.id, message: 'Save' });
  service.updateBranch(ownerContext, { projectId: 'project-1', branch: 'main', revisionId: revision.id });
  assert.deepEqual(service.listActivity(editorContext, 'project-1').items.map(e => e.type), ['branch.changed', 'revision.created']);
  assert.equal(service.listNotifications(editorContext, 'project-1').items.length, 2);
  assert.equal(service.listNotifications(ownerContext, 'project-1').items.length, 0);
});

test('ownership transfer, member removal and deletion enforce lifecycle boundaries', () => {
  const { owner, editor, viewer, access } = fixture();
  assert.throws(() => access.setProjectRole(owner, 'project-1', editor, 'owner'), { code: 'ownership-transfer-required' });
  assert.throws(() => access.removeProjectMember(owner, 'project-1', owner), { code: 'ownership-transfer-required' });
  access.transferProjectOwnership(owner, 'project-1', editor);
  assert.equal(access.roleFor(editor, 'project-1'), 'owner');
  assert.equal(access.roleFor(owner, 'project-1'), 'editor');
  assert.throws(() => access.deleteProject(owner, 'project-1'), { code: 'project-delete-forbidden' });
  access.removeProjectMember(editor, 'project-1', viewer);
  assert.throws(() => access.authorize(viewer, { projectId: 'project-1', resource: 'revision', action: 'read' }), { code: 'forbidden' });
  assert.equal(access.deleteProject(editor, 'project-1').retainedHistory, true);
  assert.throws(() => access.authorize(editor, { projectId: 'project-1', resource: 'project', action: 'read' }), { code: 'forbidden' });
});

test('media identity uses streamed content hash with explicit class metadata and no path', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-identity-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.mov'); const duplicate = path.join(directory, 'other.mov');
  await fs.writeFile(first, 'frame data'); await fs.copyFile(first, duplicate);
  const left = await identifyMediaFile(first, { assetClass: 'original', mediaType: 'video/quicktime' });
  const right = await identifyMediaFile(duplicate, { assetClass: 'proxy', mediaType: 'video/quicktime' });
  assert.equal(sameMediaContent(left, right), true);
  assert.notEqual(left.assetClass, right.assetClass);
  assert.equal(left.size, 10);
  assert.doesNotMatch(JSON.stringify(left), /first\.mov|frameline-identity/);
  assert.throws(() => createMediaAssetIdentity({ size: -1, sha256: 'bad' }), { code: 'asset-identity-invalid' });
});
