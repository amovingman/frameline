'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDurableCollaborationService, validateCollaborationState } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { fingerprint } = require('../src/project-api-contracts');
const { manifestStorageKey } = require('../src/cloud-history-store');
const master = Buffer.alloc(32, 3), current = Buffer.alloc(32, 4);
const ring = () => createKeyring({ old: master }, 'old');
const password = 'disposable durable password';
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-durable-test-')));
  const services = [];
  t.after(async () => { for (const value of services) await value.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const open = async extra => {
    const value = await createDurableCollaborationService({ directory, keyring: ring(), ...options, ...extra }); services.push(value); return value;
  };
  const runtime = await open({ initialize: true });
  const user = await runtime.identity.createAccount('owner@disposable.example.test', password);
  const session = await runtime.identity.signIn(user.email, password);
  const context = { accessToken: session.accessToken, requestId: 'durable-test' };
  const filename = path.join(directory, 'collaboration.enc.json');
  const state = async () => ring().decrypt(JSON.parse(await fs.readFile(filename, 'utf8')).record);
  return { directory, filename, runtime, user, session, context, open, state };
}
async function project(value) {
  const team = await value.runtime.teams.create(value.context, 'Disposable team');
  await value.runtime.projects.create(value.context, { projectId: 'film', name: 'Film', teamId: team.id, idempotencyKey: 'film-create' });
  return team;
}
const manifest = () => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
  sourceHash: 'a'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });

test('combined encrypted state survives fresh instances and merges concurrent local writers without plaintext credentials', async t => {
  const value = await fixture(t); await project(value);
  const second = await value.open();
  await Promise.all([value.runtime.identity.createAccount('one@disposable.example.test', password),
    second.identity.createAccount('two@disposable.example.test', password)]);
  assert.equal((await value.state()).identity.users.length, 3);
  const duplicate = await Promise.allSettled([value.runtime.identity.createAccount('race@disposable.example.test', password),
    second.identity.createAccount('race@disposable.example.test', password)]);
  assert.equal(duplicate.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(duplicate.find(v => v.status === 'rejected').reason.code, 'account-exists');
  await value.runtime.close();
  assert.equal((await second.service.getBranch(value.context, 'film', 'main')).revisionId, null);
  assert.equal((await second.identity.authenticate(value.session.accessToken)).userId, value.user.id);
  const encoded = await fs.readFile(value.filename, 'utf8');
  for (const secret of [password, value.user.email, value.session.accessToken, value.session.refreshToken, master.toString('base64')]) assert(!encoded.includes(secret));
  assert.equal((await fs.stat(value.filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(value.directory)).mode & 0o777, 0o700);
  await assert.rejects(value.runtime.getStatus(), { code: 'collaboration-service-closed' });
});

test('domain and authorization failures do not publish partial project or permission state', async t => {
  const value = await fixture(t), before = await fs.readFile(value.filename);
  await assert.rejects(value.runtime.projects.create(value.context, { projectId: 'orphan', name: 'Orphan', teamId: 'absent' }), { code: 'project-access-invalid' });
  assert.deepEqual(await fs.readFile(value.filename), before);
  const team = await project(value), valid = await fs.readFile(value.filename);
  await assert.rejects(value.runtime.projects.create(value.context, { projectId: 'unsafe', name: '/private/source', teamId: team.id }), { code: 'collaboration-state-invalid' });
  await assert.rejects(value.runtime.service.getBranch({ accessToken: 'forged', requestId: 'denied' }, 'film', 'main'), { code: 'access-token-invalid' });
  assert.deepEqual(await fs.readFile(value.filename), valid);
  assert(!Object.hasOwn((await value.state()).history.projects, 'orphan'));
});

test('refresh, sign-out and recovery changes are durable and recovery delivery follows committed hashed state', async t => {
  let delivery;
  const value = await fixture(t, { deliverRecovery: message => { delivery = message; } });
  const rotated = await value.runtime.identity.refresh(value.session.refreshToken);
  const second = await value.open();
  await assert.rejects(second.identity.authenticate(value.session.accessToken), { code: 'access-token-invalid' });
  await second.identity.signOut(rotated.refreshToken);
  await assert.rejects(value.runtime.identity.authenticate(rotated.accessToken), { code: 'access-token-invalid' });
  await value.runtime.identity.beginRecovery(value.user.email); assert(delivery?.token);
  const state = await value.state(); assert.equal(state.identity.recoveries.length, 1);
  assert(!JSON.stringify(state).includes(delivery.token));
  await second.identity.completeRecovery(delivery.token, 'a changed disposable password');
  await assert.rejects(value.runtime.identity.signIn(value.user.email, password), { code: 'credentials-invalid' });
  await assert.rejects(value.runtime.identity.completeRecovery(delivery.token, password), { code: 'recovery-token-invalid' });
  assert((await value.runtime.identity.signIn(value.user.email, 'a changed disposable password')).accessToken);
});

test('a stalled recovery delivery does not hold transaction serialization or shutdown', async t => {
  let attempted = false;
  const value = await fixture(t, { deliverRecovery: () => { attempted = true; return new Promise(() => {}); } });
  let rejectDeadline; const deadline = new Promise((_resolve, reject) => { rejectDeadline = setTimeout(() => reject(new Error('recovery delivery stalled service')), 500); });
  t.after(() => clearTimeout(rejectDeadline));
  await Promise.race([(async () => {
    await value.runtime.identity.beginRecovery(value.user.email);
    assert(attempted); assert((await value.runtime.getStatus()).generation > 0); await value.runtime.close();
  })(), deadline]);
});

test('pre-publication IO failure leaves the old file intact and the failed mutation can be retried', async t => {
  let failSync = false;
  const storage = { ...fs, open: async (filename, ...args) => {
    const handle = await fs.open(filename, ...args);
    if (!String(filename).includes('.collaboration-')) return handle;
    return { writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle), sync: async () => {
      if (failSync) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); await handle.sync();
    } };
  } };
  const value = await fixture(t, { storage }), before = await fs.readFile(value.filename); failSync = true;
  await assert.rejects(value.runtime.identity.createAccount('retry@disposable.example.test', password), { code: 'collaboration-storage-unavailable' });
  assert.deepEqual(await fs.readFile(value.filename), before); failSync = false;
  assert((await value.runtime.identity.createAccount('retry@disposable.example.test', password)).id);
});

