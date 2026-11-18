const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { createDurableCollaborationService, validateCollaborationState } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { fingerprint } = require('../src/project-api-contracts');
const manifest = marker => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: marker.repeat(64),
  sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
async function fixture(t, extra = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-durable-activity-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture'); const opts = { directory, keyring, now: () => 1000, ...extra };
  let runtime = await createDurableCollaborationService({ ...opts, initialize: true }); t.after(() => runtime.close());
  const owner = await runtime.identity.createAccount('owner@example.test', 'owner fixture password'); const ownerContext = { accessToken: (await runtime.identity.signIn('owner@example.test', 'owner fixture password')).accessToken };
  const editor = await runtime.identity.createAccount('editor@example.test', 'editor fixture password'); const editorContext = { accessToken: (await runtime.identity.signIn('editor@example.test', 'editor fixture password')).accessToken };
  const team = await runtime.teams.create(ownerContext, 'Editors'); await runtime.projects.create(ownerContext, { projectId: 'film', name: 'Film', teamId: team.id });
  const invite = await runtime.members.invite(ownerContext, 'film', 'editor@example.test', 'editor'); await runtime.members.accept(editorContext, invite.token);
  const filename = path.join(directory, 'collaboration.enc.json');
  return { opts, keyring, filename, owner, editor, ownerContext, editorContext, get runtime() { return runtime; },
    async state() { return keyring.decrypt(JSON.parse(await fs.readFile(filename)).record); },
    async reopen(changes = {}) { await runtime.close(); runtime = await createDurableCollaborationService({ ...opts, ...changes }); return runtime; } };
}
async function revision(f, marker = 'a', key = 'create-a') {
  const stored = await f.runtime.service.putManifest(f.ownerContext, 'film', manifest(marker));
  const input = { projectId: 'film', manifestId: stored.id, authorId: 'ignored', message: 'Shared cut', sourceRevisionId: `source-${marker}`, idempotencyKey: key };
  return { input, value: await f.runtime.service.createRevision(f.ownerContext, input) };
}

test('revision, branch and membership events commit once with their mutations and persist recipient read receipts through hydrate', async t => {
  const f = await fixture(t); const created = await revision(f); await f.runtime.service.createRevision(f.ownerContext, created.input);
  const branch = { projectId: 'film', branch: 'main', expectedRevisionId: null, revisionId: created.value.id, idempotencyKey: 'advance-a' };
  await f.runtime.service.updateBranch(f.ownerContext, branch); await f.runtime.service.updateBranch(f.ownerContext, branch);
  const before = await f.runtime.service.listActivity(f.editorContext, 'film'); assert.deepEqual(before.items.map(item => item.type), ['branch.changed', 'revision.created', 'member.joined', 'member.invited']);
  assert.equal((await f.runtime.service.listNotifications(f.editorContext, 'film')).unreadCount, 2);
  await f.runtime.service.markNotificationRead(f.editorContext, 'film', before.items[0].id);
  await f.runtime.members.setRole(f.ownerContext, 'film', f.editor.id, 'editor'); assert.equal((await f.runtime.service.listActivity(f.editorContext, 'film')).items.length, 4);
  const state = await f.state(); await f.reopen();
  assert.deepEqual((await f.state()).activity, state.activity); assert.equal((await f.runtime.service.listNotifications(f.editorContext, 'film')).unreadCount, 1);
  await f.runtime.getStatus(); await f.runtime.identity.authenticate(f.ownerContext.accessToken); assert.deepEqual((await f.state()).activity, state.activity);
  await assert.rejects(f.runtime.service.markNotificationRead(f.ownerContext, 'film', before.items[0].id), { code: 'notification-not-found' });
  await f.runtime.members.setRole(f.ownerContext, 'film', f.editor.id, 'viewer');
  assert.equal((await f.runtime.service.listActivity(f.editorContext, 'film')).items[0].type, 'member.role-changed');
  await f.runtime.members.remove(f.ownerContext, 'film', f.editor.id);
  await assert.rejects(f.runtime.service.listNotifications(f.editorContext, 'film'), { code: 'forbidden' });
  await assert.rejects(f.runtime.service.markNotificationRead(f.editorContext, 'film', before.items[0].id), { code: 'forbidden' });
});

