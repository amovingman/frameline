'use strict';
const { createDurableCollaborationService } = require('./durable-collaboration-service');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SAFE_ERRORS = new Set(['service-admin-input-invalid', 'service-admin-cleanup-failed', 'service-admin-operation-failed',
  'account-exists', 'account-invalid', 'password-invalid', 'credentials-invalid', 'project-exists', 'project-invalid',
  'project-access-invalid', 'invitation-exists', 'invitation-invalid', 'invitation-forbidden', 'forbidden',
  'ownership-transfer-required', 'collaboration-state-invalid', 'collaboration-state-newer-version',
  'collaboration-storage-unavailable', 'collaboration-storage-uncertain', 'collaboration-service-busy',
  'collaboration-key-rotation-required', 'identity-capacity-exceeded', 'access-capacity-exceeded']);
function fail(code) { return Object.assign(new Error(code), { code }); }
const safeErrorCode = error => SAFE_ERRORS.has(error?.code) ? error.code : 'service-admin-operation-failed';
function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
}
function email(value) {
  if (typeof value !== 'string') throw fail('service-admin-input-invalid');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    || /[\x00-\x1f\x7f]/.test(normalized)) throw fail('service-admin-input-invalid');
  return normalized;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw fail('service-admin-input-invalid');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\\/\x00-\x1f\x7f]/.test(value)
    || /^[a-z]:/i.test(value)) throw fail('service-admin-input-invalid');
  return value.trim();
}
function validateAdminRequest(input) {
  if (input?.action === 'account-create' && exact(input, ['action', 'email', 'password'])) {
    return { action: input.action, email: email(input.email), password: password(input.password) };
  }
  if (input?.action === 'project-create' && exact(input, ['action', 'email', 'password', 'projectId', 'name', 'teamName'])
    && typeof input.projectId === 'string' && ID.test(input.projectId)) {
    return { action: input.action, email: email(input.email), password: password(input.password),
      projectId: input.projectId, name: name(input.name), teamName: name(input.teamName) };
  }
  if (input?.action === 'member-add' && exact(input, ['action', 'ownerEmail', 'ownerPassword', 'memberEmail', 'memberPassword', 'projectId', 'role'])
    && typeof input.projectId === 'string' && ID.test(input.projectId) && ['editor', 'viewer'].includes(input.role)) {
    const ownerEmail = email(input.ownerEmail), memberEmail = email(input.memberEmail);
    if (ownerEmail === memberEmail) throw fail('service-admin-input-invalid');
    return { action: input.action, ownerEmail, ownerPassword: password(input.ownerPassword), memberEmail,
      memberPassword: password(input.memberPassword), projectId: input.projectId, role: input.role };
  }
  throw fail('service-admin-input-invalid');
}

// Trusted local operator entry point only. No route exposes this facade.
// Validate the entire action before opening (and potentially migrating) storage.
async function runServiceAdmin({ config, request } = {}) {
  const input = validateAdminRequest(request);
  let runtime = null; const sessions = [];
  async function signIn(address, secret) {
    const issued = await runtime.identity.signIn(address, secret); sessions.push(issued);
    const actor = await runtime.identity.authenticate(issued.accessToken);
    return { userId: actor.userId, context: { accessToken: issued.accessToken, requestId: `admin-${issued.sessionId}` } };
  }
  try {
    runtime = await createDurableCollaborationService({ directory: config?.directory, keyring: config?.keyring, initialize: false });
    if (input.action === 'account-create') {
      const created = await runtime.identity.createAccount(input.email, input.password);
      return { id: created.id, email: created.email, status: 'active' };
    }
    if (input.action === 'project-create') {
      const owner = await signIn(input.email, input.password);
      // These are separate durable transactions: project failure can retain an
      // empty team. This command does not claim an atomic multi-step workflow.
      const team = await runtime.teams.create(owner.context, input.teamName);
      const project = await runtime.projects.create(owner.context, { projectId: input.projectId, name: input.name, teamId: team.id });
      return { projectId: project.id, teamId: team.id, name: project.name, ownerId: owner.userId };
    }
    const owner = await signIn(input.ownerEmail, input.ownerPassword);
    const member = await signIn(input.memberEmail, input.memberPassword);
    // Both credentials are checked before issuing an invitation. Invitation and
    // acceptance still commit separately; acceptance failure may retain an invite.
    const invitation = await runtime.members.invite(owner.context, input.projectId, input.memberEmail, input.role);
    await runtime.members.accept(member.context, invitation.token);
    return { projectId: input.projectId, userId: member.userId, role: input.role };
  } catch (error) { throw fail(safeErrorCode(error)); }
  finally {
    let failed = false;
    if (runtime) {
      // Attempt every revocation even if an earlier cleanup operation fails.
      for (const issued of sessions) {
        try { await runtime.identity.signOut(issued.refreshToken); } catch { failed = true; }
      }
      try { await runtime.close(); } catch { failed = true; }
    }
    if (failed) throw fail('service-admin-cleanup-failed');
  }
}

module.exports = { runServiceAdmin, validateAdminRequest, safeErrorCode };