test('ambiguous rename and directory-sync failures latch the service until a fresh validated reopen', async t => {
  for (const phase of ['rename', 'directory-sync']) await t.test(phase, async t => {
    let failing = false, directory;
    const storage = { ...fs, rename: async (...args) => {
      await fs.rename(...args); if (failing && phase === 'rename') throw Object.assign(new Error('fixture uncertain rename'), { code: 'EIO' });
    }, open: async (filename, ...args) => {
      const handle = await fs.open(filename, ...args);
      if (String(filename) !== directory) return handle;
      return { close: handle.close.bind(handle), sync: async () => {
        if (failing && phase === 'directory-sync') throw Object.assign(new Error('fixture uncertain sync'), { code: 'EIO' }); await handle.sync();
      } };
    } };
    const value = await fixture(t, { storage }); directory = value.directory; failing = true;
    await assert.rejects(value.runtime.identity.createAccount('committed@disposable.example.test', password), { code: 'collaboration-storage-uncertain' });
    await assert.rejects(value.runtime.getStatus(), { code: 'collaboration-storage-uncertain' });
    const recovered = await value.open({ storage: fs });
    assert((await recovered.identity.signIn('committed@disposable.example.test', password)).accessToken);
  });
});

test('key rotation validates provider output before replacement and stale active keys cannot silently revert it', async t => {
  const value = await fixture(t), bothOld = createKeyring({ old: master, current }, 'old');
  const stale = await value.open({ keyring: bothOld }), original = await fs.readFile(value.filename);
  for (const bad of [createKeyring({ 'invalid/key': current }, 'invalid/key'),
    { encrypt: ring().encrypt, decrypt: () => ({ bad: true }) },
    { encrypt: state => { state.identity.users = []; state.identity.sessions = []; return ring().encrypt(state); }, decrypt: ring().decrypt }]) {
    await assert.rejects(value.runtime.rotateEncryption(bad), { code: 'collaboration-storage-unavailable' });
    assert.deepEqual(await fs.readFile(value.filename), original);
  }
  const next = createKeyring({ old: master, current }, 'current'); await value.runtime.rotateEncryption(next);
  assert.equal(JSON.parse(await fs.readFile(value.filename, 'utf8')).record.keyId, 'current');
  await assert.rejects(stale.identity.createAccount('stale@disposable.example.test', password), { code: 'collaboration-key-rotation-required' });
  assert.equal(JSON.parse(await fs.readFile(value.filename, 'utf8')).record.keyId, 'current');
  await assert.rejects(value.open(), { code: 'collaboration-state-invalid' });
  const fresh = await value.open({ keyring: next });
  assert.equal((await fresh.identity.authenticate(value.session.accessToken)).userId, value.user.id);
});

