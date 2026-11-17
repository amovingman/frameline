'use strict';
const { createHash } = require('node:crypto');
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
    if (createHash('sha256').update(bytes).digest('hex') !== record.contentHash) invalid();
    sources[role] = bytes;
  }
  return sources;
}
module.exports = { readResolveHistoryPreviewSources };
