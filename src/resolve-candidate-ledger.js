'use strict';

const { compareResolveSnapshotToExport } = require('./resolve-export-candidates');

const compareIds = (a, b) => a.localeCompare(b);
function fail() { const error = new Error('invalid-candidate-ledger'); error.code = 'invalid-candidate-ledger'; throw error; }

// A source-bound observation across two exports. API IDs may persist while XML
// spine positions change. Neither timing signatures nor this ledger prove a
// durable API-to-FCPXML identity mapping or authorize a write.
function createCandidateLedger({ beforeSnapshotBytes, beforeExportBytes,
  afterSnapshotBytes, afterExportBytes, timelineId } = {}) {
  if (typeof timelineId !== 'string' || !timelineId) fail();
  let before, after;
  try {
    before = compareResolveSnapshotToExport(beforeSnapshotBytes, beforeExportBytes, timelineId);
    after = compareResolveSnapshotToExport(afterSnapshotBytes, afterExportBytes, timelineId);
  } catch { fail(); }
  if (before.projectId !== after.projectId || before.timelineId !== after.timelineId) fail();
  const exactPairs = before.status === 'candidates-only' && after.status === 'candidates-only';
  const oldIds = new Map(before.matches.map(item => [item.apiItemId, item.xmlSpineIndex]));
  const newIds = new Map(after.matches.map(item => [item.apiItemId, item.xmlSpineIndex]));
  const retained = exactPairs ? [...oldIds.keys()].filter(id => newIds.has(id)).sort(compareIds)
    .map(apiItemId => ({ apiItemId, beforeXmlSpineIndex: oldIds.get(apiItemId),
      afterXmlSpineIndex: newIds.get(apiItemId) })) : [];
  return { schemaVersion: 1, readOnly: true, safeToApply: false,
    persistentMappingProven: false, status: exactPairs ? 'paired-candidates-only' : 'unresolved',
    projectId: before.projectId, timelineId,
    sourceHashes: { beforeSnapshot: before.snapshotSha256, beforeExport: before.exportSha256,
      afterSnapshot: after.snapshotSha256, afterExport: after.exportSha256 },
    retained, addedApiIds: exactPairs ? [...newIds.keys()].filter(id => !oldIds.has(id)).sort(compareIds) : [],
    removedApiIds: exactPairs ? [...oldIds.keys()].filter(id => !newIds.has(id)).sort(compareIds) : [],
    unresolvedBefore: before.unresolved.length, unresolvedAfter: after.unresolved.length };
}

function verifyCandidateLedger(ledger, sources) {
  const expected = createCandidateLedger(sources);
  return JSON.stringify(ledger) === JSON.stringify(expected)
    ? { valid: true, readOnly: true, safeToApply: false }
    : { valid: false, readOnly: true, safeToApply: false };
}

module.exports = { createCandidateLedger, verifyCandidateLedger };
