'use strict';

const { createCandidateLedger } = require('./resolve-candidate-ledger');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');

function fail() { const error = new Error('invalid-bound-resolve-diff'); error.code = 'invalid-bound-resolve-diff'; throw error; }

// Compare only observed API fields by API ID, then annotate those observations
// with source-bound XML candidate positions. XML positions are never identities.
function createBoundResolveDiff(sources) {
  let ledger, before, after, comparison;
  try {
    ledger = createCandidateLedger(sources);
    before = normalizeResolveSnapshot(JSON.parse(Buffer.from(sources.beforeSnapshotBytes).toString('utf8')));
    after = normalizeResolveSnapshot(JSON.parse(Buffer.from(sources.afterSnapshotBytes).toString('utf8')));
    comparison = compareResolveManifests(before, after);
  } catch { fail(); }
  const anchors = new Map(ledger.retained.map(row => [row.apiItemId, row]));
  const changes = comparison.changes.filter(change => change.timelineId === ledger.timelineId).map(change => {
    const anchor = change.itemId && ledger.status === 'paired-candidates-only' ? anchors.get(change.itemId) : null;
    return { ...change, xmlCandidate: anchor
      ? { beforeSpineIndex: anchor.beforeXmlSpineIndex, afterSpineIndex: anchor.afterXmlSpineIndex }
      : null };
  });
  return { schemaVersion: 1, readOnly: true, safeToApply: false,
    coverage: 'observed-api-fields-only', xmlIdentityProven: false,
    bindingStatus: ledger.status, projectId: ledger.projectId,
    timelineId: ledger.timelineId, sourceHashes: ledger.sourceHashes, changes };
}

function verifyBoundResolveDiff(diff, sources) {
  const expected = createBoundResolveDiff(sources);
  return { valid: JSON.stringify(diff) === JSON.stringify(expected), safeToApply: false };
}

module.exports = { createBoundResolveDiff, verifyBoundResolveDiff };
