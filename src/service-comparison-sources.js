'use strict';
const { createHash } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateTransferBundle } = require('./revision-transfer');
const { validateRevisionManifest } = require('./revision-manifest');
const { verifyServiceSyncBase, validateServiceSyncBaseScope, validateServiceSyncBaseEntry } = require('./service-sync-base');
const MAX_BYTES = 64 * 1024 * 1024;
const CANDIDATE_FIELDS = ['localRevisionId', 'remoteRevisionId', 'remoteAuthorId', 'manifestId', 'recordHash', 'proofHash',
  'verifiedAt', 'observedLocalHead', 'observedRemoteHead'];
const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  });
function snapshotHash(value) {
  let bytes;
  try { bytes = Buffer.from(`${JSON.stringify(value)}\n`); } catch { throw fail('service-comparison-invalid'); }
  if (bytes.length > MAX_BYTES) throw fail('service-comparison-too-large');
  return sha(bytes);
}
// Validates source identity without importing, applying or consulting a service.
function bindServiceComparisonSources(input) {
  if (!exact(input, ['scope', 'baseEntry', 'bundle', 'baseProof', 'incoming', 'local'])) throw fail('service-comparison-invalid');
  const { bundle, baseProof, incoming, local } = input;
  let scope, entry;
  try { scope = validateServiceSyncBaseScope(input.scope); entry = validateServiceSyncBaseEntry(input.baseEntry); }
  catch { throw fail('service-comparison-base-invalid'); }
  if (fingerprint(scope) !== fingerprint(entry.scope)) throw fail('service-comparison-base-invalid');
  // Use the same serialization as the immutable cache, including its newline.
  const baseSnapshotHash = snapshotHash(baseProof), incomingSnapshotHash = snapshotHash(incoming);
  snapshotHash(bundle); snapshotHash(local);
  if (baseSnapshotHash !== entry.proofSnapshotHash) throw fail('service-comparison-base-invalid');

  let records, localHead, base;
  try {
    records = validateTransferBundle(bundle); localHead = bundle.branches[scope.localBranch];
    if (bundle.projectId !== scope.localProjectId || !localHead) throw fail('service-comparison-base-invalid');
    const chain = new Set(); let cursor = localHead;
    while (cursor) { chain.add(cursor); cursor = records.get(cursor).parentRevisionId; }
    if (!chain.has(entry.localRevisionId) || !chain.has(entry.observedLocalHead)) throw fail('service-comparison-base-invalid');
    const observedBundle = { ...bundle, branches: { ...bundle.branches, [scope.localBranch]: entry.observedLocalHead } };
    const checked = verifyServiceSyncBase({ scope, bundle: observedBundle, remote: baseProof, verifiedAt: entry.verifiedAt });
    const expected = Object.fromEntries(CANDIDATE_FIELDS.map(key => [key, entry[key]]));
    if (!checked || fingerprint(checked) !== fingerprint(expected)) throw fail('service-comparison-base-invalid');
    base = records.get(entry.localRevisionId).manifest;
    const bytes = bundle.records.find(item => item.summary.id === entry.localRevisionId).bytes;
    if (`sha256:${fingerprint(base)}` !== entry.manifestId || sha(bytes) !== entry.recordHash) throw fail('service-comparison-base-invalid');
  } catch { throw fail('service-comparison-base-invalid'); }

  let incomingManifest;
  try {
    // Explicit fetched history is indexed under the selected local branch; only
    // its proof-validation view is remapped to the real remote destination.
    if (incoming.branch !== scope.localBranch) throw fail('service-comparison-incoming-invalid');
    verifyServiceSyncBase({ scope, bundle, remote: { ...incoming, branch: scope.remoteBranch },
      verifiedAt: incoming.checkedAt ?? entry.verifiedAt });
    const oldEnd = baseProof.revisions.findIndex(item => item.id === entry.remoteRevisionId);
    const newEnd = incoming.revisions.findIndex(item => item.id === entry.remoteRevisionId);
    if (oldEnd < 0 || newEnd !== oldEnd) throw fail('service-comparison-incoming-invalid');
    for (let index = 0; index <= oldEnd; index++) {
      if (fingerprint(baseProof.revisions[index]) !== fingerprint(incoming.revisions[index])) throw fail('service-comparison-incoming-invalid');
    }
    const head = incoming.revisions.at(-1);
    if (!head || head.id !== incoming.head) throw fail('service-comparison-incoming-invalid');
    incomingManifest = incoming.manifests.find(item => item.id === head.manifestId).document;
  } catch { throw fail('service-comparison-incoming-invalid'); }

  try { validateRevisionManifest(local); } catch { throw fail('service-comparison-invalid'); }
  const binding = { scope, baseVersion: entry.version, baseEntryHash: fingerprint(entry), baseLocalRevisionId: entry.localRevisionId,
      baseRemoteRevisionId: entry.remoteRevisionId, baseManifestId: entry.manifestId, baseSourceHash: base.sourceHash,
      baseRecordHash: entry.recordHash, baseProofHash: entry.proofHash, baseProofSnapshotHash: entry.proofSnapshotHash,
      localHead, localSourceHash: local.sourceHash, localManifestId: `sha256:${fingerprint(local)}`,
      incomingRevisionId: incoming.head, incomingManifestId: incoming.revisions.at(-1).manifestId,
      incomingSourceHash: incomingManifest.sourceHash, incomingSnapshotHash, incomingCheckedAt: incoming.checkedAt ?? null };
  return { binding, base: structuredClone(base), local: structuredClone(local), incoming: structuredClone(incomingManifest) };
}
module.exports = { bindServiceComparisonSources };
