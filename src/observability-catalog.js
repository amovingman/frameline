'use strict';
const { KNOWN_ERRORS } = require('./adapter-metrics');
// Values are deliberately enumerated: a syntactically valid slug may still be a
// credential, client name or filename. Unknown values never enter local logs.
const ERROR_CODES = new Set([...KNOWN_ERRORS,
  'unknown-error', 'scan-failed', 'scan-recovery-unavailable', 'workspace-busy',
  'metadata-invalid', 'metadata-unavailable', 'metadata-storage-uncertain', 'metadata-lock-timeout',
  'media-jobs-unavailable', 'media-audit-failed', 'resolve-review-error', 'resolve-companion-error',
  'resolve-companion-save-failed', 'resolve-companion-revision-failed', 'resolve-history-error',
  'resolve-backup-invalid', 'service-connection-failed', 'invitation-invalid', 'review-copy-failed', 'media-search-failed',
  'native-pull-busy', 'native-pull-review-locked', 'native-pull-roles-required', 'native-pull-intent-terminal',
  'native-pull-review-stale', 'native-pull-plan-not-ready', 'native-pull-action-failed',
  'native-pull-refresh-not-ready', 'native-pull-choice-not-ready', 'native-pull-cancel-not-ready',
  'native-pull-execution-already-started', 'closed-project-resolve-running', 'closed-project-source-hash-stale',
  'media-relink-action-failed', 'media-relink-import-not-ready', 'media-relink-import-result-invalid', 'media-relink-import-admission-required',
  'media-relink-candidate-content-mismatch', 'media-relink-asset-class-mismatch', 'media-relink-candidate-changed',
  'media-relink-expected-identity-required', 'media-relink-destination-exists', 'media-relink-review-stale',
  'media-relink-import-already-issued', 'media-relink-import-editor-running', 'media-relink-import-frame-rate-unsupported',
  'media-relink-import-proxy-pair-ambiguous', 'media-relink-import-retired', 'media-relink-existing-native-project-open',
  'asset-transfer-input-invalid', 'asset-transfer-unavailable', 'asset-transfer-busy', 'asset-transfer-capacity-exceeded',
  'asset-transfer-journal-invalid', 'asset-transfer-storage-unavailable', 'asset-transfer-storage-uncertain',
  'asset-transfer-interrupted', 'asset-selection-changed', 'asset-viewer-read-only', 'asset-file-invalid',
  'asset-source-changed', 'asset-identity-mismatch', 'asset-destination-exists', 'asset-checkpoint-invalid',
  'asset-cache-corrupt', 'asset-progress-failed', 'asset-cancelled', 'asset-local-io-failed', 'asset-local-io-uncertain',
  'asset-network-unavailable', 'asset-service-failed', 'asset-forbidden', 'asset-not-found', 'asset-content-mismatch',
  'asset-storage-unavailable', 'asset-storage-uncertain', 'asset-verification-timeout', 'service-sign-in-required',
  'service-credential-storage-unavailable', 'service-offline', 'forbidden',
  'integrity-ancestry-cycle', 'integrity-artifact-changed', 'integrity-artifact-invalid', 'integrity-artifact-outside-store',
  'integrity-artifact-unsafe', 'integrity-backup-binding', 'integrity-checkpoint-changed', 'integrity-config-invalid',
  'integrity-determinism-failed', 'integrity-fork-unverified', 'integrity-history-scope', 'integrity-identity-collision',
  'integrity-identity-generation', 'integrity-identity-graph', 'integrity-identity-invalid', 'integrity-identity-parent',
  'integrity-identity-reused', 'integrity-parent-missing', 'integrity-preservation-changed', 'integrity-project-identity',
  'integrity-result-unverified', 'integrity-selection-changed', 'integrity-transaction-collision', 'integrity-transaction-scope',
  'integrity-work-active', 'integrity-workspace-unsafe', 'integrity-record-unverified', 'integrity-capacity-exceeded', 'integrity-busy', 'integrity-unavailable'
]);
const EVENTS = new Set([
  'app.ready', 'media-jobs.unavailable', 'media.audit-job-failed', 'resolve.review-failed',
  'asset-transfer.action-failed', 'service.action-failed', 'collaboration.invite-failed',
  'resolve.companion-prepare-failed', 'resolve.companion-read-failed', 'resolve.companion-save-failed',
  'resolve.companion-revision-failed', 'resolve.history-list-failed', 'resolve.history-transfer-failed',
  'resolve.history-revisions-failed', 'resolve.history-open-failed', 'resolve.history-graph-failed',
  'resolve.history-create-branch-failed', 'resolve.history-switch-branch-failed',
  'project.selection-cancelled', 'project.selection-rejected', 'project.selected', 'project.scan-complete',
  'project.scan-failed', 'project.rescan-complete', 'project.rescan-failed',
  'review-copy.failed', 'review-copy.verify-failed', 'review-copy.reveal-failed', 'media.search-failed',
  'revision.save-failed', 'revision.saved', 'revision.export-failed', 'revision.import-failed'
]);
const safeErrorCode = value => ERROR_CODES.has(value) ? value : 'unknown-error';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function safeLogFields(event, fields = {}) {
  if (!EVENTS.has(event) || !fields || typeof fields !== 'object') return {};
  const output = {};
  if (Object.hasOwn(fields, 'code')) output.code = safeErrorCode(fields.code);
  if (event === 'app.ready' && typeof fields.version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/.test(fields.version || '')) output.version = fields.version;
  if (event === 'project.selected' && ['FCPXML', 'FCPXML bundle'].includes(fields.format)) output.format = fields.format;
  if (['project.scan-complete', 'project.rescan-complete'].includes(event)) {
    for (const key of ['clipCount', 'warningCount']) if (count(fields[key]) !== null) output[key] = fields[key];
  }
  return output;
}
module.exports = { safeErrorCode, safeLogFields, isKnownEvent: value => EVENTS.has(value), count };
