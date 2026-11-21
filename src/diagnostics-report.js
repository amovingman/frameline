const { createHash } = require('node:crypto');
const { KNOWN_ERRORS } = require('./adapter-metrics');
const { sanitizeOperationHealth } = require('./operation-health');
const SAFE_ERRORS = new Set([...KNOWN_ERRORS, 'scan-failed', 'metadata-invalid', 'metadata-unavailable',
  'metadata-storage-uncertain', 'metadata-lock-timeout', 'workspace-busy']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const version = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/.test(value) ? value : null;
function diagnosticsOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['includeProject', 'includeAdapter'].includes(key))
    || Object.values(input).some(value => typeof value !== 'boolean')) throw Object.assign(new Error('diagnostics-input-invalid'), { code: 'diagnostics-input-invalid' });
  return { includeProject: input.includeProject !== false, includeAdapter: input.includeAdapter !== false };
}

// Build a new allowlisted object. Never serialize input objects, free-form error
// messages, logs, URLs, identifiers or paths, even when they look like safe codes.
function createDiagnosticsReport({ appVersion, state, syncState, adapterUsage = null, operationHealth = null, runtime = {}, options } = {}) {
  if (!version(appVersion) || !state || !syncState) throw Object.assign(new Error('diagnostics-input-invalid'), { code: 'diagnostics-input-invalid' });
  const included = diagnosticsOptions(options);
  const report = { schemaVersion: 3, product: 'Frameline', appVersion,
    runtime: {
      platform: ['darwin', 'win32', 'linux'].includes(runtime.platform) ? runtime.platform : 'unknown',
      architecture: ['arm64', 'x64', 'ia32', 'arm'].includes(runtime.architecture) ? runtime.architecture : 'unknown',
      electron: version(runtime.electron), chromium: version(runtime.chromium), node: version(runtime.node),
      packaged: runtime.packaged === true
    },
    includedSections: included,
    syncConnected: syncState.connected === true || syncState.status === 'connected',
    syncStatus: ['connected', 'disconnected', 'offline', 'connecting', 'error'].includes(syncState.status) ? syncState.status : 'unknown',
    queuedSyncCount: Array.isArray(syncState.operations) ? syncState.operations.length : 0
  };
  if (included.includeProject) Object.assign(report, {
    selectedFormat: ['FCPXML', 'FCPXML bundle', null].includes(state.selectedProject?.format ?? null) ? state.selectedProject?.format ?? null : 'unknown',
    scanStatus: ['idle', 'not-scanned', 'scanning', 'ready', 'error'].includes(state.scanStatus) ? state.scanStatus : 'unknown',
    scanErrorCode: SAFE_ERRORS.has(state.error) ? state.error : null,
    scanManifestVersion: count(state.scan?.schemaVersion),
    pictureClipCount: Array.isArray(state.scan?.clips) ? state.scan.clips.length : null,
    mediaReferenceCount: Array.isArray(state.scan?.media) ? state.scan.media.length : null,
    revisionCount: Array.isArray(state.revisions) ? state.revisions.length : 0
  });
  if (included.includeAdapter) report.adapterUsage = adapterUsage && count(adapterUsage.attempts) !== null
    ? Object.fromEntries([
      ...['attempts', 'succeeded', 'failed', 'cancelled', 'averageDurationMs', 'recentSampleCount', 'recentP50Ms', 'recentP95Ms']
        .map(key => [key, count(adapterUsage[key])]),
      ['errorCodes', Object.fromEntries([...SAFE_ERRORS].filter(code => Object.hasOwn(adapterUsage.errorCodes || {}, code)
        && count(adapterUsage.errorCodes[code]) !== null).map(code => [code, adapterUsage.errorCodes[code]]))]
    ]) : null;
  if (included.includeAdapter) report.operationHealth = sanitizeOperationHealth(operationHealth);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  return { report, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
module.exports = { createDiagnosticsReport, diagnosticsOptions };
