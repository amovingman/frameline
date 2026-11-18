'use strict';
const { createHash } = require('node:crypto');
const { createResolveRevisionManifest } = require('./resolve-revision-manifest');
const UUID = /^[a-f0-9-]{36}$/;
const ROLES = ['base', 'local', 'incoming'];
function invalid() { const error = new Error('resolve-history-preview-invalid'); error.code = 'resolve-history-preview-invalid'; throw error; }

async function readResolveHistoryPreviewSources(store, projectId, revisionIds) {
  if (!store || typeof store.getResolveRevisionGraph !== 'function' || typeof store.getRevision !== 'function'
    || !UUID.test(projectId || '') || !revisionIds || typeof revisionIds !== 'object'
    || Array.isArray(revisionIds) || Object.keys(revisionIds).sort().join('|') !== ROLES.slice().sort().join('|')
    || ROLES.some(role => !UUID.test(revisionIds[role] || ''))) invalid();
  let graph;
  try { graph = await store.getResolveRevisionGraph(projectId); } catch { invalid(); }
  const byId = new Map(graph.revisions.map(revision => [revision.id, revision]));
  if (ROLES.some(role => !byId.has(revisionIds[role]))) invalid();
  const ancestor = (baseId, headId) => {
    const seen = new Set(); let id = headId;
    while (id && !seen.has(id)) {
      if (id === baseId) return true;
      seen.add(id); id = byId.get(id)?.parentRevisionId;
    }
    return false;
  };
  if (!ancestor(revisionIds.base, revisionIds.local)
    || !ancestor(revisionIds.base, revisionIds.incoming)) invalid();
  const sources = {};
  for (const role of ROLES) {
    let record;
    try { record = await store.getRevision(projectId, revisionIds[role]); } catch { invalid(); }
    if (record.manifest.format !== 'resolve-api-observation'
      || record.manifest.snapshot.project_id !== graph.editorProjectId) invalid();
    const bytes = Buffer.from(JSON.stringify(record.manifest.snapshot));
    if (createHash('sha256').update(bytes).digest('hex') !== (record.manifest.snapshotHash || record.contentHash)) invalid();
    sources[role] = bytes;
  }
  return sources;
}
async function readResolveLiveHistoryPreviewSources(store, projectId, revisionIds, snapshot, expectedHash) {
  if (!revisionIds || Object.keys(revisionIds).sort().join('|') !== 'base|incoming'
    || !/^[a-f0-9]{64}$/.test(expectedHash || '')) invalid();
  let live;
  try { live = createResolveRevisionManifest(snapshot); } catch { invalid(); }
  if (live.sourceHash !== expectedHash) invalid();
  const sources = await readResolveHistoryPreviewSources(store, projectId,
    { base: revisionIds.base, local: revisionIds.base, incoming: revisionIds.incoming });
  let graph;
  try { graph = await store.getResolveRevisionGraph(projectId); } catch { invalid(); }
  if (live.snapshot.project_id !== graph.editorProjectId) invalid();
  const byId = new Map(graph.revisions.map(record => [record.id, record]));
  const seen = new Set();
  let id = graph.branches[graph.currentBranch];
  while (id && !seen.has(id) && id !== revisionIds.base) {
    seen.add(id);
    id = byId.get(id)?.parentRevisionId;
  }
  if (id !== revisionIds.base) invalid();
  sources.local = Buffer.from(JSON.stringify(live.snapshot));
  return sources;
}
module.exports = { readResolveHistoryPreviewSources, readResolveLiveHistoryPreviewSources };
