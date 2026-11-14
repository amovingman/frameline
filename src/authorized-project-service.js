function fail(code) { const error = new Error(code); error.code = code; return error; }

// Every operation resolves authorization before touching the history store.
// Asset access is represented even though the current history store does not
// persist media bytes.
function createAuthorizedProjectService({ history, access, identity, rateLimit = () => ({}), audit = null }) {
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
    createRevision: (context, input) => checked(context, input.projectId, 'revision', 'write',
      actorId => history.createRevision({ ...input, authorId: actorId })),
    updateBranch: (context, input) => checked(context, input.projectId, 'branch', 'write',
      () => history.compareAndSwapBranch(input)),
    getManifest: (context, projectId, manifestId) => checked(context, projectId, 'revision', 'read',
      () => history.getManifest(projectId, manifestId)),
    listRevisions: (context, projectId, page) => checked(context, projectId, 'revision', 'read',
      () => history.listRevisions(projectId, page)),
    getBranch: (context, projectId, branch) => checked(context, projectId, 'branch', 'read',
      () => history.getBranch(projectId, branch)),
    authorizeAsset: (context, projectId, action = 'read') => checked(context, projectId, 'asset', action,
      () => ({ allowed: true }))
  };
}

module.exports = { createAuthorizedProjectService };
