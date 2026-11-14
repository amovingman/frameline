const { fingerprint } = require('./project-api-contracts');
const { createCloudHistoryStore, validateState } = require('./cloud-history-store');

function fail(code) { const error = new Error(code); error.code = code; return error; }
function createServiceBackup(store) {
  if (!store || typeof store.snapshot !== 'function') throw fail('backup-source-invalid');
  const state = store.snapshot();
  validateState(state);
  return { format: 'frameline-service-backup', version: 1, createdAt: new Date().toISOString(),
    state, sha256: fingerprint(state) };
}
function restoreServiceBackup(backup, options) {
  if (!backup || backup.format !== 'frameline-service-backup' || backup.version !== 1
    || backup.sha256 !== fingerprint(backup.state)) throw fail('backup-invalid');
  validateState(backup.state);
  return createCloudHistoryStore(backup.state, options);
}
function runRestoreDrill(store, options) {
  const backup = createServiceBackup(store);
  const restored = restoreServiceBackup(backup, options);
  return { verified: fingerprint(restored.snapshot()) === backup.sha256, backupHash: backup.sha256 };
}
function retentionReport(store) {
  const state = store.snapshot();
  const referenced = new Set(Object.values(state.revisions).map(item => item.manifestId));
  const retained = []; const eligible = [];
  for (const id of Object.keys(state.manifests).sort()) (referenced.has(id) ? retained : eligible).push(id);
  return { schemaVersion: 1, retainedManifestIds: retained, eligibleUnreferencedManifestIds: eligible,
    deletionPerformed: false };
}
module.exports = { createServiceBackup, restoreServiceBackup, runRestoreDrill, retentionReport };