test('strict combined validation rejects dangling references, cyclic history and hidden fields', async t => {
  const value = await fixture(t); await project(value);
  const stored = await value.runtime.service.putManifest(value.context, 'film', manifest());
  const revision = await value.runtime.service.createRevision(value.context, { projectId: 'film', manifestId: stored.id,
    message: 'Initial cut', sourceRevisionId: 'local-first', idempotencyKey: 'first-revision' });
  await value.runtime.service.updateBranch(value.context, { projectId: 'film', branch: 'main', expectedRevisionId: null,
    revisionId: revision.id, idempotencyKey: 'advance-first' });
  const state = await value.state(); assert.deepEqual(validateCollaborationState(state), state);
  const change = fn => { const altered = structuredClone(state); fn(altered); return altered; };
  for (const altered of [change(s => { s.access.teams[0].members[0].userId = 'missing-user'; }),
    change(s => { s.history.revisions[revision.id].authorId = 'missing-user'; }),
    change(s => { s.history.revisions[revision.id].parentRevisionId = revision.id; }),
    change(s => { s.history.projects.film.branches.main = 'missing-revision'; }),
    change(s => { s.history.manifests[manifestStorageKey('film', stored.id)].projectId = 'constructor'; }),
    change(s => { s.history.revisions[revision.id].rawToken = 'private'; }),
    change(s => { s.history.projects.extra = { ...s.history.projects.film, id: 'extra' }; })]) {
    assert.throws(() => validateCollaborationState(altered), { code: 'collaboration-state-invalid' });
  }
  assert.throws(() => validateCollaborationState({ ...state, schemaVersion: 5 }), { code: 'collaboration-state-newer-version' });
  assert.equal(fingerprint(await value.state()), fingerprint(state));
});

test('tampered ciphertext, outer generation, symlinks and broad file permissions are refused without overwriting evidence', async t => {
  const value = await fixture(t), valid = await fs.readFile(value.filename);
  const file = JSON.parse(valid);
  for (const corrupted of [{ ...file, generation: file.generation + 1 },
    { ...file, record: { ...file.record, tag: Buffer.alloc(16).toString('base64') } }]) {
    const bytes = Buffer.from(JSON.stringify(corrupted)); await fs.writeFile(value.filename, bytes);
    await assert.rejects(value.open(), { code: 'collaboration-state-invalid' });
    assert.deepEqual(await fs.readFile(value.filename), bytes);
  }
  await fs.writeFile(value.filename, valid); await fs.chmod(value.filename, 0o644);
  await assert.rejects(value.open(), { code: 'collaboration-state-invalid' }); await fs.chmod(value.filename, 0o600);
  const target = path.join(value.directory, 'retained.enc.json'); await fs.rename(value.filename, target); await fs.symlink(target, value.filename);
  await assert.rejects(value.open(), { code: 'collaboration-state-invalid' }); assert.deepEqual(await fs.readFile(target), valid);
  await fs.unlink(value.filename); await fs.rename(target, value.filename);
});

test('missing state is never silently reset by an existing runtime or ordinary reopen', async t => {
  const value = await fixture(t), bytes = await fs.readFile(value.filename); await fs.unlink(value.filename);
  await assert.rejects(value.runtime.identity.createAccount('reset@disposable.example.test', password), { code: 'collaboration-state-invalid' });
  await assert.rejects(value.open(), { code: 'collaboration-state-invalid' });
  await assert.rejects(fs.access(value.filename), { code: 'ENOENT' });
  await fs.writeFile(value.filename, bytes, { mode: 0o600 });
});