test('durable scoped pagination resumes through restart without same-millisecond gaps or exposing recipients', async t => {
  const f = await fixture(t); for (const marker of ['a', 'b', 'c']) await revision(f, marker, `create-${marker}`);
  const first = await f.runtime.service.listActivity(f.editorContext, 'film', { limit: 2 }); const firstInbox = await f.runtime.service.listNotifications(f.editorContext, 'film', { limit: 1 });
  await f.reopen(); const second = await f.runtime.service.listActivity(f.editorContext, 'film', { limit: 2, cursor: first.nextCursor });
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4);
  await assert.rejects(f.runtime.service.listActivity(f.ownerContext, 'film', { cursor: first.nextCursor }), { code: 'activity-cursor-invalid' });
  await assert.rejects(f.runtime.service.listNotifications(f.editorContext, 'film', { cursor: first.nextCursor }), { code: 'activity-cursor-invalid' });
  assert.equal((await f.runtime.service.listNotifications(f.editorContext, 'film', { limit: 1, cursor: firstInbox.nextCursor })).items.length, 1);
  assert.doesNotMatch(JSON.stringify({ first, second, firstInbox }), /recipientIds|previousHash|owner@example|editor@example|accessToken/);
});

test('a pre-publication write failure cannot persist history without its event or persist a read receipt', async t => {
  let failing = false; const storage = { ...fs, async open(filename, ...args) { const handle = await fs.open(filename, ...args);
    if (!filename.endsWith('.tmp')) return handle; return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() {
      if (failing) throw Object.assign(new Error('disk'), { code: 'EIO' }); return handle.sync(); } }; } };
  const f = await fixture(t, { storage }); const stored = await f.runtime.service.putManifest(f.ownerContext, 'film', manifest('a'));
  const input = { projectId: 'film', manifestId: stored.id, message: 'Atomic cut', sourceRevisionId: 'atomic-source', idempotencyKey: 'atomic-create' };
  const before = await fs.readFile(f.filename); failing = true;
  await assert.rejects(f.runtime.service.createRevision(f.ownerContext, input), { code: 'collaboration-storage-unavailable' }); assert.deepEqual(await fs.readFile(f.filename), before);
  failing = false; const result = await f.runtime.service.createRevision(f.ownerContext, input); const inbox = await f.runtime.service.listNotifications(f.editorContext, 'film'); assert.equal(inbox.items[0].subjectId, result.id);
  failing = true; await assert.rejects(f.runtime.service.markNotificationRead(f.editorContext, 'film', inbox.items[0].id), { code: 'collaboration-storage-unavailable' });
  failing = false; await f.reopen(); assert.equal((await f.runtime.service.listNotifications(f.editorContext, 'film')).items[0].read, false);
});

test('combined schema1 migration preserves credentials/history and adds empty activity atomically without replay', async t => {
  const f = await fixture(t); const created = await revision(f); const old = await f.state(); old.schemaVersion = 1; delete old.activity;
  await f.runtime.close(); const envelope = JSON.parse(await fs.readFile(f.filename)); envelope.record = f.keyring.encrypt(old); await fs.writeFile(f.filename, JSON.stringify(envelope));
  await f.reopen(); const migrated = await f.state(); assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.generation, old.generation + 1);
  for (const field of ['identity', 'access', 'history', 'paginationKey']) assert.deepEqual(migrated[field], old[field]);
  assert.deepEqual(migrated.activity, { version: 1, events: [], receipts: {} });
  assert.equal((await f.runtime.identity.authenticate(f.editorContext.accessToken)).userId, f.editor.id);
  assert.equal((await f.runtime.service.getRevision(f.editorContext, 'film', created.value.id)).id, created.value.id);
  await f.runtime.service.createRevision(f.ownerContext, created.input); assert.equal((await f.runtime.service.listActivity(f.editorContext, 'film')).items.length, 0);
  const bytes = await fs.readFile(f.filename); await f.reopen(); assert.deepEqual(await fs.readFile(f.filename), bytes);
});

test('failed and uncertain schema migration preserve evidence and recover without duplicated notifications', async t => {
  const f = await fixture(t); await revision(f); const old = await f.state(); old.schemaVersion = 1; delete old.activity;
  await f.runtime.close(); const envelope = JSON.parse(await fs.readFile(f.filename)); envelope.record = f.keyring.encrypt(old); const legacy = Buffer.from(JSON.stringify(envelope)); await fs.writeFile(f.filename, legacy);
  const failing = { ...fs, async open(filename, ...args) { const handle = await fs.open(filename, ...args); if (!filename.endsWith('.tmp')) return handle;
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() { throw new Error('disk'); } }; } };
  await assert.rejects(createDurableCollaborationService({ ...f.opts, storage: failing }), { code: 'collaboration-storage-unavailable' }); assert.deepEqual(await fs.readFile(f.filename), legacy);
  const uncertain = { ...fs, async rename(from, to) { await fs.rename(from, to); throw new Error('uncertain'); } };
  await assert.rejects(createDurableCollaborationService({ ...f.opts, storage: uncertain }), { code: 'collaboration-storage-uncertain' });
  await f.reopen(); assert.equal((await f.state()).generation, old.generation + 1); assert.equal((await f.runtime.service.listNotifications(f.editorContext, 'film')).unreadCount, 0);
});

