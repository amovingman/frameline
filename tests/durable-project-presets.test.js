'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { createDurableCollaborationService, validateCollaborationState } = require('../src/durable-collaboration-service');

const snapshot = { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'immutable-resolve-project', project_name: 'Legacy film',
  timelines: [{ id: 'timeline', name: 'Cut', start_frame: 0, tracks: [{ type: 'video', index: 1, name: 'V1' }],
    items: [{ id: 'clip', track_type: 'video', track_index: 1, type: 'video', name: 'Observed clip', start_frame: 0, end_frame: 10,
      source_start_frame: 0, source_end_frame: 10, media_pool_id: 'media', linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }] }] };

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'durable-presets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  const opts = { directory, keyring, now: () => 1000, assetPolicyDefaultsEnabled: true, notificationDeliveryAvailable: true, ...extra };
  let runtime = await createDurableCollaborationService({ ...opts, initialize: true });
  t.after(() => runtime.close());
  const users = {};
  for (const role of ['owner', 'coowner', 'editor']) {
    const email = `${role}@durable-presets.example.test`, password = `${role} fixture password`;
    users[role] = { ...await runtime.identity.createAccount(email, password), password,
      context: { accessToken: (await runtime.identity.signIn(email, password)).accessToken } };
  }
  const team = await runtime.teams.create(users.owner.context, 'Editing / équipe');
  for (const role of ['coowner', 'editor']) {
    const invitation = await runtime.teams.invite(users.owner.context, team.id, users[role].email, role === 'coowner' ? 'owner' : 'editor');
    await runtime.members.accept(users[role].context, invitation.token);
  }
  await runtime.projects.create(users.owner.context, { projectId: 'legacy', name: 'Existing film', teamId: team.id });
  await runtime.members.setRole(users.owner.context, 'legacy', users.editor.id, 'editor');
  const stored = await runtime.service.putManifest(users.owner.context, 'legacy', createResolveRevisionManifest(snapshot));
  const base = await runtime.service.createRevision(users.owner.context, { projectId: 'legacy', manifestId: stored.id,
    message: 'Existing captured root', sourceRevisionId: 'existing-root', idempotencyKey: 'existing-root' });
  await runtime.service.updateBranch(users.owner.context, { projectId: 'legacy', branch: 'main', expectedRevisionId: null,
    revisionId: base.id, idempotencyKey: 'existing-root-head' });
  const filename = path.join(directory, 'collaboration.enc.json');
  return {
    opts, users, team, keyring, filename, base, stored,
    get runtime() { return runtime; },
    save(key = 'save', changes = {}) { return runtime.service.saveProjectPreset(users.owner.context, {
      teamId: team.id, presetId: null, expectedVersion: 0, name: 'Documentary', branches: ['edit', 'review'],
      syncClasses: ['audio', 'proxy'], idempotencyKey: key, ...changes
    }); },
    async intent(preset, projectName = 'New preset project', role = 'owner') {
      const input = { teamId: team.id, presetId: preset.id, expectedVersion: preset.version, projectName };
      const plan = await runtime.service.previewProjectFromPreset(users[role].context, input);
      return { ...input, planId: plan.planId, idempotencyKey: 'create' };
    },
    async state() { return keyring.decrypt(JSON.parse(await fs.readFile(filename)).record); },
    async writeState(state) {
      const file = JSON.parse(await fs.readFile(filename));
      file.record = keyring.encrypt(state);
      await fs.writeFile(filename, JSON.stringify(file));
    },
    async reopen(changes = {}) {
      await runtime.close();
      runtime = await createDurableCollaborationService({ ...opts, ...changes });
    }
  };
}

