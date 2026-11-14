const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createIdentityService } = require('../src/identity-service');
const { createAccessControl } = require('../src/access-control');
const { createCredentialVault } = require('../src/credential-vault');
const { requireSecureTransport, createKeyring, createRateLimiter,
  createAuditTrail, deleteAccountFlow } = require('../src/security-controls');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');

test('sign-in, rotating refresh, sign-out and recovery revoke old credentials', async () => {
  let time = 1000; let recoveryToken;
  const identity = createIdentityService({ now: () => time,
    deliverRecovery: async delivery => { recoveryToken = delivery.token; } });
  const user = identity.createAccount('Editor@example.com', 'a secure password');
  const first = identity.signIn('editor@example.com', 'a secure password');
  assert.equal(identity.authenticate(first.accessToken).userId, user.id);
  const second = identity.refresh(first.refreshToken);
  assert.throws(() => identity.authenticate(first.accessToken), { code: 'access-token-invalid' });
  identity.signOut(second.refreshToken);
  assert.throws(() => identity.refresh(second.refreshToken), { code: 'refresh-token-invalid' });
  await identity.beginRecovery('EDITOR@example.com');
  identity.completeRecovery(recoveryToken, 'a different secure password');
  assert.throws(() => identity.signIn('editor@example.com', 'a secure password'), { code: 'credentials-invalid' });
  assert.ok(identity.signIn('editor@example.com', 'a different secure password').accessToken);
  time += 31 * 60_000;
  assert.throws(() => identity.completeRecovery(recoveryToken, 'another secure password'), { code: 'recovery-token-invalid' });
});

test('teams, invitations and project roles enforce every resource boundary', () => {
  const access = createAccessControl(); const owner = 'user-owner'; const editor = 'user-editor'; const viewer = 'user-viewer';
  const team = access.createTeam(owner, 'Post team');
  const editorInvite = access.invite(owner, team.id, 'editor@example.com', 'editor');
  access.acceptInvitation(editorInvite.token, editor, 'editor@example.com');
  const viewerInvite = access.invite(owner, team.id, 'viewer@example.com', 'viewer');
  access.acceptInvitation(viewerInvite.token, viewer, 'viewer@example.com');
  access.registerProject(owner, 'project-1', team.id);
  access.setProjectRole(owner, 'project-1', editor, 'editor'); access.setProjectRole(owner, 'project-1', viewer, 'viewer');
  assert.equal(access.authorize(editor, { projectId: 'project-1', resource: 'revision', action: 'write' }).allowed, true);
  assert.throws(() => access.authorize(viewer, { projectId: 'project-1', resource: 'asset', action: 'write' }), { code: 'forbidden' });
  assert.throws(() => access.authorize('outsider', { projectId: 'project-1', resource: 'project', action: 'read' }), { code: 'forbidden' });
});

test('authorized history wrapper checks writes, reads, assets, rate limits and audit trail', () => {
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'project-1', name: 'Film' });
  const identity = createIdentityService(); const owner = identity.createAccount('owner@example.com', 'authorization password');
  const outsider = identity.createAccount('outsider@example.com', 'authorization password');
  const ownerSession = identity.signIn('owner@example.com', 'authorization password');
  const outsiderSession = identity.signIn('outsider@example.com', 'authorization password');
  const access = createAccessControl(); const team = access.createTeam(owner.id, 'Team');
  access.registerProject(owner.id, 'project-1', team.id);
  const audit = createAuditTrail(); const rateLimit = createRateLimiter({ limit: 20 });
  const service = createAuthorizedProjectService({ history, access, identity, audit, rateLimit });
  const context = { accessToken: ownerSession.accessToken, requestId: 'request-1' };
  const manifest = service.putManifest(context, 'project-1', { schemaVersion: 1 });
  const revision = service.createRevision(context, { projectId: 'project-1', manifestId: manifest.id, message: 'Save' });
  service.updateBranch(context, { projectId: 'project-1', branch: 'main', expectedRevisionId: null, revisionId: revision.id });
  assert.equal(service.getBranch(context, 'project-1', 'main').revisionId, revision.id);
  assert.equal(service.authorizeAsset(context, 'project-1').allowed, true);
  assert.throws(() => service.listRevisions({ accessToken: outsiderSession.accessToken, requestId: 'request-2' }, 'project-1'), { code: 'forbidden' });
  assert.throws(() => service.listRevisions({ accessToken: 'forged', requestId: 'request-3' }, 'project-1'), { code: 'access-token-invalid' });
  assert.equal(audit.verify(), true); assert.equal(audit.list().length, 6);
});

test('credential vault encrypts at rest, rotates, and is absent from renderer preload', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'credential-vault-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let generation = 1;
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`${generation}:${Buffer.from(value).toString('base64')}`),
    decryptString: bytes => Buffer.from(bytes.toString().split(':')[1], 'base64').toString('utf8') };
  const vault = createCredentialVault({ directory, safeStorage });
  await vault.set('refresh-token', 'private-token-value');
  const before = await fs.readFile(path.join(directory, 'credentials.enc.json'), 'utf8');
  assert.doesNotMatch(before, /private-token-value/); assert.equal(await vault.get('refresh-token'), 'private-token-value');
  generation = 2; assert.equal((await vault.rotate()).rotated, 1);
  const after = await fs.readFile(path.join(directory, 'credentials.enc.json'), 'utf8');
  assert.notEqual(after, before); assert.equal(await vault.get('refresh-token'), 'private-token-value');
  assert.doesNotMatch(await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8'), /credential|token/i);
});

test('HTTPS, authenticated encryption, rate limits and account deletion fail closed', async () => {
  assert.equal(requireSecureTransport('https://api.example.test/v1').secure, true);
  assert.throws(() => requireSecureTransport('http://api.example.test'), { code: 'secure-transport-required' });
  const oldKey = Buffer.alloc(32, 1), newKey = Buffer.alloc(32, 2);
  const oldRing = createKeyring({ old: oldKey }, 'old'); const record = oldRing.encrypt({ secret: 'value' });
  const newRing = createKeyring({ old: oldKey, current: newKey }, 'current');
  const rotated = newRing.rotate(record); assert.equal(rotated.keyId, 'current'); assert.deepEqual(newRing.decrypt(rotated), { secret: 'value' });
  const limited = createRateLimiter({ limit: 1 }); limited('user:sign-in');
  assert.throws(() => limited('user:sign-in'), { code: 'rate-limit-exceeded' });
  const identity = createIdentityService(); const user = identity.createAccount('delete@example.com', 'deletion password');
  const access = createAccessControl(); const audit = createAuditTrail();
  await deleteAccountFlow({ userId: user.id, password: 'deletion password', identity, access, audit, requestId: 'delete-1' });
  assert.equal(identity.getUser(user.id).status, 'deleted'); assert.equal(audit.verify(), true);
});

test('account deletion refuses to orphan teams or projects', async () => {
  const identity = createIdentityService(); const owner = identity.createAccount('owner@example.com', 'ownership password');
  const access = createAccessControl(); const team = access.createTeam(owner.id, 'Owned team');
  access.registerProject(owner.id, 'owned-project', team.id); const audit = createAuditTrail();
  assert.equal(access.accountRemovalPlan(owner.id).ready, false);
  await assert.rejects(deleteAccountFlow({ userId: owner.id, password: 'ownership password', identity,
    access, audit, requestId: 'delete-2' }), { code: 'ownership-transfer-required' });
  assert.equal(identity.getUser(owner.id).status, 'active');
});