test('combined activity cross-reference validation rejects unknown actors/projects/subjects and cross-recipient receipts', async t => {
  const f = await fixture(t); await revision(f); const state = await f.state();
  const edits = [value => { value.activity.events.at(-1).actorId = 'missing-user'; }, value => { value.activity.events.at(-1).projectId = 'missing-project'; },
    value => { value.activity.events.at(-1).subjectId = 'missing-revision'; }, value => { value.activity.receipts[`${f.owner.id}:${value.activity.events.at(-1).id}`] = true; },
    value => { value.activity.events.at(-1).privatePath = '/Users/private'; }];
  for (const edit of edits) { const value = structuredClone(state); edit(value); const item = value.activity.events.at(-1); item.hash = fingerprint(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'hash')));
    assert.throws(() => validateCollaborationState(value), { code: 'collaboration-state-invalid' }); }
});

test('replaying an old branch acknowledgment after another advance neither regresses history nor appends activity', async t => {
  const f = await fixture(t); const first = await revision(f); const old = { projectId: 'film', branch: 'main', expectedRevisionId: null, revisionId: first.value.id, idempotencyKey: 'old-branch' };
  await f.runtime.service.updateBranch(f.ownerContext, old);
  const stored = await f.runtime.service.putManifest(f.ownerContext, 'film', manifest('b'));
  const second = await f.runtime.service.createRevision(f.ownerContext, { projectId: 'film', manifestId: stored.id, parentRevisionId: first.value.id, sourceRevisionId: 'source-b', message: 'Second cut', idempotencyKey: 'second-revision' });
  await f.runtime.service.updateBranch(f.ownerContext, { projectId: 'film', branch: 'main', expectedRevisionId: first.value.id, revisionId: second.id, idempotencyKey: 'new-branch' });
  const before = await f.state(); const receipt = await f.runtime.service.updateBranch(f.ownerContext, old);
  assert.equal(receipt.revisionId, first.value.id); assert.equal((await f.runtime.service.getBranch(f.editorContext, 'film', 'main')).revisionId, second.id);
  assert.deepEqual((await f.state()).activity, before.activity);
});

test('activity capacity rolls back durable revision creation and account deletion with their permission changes', async t => {
  const { MAX_EVENTS } = require('../src/project-activity'); const { randomUUID } = require('node:crypto');
  const f = await fixture(t); const stored = await f.runtime.service.putManifest(f.ownerContext, 'film', manifest('a')); await f.runtime.close();
  const state = await f.state(); let previousHash = state.activity.events.at(-1).hash;
  while (state.activity.events.length < MAX_EVENTS) {
    const event = { id: randomUUID(), projectId: 'film', actorId: f.owner.id, type: 'branch.changed', subjectId: 'main', recipientIds: [], at: 1000, previousHash };
    event.hash = fingerprint(event); state.activity.events.push(event); previousHash = event.hash;
  }
  const envelope = JSON.parse(await fs.readFile(f.filename)); envelope.record = f.keyring.encrypt(state); await fs.writeFile(f.filename, JSON.stringify(envelope));
  await f.reopen(); const before = await fs.readFile(f.filename);
  await assert.rejects(f.runtime.service.createRevision(f.ownerContext, { projectId: 'film', manifestId: stored.id, message: 'Unreportable cut', idempotencyKey: 'capacity-revision' }), { code: 'activity-capacity-exceeded' });
  assert.deepEqual(await fs.readFile(f.filename), before); assert.equal(Object.keys((await f.state()).history.revisions).length, 0);
  await assert.rejects(f.runtime.identity.deleteAccount(f.editorContext, 'editor fixture password'), { code: 'activity-capacity-exceeded' });
  assert.deepEqual(await fs.readFile(f.filename), before);
  assert.equal((await f.runtime.identity.getUser(f.editor.id)).status, 'active');
  assert.equal((await f.runtime.identity.authenticate(f.editorContext.accessToken)).userId, f.editor.id);
  assert.equal((await f.state()).access.projects.find(project => project.id === 'film').roles.find(role => role.userId === f.editor.id).role, 'editor');
});