test('team authorization is independent of project ownership and retries recheck current authenticated team membership', async t => {
  const f = await fixture(t), preset = await f.save();
  await f.runtime.members.transferOwnership(f.users.owner.context, 'legacy', f.users.editor.id);
  assert.equal((await f.runtime.projects.list(f.users.editor.context)).projects[0].role, 'owner');
  await assert.rejects(f.runtime.service.saveProjectPreset(f.users.editor.context, {
    teamId: f.team.id, presetId: null, expectedVersion: 0, name: 'Denied', branches: [], syncClasses: [], idempotencyKey: 'denied'
  }), { code: 'preset-forbidden' });
  assert.equal((await f.runtime.service.listProjectPresets(f.users.editor.context, f.team.id)).items[0].id, preset.id);
  const intent = await f.intent(preset, 'Coowner-created project', 'coowner');
  const created = await f.runtime.service.createProjectFromPreset(f.users.coowner.context, intent);
  await assert.rejects(f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, created.projectId), { code: 'forbidden' });
  assert.deepEqual(await f.runtime.projects.getInitialAssetPolicy(f.users.coowner.context, created.projectId), {
    projectId: created.projectId, version: 1, syncClasses: ['audio', 'proxy']
  });
  await f.runtime.identity.deleteAccount(f.users.owner.context, f.users.owner.password);
  await assert.rejects(f.save(), { code: 'access-token-invalid' });
});

test('one encrypted commit contains project access, every empty branch, media defaults and an immutable replayable receipt', async t => {
  const f = await fixture(t), preset = await f.save(), intent = await f.intent(preset);
  const created = await f.runtime.service.createProjectFromPreset(f.users.owner.context, intent);
  const state = await f.state();
  assert.equal(state.schemaVersion, 7);
  assert.deepEqual(state.history.projects[created.projectId].branches, { main: null, edit: null, review: null });
  assert.deepEqual(state.access.projects.find(project => project.id === created.projectId).roles, [{ userId: f.users.owner.id, role: 'owner' }]);
  assert.equal(state.projectPresets.creations[0].projectId, created.projectId);
  await f.reopen();
  assert.deepEqual(await f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), created);
  assert.equal((await f.state()).projectPresets.creations.length, 1);
  const changed = await f.save('update', { presetId: preset.id, expectedVersion: 1, branches: ['finish'], syncClasses: ['graphics'] });
  assert.equal(changed.version, 2);
  assert.deepEqual(await f.save(), preset);
  assert.deepEqual(await f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), created);
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.owner.context, { ...intent, idempotencyKey: 'new-stale' }), { code: 'preset-version-conflict' });
  assert.deepEqual((await f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, created.projectId)).syncClasses, ['audio', 'proxy']);
  await f.runtime.projects.delete(f.users.owner.context, created.projectId);
  await f.reopen();
  assert.deepEqual(await f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), created);
  assert.equal((await f.state()).access.projects.find(project => project.id === created.projectId).deletedAt, 1000);
  assert.equal((await f.runtime.projects.list(f.users.owner.context)).projects.some(project => project.id === created.projectId), false);
});

test('actor/name-bound previews and missing media service refuse creation without changing any project store', async t => {
  const f = await fixture(t, { assetPolicyDefaultsEnabled: false }), preset = await f.save();
  const intent = await f.intent(preset);
  const before = await fs.readFile(f.filename);
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), { code: 'preset-media-unavailable' });
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.coowner.context, intent), { code: 'preset-plan-stale' });
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.owner.context, { ...intent, projectName: 'Different' }), { code: 'preset-plan-stale' });
  assert.deepEqual(await fs.readFile(f.filename), before);
  const empty = await f.save('empty', { name: 'Metadata only', branches: [], syncClasses: [] });
  const created = await f.runtime.service.createProjectFromPreset(f.users.owner.context, await f.intent(empty));
  assert.deepEqual(created.branches, ['main']);
  assert.deepEqual(await f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, created.projectId), { projectId: created.projectId, version: 1, syncClasses: [] });
  assert.deepEqual(await f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, 'legacy'), { projectId: 'legacy', version: 0, syncClasses: [] });
});

