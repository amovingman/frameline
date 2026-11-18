function fail(code) { const error = new Error(code); error.code = code; return error; }

// Every operation resolves authorization before touching the history store.
// Asset access is represented even though the current history store does not
// persist media bytes.
function createAuthorizedProjectService({ history, access, identity, rateLimit = () => ({}), audit = null, activity = null,
  branchProtection = null }) {
  if (!history || !access || !identity || typeof identity.authenticate !== 'function') throw fail('authorized-service-invalid');
  function checked(context, projectId, resource, action, operation) {
    const actorId = identity.authenticate(context?.accessToken).userId;
    try {
      rateLimit(`${actorId}:${resource}:${action}`);
      access.authorize(actorId, { projectId, resource, action });
      const result = operation(actorId);
      audit?.record({ actorId, action: `${resource}.${action}`, projectId, outcome: 'success', requestId: context.requestId });
      return result;
    } catch (error) {
      audit?.record({ actorId, action: `${resource}.${action}`, projectId, outcome: error.code || 'failed', requestId: context.requestId });
      throw error;
    }
  }
  return {
    putManifest: (context, projectId, manifest) => checked(context, projectId, 'revision', 'write',
      () => history.putManifest(projectId, manifest)),
    createRevision: (context, input) => checked(context, input.projectId, 'revision', 'write', actorId => {
      const result = history.createRevision({ ...input, authorId: actorId });
      activity?.record({ projectId: input.projectId, actorId, type: 'revision.created', subjectId: result.id,
        recipientIds: access.listProjectMembers(actorId, input.projectId).map(item => item.userId) });
      return result;
    }),
    updateBranch: (context, input) => checked(context, input.projectId, 'branch', 'write', actorId => {
      branchProtection?.assertCanAdvance({ actorId, projectId: input.projectId, branch: input.branch,
        expectedHead: input.expectedRevisionId ?? null, revisionId: input.revisionId });
      const result = history.compareAndSwapBranch(input);
      activity?.record({ projectId: input.projectId, actorId, type: 'branch.changed', subjectId: input.branch,
        recipientIds: access.listProjectMembers(actorId, input.projectId).map(item => item.userId) });
      return result;
    }),
    getManifest: (context, projectId, manifestId) => checked(context, projectId, 'revision', 'read',
      () => history.getManifest(projectId, manifestId)),
    getRevision: (context, projectId, revisionId) => checked(context, projectId, 'revision', 'read',
      () => history.getRevision(projectId, revisionId)),
    findRevisionBySource: (context, projectId, sourceRevisionId) => checked(context, projectId, 'revision', 'read',
      () => history.findRevisionBySource(projectId, sourceRevisionId)),
    listRevisions: (context, projectId, page) => checked(context, projectId, 'revision', 'read',
      () => history.listRevisions(projectId, page)),
    getBranch: (context, projectId, branch) => checked(context, projectId, 'branch', 'read',
      () => history.getBranch(projectId, branch)),
    listActivity: (context, projectId, page) => checked(context, projectId, 'project', 'read',
      actorId => activity ? activity.list(actorId, projectId, page) : []),
    listNotifications: (context, projectId) => checked(context, projectId, 'project', 'read',
      actorId => activity ? activity.notifications(actorId, projectId) : []),
    markNotificationRead: (context, projectId, eventId) => checked(context, projectId, 'project', 'read',
      actorId => activity ? activity.markRead(actorId, projectId, eventId) : null),
    authorizeAsset: (context, projectId, action = 'read') => checked(context, projectId, 'asset', action,
      () => ({ allowed: true }))
  };
}

module.exports = { createAuthorizedProjectService };
