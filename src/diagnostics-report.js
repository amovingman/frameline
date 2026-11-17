const { createHash } = require('node:crypto');
function fail(code) { const error = new Error(code); error.code = code; return error; }
function createDiagnosticsReport({ appVersion, state, syncState } = {}) {
  if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(appVersion) || !state || !syncState) throw fail('diagnostics-input-invalid');
  const report = {
    schemaVersion: 1, product: 'Frameline', appVersion,
    selectedFormat: ['FCPXML', null].includes(state.selectedProject?.format ?? null) ? state.selectedProject?.format ?? null : 'unknown',
    scanStatus: ['idle', 'scanning', 'ready', 'error'].includes(state.scanStatus) ? state.scanStatus : 'unknown',
    scanErrorCode: typeof state.error === 'string' && /^[a-z0-9-]{1,80}$/.test(state.error) ? state.error : null,
    scanManifestVersion: Number.isSafeInteger(state.scan?.schemaVersion) ? state.scan.schemaVersion : null,
    pictureClipCount: Array.isArray(state.scan?.clips) ? state.scan.clips.length : null,
    mediaReferenceCount: Array.isArray(state.scan?.media) ? state.scan.media.length : null,
    revisionCount: Array.isArray(state.revisions) ? state.revisions.length : 0,
    syncConnected: syncState.connected === true,
    queuedSyncCount: Array.isArray(syncState.operations) ? syncState.operations.length : 0
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  return { report, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
module.exports = { createDiagnosticsReport };
