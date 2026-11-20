'use strict';
const { fingerprint } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');

// Read while the history metadata lease is held. Every immutable revision is
// retained, including revisions that are no longer reachable from a branch.
// A legacy or otherwise unbound revision cannot establish a safe deletion set.
function retainedMediaReferences(history, projectId) {
  const state = history.snapshot();
  const manifests = new Map(Object.values(state.manifests)
    .filter(item => item.projectId === projectId).map(item => [item.id, item.document]));
  let complete = true;
  const revisions = Object.values(state.revisions).filter(item => item.projectId === projectId)
    .sort((a, b) => a.id.localeCompare(b.id)).map(revision => {
      const manifest = manifests.get(revision.manifestId);
      try { validateRevisionManifest(manifest); } catch { complete = false; }
      const dependencies = manifest?.mediaDependencies;
      if (manifest?.adapter !== 'fcpxml' || manifest.schemaVersion !== 3
        || dependencies?.coverage !== 'complete') complete = false;
      return { revisionId: revision.id, manifestId: revision.manifestId,
        sourceHash: manifest?.sourceHash || null,
        assets: dependencies?.assets?.map(item => structuredClone(item.identity)) || [] };
    });
  const body = { projectId, complete, revisions };
  return { ...body, stateHash: fingerprint(body) };
}

function assertRetainedMediaIdentities(history, projectId, manifest) {
  const incoming = new Map((manifest.mediaDependencies?.assets || []).map(item => [item.identity.contentId, fingerprint(item.identity)]));
  if (!incoming.size) return;
  for (const revision of retainedMediaReferences(history, projectId).revisions) for (const identity of revision.assets) {
    if (incoming.has(identity.contentId) && incoming.get(identity.contentId) !== fingerprint(identity)) {
      throw Object.assign(new Error('asset-revision-identity-mismatch'), { code: 'asset-revision-identity-mismatch' });
    }
  }
}

module.exports = { retainedMediaReferences, assertRetainedMediaIdentities };