test('legacy colon-delimited opaque project and branch IDs remain writable after activity migration', async t => {
  const { createCloudHistoryStore } = require('../src/cloud-history-store');
  const f = await fixture(t); const state = await f.state(); const teamId = state.access.teams[0].id;
  await f.runtime.projects.create(f.ownerContext, { projectId: 'C:film', name: 'Colon film', teamId });
  const legacy = await f.state(); legacy.schemaVersion = 1; delete legacy.activity;
  const history = createCloudHistoryStore(legacy.history); history.createBranch('C:film', 'C:review'); legacy.history = history.snapshot();
  await f.runtime.close(); const envelope = JSON.parse(await fs.readFile(f.filename)); envelope.record = f.keyring.encrypt(legacy); await fs.writeFile(f.filename, JSON.stringify(envelope));
  await f.reopen(); const stored = await f.runtime.service.putManifest(f.ownerContext, 'C:film', manifest('b'));
  const created = await f.runtime.service.createRevision(f.ownerContext, { projectId: 'C:film', manifestId: stored.id, message: 'Opaque IDs', sourceRevisionId: 'C:source' });
  await f.runtime.service.updateBranch(f.ownerContext, { projectId: 'C:film', branch: 'C:review', expectedRevisionId: null, revisionId: created.id });
  const page = await f.runtime.service.listActivity(f.ownerContext, 'C:film');
  assert.deepEqual(page.items.map(item => item.type), ['branch.changed', 'revision.created']);
  assert.equal(page.items[0].subjectId, 'C:review'); assert.equal(page.projectId, 'C:film');
});

test('account deletion atomically records each actual membership removal and preserves deleted-project owner tombstones', async t => {
  const f = await fixture(t); const teamId = (await f.state()).access.teams[0].id;
  for (const [projectId, role] of [['deleted-owner-film', 'editor'], ['deleted-viewer-film', 'viewer']]) {
    await f.runtime.projects.create(f.ownerContext, { projectId, name: 'Retained project', teamId });
    const invitation = await f.runtime.members.invite(f.ownerContext, projectId, 'editor@example.test', role);
    await f.runtime.members.accept(f.editorContext, invitation.token);
  }
  await f.runtime.members.transferOwnership(f.ownerContext, 'deleted-owner-film', f.editor.id);
  await f.runtime.projects.delete(f.editorContext, 'deleted-owner-film');
  await f.runtime.projects.delete(f.ownerContext, 'deleted-viewer-film');
  const before = await f.state(); assert.equal(before.identity.users.find(user => user.id === f.editor.id).status, 'active');
  await f.runtime.identity.deleteAccount(f.editorContext, 'editor fixture password');
  const committed = await f.state(); assert.equal(validateCollaborationState(committed).schemaVersion, 2);
  const removal = (await f.runtime.service.listActivity(f.ownerContext, 'film')).items[0];
  assert.deepEqual(Object.keys(removal).sort(), ['id', 'projectId', 'actorId', 'type', 'subjectId', 'at'].sort());
  assert.equal(removal.type, 'member.removed'); assert.equal(removal.actorId, f.editor.id); assert.equal(removal.subjectId, f.editor.id);
  const inbox = await f.runtime.service.listNotifications(f.ownerContext, 'film'); assert.equal(inbox.items[0].id, removal.id); assert.equal(inbox.items[0].read, false);
  const removed = committed.activity.events.filter(event => event.type === 'member.removed' && event.actorId === f.editor.id);
  assert.deepEqual(removed.map(event => event.projectId).sort(), ['deleted-viewer-film', 'film']);
  assert.ok(removed.every(event => event.subjectId === f.editor.id && !event.recipientIds.includes(f.editor.id)));
  assert.equal(committed.access.projects.find(project => project.id === 'deleted-owner-film').roles.find(role => role.userId === f.editor.id).role, 'owner');
  assert.equal(committed.identity.users.find(user => user.id === f.editor.id).status, 'deleted');
  await assert.rejects(f.runtime.service.listNotifications(f.editorContext, 'film'), { code: 'access-token-invalid' });
  await assert.rejects(f.runtime.identity.deleteAccount(f.editorContext, 'editor fixture password'), { code: 'access-token-invalid' });
  await f.reopen(); assert.deepEqual((await f.state()).activity, committed.activity);
  assert.equal((await f.runtime.service.listNotifications(f.ownerContext, 'film')).items[0].id, removal.id);
  assert.doesNotMatch(JSON.stringify(removal), /editor@example|password|recipientIds|previousHash/);
});
