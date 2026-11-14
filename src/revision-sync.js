const { validateTransferBundle } = require('./revision-transfer');

function fail(code) { const error = new Error(code); error.code = code; return error; }
function localChain(records, headId) {
  const chain = []; const seen = new Set(); let current = headId;
  while (current) {
    if (seen.has(current) || !records.has(current)) throw fail('sync-history-invalid');
    seen.add(current); chain.push(records.get(current)); current = records.get(current).parentRevisionId;
  }
  return chain.reverse();
}

function createRevisionSyncService(remote) {
  if (!remote || !['putManifest', 'createRevision', 'compareAndSwapBranch', 'getBranch',
    'getRevision', 'getManifest', 'findRevisionBySource'].every(name => typeof remote[name] === 'function')) throw fail('sync-remote-invalid');
  function divergence({ remoteProjectId, branch = 'main', bundle }) {
    const records = validateTransferBundle(bundle); const localHead = bundle.branches[branch];
    if (localHead === undefined) throw fail('sync-branch-invalid');
    const remoteHead = remote.getBranch(remoteProjectId, branch).revisionId;
    if (!localHead && !remoteHead) return { status: 'in-sync', localHead, remoteHead, actions: [] };
    const localRemote = localHead ? remote.findRevisionBySource(remoteProjectId, localHead) : null;
    if (localRemote?.id === remoteHead) return { status: 'in-sync', localHead, remoteHead, actions: [] };
    const localIds = new Set(localChain(records, localHead).map(item => item.id));
    const remoteRecord = remoteHead ? remote.getRevision(remoteProjectId, remoteHead) : null;
    if (!remoteHead || (remoteRecord.sourceRevisionId && localIds.has(remoteRecord.sourceRevisionId))) {
      return { status: 'local-ahead', localHead, remoteHead, actions: ['push'] };
    }
    if (!localHead) return { status: 'remote-ahead', localHead, remoteHead, actions: ['fetch'] };
    let remoteCursor = remoteRecord;
    while (remoteCursor) {
      if (remoteCursor.sourceRevisionId === localHead) return { status: 'remote-ahead', localHead, remoteHead, actions: ['fetch'] };
      remoteCursor = remoteCursor.parentRevisionId ? remote.getRevision(remoteProjectId, remoteCursor.parentRevisionId) : null;
    }
    return { status: 'diverged', localHead, remoteHead, actions: ['fetch', 'create-reconciliation-branch'] };
  }
  function push({ remoteProjectId, branch = 'main', bundle, authorId }) {
    const records = validateTransferBundle(bundle); const state = divergence({ remoteProjectId, branch, bundle });
    if (!['in-sync', 'local-ahead'].includes(state.status)) throw fail('sync-reconciliation-required');
    if (state.status === 'in-sync') return { pushed: 0, remoteHead: state.remoteHead, status: 'in-sync' };
    const chain = localChain(records, bundle.branches[branch]);
    let expected = state.remoteHead; let pushed = 0;
    const remoteSource = expected ? remote.getRevision(remoteProjectId, expected).sourceRevisionId : null;
    const start = remoteSource ? chain.findIndex(item => item.id === remoteSource) + 1 : 0;
    if (remoteSource && start === 0) throw fail('sync-reconciliation-required');
    for (const local of chain.slice(start)) {
      const existing = remote.findRevisionBySource(remoteProjectId, local.id);
      if (existing) { expected = existing.id; continue; }
      const manifest = remote.putManifest(remoteProjectId, local.manifest);
      const revision = remote.createRevision({ projectId: remoteProjectId, manifestId: manifest.id,
        parentRevisionId: expected, authorId, message: local.message, sourceRevisionId: local.id,
        idempotencyKey: `sync:${remoteProjectId}:${local.id}` });
      remote.compareAndSwapBranch({ projectId: remoteProjectId, branch, expectedRevisionId: expected,
        revisionId: revision.id, idempotencyKey: `sync-branch:${remoteProjectId}:${local.id}` });
      expected = revision.id; pushed += 1;
    }
    return { pushed, remoteHead: expected, status: 'in-sync' };
  }
  function fetch({ remoteProjectId, branch = 'main' }) {
    const head = remote.getBranch(remoteProjectId, branch).revisionId; const revisions = []; const manifests = new Map();
    let current = head; const seen = new Set();
    while (current) {
      if (seen.has(current)) throw fail('sync-history-invalid'); seen.add(current);
      const revision = remote.getRevision(remoteProjectId, current); revisions.push(revision);
      if (!manifests.has(revision.manifestId)) manifests.set(revision.manifestId,
        remote.getManifest(remoteProjectId, revision.manifestId));
      current = revision.parentRevisionId;
    }
    return { schemaVersion: 1, remoteProjectId, branch, head, revisions: revisions.reverse(),
      manifests: [...manifests.values()], mediaFetched: false };
  }
  return { push, fetch, divergence };
}

module.exports = { createRevisionSyncService };