test('concurrent exact intents merge to one project while competing template CAS preserves the winning version', async t => {
  const f = await fixture(t), preset = await f.save(), intent = await f.intent(preset);
  const other = await createDurableCollaborationService(f.opts);
  t.after(() => other.close());
  const results = await Promise.all([
    f.runtime.service.createProjectFromPreset(f.users.owner.context, intent),
    other.service.createProjectFromPreset(f.users.owner.context, intent)
  ]);
  assert.deepEqual(results[0], results[1]);
  const edits = await Promise.allSettled([
    f.save('edit-a', { presetId: preset.id, expectedVersion: 1, name: 'Cut A' }),
    other.service.saveProjectPreset(f.users.owner.context, { teamId: f.team.id, presetId: preset.id, expectedVersion: 1,
      name: 'Cut B', branches: ['edit'], syncClasses: [], idempotencyKey: 'edit-b' })
  ]);
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find(result => result.status === 'rejected').reason.code, 'preset-version-conflict');
  assert.equal((await f.state()).projectPresets.creations.length, 1);
});

test('cross-state validation rejects missing branches, wrong teams/users, altered receipts, private fields and downgrade', async t => {
  const f = await fixture(t), preset = await f.save();
  const created = await f.runtime.service.createProjectFromPreset(f.users.owner.context, await f.intent(preset));
  const state = await f.state();
  const edits = [
    value => { delete value.history.projects[created.projectId].branches.review; },
    value => { value.projectPresets.presets[0].createdBy = 'missing-user'; },
    value => { value.projectPresets.presets[0].teamId = 'missing-team'; },
    value => { value.projectPresets.creations[0].projectId = 'missing-project'; },
    value => { value.projectPresets.creations[0].template.syncClasses = []; },
    value => { value.projectPresets.saveReceipts[0].requestHash = '0'.repeat(64); },
    value => { value.projectPresets.creations[0].privatePath = '/Users/private'; },
    value => { value.schemaVersion = 6; },
    value => { value.schemaVersion = 8; }
  ];
  for (const edit of edits) {
    const copy = structuredClone(state);
    edit(copy);
    assert.throws(() => validateCollaborationState(copy));
  }
});

test('a failure before rename publishes no partial project; uncertain rename reopens to the original committed intent', async t => {
  let failing = false;
  const storage = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    if (!filename.endsWith('.tmp')) return handle;
    return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), async sync() {
      if (failing) throw new Error('disposable disk failure');
      await handle.sync();
    } };
  } };
  const f = await fixture(t, { storage }), preset = await f.save(), intent = await f.intent(preset);
  const before = await fs.readFile(f.filename);
  failing = true;
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), { code: 'collaboration-storage-unavailable' });
  assert.deepEqual(await fs.readFile(f.filename), before);
  failing = false;
  await f.reopen({ storage: { ...fs, async rename(from, to) { await fs.rename(from, to); throw new Error('uncertain'); } } });
  await assert.rejects(f.runtime.service.createProjectFromPreset(f.users.owner.context, intent), { code: 'collaboration-storage-uncertain' });
  await f.reopen({ storage: fs });
  const created = await f.runtime.service.createProjectFromPreset(f.users.owner.context, intent);
  assert.equal((await f.state()).projectPresets.creations.length, 1);
  assert.deepEqual(await f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, created.projectId), { projectId: created.projectId, version: 1, syncClasses: ['audio', 'proxy'] });
});

test('schema1..6 upgrade preserves original snapshots/IDs and adds empty templates without backfilling project defaults', async t => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const f = await fixture(t);
    const old = await f.state();
    old.schemaVersion = version;
    delete old.projectPresets;
    if (version < 6) delete old.notifications;
    if (version < 5) delete old.shareLinks;
    if (version < 4) delete old.branchProtection;
    if (version < 3) delete old.comments;
    if (version < 2) delete old.activity;
    await f.runtime.close();
    await f.writeState(old);
    await f.reopen();
    const current = await f.state();
    assert.equal(current.schemaVersion, 7);
    assert.equal(current.generation, old.generation + 1);
    for (const field of Object.keys(old).filter(key => !['schemaVersion', 'generation'].includes(key))) assert.deepEqual(current[field], old[field]);
    assert.deepEqual(current.projectPresets, { version: 1, presets: [], saveReceipts: [], creations: [] });
    assert.deepEqual(await f.runtime.projects.getInitialAssetPolicy(f.users.owner.context, 'legacy'), { projectId: 'legacy', version: 0, syncClasses: [] });
    const bytes = await fs.readFile(f.filename);
    await f.reopen();
    assert.deepEqual(await fs.readFile(f.filename), bytes);
  }
});
