'use strict';
const { validatePortableTrialAuditBundle } = require('./resolve-portable-trial-audit');
const { createResolveRevisionManifest } = require('./resolve-revision-manifest');

// Import an explicitly selected historical observation. No editor calls, native
// backup restoration, branch switching, or sync-base changes occur here.
async function importPortableTrialAudit(store, bundle) {
  validatePortableTrialAuditBundle(bundle);
  const { audit } = bundle;
  const snapshot = JSON.parse(audit.resultSnapshot);
  const manifest = createResolveRevisionManifest(snapshot, audit);
  const existingProject = (await store.listResolveProjects()).find(project => project.editorProjectId === snapshot.project_id);
  const project = existingProject || await store.getResolveProjectId(snapshot.project_id, snapshot.project_name);
  const graph = await store.getResolveRevisionGraph(project.id);
  const matches = [];
  for (const summary of graph.revisions) {
    const revision = await store.getRevision(project.id, summary.id);
    if (revision.manifest.transactionAudit?.transactionId !== audit.transactionId) continue;
    if (revision.manifest.transactionAuditHash !== bundle.auditHash) throw new Error('conflicting-imported-trial-audit');
    matches.push(revision);
  }
  if (matches.length) {
    return { imported: false, projectId: project.id, revisionId: matches[0].id, branch: graph.currentBranch,
      auditHash: bundle.auditHash, snapshotHash: manifest.sourceHash, readOnly: true, safeToApply: false, nativeBackupIncluded: false };
  }
  const branch = graph.currentBranch;
  const revision = await store.saveRevision(project.id, manifest, `Imported trial audit ${audit.transactionId} ${audit.outcome.status}`,
    graph.branches[branch], branch);
  return { imported: true, projectId: project.id, revisionId: revision.id, branch,
    auditHash: bundle.auditHash, snapshotHash: manifest.sourceHash, readOnly: true, safeToApply: false, nativeBackupIncluded: false };
}

module.exports = { importPortableTrialAudit };
