const { randomBytes, randomUUID, createHash } = require('node:crypto');

const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const COLLABORATOR_ROLES = Object.freeze(['editor', 'viewer']);
const PERMISSIONS = Object.freeze({
  owner: new Set(['project:read', 'project:write', 'project:delete', 'members:read', 'members:write',
    'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write', 'comment:read', 'comment:write']),
  editor: new Set(['project:read', 'members:read', 'revision:read', 'revision:write', 'branch:read', 'branch:write', 'asset:read', 'asset:write', 'comment:read', 'comment:write']),
  viewer: new Set(['project:read', 'members:read', 'revision:read', 'branch:read', 'asset:read', 'comment:read'])
});
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const MAX_ACCESS_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCES = 10_000;
const MAX_ENTRIES = 100_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const emailAddress = value => typeof value === 'string' && value === value.trim().toLowerCase()
  && value.length <= 254 && !/[\x00-\x1f\x7f]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const teamName = value => typeof value === 'string' && value === value.trim() && value.length > 0
  && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validateAccessState(input) {
  if (input?.schemaVersion > 1) throw fail('access-state-newer-version');
  const invalid = () => { throw fail('access-state-invalid'); };
  if (!exact(input, ['schemaVersion', 'teams', 'projects', 'invitations']) || input.schemaVersion !== 1
    || !Array.isArray(input.teams) || input.teams.length > MAX_RESOURCES
    || !Array.isArray(input.projects) || input.projects.length > MAX_RESOURCES
    || !Array.isArray(input.invitations) || input.invitations.length > MAX_ENTRIES) invalid();
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { invalid(); }
  if (bytes > MAX_ACCESS_BYTES) invalid();
  const teams = new Map(), projects = new Map(), invitationIds = new Set(), digests = new Set();
  let membershipCount = 0;
  function members(values) {
    if (!Array.isArray(values) || values.length > MAX_ENTRIES) invalid();
    membershipCount += values.length;
    if (membershipCount > MAX_ENTRIES) invalid();
    const result = new Map();
    for (const item of values) {
      if (!exact(item, ['userId', 'role']) || !validId(item.userId) || !ROLES.includes(item.role)
        || result.has(item.userId)) invalid();
      result.set(item.userId, item.role);
    }
    return result;
  }
  for (const team of input.teams) {
    if (!exact(team, ['id', 'name', 'members']) || !validId(team.id) || !teamName(team.name) || teams.has(team.id)) invalid();
    const users = members(team.members);
    if (![...users.values()].includes('owner')) invalid();
    teams.set(team.id, users);
  }
  for (const project of input.projects) {
    if (!exact(project, ['id', 'teamId', 'roles', 'deletedAt']) || !validId(project.id)
      || !validId(project.teamId) || !teams.has(project.teamId) || projects.has(project.id)
      || (project.deletedAt !== null && !time(project.deletedAt))) invalid();
    const users = members(project.roles);
    if ([...users.values()].filter(role => role === 'owner').length !== 1
      || [...users.keys()].some(userId => !teams.get(project.teamId).has(userId))) invalid();
    projects.set(project.id, project);
  }
  for (const invitation of input.invitations) {
    if (!exact(invitation, ['digest', 'id', 'teamId', 'projectId', 'email', 'role', 'expiresAt', 'acceptedAt'])
      || typeof invitation.digest !== 'string' || !/^[a-f0-9]{64}$/.test(invitation.digest)
      || digests.has(invitation.digest) || !validId(invitation.id) || invitationIds.has(invitation.id)
      || !validId(invitation.teamId) || !teams.has(invitation.teamId) || !emailAddress(invitation.email)
      || !ROLES.includes(invitation.role) || !time(invitation.expiresAt)
      || (invitation.acceptedAt !== null && (!time(invitation.acceptedAt) || invitation.acceptedAt >= invitation.expiresAt))) invalid();
    if (invitation.projectId !== null) {
      const project = projects.get(invitation.projectId);
      if (!validId(invitation.projectId) || !project || project.teamId !== invitation.teamId
        || !COLLABORATOR_ROLES.includes(invitation.role)
        || (project.deletedAt !== null && invitation.acceptedAt === null && invitation.expiresAt > project.deletedAt)) invalid();
    }
    digests.add(invitation.digest); invitationIds.add(invitation.id);
  }
  return structuredClone(input);
}

