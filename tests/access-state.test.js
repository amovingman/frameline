'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAccessControl, validateAccessState } = require('../src/access-control');

function setup() {
  let now = 0;
  const access = createAccessControl({ now: () => now, invitationTtlMs: 1000 });
  const team = access.createTeam('user-owner', 'Post team');
  access.registerProject('user-owner', 'project-film', team.id);
  return { access, team, setTime(value) { now = value; }, getTime: () => now };
}
function member(access, email, userId, role = 'editor') {
  const invitation = access.inviteProject('user-owner', 'project-film', email, role);
  access.acceptInvitation(invitation.token, userId, email); return invitation;
}

test('private snapshot restarts membership, ownership transfers, removals and project tombstones', () => {
  const { access, team, setTime } = setup();
  member(access, 'editor@example.test', 'user-editor');
  member(access, 'viewer@example.test', 'user-viewer', 'viewer');
  access.transferProjectOwnership('user-owner', 'project-film', 'user-editor');
  access.removeProjectMember('user-editor', 'project-film', 'user-viewer');
  const pending = access.inviteProject('user-editor', 'project-film', 'future@example.test', 'viewer');
  setTime(30); access.deleteProject('user-editor', 'project-film');
  const snapshot = access.snapshot();
  const restored = createAccessControl({ initialState: JSON.parse(JSON.stringify(snapshot)), now: () => 31 });
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(restored.isProjectDeleted('project-film'), true);
  assert.equal(restored.roleFor('user-editor', 'project-film'), null);
  assert.throws(() => restored.authorize('user-editor', { projectId: 'project-film', resource: 'revision', action: 'read' }), { code: 'forbidden' });
  assert.throws(() => restored.acceptInvitation(pending.token, 'user-future', 'future@example.test'), { code: 'invitation-invalid' });
  assert.deepEqual(snapshot.projects[0], { id: 'project-film', teamId: team.id,
    roles: [{ userId: 'user-owner', role: 'editor' }, { userId: 'user-editor', role: 'owner' }], deletedAt: 30 });
});

test('invitation bearer is absent from snapshots while digest acceptance, expiry and replay protection survive restart', () => {
  const { access, getTime, setTime } = setup();
  const pending = access.inviteProject('user-owner', 'project-film', 'Editor@example.test', 'editor');
  const teamInvite = access.invite('user-owner', access.snapshot().teams[0].id, 'another@example.test', 'owner');
  const snapshot = access.snapshot(); const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, new RegExp(pending.token));
  assert.doesNotMatch(serialized, new RegExp(teamInvite.token));
  assert.equal(snapshot.invitations[0].digest, createHash('sha256').update(pending.token).digest('hex'));
  let restored = createAccessControl({ initialState: snapshot, now: getTime });
  restored.acceptInvitation(pending.token, 'user-editor', 'editor@example.test');
  // Zero is a valid accepted timestamp and must not become pending on restart.
  assert.equal(restored.snapshot().invitations[0].acceptedAt, 0);
  assert.equal(restored.listProjectInvitations('user-owner', 'project-film')[0].status, 'accepted');
  assert.throws(() => restored.acceptInvitation(pending.token, 'user-editor', 'editor@example.test'), { code: 'invitation-invalid' });
  // The used invite no longer blocks a replacement invitation at clock zero.
  restored.inviteProject('user-owner', 'project-film', 'editor@example.test', 'viewer');
  restored = createAccessControl({ initialState: restored.snapshot(), now: getTime });
  assert.throws(() => restored.acceptInvitation(pending.token, 'user-editor', 'editor@example.test'), { code: 'invitation-invalid' });
  setTime(1000);
  assert.throws(() => restored.acceptInvitation(teamInvite.token, 'user-another', 'another@example.test'), { code: 'invitation-invalid' });
});

test('team owner invitations permit multiple owners and lesser invitations cannot demote existing owners', () => {
  const { access, team } = setup();
  const coOwner = access.invite('user-owner', team.id, 'co@example.test', 'owner');
  access.acceptInvitation(coOwner.token, 'user-co', 'co@example.test');
  const selfTeam = access.invite('user-co', team.id, 'owner@example.test', 'viewer');
  assert.equal(access.acceptInvitation(selfTeam.token, 'user-owner', 'owner@example.test').role, 'owner');
  const selfProject = access.inviteProject('user-owner', 'project-film', 'owner@example.test', 'editor');
  assert.equal(access.acceptInvitation(selfProject.token, 'user-owner', 'owner@example.test').role, 'owner');
  assert.equal(access.roleFor('user-owner', 'project-film'), 'owner');
  const snapshot = access.snapshot();
  assert.equal(snapshot.teams[0].members.filter(item => item.role === 'owner').length, 2);
  assert.equal(snapshot.projects[0].roles.filter(item => item.role === 'owner').length, 1);
  assert.deepEqual(createAccessControl({ initialState: snapshot }).snapshot(), snapshot);
});

test('account removal retains only deleted-project ownership references with powerless team membership', () => {
  const { access, team } = setup();
  const coOwner = access.invite('user-owner', team.id, 'co@example.test', 'owner');
  access.acceptInvitation(coOwner.token, 'user-co', 'co@example.test');
  access.deleteProject('user-owner', 'project-film');
  access.registerProject('user-co', 'project-live', team.id);
  access.setProjectRole('user-co', 'project-live', 'user-owner', 'editor');
  assert.equal(access.accountRemovalPlan('user-owner').ready, true);
  access.removeUser('user-owner');
  const snapshot = access.snapshot();
  assert.deepEqual(snapshot.teams[0].members.find(item => item.userId === 'user-owner'), { userId: 'user-owner', role: 'viewer' });
  assert.equal(snapshot.projects.find(item => item.id === 'project-film').roles[0].role, 'owner');
  assert.equal(access.roleFor('user-owner', 'project-live'), null);
  assert.throws(() => access.registerProject('user-owner', 'project-new', team.id), { code: 'project-access-invalid' });
  assert.deepEqual(createAccessControl({ initialState: snapshot }).snapshot(), snapshot);
});