test('account deletion atomically retains historical tombstones without granting a reused email its old role', async t => {
  const value = await fixture(t), team = await project(value);
  const successor = await value.runtime.identity.createAccount('successor@disposable.example.test', password);
  const successorSession = await value.runtime.identity.signIn(successor.email, password);
  const successorContext = { accessToken: successorSession.accessToken, requestId: 'successor' };
  const invitation = await value.runtime.teams.invite(value.context, team.id, successor.email, 'owner');
  await value.runtime.members.accept(successorContext, invitation.token);
  await value.runtime.projects.delete(value.context, 'film');
  await value.runtime.identity.deleteAccount(value.context, password);
  const reopened = await value.open();
  await assert.rejects(reopened.identity.authenticate(value.session.accessToken), { code: 'access-token-invalid' });
  assert.equal((await reopened.identity.getUser(value.user.id)).status, 'deleted');
  const reuse = await reopened.identity.createAccount(value.user.email, password); assert.notEqual(reuse.id, value.user.id);
  const reusedSession = await reopened.identity.signIn(value.user.email, password);
  await assert.rejects(reopened.service.getBranch({ accessToken: reusedSession.accessToken, requestId: 'reuse' }, 'film', 'main'), { code: 'forbidden' });
  const state = await value.state();
  assert.equal(state.access.projects[0].roles.find(member => member.userId === value.user.id).role, 'owner');
  assert.equal(state.access.teams[0].members.find(member => member.userId === value.user.id).role, 'viewer');
});

test('identical manifest content has independent project references through durable reopen', async t => {
  const value = await fixture(t), team = await project(value);
  await value.runtime.projects.create(value.context, { projectId: 'second-film', name: 'Second film', teamId: team.id });
  const first = await value.runtime.service.putManifest(value.context, 'film', manifest());
  const second = await value.runtime.service.putManifest(value.context, 'second-film', manifest());
  assert.equal(first.id, second.id);
  for (const projectId of ['film', 'second-film']) {
    const revision = await value.runtime.service.createRevision(value.context, { projectId, manifestId: first.id,
      sourceRevisionId: `source-${projectId}`, message: 'Identical content', idempotencyKey: `revision-${projectId}` });
    await value.runtime.service.updateBranch(value.context, { projectId, branch: 'main', expectedRevisionId: null,
      revisionId: revision.id, idempotencyKey: `branch-${projectId}` });
  }
  const reopened = await value.open(), state = await value.state();
  assert.equal(state.history.schemaVersion, 3); assert.equal(Object.keys(state.history.manifests).length, 2);
  for (const projectId of ['film', 'second-film']) {
    assert.equal((await reopened.service.getManifest(value.context, projectId, first.id)).projectId, projectId);
    assert((await reopened.service.getBranch(value.context, projectId, 'main')).revisionId);
  }
});

test('encrypted legacy history migrates its scoped references atomically once without changing recorded idempotency', async t => {
  const value = await fixture(t); await project(value);
  const stored = await value.runtime.service.putManifest(value.context, 'film', manifest());
  const revision = await value.runtime.service.createRevision(value.context, { projectId: 'film', manifestId: stored.id,
    message: 'Legacy cut', sourceRevisionId: 'legacy-source', idempotencyKey: 'legacy-revision' });
  await value.runtime.service.updateBranch(value.context, { projectId: 'film', branch: 'main', expectedRevisionId: null,
    revisionId: revision.id, idempotencyKey: 'legacy-branch' });
  const legacy = await value.state(), generation = legacy.generation;
  legacy.history = { ...legacy.history, schemaVersion: 2,
    manifests: Object.fromEntries(Object.values(legacy.history.manifests).map(item => [item.id, item])) };
  const priorIdempotency = structuredClone(legacy.history.idempotency);
  await fs.writeFile(value.filename, JSON.stringify({ schemaVersion: 1, generation, record: ring().encrypt(legacy) }));
  const reopened = await value.open(), migrated = await value.state();
  assert.equal(migrated.generation, generation + 1); assert.equal(migrated.history.schemaVersion, 3);
  assert.deepEqual(migrated.history.idempotency, priorIdempotency);
  assert.equal((await reopened.service.getBranch(value.context, 'film', 'main')).revisionId, revision.id);
  const retried = await reopened.service.createRevision(value.context, { projectId: 'film', manifestId: stored.id,
    message: 'Legacy cut', sourceRevisionId: 'legacy-source', idempotencyKey: 'legacy-revision' });
  assert.equal(retried.id, revision.id);
  const again = await value.open(); assert.equal((await again.getStatus()).generation, generation + 1);
});