function createAccessControl({ now = () => Date.now(), invitationTtlMs = 7 * 24 * 60 * 60_000,
  onProjectEvent = () => {}, initialState = null } = {}) {
  if (typeof now !== 'function' || typeof onProjectEvent !== 'function' || !Number.isSafeInteger(invitationTtlMs)
    || invitationTtlMs <= 0) throw fail('access-control-invalid');
  const teams = new Map(); const projects = new Map(); const invitations = new Map();
  if (initialState !== null) {
    const restored = validateAccessState(initialState);
    for (const team of restored.teams) teams.set(team.id, { id: team.id, name: team.name,
      members: new Map(team.members.map(item => [item.userId, item.role])) });
    for (const project of restored.projects) projects.set(project.id, { teamId: project.teamId,
      roles: new Map(project.roles.map(item => [item.userId, item.role])),
      ...(project.deletedAt === null ? {} : { deletedAt: project.deletedAt }) });
    for (const { digest: tokenDigest, ...invitation } of restored.invitations) invitations.set(tokenDigest, invitation);
  }
  function clock() { const result = now(); if (!time(result)) throw fail('access-clock-invalid'); return result; }
  function expiration() {
    const result = clock() + invitationTtlMs;
    if (!time(result)) throw fail('access-clock-invalid');
    return result;
  }
  function createTeam(ownerId, name) {
    if (!validId(ownerId) || typeof name !== 'string' || !teamName(name.trim())
      || teams.size >= MAX_RESOURCES) throw fail('team-invalid');
    const team = { id: randomUUID(), name: name.trim(), members: new Map([[ownerId, 'owner']]) };
    teams.set(team.id, team); return { id: team.id, name: team.name };
  }
  function invite(actorId, teamId, email, role = 'editor') {
    const team = teams.get(teamId);
    if (!team || team.members.get(actorId) !== 'owner' || !ROLES.includes(role)) throw fail('invitation-forbidden');
    const normalized = String(email || '').trim().toLowerCase();
    if (!emailAddress(normalized) || invitations.size >= MAX_ENTRIES) throw fail('invitation-invalid');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expiresAt = expiration();
    invitations.set(digest(token), { id, teamId, projectId: null, email: normalized, role, expiresAt, acceptedAt: null });
    return { id, token, expiresAt };
  }
  function inviteProject(actorId, projectId, email, role = 'editor') {
    const project = projects.get(projectId); const normalized = String(email || '').trim().toLowerCase();
    if (!project || project.deletedAt !== undefined || project.roles.get(actorId) !== 'owner' || !COLLABORATOR_ROLES.includes(role)) throw fail('invitation-forbidden');
    if (!emailAddress(normalized) || invitations.size >= MAX_ENTRIES) throw fail('invitation-invalid');
    const duplicate = [...invitations.values()].some(item => item.projectId === projectId && item.email === normalized
      && item.acceptedAt === null && item.expiresAt > clock());
    if (duplicate) throw fail('invitation-exists');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expiresAt = expiration();
    invitations.set(digest(token), { id, teamId: project.teamId, projectId, email: normalized, role, expiresAt, acceptedAt: null });
    onProjectEvent({ projectId, actorId, type: 'member.invited', subjectId: id });
    return { id, token, expiresAt, projectId, role };
  }
  function acceptInvitation(token, userId, email) {
    const invitation = invitations.get(digest(String(token || ''))); const normalized = String(email || '').trim().toLowerCase();
    const acceptedAt = clock();
    if (!validId(userId) || !invitation || invitation.acceptedAt !== null || invitation.expiresAt <= acceptedAt || invitation.email !== normalized
      || invitation.projectId && isProjectDeleted(invitation.projectId)) throw fail('invitation-invalid');
    const team = teams.get(invitation.teamId);
    // An invitation cannot silently demote an existing owner or orphan its team.
    team.members.set(userId, team.members.get(userId) === 'owner' ? 'owner' : invitation.role);
    let role = team.members.get(userId);
    if (invitation.projectId) {
      const project = projects.get(invitation.projectId);
      role = project.roles.get(userId) === 'owner' ? 'owner' : invitation.role;
      project.roles.set(userId, role);
      onProjectEvent({ projectId: invitation.projectId, actorId: userId, type: 'member.joined', subjectId: userId });
    }
    invitation.acceptedAt = acceptedAt;
    return { teamId: invitation.teamId, projectId: invitation.projectId, role };
  }
  function registerProject(actorId, projectId, teamId) {
    const team = teams.get(teamId);
    if (!team || team.members.get(actorId) !== 'owner' || !validId(projectId) || projects.has(projectId)
      || projects.size >= MAX_RESOURCES) throw fail('project-access-invalid');
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
    project.deletedAt = clock();
    for (const invitation of invitations.values()) if (invitation.projectId === projectId && invitation.acceptedAt === null) invitation.expiresAt = project.deletedAt;
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
      status: item.acceptedAt !== null ? 'accepted' : item.expiresAt <= clock() ? 'expired' : 'pending'
    })).sort((left, right) => left.expiresAt - right.expiresAt);
  }
  function authorize(userId, { projectId, resource, action }) {
    if (!['project', 'members', 'revision', 'branch', 'asset', 'comment'].includes(resource)
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
    const historicalTeams = new Set([...projects.values()].filter(project => project.deletedAt !== undefined
      && project.roles.get(userId) === 'owner').map(project => project.teamId));
    for (const team of teams.values()) {
      if (historicalTeams.has(team.id)) team.members.set(userId, 'viewer');
      else team.members.delete(userId);
    }
    for (const project of projects.values()) {
      if (project.deletedAt !== undefined && project.roles.get(userId) === 'owner') continue;
      project.roles.delete(userId);
    }
    return { removed: true };
  }
  function snapshot() {
    return validateAccessState({ schemaVersion: 1,
      teams: [...teams.values()].map(team => ({ id: team.id, name: team.name,
        members: [...team.members].map(([userId, role]) => ({ userId, role })) })),
      projects: [...projects].map(([id, project]) => ({ id, teamId: project.teamId,
        roles: [...project.roles].map(([userId, role]) => ({ userId, role })), deletedAt: project.deletedAt ?? null })),
      invitations: [...invitations].map(([tokenDigest, invitation]) => ({ digest: tokenDigest, ...invitation })) });
  }
  return { createTeam, invite, inviteProject, acceptInvitation, registerProject, setProjectRole,
    transferProjectOwnership, removeProjectMember, deleteProject, isProjectDeleted, roleFor,
    listProjectMembers, listProjectInvitations, authorize, accountRemovalPlan, removeUser, snapshot };
}

module.exports = { ROLES, COLLABORATOR_ROLES, PERMISSIONS, createAccessControl, validateAccessState };
