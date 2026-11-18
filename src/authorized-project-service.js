function fail(code) { const error = new Error(code); error.code = code; return error; }

// Every operation resolves authorization before touching the history store.
// Asset access is represented even though the current history store does not
// persist media bytes.
function createAuthorizedProjectService({ history, access, identity, rateLimit = () => ({}), audit = null, activity = null, comments = null, shareLinks = null,
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
      const replayed = input.idempotencyKey !== null && input.idempotencyKey !== undefined
        && Object.hasOwn(history.snapshot().idempotency, input.idempotencyKey);
      const result = history.createRevision({ ...input, authorId: actorId });
      if (!replayed) activity?.record({ projectId: input.projectId, actorId, type: 'revision.created', subjectId: result.id,
        recipientIds: access.listProjectMembers(actorId, input.projectId).map(item => item.userId) });
      return result;
    }),
    updateBranch: (context, input) => checked(context, input.projectId, 'branch', 'write', actorId => {
      const previous = history.getBranch(input.projectId, input.branch).revisionId;
      const receipt = input.idempotencyKey !== null && input.idempotencyKey !== undefined
        && Object.hasOwn(history.snapshot().idempotency, input.idempotencyKey);
      // Existing CAS keys are delegated to the immutable history receipt first.
      // An exact committed retry does not need today's reviewer permissions.
      if (receipt) return history.compareAndSwapBranch(input);
      const gate = branchProtection?.assertCanAdvance({ actorId, projectId: input.projectId, branch: input.branch,
        expectedHead: input.expectedRevisionId ?? null, revisionId: input.revisionId });
      const result = history.compareAndSwapBranch(input);
      branchProtection?.consumeAdvance?.(gate, { actorId, projectId: input.projectId, branch: input.branch, revisionId: input.revisionId });
      if (history.getBranch(input.projectId, input.branch).revisionId !== previous) activity?.record({ projectId: input.projectId, actorId, type: 'branch.changed', subjectId: input.branch,
        recipientIds: access.listProjectMembers(actorId, input.projectId).map(item => item.userId) });
      return result;
    }),
    getBranchReview: (context, projectId, branch, page) => checked(context, projectId, 'approval', 'read',
      actorId => { if (!branchProtection?.getReview) throw fail('branch-review-unavailable'); return branchProtection.getReview(actorId, projectId, branch, page); }),
    setBranchProtection: (context, input) => checked(context, input?.projectId, 'branch-policy', 'write',
      actorId => { if (!branchProtection?.setPolicy) throw fail('branch-review-unavailable'); return branchProtection.setPolicy(actorId, input); }),
    requestBranchApproval: (context, input) => checked(context, input?.projectId, 'approval', 'write',
      actorId => { if (!branchProtection?.request) throw fail('branch-review-unavailable'); return branchProtection.request(actorId, input); }),
    approveBranchRequest: (context, input) => checked(context, input?.projectId, 'approval', 'write',
      actorId => { if (!branchProtection?.approve) throw fail('branch-review-unavailable'); return branchProtection.approve(actorId, input); }),
    getShareReview: (context, projectId, branch, page) => checked(context, projectId, 'project', 'write',
      actorId => { if (!shareLinks) throw fail('share-links-unavailable'); return shareLinks.getReview(actorId, projectId, branch, page); }),
    createShareLink: (context, input) => checked(context, input?.projectId, 'project', 'write',
      actorId => { if (!shareLinks) throw fail('share-links-unavailable'); return shareLinks.create(actorId, input); }),
    revokeShareLink: (context, input) => checked(context, input?.projectId, 'project', 'write',
      actorId => { if (!shareLinks) throw fail('share-links-unavailable'); return shareLinks.revoke(actorId, input); }),
    redeemShareLink: input => { if (!shareLinks) throw fail('share-link-unavailable'); return shareLinks.redeem(input); },
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
      actorId => activity ? activity.listPage(actorId, projectId, page) : { projectId, items: [], nextCursor: null, unreadCount: null }),
    listNotifications: (context, projectId, page) => checked(context, projectId, 'project', 'read',
      actorId => activity ? activity.notificationPage(actorId, projectId, page) : { projectId, items: [], nextCursor: null, unreadCount: 0 }),
    markNotificationRead: (context, projectId, eventId) => checked(context, projectId, 'project', 'read',
      actorId => activity ? activity.markRead(actorId, projectId, eventId) : null),
    listReviewComments: (context, projectId, revisionId, page) => checked(context, projectId, 'comment', 'read',
      actorId => { if (!comments) throw fail('comments-unavailable'); return comments.list(actorId, projectId, revisionId, page); }),
    addReviewComment: (context, input) => checked(context, input?.projectId, 'comment', 'write',
      actorId => { if (!comments) throw fail('comments-unavailable'); return comments.add(actorId, input); }),
    resolveReviewComment: (context, input) => checked(context, input?.projectId, 'comment', 'read',
      actorId => { if (!comments) throw fail('comments-unavailable'); return comments.resolve(actorId, input); }),
    authorizeAsset: (context, projectId, action = 'read') => checked(context, projectId, 'asset', action,
      actorId => ({ allowed: true, actorId })),
    authorizeAssetPolicy: (context, projectId, action = 'read') => {
      if (!['read', 'write'].includes(action)) throw fail('authorization-request-invalid');
      return checked(context, projectId, 'project', action, actorId => ({ allowed: true, actorId }));
    }
  };
}

module.exports = { createAuthorizedProjectService };
