const { randomBytes, randomUUID, createHash } = require('node:crypto');

const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const PERMISSIONS = Object.freeze({
  owner: new Set(['project:read', 'project:write', 'project:delete', 'members:read', 'members:write',
    'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write']),
  editor: new Set(['project:read', 'members:read', 'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write']),
  viewer: new Set(['project:read', 'members:read', 'revision:read', 'branch:read', 'asset:read'])
});
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; return error; }

function createAccessControl({ now = () => Date.now(), invitationTtlMs = 7 * 24 * 60 * 60_000 } = {}) {
  const teams = new Map(); const projects = new Map(); const invitations = new Map();
  function createTeam(ownerId, name) {
    if (typeof ownerId !== 'string' || !ownerId || typeof name !== 'string' || !name.trim()) throw fail('team-invalid');
    const team = { id: randomUUID(), name: name.trim(), members: new Map([[ownerId, 'owner']]) };
    teams.set(team.id, team); return { id: team.id, name: team.name };
  }
  function invite(actorId, teamId, email, role = 'editor') {
    const team = teams.get(teamId);
    if (!team || team.members.get(actorId) !== 'owner' || !ROLES.includes(role)) throw fail('invitation-forbidden');
    const normalized = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw fail('invitation-invalid');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expiresAt = now() + invitationTtlMs;
    invitations.set(digest(token), { id, teamId, email: normalized, role, expiresAt, acceptedAt: null });
    return { id, token, expiresAt };
  }
  function acceptInvitation(token, userId, email) {
    const invitation = invitations.get(digest(String(token || ''))); const normalized = String(email || '').trim().toLowerCase();
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now() || invitation.email !== normalized) throw fail('invitation-invalid');
    teams.get(invitation.teamId).members.set(userId, invitation.role); invitation.acceptedAt = now();
    return { teamId: invitation.teamId, role: invitation.role };
  }
  function registerProject(actorId, projectId, teamId) {
    const team = teams.get(teamId);
    if (!team || team.members.get(actorId) !== 'owner' || projects.has(projectId)) throw fail('project-access-invalid');
    projects.set(projectId, { teamId, roles: new Map([[actorId, 'owner']]) });
    return { projectId, teamId };
  }
  function setProjectRole(actorId, projectId, userId, role) {
    const project = projects.get(projectId);
    if (!project || project.roles.get(actorId) !== 'owner' || !ROLES.includes(role)
      || !teams.get(project.teamId)?.members.has(userId)) throw fail('role-change-forbidden');
    project.roles.set(userId, role); return { projectId, userId, role };
  }
  function roleFor(userId, projectId) { return projects.get(projectId)?.roles.get(userId) || null; }
  function authorize(userId, { projectId, resource, action }) {
    if (!['project', 'members', 'revision', 'branch', 'asset'].includes(resource)
      || !['read', 'write', 'delete'].includes(action)) throw fail('authorization-request-invalid');
    const role = roleFor(userId, projectId);
    if (!role || !PERMISSIONS[role].has(`${resource}:${action}`)) throw fail('forbidden');
    return { allowed: true, role };
  }
  function accountRemovalPlan(userId) {
    const blockers = [];
    for (const team of teams.values()) if (team.members.get(userId) === 'owner'
      && ![...team.members.entries()].some(([id, role]) => id !== userId && role === 'owner')) blockers.push({ type: 'team-owner', id: team.id });
    for (const [projectId, project] of projects) if (project.roles.get(userId) === 'owner'
      && ![...project.roles.entries()].some(([id, role]) => id !== userId && role === 'owner')) blockers.push({ type: 'project-owner', id: projectId });
    return { userId, ready: blockers.length === 0, blockers };
  }
  function removeUser(userId) {
    if (!accountRemovalPlan(userId).ready) throw fail('ownership-transfer-required');
    for (const team of teams.values()) team.members.delete(userId);
    for (const project of projects.values()) project.roles.delete(userId);
    return { removed: true };
  }
  return { createTeam, invite, acceptInvitation, registerProject, setProjectRole, roleFor,
    authorize, accountRemovalPlan, removeUser };
}

module.exports = { ROLES, PERMISSIONS, createAccessControl };
