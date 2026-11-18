const { fingerprint } = require('./project-api-contracts');
const { createCloudHistoryStore, validateState, migrateServiceState, manifestStorageKey } = require('./cloud-history-store');

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
  const migrated = migrateServiceState(backup.state); validateState(migrated);
  return createCloudHistoryStore(migrated, options);
}
function runRestoreDrill(store, options) {
  const backup = createServiceBackup(store);
  const restored = restoreServiceBackup(backup, options);
  return { verified: fingerprint(restored.snapshot()) === backup.sha256, backupHash: backup.sha256 };
}
function retentionReport(store) {
  const state = migrateServiceState(store.snapshot());
  const referenced = new Set(Object.values(state.revisions).map(item => manifestStorageKey(item.projectId, item.manifestId)));
  const retained = []; const eligible = [];
  const manifests = Object.entries(state.manifests).sort(([, a], [, b]) => {
    const left = JSON.stringify([a.projectId, a.id]), right = JSON.stringify([b.projectId, b.id]); return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const [key, manifest] of manifests) (referenced.has(key) ? retained : eligible).push({ projectId: manifest.projectId, manifestId: manifest.id });
  return { schemaVersion: 2, retainedManifests: retained, eligibleUnreferencedManifests: eligible,
    deletionPerformed: false };
}
module.exports = { createServiceBackup, restoreServiceBackup, runRestoreDrill, retentionReport };