test('snapshot, validation and hydration clone state in both directions without replaying events', () => {
  const { access } = setup();
  const original = access.snapshot(); const validated = validateAccessState(original);
  validated.teams[0].name = 'Changed copy';
  assert.equal(original.teams[0].name, 'Post team');
  let events = 0;
  const restored = createAccessControl({ initialState: original, onProjectEvent: () => { events += 1; } });
  original.teams[0].members[0].role = 'viewer'; original.projects[0].roles[0].role = 'viewer';
  assert.equal(restored.roleFor('user-owner', 'project-film'), 'owner');
  const snapshot = restored.snapshot(); snapshot.projects[0].roles.length = 0;
  assert.equal(restored.snapshot().projects[0].roles.length, 1); assert.equal(events, 0);
});

test('strict state validation rejects corrupt fields, bindings, uniqueness, roles and timestamps', () => {
  const { access, team } = setup();
  member(access, 'editor@example.test', 'user-editor');
  access.inviteProject('user-owner', 'project-film', 'pending@example.test', 'viewer');
  const valid = access.snapshot();
  const corruptions = [
    s => { s.extra = true; }, s => { delete s.teams; }, s => { s.schemaVersion = 0; },
    s => { s.teams[0].token = 'bearer'; }, s => { s.teams[0].name = ''; },
    s => { s.teams[0].id = '../team'; }, s => { s.teams.push(structuredClone(s.teams[0])); },
    s => { s.teams[0].members.push(structuredClone(s.teams[0].members[0])); },
    s => { s.teams[0].members[0].userId = undefined; }, s => { s.teams[0].members[0].role = 'viewer'; },
    s => { s.projects[0].teamId = 'absent-team'; }, s => { s.projects[0].roles[1].userId = 'not-a-team-member'; },
    s => { s.projects[0].roles[1].role = 'owner'; }, s => { s.projects[0].roles[0].role = 'admin'; },
    s => { s.projects[0].deletedAt = -1; }, s => { s.projects[0].deletedAt = 0.5; },
    s => { s.projects.push(structuredClone(s.projects[0])); },
    s => { s.invitations[0].token = 'bearer'; }, s => { s.invitations[0].digest = 'not-a-digest'; },
    s => { s.invitations.push(structuredClone(s.invitations[0])); },
    s => { s.invitations[1].id = s.invitations[0].id; },
    s => { s.invitations[1].digest = s.invitations[0].digest; },
    s => { s.invitations[0].projectId = 'missing-project'; },
    s => { s.invitations[0].teamId = 'missing-team'; },
    s => { s.invitations[0].email = 'UPPER@example.test'; },
    s => { s.invitations[0].email = 'hidden\u0000@example.test'; },
    s => { s.invitations[0].role = 'owner'; },
    s => { s.invitations[0].acceptedAt = s.invitations[0].expiresAt; },
    s => { s.invitations[1].expiresAt = Number.MAX_SAFE_INTEGER + 1; },
    s => { s.projects[0].deletedAt = 0; },
    s => { const other = structuredClone(s.teams[0]); other.id = 'other-team'; s.teams.push(other); s.invitations[1].teamId = other.id; }
  ];
  for (const corrupt of corruptions) {
    const input = structuredClone(valid); corrupt(input);
    assert.throws(() => validateAccessState(input), { code: 'access-state-invalid' });
    assert.throws(() => createAccessControl({ initialState: input }), { code: 'access-state-invalid' });
  }
  assert.equal(valid.teams[0].id, team.id);
  assert.throws(() => validateAccessState({ ...valid, schemaVersion: 2 }), { code: 'access-state-newer-version' });
});

test('state bounds and mutation inputs fail before unsafe IDs or unrepresentable times can be persisted', () => {
  const { access } = setup(); const valid = access.snapshot();
  assert.throws(() => validateAccessState({ ...valid, teams: new Array(10001) }), { code: 'access-state-invalid' });
  assert.throws(() => validateAccessState({ ...valid, invitations: new Array(100001) }), { code: 'access-state-invalid' });
  const oversized = { ...valid, teams: [{ ...valid.teams[0], name: 'x'.repeat(16 * 1024 * 1024) }] };
  assert.throws(() => validateAccessState(oversized), { code: 'access-state-invalid' });
  assert.throws(() => access.createTeam(undefined, 'Team'), { code: 'team-invalid' });
  assert.throws(() => access.registerProject('user-owner', '../project', valid.teams[0].id), { code: 'project-access-invalid' });
  assert.throws(() => createAccessControl({ initialState: false }), { code: 'access-state-invalid' });
  assert.throws(() => createAccessControl({ now: () => -1 }).invite('owner', 'missing', 'x@y.test'), { code: 'invitation-forbidden' });
  const clock = createAccessControl({ now: () => Number.MAX_SAFE_INTEGER }); const team = clock.createTeam('owner', 'Team');
  assert.throws(() => clock.invite('owner', team.id, 'x@y.test'), { code: 'access-clock-invalid' });
});
