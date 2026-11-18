'use strict';
const { carryObservedIdentity, evaluateMediaRequirements } = require('./local-media-readiness');
const ERRORS = new Set(['media-audit-source-required', 'media-job-retry-unavailable', 'media-audit-unavailable',
  'media-audit-job-unavailable', 'media-audit-queue-failed', 'stale-export', 'media-audit-copy-unverified',
  'media-job-progress-failed', 'handler-unavailable', 'media-audit-failed']);
const safeError = code => code ? ERRORS.has(code) ? code : 'media-audit-failed' : null;
const pick = (value, names) => Object.fromEntries(names.map(name => [name, value[name]]));
const JOB_FIELDS = ['id', 'label', 'projectId', 'sourceHash', 'target', 'status', 'progress', 'attempts',
  'updatedAt', 'completedAt', 'bound', 'scheduled', 'reportUnavailable', 'canCancel', 'canResume', 'canRetry', 'canRestart'];

// A main-process projection. Never spread private worker reports into IPC.
function createMediaAuditView({ getSelection, getAudit, setAudit }) {
  let latestVersion = 0;
  function reportValue(report, checkedAt) {
    const requirements = evaluateMediaRequirements({ schemaVersion: 1,
      items: report.assets.map(asset => ({ id: asset.id, required: true, state: asset.status,
        availabilityReason: asset.reason, verified: asset.identityVerified,
        reason: asset.identityVerified ? 'prior-size-and-hash-match' : asset.fingerprint ? 'expected-identity-unavailable' : 'original-unavailable' })) });
    return { status: 'ready', sourceHash: report.sourceHash, counts: { ...report.counts }, checkedAt,
      checkId: String(report._runId), assets: report.assets.map(asset => ({
        ...pick(asset, ['id', 'displayNames', 'status', 'reason', 'identityVerified']),
        fingerprintAvailable: !!asset.fingerprint, expectedIdentityAvailable: !!asset.expectedFingerprint,
        size: asset.fingerprint?.size ?? null })), requirements, identityVerified: false, error: null };
  }
  return function publicState(state) {
    const selection = getSelection(), reports = {};
    const current = Number.isSafeInteger(state.version) && state.version >= latestVersion;
    if (current) latestVersion = state.version;
    if (selection && state.selection?.projectId === selection.projectId && state.selection.sourceHash === selection.sourceHash) {
      for (const target of ['source', 'copy']) {
        const value = state.reports?.[target];
        if (!value || target === 'copy' && !selection.copyPath) continue;
        const { report, completedAt, runId } = value;
        const previous = getAudit(target);
        if (current && (previous?._runId !== runId || previous?.sourceHash !== report.sourceHash)) {
          setAudit(target, { ...report, assets: carryObservedIdentity(report.assets,
            previous?.sourceHash === report.sourceHash ? previous.assets : []), _runId: runId });
        }
        const cached = getAudit(target);
        reports[target] = reportValue(cached?._runId === runId && cached.sourceHash === report.sourceHash
          ? cached : { ...report, assets: carryObservedIdentity(report.assets, []), _runId: runId }, completedAt);
      }
    }
    return { version: state.version, busy: state.busy === true, error: safeError(state.error),
      selection: state.selection ? pick(state.selection, ['projectId', 'sourceHash']) : null,
      total: state.total || 0, reports, jobs: (state.jobs || []).map(job => ({ ...pick(job, JOB_FIELDS),
        error: safeError(job.error), detail: job.detail ? pick(job.detail, ['phase', 'checked', 'total', 'bytesRead', 'totalBytes']) : null })) };
  };
}
module.exports = { createMediaAuditView };
