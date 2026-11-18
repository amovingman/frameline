const { createHash, createHmac, randomUUID } = require('node:crypto');

const API_VERSION = '2026-11-13';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const PROJECT_API_CONTRACTS = Object.freeze([
  ['POST', '/users', 'CreateUser', 'User'],
  ['POST', '/auth/sessions', 'SignIn', 'Session'],
  ['POST', '/auth/sessions/refresh', 'RefreshSession', 'Session'],
  ['POST', '/auth/sessions/sign-out', 'SignOut', 'Empty'],
  ['GET', '/account', 'GetCurrentAccount', 'User'],
  ['DELETE', '/auth/sessions/:sessionId', 'SignOut', 'Empty'],
  ['POST', '/auth/recovery', 'BeginRecovery', 'Empty'],
  ['PUT', '/auth/recovery', 'CompleteRecovery', 'Empty'],
  ['POST', '/teams', 'CreateTeam', 'Team'],
  ['POST', '/teams/:teamId/invitations', 'InviteMember', 'Invitation'],
  ['POST', '/projects', 'CreateProject', 'Project'],
  ['GET', '/projects', 'ListAuthorizedProjects', 'ProjectPage'],
  ['GET', '/projects/:projectId/members', 'ListMembers', 'MemberPage'],
  ['PUT', '/projects/:projectId/members/:userId', 'SetProjectRole', 'Member'],
  ['PUT', '/projects/:projectId/branches/:branch', 'CompareAndSwapBranch', 'Branch'],
  ['GET', '/projects/:projectId/branches/:branch', 'GetBranch', 'Branch'],
  ['GET', '/projects/:projectId/branches/:branch/review', 'GetBranchReview', 'BranchReview'],
  ['PUT', '/projects/:projectId/branches/:branch/protection', 'SetBranchProtection', 'BranchProtectionPolicy'],
  ['POST', '/projects/:projectId/branches/:branch/approval-requests', 'RequestBranchApproval', 'BranchApprovalRequest'],
  ['PUT', '/projects/:projectId/branches/:branch/approval-requests/:requestId/approval', 'ApproveBranchRequest', 'BranchApprovalRequest'],
  ['POST', '/projects/:projectId/revisions', 'CreateRevision', 'Revision'],
  ['GET', '/projects/:projectId/revisions/:revisionId', 'GetRevision', 'Revision'],
  ['GET', '/projects/:projectId/revisions/:revisionId/comments', 'ListReviewComments', 'ReviewCommentPage'],
  ['POST', '/projects/:projectId/revisions/:revisionId/comments', 'AddReviewComment', 'ReviewComment'],
  ['PUT', '/projects/:projectId/revisions/:revisionId/comments/:commentId/resolve', 'ResolveReviewComment', 'ReviewComment'],
  ['GET', '/projects/:projectId/revisions/by-source/:sourceRevisionId', 'FindRevisionBySource', 'Revision'],
  ['PUT', '/projects/:projectId/manifests', 'PutManifest', 'Manifest'],
  ['GET', '/projects/:projectId/manifests/:manifestId', 'GetManifest', 'Manifest'],
  ['POST', '/projects/:projectId/assets/uploads', 'BeginAssetUpload', 'AssetUpload'],
  ['GET', '/projects/:projectId/assets/uploads/:uploadId', 'GetAssetUpload', 'AssetUpload'],
  ['PUT', '/projects/:projectId/assets/uploads/:uploadId/chunks/:index', 'PutAssetChunk', 'AssetChunkReceipt'],
  ['POST', '/projects/:projectId/assets/uploads/:uploadId/complete', 'CompleteAssetUpload', 'VerifiedAsset'],
  ['DELETE', '/projects/:projectId/assets/uploads/:uploadId/complete', 'CancelAssetVerification', 'AssetVerificationCancellation'],
  ['GET', '/projects/:projectId/assets/:assetId', 'GetAsset', 'Asset'],
  ['GET', '/projects/:projectId/assets/:assetId/chunks/:index', 'GetAssetChunk', 'AssetChunkBytes'],
  ['POST', '/projects/:projectId/assets/tickets', 'CreateAssetChunkTicket', 'AssetChunkTicket'],
  ['GET', '/projects/:projectId/assets/policy', 'GetProjectMediaPolicy', 'ProjectMediaPolicy'],
  ['PUT', '/projects/:projectId/assets/policy', 'SetProjectMediaPolicy', 'ProjectMediaPolicy'],
  ['GET', '/projects/:projectId/assets/usage', 'GetProjectMediaUsage', 'ProjectMediaUsage'],
  ['GET', '/projects/:projectId/assets/:assetId/availability', 'GetAssetAvailability', 'AssetAvailability'],
  ['PUT', '/projects/:projectId/assets/:assetId/archive', 'SetAssetArchived', 'AssetAvailability'],
  ['POST', '/projects/:projectId/pull-plans', 'CreatePullPlan', 'PullPlan'],
  ['GET', '/projects/:projectId/activity', 'ListActivity', 'ActivityPage'],
  ['GET', '/projects/:projectId/notifications', 'ListNotifications', 'NotificationPage'],
  ['PUT', '/projects/:projectId/notifications/:eventId/read', 'MarkNotificationRead', 'NotificationReceipt'],
  ['DELETE', '/users/:userId', 'DeleteAccount', 'DeletionReport']
].map(([method, path, request, response]) => Object.freeze({ method, path, request, response })));

function fail(code) { const error = new Error(code); error.code = code; return error; }
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function fingerprint(value) { return createHash('sha256').update(stable(value)).digest('hex'); }

function createRequestContext(headers = {}) {
  const requestId = headers['x-request-id'] || randomUUID();
  const idempotencyKey = headers['idempotency-key'] || null;
  if (!ID_PATTERN.test(requestId) || (idempotencyKey !== null && !ID_PATTERN.test(idempotencyKey))) throw fail('invalid-request-headers');
  return Object.freeze({ apiVersion: API_VERSION, requestId, idempotencyKey });
}

function responseEnvelope(context, data) {
  if (!context || context.apiVersion !== API_VERSION || !ID_PATTERN.test(context.requestId)) throw fail('invalid-request-context');
  return { apiVersion: API_VERSION, requestId: context.requestId, data };
}

function pageToken(position, secret) {
  if (!Number.isSafeInteger(position) || position < 0 || typeof secret !== 'string' || secret.length < 16) throw fail('invalid-page-token-input');
  const payload = Buffer.from(JSON.stringify({ v: 1, p: position })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readPageToken(token, secret) {
  if (token === null || token === undefined) return 0;
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < 16) throw fail('invalid-page-token');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw fail('invalid-page-token');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !require('node:crypto').timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw fail('invalid-page-token');
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.p) || parsed.p < 0) throw new Error();
    return parsed.p;
  } catch { throw fail('invalid-page-token'); }
}

module.exports = { API_VERSION, PROJECT_API_CONTRACTS, stable, fingerprint,
  createRequestContext, responseEnvelope, pageToken, readPageToken };
