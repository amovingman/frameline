'use strict';
// Public recomputation of pinned parsed facts; original DRP bytes stay private.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { readInput } = require('./integration-input');
const { auditNativeTrackReadOnlyEvidence } = require('./native-track-readonly-evidence-audit');
const root = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sources = ['phase-0/resolve-native-field-inventory.py', 'phase-0/resolve-native-track-identity.py', 'phase-0/compare-native-resolve-exports.py'];
const metadata = new Set(['memberNameSha256', 'memberKind', 'ownerNativeId', 'ownerTypeSha256', 'relativeLocationSha256',
  'fieldKey', 'tag', 'containingApiItemIdMatch', 'ownerMatchesApiItemId']);
const payload = row => row ? Object.fromEntries(Object.entries(row).filter(([key]) => !metadata.has(key))) : null;
const need = condition => { if (!condition) throw new Error('native-field-control-evidence-invalid'); };

function auditNativeFieldControlEvidence(read = readInput) {
  const file = name => read(path.join(root, name));
  const receiptBytes = file('phase-0/native-field-control-evidence/receipt.json');
  need(sha(receiptBytes) === '4840172986d546d031ed9d0325ee82796c12e52079fb9bd030a9a13a5c4d7020');
  const receipt = JSON.parse(receiptBytes);
  need(receipt.readOnly === true && receipt.safeToApply === false && receipt.losslessValidated === false
    && same(Object.keys(receipt.sourceHashes).sort(), [...sources].sort()));
  for (const source of sources) need(sha(file(source)) === receipt.sourceHashes[source]);
  const decoded = {};
  for (const label of ['first-inventory', 'second-inventory', 'comparison']) {
    const entry = receipt.payloads[label];
    need(entry.file === `phase-0/native-field-control-evidence/${label}.json.gz`);
    const compressed = file(entry.file);
    need(sha(compressed) === entry.compressedSha256);
    const raw = gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 });
    need(sha(raw) === entry.sha256 && raw.length === entry.bytes);
    decoded[label] = JSON.parse(raw);
  }
  const control = auditNativeTrackReadOnlyEvidence(read);
  need(control.resultSha256 === receipt.sourceLiveReadOnlyResultSha256 && control.readExportReadStateUnchanged === true);
  need(receipt.sourceProofFile === 'phase-0/native-track-readonly-live-observation.json');
  const source = JSON.parse(file(receipt.sourceProofFile));
  const a = decoded['first-inventory'], b = decoded['second-inventory'], compared = decoded.comparison;
  for (const [value, graph] of [[a, source.graphs.first], [b, source.graphs.second]]) {
    need(value.projectId === control.projectId && value.apiSourceSha256 === source.sourceObservationSha256
      && same(value.archive, graph.archive) && value.allNativeFieldsCovered === false
      && value.records.length === 430 && new Set(value.records.map(row => row.fieldKey)).size === 430);
  }
  const old = new Map(a.records.map(row => [row.fieldKey, row])), current = new Map(b.records.map(row => [row.fieldKey, row]));
  const changes = [], locations = [], contexts = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const before = old.get(key) || null, after = current.get(key) || null;
    if (before && after && before.containingApiItemIdMatch !== after.containingApiItemIdMatch) {
      contexts.push({ fieldKey: key, ownerNativeId: before.ownerNativeId,
        beforeApiItemIdMatch: before.containingApiItemIdMatch, afterApiItemIdMatch: after.containingApiItemIdMatch });
    }
    if (!same(payload(before), payload(after))) {
      const reference = after || before;
      changes.push({ fieldKey: key, ownerNativeId: reference.ownerNativeId,
        status: !before ? 'added-record' : !after ? 'removed-record' : 'observed-payload-difference',
        ownerMatchesApiItemId: reference.ownerMatchesApiItemId, containingApiItemIdMatch: reference.containingApiItemIdMatch,
        tag: reference.tag, before, after });
    } else if (before.memberNameSha256 !== after.memberNameSha256) {
      locations.push({ fieldKey: key, ownerNativeId: before.ownerNativeId,
        beforeMemberNameSha256: before.memberNameSha256, afterMemberNameSha256: after.memberNameSha256 });
    }
  }
  const counts = Object.fromEntries(['added-record', 'removed-record', 'observed-payload-difference']
    .map(status => [status, changes.filter(row => row.status === status).length]));
  const members = value => Object.fromEntries(value.members.map(row => [row.memberNameSha256, row.rawSha256]));
  const rawMatch = same(members(a), members(b));
  need(same(changes, compared.selectedPayloadChanges) && same(locations, compared.memberLocationChangesWithSameObservedPayload)
    && same(contexts, compared.apiItemAncestorMatchChanges) && same(counts, compared.recordDifferenceCounts)
    && same(counts, receipt.recordDifferenceCounts) && rawMatch === compared.rawMemberBytesMatch
    && same(compared.beforeArchive, a.archive) && same(compared.afterArchive, b.archive)
    && compared.completeSelectedPayloadEqualityProven === false && compared.losslessValidated === false);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, projectId: control.projectId,
    sourceLiveResultSha256: control.resultSha256, representedApiStateUnchangedDuringControl: true,
    recordsPerExport: [a.records.length, b.records.length], recordDifferenceCounts: counts,
    pairedAncestorMatchChanges: contexts.length, memberLocationOnlyChanges: locations.length,
    rawMemberBytesMatch: rawMatch, selectedParsedTextAndShapeMatch: changes.length === 0,
    originalNativeArchivesReconstructed: false, nativeArchivesRetainedPrivately: true,
    fullNativePreservationProven: false, completeSelectedPayloadEqualityProven: false,
    sourceHashes: receipt.sourceHashes,
    limitations: ['Added and removed diagnostic records are not paired or treated as harmless payload changes.',
      'Public checks recompute pinned parsed field facts and API provenance; private native archives are not reconstructed.',
      'Read-only control differences establish neither semantic change nor volatility. No payload is ignored.',
      ...a.limitations] };
}
module.exports = { auditNativeFieldControlEvidence };
