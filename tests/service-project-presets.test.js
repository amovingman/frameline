'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAccessControl } = require('../src/access-control');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createServiceProjectPresets, validateServiceProjectPresetsState, MAX_PRESETS, MAX_CREATIONS } = require('../src/service-project-presets');

function fixture({ mediaAvailable = true } = {}) {
  const active = new Set(['owner', 'coowner', 'editor', 'viewer', 'outsider']);
  const identity = { getUser: actorId => ({ id: actorId, status: active.has(actorId) ? 'active' : 'deleted' }) };
  const access = createAccessControl({ now: () => 1000 });
  const history = createCloudHistoryStore();
  const team = access.createTeam('owner', 'Editing / équipe');
  for (const actor of ['coowner', 'editor', 'viewer']) {
    const invitation = access.invite('owner', team.id, `${actor}@example.test`, actor === 'coowner' ? 'owner' : actor);
    access.acceptInvitation(invitation.token, actor, `${actor}@example.test`);
  }
  const opts = { identity, access, history, mediaAvailable, now: () => 1000 };
  const service = createServiceProjectPresets(opts);
  const save = (key = 'save', changes = {}) => service.save('owner', {
    teamId: team.id, presetId: null, expectedVersion: 0, name: 'Documentary',
    branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'], idempotencyKey: key, ...changes
  });
  function intent(preset, projectName = 'New project', actor = 'owner') {
    const input = { teamId: team.id, presetId: preset.id, expectedVersion: preset.version, projectName };
    return { ...input, planId: service.preview(actor, input).planId, idempotencyKey: 'create' };
  }
  return { active, access, history, team, opts, service, save, intent };
}

test('current team membership controls reads and team ownership, independently of project ownership, controls mutations', () => {
  const f = fixture();
  f.history.createProject({ projectId: 'legacy', name: 'Legacy project' });
  f.access.registerProject('owner', 'legacy', f.team.id);
  f.access.setProjectRole('owner', 'legacy', 'editor', 'editor');
  f.access.transferProjectOwnership('owner', 'legacy', 'editor');
  const preset = f.save();
  assert.equal(f.access.roleFor('editor', 'legacy'), 'owner');
  assert.equal(f.access.roleFor('coowner', 'legacy'), null);
  for (const actor of ['editor', 'viewer']) {
    assert.equal(f.service.list(actor, f.team.id).items[0].id, preset.id);
    assert.throws(() => f.service.save(actor, { teamId: f.team.id, presetId: null, expectedVersion: 0,
      name: 'Denied', branches: [], syncClasses: [], idempotencyKey: 'denied' }), { code: 'preset-forbidden' });
    assert.throws(() => f.service.preview(actor, { teamId: f.team.id, presetId: preset.id, expectedVersion: 1, projectName: 'Denied' }), { code: 'preset-forbidden' });
  }
  assert.equal(f.service.listTeams('outsider').teams.length, 0);
  assert.throws(() => f.service.list('outsider', f.team.id), { code: 'preset-forbidden' });
  const created = f.service.create('coowner', f.intent(preset, 'Coowner project', 'coowner'));
  assert.equal(f.access.roleFor('coowner', created.projectId), 'owner');
  assert.equal(f.access.roleFor('editor', created.projectId), null);
});

test('CAS updates and exact retries preserve historical results while no-op saves preserve the version', () => {
  const f = fixture(), first = f.save();
  const noOp = f.save('no-op', { presetId: first.id, expectedVersion: 1 });
  assert.deepEqual(noOp, first);
  const second = f.save('update', { presetId: first.id, expectedVersion: 1, name: 'Updated', branches: ['finish'], syncClasses: [] });
  assert.equal(second.version, 2);
  assert.deepEqual(f.save(), first);
  assert.throws(() => f.save('stale', { presetId: first.id, expectedVersion: 1 }), { code: 'preset-version-conflict' });
  assert.throws(() => f.save('save', { name: 'Changed duplicate' }), { code: 'preset-idempotency-conflict' });
  assert.equal(validateServiceProjectPresetsState(f.service.snapshot()).saveReceipts.length, 3);
  f.access.removeUser('owner');
  assert.throws(() => f.save(), { code: 'preset-forbidden' });
  f.active.delete('owner');
  assert.throws(() => f.service.listTeams('owner'), { code: 'preset-forbidden' });
});

