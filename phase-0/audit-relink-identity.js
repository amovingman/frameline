'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { parseEffectObservation, describeEffectCoverage, compareEffectObservations } = require('../src/resolve-effect-observation');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const REPORT_HASH = '59edb9e25a3afdcbb3b90196d5243a6ccf95750ae690abbe6582ed6d9804a1e3';
function requireProof(condition) { if (!condition) throw new Error('relink-identity-evidence-mismatch'); }

function auditRelinkIdentity(directory = __dirname) {
  const reportBytes = fs.readFileSync(path.join(directory, 'relink-identity-live-observation.json'));
  requireProof(hash(reportBytes) === REPORT_HASH);
  const report = JSON.parse(reportBytes), bytes = {}, values = {};
  for (const [role, source] of Object.entries(report.files)) {
    requireProof(/^live-relink-identity[-a-z]+\.json$/.test(source.name));
    bytes[role] = fs.readFileSync(path.join(directory, 'resolve-xml-proof', source.name));
    requireProof(bytes[role].length <= 20 * 1024 * 1024 && hash(bytes[role]) === source.sha256);
    values[role] = JSON.parse(bytes[role]);
  }
  requireProof(hash(fs.readFileSync(path.join(directory, 'resolve-relink-identity-spike.lua'))) === report.spikeSourceSha256
    && hash(fs.readFileSync(path.join(directory, 'resolve-relink-identity.js'))) === report.commandBuilderSha256);
  const baseline = parseEffectObservation(bytes.baseline), snapshot = baseline.snapshot;
  requireProof(snapshot.project_id === report.projectId && snapshot.project_name === report.projectName
    && snapshot.resolve_version === report.resolveVersion && snapshot.timelines.length === report.timelineCount
    && snapshot.timelines[0].id === report.timelineId && report.safeToApply === false && report.readOnly === true);
  const items = snapshot.timelines.flatMap(timeline => timeline.items);
  const groups = new Map();
  for (const item of items) {
    requireProof(typeof item.media_pool_id === 'string');
    groups.set(item.media_pool_id, (groups.get(item.media_pool_id) || 0) + 1);
  }
  requireProof(items.length === report.occurrenceCount && groups.size === report.mediaPoolItemCount
    && [...groups.values()].filter(count => count > 1).length === report.repeatedMediaGroups
    && isDeepStrictEqual(describeEffectCoverage(baseline), report.coverage));
  const receipts = values.receipts, expected = new Map();
  requireProof(receipts.projectId === report.projectId && receipts.media.length === groups.size
    && receipts.contentHashCheckLocation === 'node-outside-editor' && receipts.runtimeContentHashGuard === false);
  for (const media of receipts.media) {
    requireProof(groups.has(media.mediaPoolId) && !expected.has(media.mediaPoolId));
    expected.set(media.mediaPoolId, media.name);
    for (const field of ['originalBefore', 'relocatedBefore', 'originalAfter', 'relocatedAfter']) {
      requireProof(media[field].size === media.size && media[field].sha256 === media.sha256);
    }
  }
  function checkPaths(records, flag) {
    requireProof(Array.isArray(records) && records.length === expected.size);
    const seen = new Set();
    for (const item of records) {
      requireProof(expected.get(item.mediaPoolId) === item.name && !seen.has(item.mediaPoolId) && item[flag] === true);
      seen.add(item.mediaPoolId);
    }
  }
  for (const role of ['relocated', 'reopened', 'restored']) {
    parseEffectObservation(bytes[role]);
    const comparison = compareEffectObservations(bytes.baseline, bytes[role]);
    requireProof(bytes.baseline.equals(bytes[role]) && comparison.snapshotChanges.length === 0
      && comparison.effectChanges.length === 0 && comparison.propertyChanges.length === 0 && comparison.trackStateChanges.length === 0);
    requireProof(receipts[role].projectId === report.projectId);
    checkPaths(receipts[role].assets, role === 'restored' ? 'matchesOriginal' : 'matchesRelocated');
    requireProof(role === 'relocated' ? receipts[role].relinkReturnedTrue === true : receipts[role].savedAndReopened === true);
  }
  for (const role of ['commandForward', 'commandReverse']) {
    const result = values[role];
    requireProof(result.schemaVersion === 1 && result.operation === 'resolve-relink-identity-result'
      && result.projectId === report.projectId && result.experimental === true && result.safeToApply === false
      && result.savedAndReopened === true && isDeepStrictEqual(parseEffectObservation(JSON.stringify(result.observation)), baseline));
    checkPaths(result.media, 'pathMatches');
  }
  requireProof(receipts.previousFixture.expectedObservationMatched === true && receipts.previousFixture.proofProjectSaved === true
    && report.previousFixture.expectedObservationMatched === true && report.previousFixture.proofProjectSaved === true
    && report.previousFixture.projectId === receipts.previousFixture.projectId);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, sourceHash: REPORT_HASH,
    projectId: report.projectId, resolveVersion: report.resolveVersion, method: report.method,
    occurrenceCount: items.length, mediaPoolItemCount: groups.size, repeatedMediaGroups: report.repeatedMediaGroups,
    propertyValueCount: report.coverage.propertyValueCount, observedIdentitiesRetained: true,
    relocatedPathsAndReopenVerified: true, originalPathsRestoredAndReopened: true, reusableCommandsVerified: true,
    contentHashCheckLocation: 'node-outside-editor', runtimeContentHashGuard: false,
    fullNativePropertiesVerified: false, stableTrackIdentityProven: false, apiToExportMappingProven: false };
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(auditRelinkIdentity(), null, 2)}\n`); }
  catch { process.stderr.write('relink-identity-audit-failed\n'); process.exitCode = 1; }
}
module.exports = { auditRelinkIdentity };
