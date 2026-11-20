'use strict';
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { inventory } = require('../src/resolve-integration-inspection');
const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const resultFile = 'phase-0/resolve-menu-inventory-live-result.json.gz';
const resultSha256 = '06566f0889aa617192271240a24b7aed5804a56397b9c5f4b15207a17b4a4128';

function auditMenuInventoryEvidence(read = readInput) {
  const compressed = read(path.join(root, resultFile));
  const raw = gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
  if (hash(raw) !== resultSha256) throw new Error('menu-inventory-evidence-changed');
  const result = JSON.parse(raw);
  if (result.operation !== 'resolve-menu-inventory' || result.schemaVersion !== 1 || result.readOnly !== true
    || result.safeToApply !== false || result.capturePasses !== 2 || result.representedStateUnchangedAcrossReads !== true
    || result.cpuTimeStatus !== 'captured' || !Number.isSafeInteger(result.cpuMicros) || result.cpuMicros < 0) throw new Error('invalid-menu-inventory-evidence');
  validateResolveSnapshot(result.snapshot);
  const snapshotBytes = Buffer.from(JSON.stringify(canonical(result.snapshot)));
  const inspected = inventory(snapshotBytes);
  const counts = inspected.timelines.map(timeline => timeline.items).sort((a, b) => a - b);
  if (JSON.stringify(counts) !== '[50,500,10000]' || result.snapshot.project_id !== '96752d7b-7fa0-4d51-aa56-80db8f18c5c6') throw new Error('menu-inventory-fixture-mismatch');
  return { schemaVersion: 1, readOnly: true, safeToApply: false, resultFile, resultSha256,
    compressedSha256: hash(compressed), snapshotCanonicalSha256: hash(snapshotBytes), resultBytes: raw.length,
    projectId: result.snapshot.project_id, timelineCount: counts.length, timelineItemCounts: counts,
    itemCount: counts.reduce((sum, count) => sum + count, 0), observedTracks: inspected.timelines.reduce((sum, timeline) => sum + timeline.tracks, 0),
    capturePasses: 2, representedStateUnchangedAcrossReads: true, cpuMicros: result.cpuMicros,
    cpuTimeScope: 'Process CPU across two API reads and encoding; includes other active editor threads and does not measure wall time or writes.',
    inventory: inspected, completeEnumerationProven: false, stableTrackIdentityProven: false, losslessRoundTripProven: false };
}

module.exports = { auditMenuInventoryEvidence };