test('plans bind actor, name and current immutable template version; creation preserves initial branches/classes', () => {
  const f = fixture(), preset = f.save(), input = f.intent(preset);
  assert.throws(() => f.service.create('coowner', { ...input, idempotencyKey: 'other-actor' }), { code: 'preset-plan-stale' });
  assert.throws(() => f.service.create('owner', { ...input, projectName: 'Changed', idempotencyKey: 'changed-name' }), { code: 'preset-plan-stale' });
  assert.equal(Object.keys(f.history.snapshot().projects).length, 0);
  const created = f.service.create('owner', input);
  assert.deepEqual(f.history.snapshot().projects[created.projectId].branches, { main: null, edit: null, review: null });
  assert.deepEqual(f.service.initialPolicy('owner', created.projectId), { projectId: created.projectId, version: 1, syncClasses: ['audio', 'proxy'] });
  f.save('next', { presetId: preset.id, expectedVersion: 1, branches: ['finish'], syncClasses: ['graphics'] });
  assert.deepEqual(f.service.create('owner', input), created);
  assert.throws(() => f.service.create('owner', { ...input, idempotencyKey: 'stale-plan' }), { code: 'preset-version-conflict' });
  assert.deepEqual(f.service.initialPolicy('owner', created.projectId).syncClasses, ['audio', 'proxy']);
  f.access.deleteProject('owner', created.projectId);
  assert.deepEqual(f.service.create('owner', input), created);
  assert.equal(f.access.isProjectDeleted(created.projectId), true);
  assert.throws(() => f.service.initialPolicy('owner', created.projectId), { code: 'forbidden' });
});

test('media-unavailable hosts refuse nonempty classes without changing project stores and permit metadata-only presets', () => {
  const f = fixture({ mediaAvailable: false }), preset = f.save();
  assert.equal(f.service.listTeams('owner').mediaAvailable, false);
  assert.throws(() => f.service.create('owner', f.intent(preset)), { code: 'preset-media-unavailable' });
  assert.equal(Object.keys(f.history.snapshot().projects).length, 0);
  assert.equal(f.access.snapshot().projects.length, 0);
  const empty = f.save('empty', { name: 'Metadata only', branches: [], syncClasses: [] });
  const created = f.service.create('owner', f.intent(empty));
  assert.deepEqual(created.branches, ['main']);
  assert.deepEqual(f.service.initialPolicy('owner', created.projectId), { projectId: created.projectId, version: 1, syncClasses: [] });
});

test('strict version-chain and creation imports reject missing transitions, changed template snapshots and private fields', () => {
  const f = fixture(), preset = f.save();
  f.service.create('owner', f.intent(preset));
  const state = f.service.snapshot();
  const edits = [
    value => { value.saveReceipts = []; },
    value => { value.presets[0].version = 2; },
    value => { value.saveReceipts[0].result.branches = ['finish']; },
    value => { value.creations[0].template.syncClasses = ['original']; },
    value => { value.creations[0].actorId = 'coowner'; },
    value => { value.creations[0].projectName = 'Different'; },
    value => { value.presets[0].privatePath = '/Users/private'; },
    value => { value.version = 2; }
  ];
  for (const edit of edits) {
    const copy = structuredClone(state);
    edit(copy);
    assert.throws(() => validateServiceProjectPresetsState(copy), { code: 'preset-state-invalid' });
  }
  const clone = f.service.snapshot();
  clone.presets[0].name = 'Mutated';
  assert.equal(f.service.snapshot().presets[0].name, preset.name);
});

test('bounded preset and creation capacity fails without minting another project or changing historical receipts', () => {
  const f = fixture();
  for (let index = 0; index < MAX_PRESETS; index++) f.save(`preset-${index}`, { name: `Preset ${index}` });
  assert.throws(() => f.save('overflow'), { code: 'preset-capacity' });
  const g = fixture(), preset = g.save(), input = g.intent(preset), created = g.service.create('owner', input);
  const state = g.service.snapshot(), seed = state.creations[0];
  for (let index = 1; index < MAX_CREATIONS; index++) state.creations.push({ ...structuredClone(seed), projectId: `project-${index}`,
    keyHash: createHash('sha256').update(`creation-key-${index}`).digest('hex') });
  const full = createServiceProjectPresets({ ...g.opts, initialState: state });
  const before = g.history.snapshot();
  assert.throws(() => full.create('owner', { ...input, idempotencyKey: 'overflow' }), { code: 'preset-capacity' });
  assert.deepEqual(g.history.snapshot(), before);
  assert.deepEqual(full.create('owner', input), created);
});
