'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fingerprint } = require('./project-api-contracts');
const { validateTransferBundle } = require('./revision-transfer');
const { validateScanManifest } = require('./scan-manifest');
const { verifyServiceSyncBase, validateServiceSyncBaseScope, validateServiceSyncBaseEntry } = require('./service-sync-base');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const CANDIDATE_FIELDS = ['localRevisionId', 'remoteRevisionId', 'remoteAuthorId', 'manifestId', 'recordHash', 'proofHash',
  'verifiedAt', 'observedLocalHead', 'observedRemoteHead'];
const AVAILABILITY = ['local', 'missing', 'external', 'unknown', 'unavailable'];
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

function canonicalRate(value) {
  let [numerator, denominator] = value.slice(0, -1).split('/').map(BigInt);
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a; denominator /= a;
  return `${numerator}/${denominator}s`;
}

function context(manifest) {
  const names = new Set(); let ambiguousMediaNames = false;
  const availability = Object.fromEntries(AVAILABILITY.map(key => [key, 0]));
  for (const item of manifest.media) {
    if (names.has(item.name)) ambiguousMediaNames = true;
    names.add(item.name); availability[item.availability]++;
  }
  return { clipCount: manifest.clips.length, mediaCount: manifest.media.length, ambiguousMediaNames,
    availability, warningCount: manifest.warnings.length };
}

/** Compare captured sequence observations only. The caller must independently
 * verify current local source bytes and scope before and after this pure work.
 * No source, incoming revision, branch, or shared-base receipt is changed here.
 */
function createServiceThreeWayComparison(input) {
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

  if ([base, local, incomingManifest].some(value => value?.format === 'resolve-api-observation')) throw fail('service-comparison-unsupported');
  try { for (const value of [base, local, incomingManifest]) validateScanManifest(value); }
  catch { throw fail('service-comparison-invalid'); }
  const decisions = [];
  for (const field of ['name', 'frameDuration', 'durationFrames']) {
    const values = [base, local, incomingManifest].map(value => field === 'frameDuration'
      ? canonicalRate(value.sequence[field]) : value.sequence[field]);
    const [b, l, i] = values;
    if (b === l && b === i) continue;
    const status = l === i ? 'already-applied' : b === l ? 'incoming-only' : b === i ? 'local-only' : 'conflict';
    decisions.push({ field, status, base: b, local: l, incoming: i });
  }
  const contexts = { base: context(base), local: context(local), incoming: context(incomingManifest) };
  const warnings = [
    'Only captured sequence name, frame duration, and duration in frames are classified. Unchanged observed fields are omitted.',
    'Clip positions are scan positions, not persistent clip identities. Clip edits and complete editor equivalence are unavailable.',
    'Media inventory and availability counts are context only. Availability may differ between machines and does not establish an editor change or media identity.',
    'Duration values are frame counts; a frame-rate change may alter elapsed time.',
    'This comparison captures the selected export at verification time. Later file or service changes require another scan or fetch and comparison; live editor state and apply remain unproven.'
  ];
  if (Object.values(contexts).some(value => value.warningCount)) warnings.push('At least one source scan reported coverage warnings; unobserved content is excluded from classification.');
  const payload = { schemaVersion: 1, readOnly: true, safeToApply: false, coverage: 'fcpxml-sequence-fields-only',
    binding: { scope, baseVersion: entry.version, baseEntryHash: fingerprint(entry), baseLocalRevisionId: entry.localRevisionId,
      baseRemoteRevisionId: entry.remoteRevisionId, baseManifestId: entry.manifestId, baseSourceHash: base.sourceHash,
      baseRecordHash: entry.recordHash, baseProofHash: entry.proofHash, baseProofSnapshotHash: entry.proofSnapshotHash,
      localHead, localSourceHash: local.sourceHash, localManifestId: `sha256:${fingerprint(local)}`,
      incomingRevisionId: incoming.head, incomingManifestId: incoming.revisions.at(-1).manifestId,
      incomingSourceHash: incomingManifest.sourceHash, incomingSnapshotHash, incomingCheckedAt: incoming.checkedAt ?? null },
    decisions, context: contexts,
    gaps: ['clip-edits-unavailable', 'media-edit-classification-unavailable', 'live-editor-state-unproven', 'editor-apply-unavailable'], warnings };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESULT_BYTES) throw fail('service-comparison-too-large');
  return { ...payload, id: `sha256:${fingerprint(payload)}` };
}

function verifyServiceThreeWayComparison(result, input) {
  return { valid: isDeepStrictEqual(result, createServiceThreeWayComparison(input)), readOnly: true, safeToApply: false };
}

module.exports = { createServiceThreeWayComparison, verifyServiceThreeWayComparison };
