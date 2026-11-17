const { randomBytes, randomUUID, createHash } = require('node:crypto');

const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const COLLABORATOR_ROLES = Object.freeze(['editor', 'viewer']);
const PERMISSIONS = Object.freeze({
  owner: new Set(['project:read', 'project:write', 'project:delete', 'members:read', 'members:write',
    'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write']),
  editor: new Set(['project:read', 'members:read', 'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write']),
  viewer: new Set(['project:read', 'members:read', 'revision:read', 'branch:read', 'asset:read'])
});
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; return error; }

function createAccessControl({ now = () => Date.now(), invitationTtlMs = 7 * 24 * 60 * 60_000,
  onProjectEvent = () => {} } = {}) {
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
    invitations.set(digest(token), { id, teamId, projectId: null, email: normalized, role, expiresAt, acceptedAt: null });
    return { id, token, expiresAt };
  }
  function inviteProject(actorId, projectId, email, role = 'editor') {
    const project = projects.get(projectId); const normalized = String(email || '').trim().toLowerCase();
    if (!project || project.deletedAt !== undefined || project.roles.get(actorId) !== 'owner' || !COLLABORATOR_ROLES.includes(role)) throw fail('invitation-forbidden');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw fail('invitation-invalid');
    const duplicate = [...invitations.values()].some(item => item.projectId === projectId && item.email === normalized
      && !item.acceptedAt && item.expiresAt > now());
    if (duplicate) throw fail('invitation-exists');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expiresAt = now() + invitationTtlMs;
    invitations.set(digest(token), { id, teamId: project.teamId, projectId, email: normalized, role, expiresAt, acceptedAt: null });
    onProjectEvent({ projectId, actorId, type: 'member.invited', subjectId: id });
    return { id, token, expiresAt, projectId, role };
  }
  function acceptInvitation(token, userId, email) {
    const invitation = invitations.get(digest(String(token || ''))); const normalized = String(email || '').trim().toLowerCase();
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now() || invitation.email !== normalized
      || invitation.projectId && isProjectDeleted(invitation.projectId)) throw fail('invitation-invalid');
    teams.get(invitation.teamId).members.set(userId, invitation.role);
    if (invitation.projectId) {
      projects.get(invitation.projectId).roles.set(userId, invitation.role);
      onProjectEvent({ projectId: invitation.projectId, actorId: userId, type: 'member.joined', subjectId: userId });
    }
    invitation.acceptedAt = now();
    return { teamId: invitation.teamId, projectId: invitation.projectId, role: invitation.role };
  }
  function registerProject(actorId, projectId, teamId) {
    const team = teams.get(teamId);
    if (!team || team.members.get(actorId) !== 'owner' || projects.has(projectId)) throw fail('project-access-invalid');
    projects.set(projectId, { teamId, roles: new Map([[actorId, 'owner']]) });
    return { projectId, teamId };
  }
  function setProjectRole(actorId, projectId, userId, role) {
    const project = projects.get(projectId);
    if (!project || project.deletedAt !== undefined || project.roles.get(actorId) !== 'owner' || !ROLES.includes(role)
      || !teams.get(project.teamId)?.members.has(userId)) throw fail('role-change-forbidden');
    if (role === 'owner' && project.roles.get(userId) !== 'owner') throw fail('ownership-transfer-required');
    if (project.roles.get(userId) === 'owner' && role !== 'owner') throw fail('ownership-transfer-required');
    project.roles.set(userId, role);
    onProjectEvent({ projectId, actorId, type: 'member.role-changed', subjectId: userId });
    return { projectId, userId, role };
  }
  function transferProjectOwnership(actorId, projectId, nextOwnerId) {
    const project = projects.get(projectId);
    if (!project || project.deletedAt !== undefined || project.roles.get(actorId) !== 'owner'
      || actorId === nextOwnerId || !project.roles.has(nextOwnerId)
      || !teams.get(project.teamId)?.members.has(nextOwnerId)) throw fail('ownership-transfer-forbidden');
    project.roles.set(nextOwnerId, 'owner'); project.roles.set(actorId, 'editor');
    onProjectEvent({ projectId, actorId, type: 'owner.transferred', subjectId: nextOwnerId });
    return { projectId, previousOwnerId: actorId, ownerId: nextOwnerId };
  }
  function removeProjectMember(actorId, projectId, userId) {
    const project = projects.get(projectId);
    if (!project || project.deletedAt !== undefined || project.roles.get(actorId) !== 'owner'
      || !project.roles.has(userId)) throw fail('member-removal-forbidden');
    if (project.roles.get(userId) === 'owner') throw fail('ownership-transfer-required');
    project.roles.delete(userId);
    onProjectEvent({ projectId, actorId, type: 'member.removed', subjectId: userId });
    return { projectId, userId, removed: true };
  }
  function deleteProject(actorId, projectId) {
    const project = projects.get(projectId);
    if (!project || project.roles.get(actorId) !== 'owner' || project.deletedAt !== undefined) throw fail('project-delete-forbidden');
    project.deletedAt = now();
    for (const invitation of invitations.values()) if (invitation.projectId === projectId && !invitation.acceptedAt) invitation.expiresAt = now();
    onProjectEvent({ projectId, actorId, type: 'project.deleted' });
    return { projectId, deletedAt: project.deletedAt, retainedHistory: true };
  }
  function isProjectDeleted(projectId) { return projects.get(projectId)?.deletedAt !== undefined; }
  function roleFor(userId, projectId) { const project = projects.get(projectId); return project && project.deletedAt === undefined ? project.roles.get(userId) || null : null; }
  function listProjectMembers(actorId, projectId) {
    authorize(actorId, { projectId, resource: 'members', action: 'read' });
    return [...projects.get(projectId).roles.entries()].map(([userId, role]) => ({ userId, role }));
  }
  function listProjectInvitations(actorId, projectId) {
    authorize(actorId, { projectId, resource: 'members', action: 'write' });
    return [...invitations.values()].filter(item => item.projectId === projectId).map(item => ({
      id: item.id, email: item.email, role: item.role, expiresAt: item.expiresAt,
      status: item.acceptedAt ? 'accepted' : item.expiresAt <= now() ? 'expired' : 'pending'
    })).sort((left, right) => left.expiresAt - right.expiresAt);
  }
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
    for (const [projectId, project] of projects) if (project.deletedAt === undefined && project.roles.get(userId) === 'owner'
      && ![...project.roles.entries()].some(([id, role]) => id !== userId && role === 'owner')) blockers.push({ type: 'project-owner', id: projectId });
    return { userId, ready: blockers.length === 0, blockers };
  }
  function removeUser(userId) {
    if (!accountRemovalPlan(userId).ready) throw fail('ownership-transfer-required');
    for (const team of teams.values()) team.members.delete(userId);
    for (const project of projects.values()) project.roles.delete(userId);
    return { removed: true };
  }
  return { createTeam, invite, inviteProject, acceptInvitation, registerProject, setProjectRole,
    transferProjectOwnership, removeProjectMember, deleteProject, isProjectDeleted, roleFor,
    listProjectMembers, listProjectInvitations, authorize, accountRemovalPlan, removeUser };
}

module.exports = { ROLES, COLLABORATOR_ROLES, PERMISSIONS, createAccessControl };
