'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventory, inspectIdentity, fieldCoverage, inspectPreservation } = require('../src/resolve-integration-inspection');
const { inspectApi, reference } = require('../phase-0/inspect-resolve-api');
const { readInput, auditIntegrationGates } = require('../phase-0/integration-gates');
const { inspectCorpus, catalog } = require('../phase-0/integration-corpus');
const { benchmark } = require('../phase-0/benchmark-integration');
const { auditMenuInventoryEvidence } = require('../phase-0/menu-inventory-evidence');
const bytes = value => Buffer.from(JSON.stringify(value));
const live = name => fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof', name));

function fixture() {
  const item = (id, track) => ({ id, track_type: 'video', track_index: track, type: 'video', name: 'Repeated name',
    start_frame: 0, end_frame: 24, source_start_frame: 0, source_end_frame: 24, media_pool_id: 'same-source',
    linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } });
  return { schemaVersion: 2, operation: 'resolve-effect-observation', readOnly: true, safeToApply: false,
    snapshot: { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'project', project_name: 'Disposable',
      timelines: [{ id: 'timeline', name: 'Timeline', start_frame: 0,
        tracks: [1, 2, 3].map(index => ({ type: 'video', index, name: 'Same track name' })), items: [item('a', 1), item('b', 2)] }] },
    activeTimelineId: 'timeline', items: ['a', 'b'].map(itemId => ({ timelineId: 'timeline', itemId, effects: [],
      propertyReadStatus: 'captured', properties: { Pan: { decimal: '0.0000000000000000e+00' }, TransformEnabled: true } })),
    tracks: [1, 2, 3].map(index => ({ timelineId: 'timeline', type: 'video', index, enabled: true, locked: false })) };
}

test('enumeration recomputes the mixed live fixture without claiming complete coverage', () => {
  const report = inventory(live('live-properties-enabled.json'));
  assert.deepEqual(report.timelines[0].itemTypes, { audio: 49, transition: 1, video: 3 });
  assert.equal(report.timelines[0].reciprocalLinkEdges, 1);
  assert.equal(report.timelines[0].effectSlots, 1);
  assert.deepEqual(report.timelines[0].linkIssues, []);
  assert.equal(report.completeEnumerationProven, false);
  assert.equal(report.safeToApply, false);
  const asymmetric = fixture(); asymmetric.snapshot.timelines[0].items[0].linked_item_ids = ['b'];
  assert.deepEqual(inventory(bytes(asymmetric)).timelines[0].linkIssues, [{ itemId: 'a', linkedId: 'b', reason: 'not-reciprocal' }]);
});

test('identity witnesses follow retained IDs across track indexes while empty tracks stay unresolved', () => {
  const before = fixture(), after = fixture();
  after.snapshot.timelines[0].items[0].track_index = 2;
  after.snapshot.timelines[0].items[1].track_index = 1;
  after.snapshot.timelines[0].tracks.forEach(track => { track.name = 'Renamed'; });
  const report = inspectIdentity(bytes(before), bytes(after));
  assert.deepEqual(report.timelineChanges[0].retainedItemIds, ['a', 'b']);
  assert.equal(report.trackWitnesses[0].candidates[0].index, 2);
  assert.equal(report.trackWitnesses[1].candidates[0].index, 1);
  assert.equal(report.trackWitnesses[2].status, 'unresolved');
  assert.equal(report.stableTrackIdentityProven, false);
  assert.equal(report.durableExportMappingProven, false);
});

test('raw schema-3 menu snapshots support inventory and identity without gaining supplementary coverage', () => {
  const observation = fixture(), snapshot = observation.snapshot;
  const report = inventory(bytes(snapshot));
  assert.equal(report.timelines[0].items, 2);
  assert.equal(report.effectMetadataObserved, false); assert.equal(report.propertyMetadataObserved, false);
  assert.equal(report.completeEnumerationProven, false);
  const identity = inspectIdentity(bytes(snapshot), bytes(observation));
  assert.deepEqual(identity.timelineChanges[0].retainedItemIds, ['a', 'b']);
  assert.equal(identity.stableTrackIdentityProven, false);
  assert.throws(() => inspectPreservation(bytes(snapshot), bytes(snapshot)));
});

test('split membership, removed IDs and added IDs never manufacture track identity', () => {
  const before = fixture(), after = fixture();
  before.snapshot.timelines[0].items[1].track_index = 1;
  assert.equal(inspectIdentity(bytes(before), bytes(after)).trackWitnesses[0].status, 'split-membership');
  after.snapshot.timelines[0].items[0].id = 'new-a'; after.items[0].itemId = 'new-a';
  const report = inspectIdentity(bytes(before), bytes(after));
  assert.deepEqual(report.timelineChanges[0].removedItemIds, ['a']);
  assert.deepEqual(report.timelineChanges[0].addedItemIds, ['new-a']);
  assert.equal(report.trackWitnesses[0].candidateCount, 1);
  assert.deepEqual(report.trackWitnesses[0].candidates[0].sharedItemIds, ['b']);
});

test('membership witnesses do not collide on item IDs reused in different timelines', () => {
  const before = fixture();
  const timeline = structuredClone(before.snapshot.timelines[0]); timeline.id = 'other';
  before.snapshot.timelines.push(timeline);
  before.items.push(...before.items.map(item => ({ ...structuredClone(item), timelineId: 'other' })));
  before.tracks.push(...before.tracks.map(track => ({ ...track, timelineId: 'other' })));
  const after = structuredClone(before); after.snapshot.timelines[1].items[0].track_index = 3;
  const report = inspectIdentity(bytes(before), bytes(after));
  assert.equal(report.trackWitnesses.find(t => t.timelineId === 'timeline' && t.index === 1).candidates[0].index, 1);
  assert.equal(report.trackWitnesses.find(t => t.timelineId === 'other' && t.index === 1).candidates[0].index, 3);
});

test('cross-project, invalid-version, duplicate IDs and undeclared data fail before inspection', () => {
  const before = fixture();
  for (const operation of [inspectIdentity, inspectPreservation]) {
    const after = fixture(); after.snapshot.project_id = 'different';
    assert.throws(() => operation(bytes(before), bytes(after)), /integration-project-mismatch/);
  }
  for (const edit of [o => { o.snapshot.resolve_version = '22'; }, o => { o.snapshot.timelines[0].items[1].id = 'a'; },
    o => { o.snapshot.timelines[0].items[0].path = '/Users/private'; }]) {
    const changed = fixture(); edit(changed);
    assert.throws(() => inventory(bytes(changed)));
  }
});

test('field coverage counts keys per item without promoting union coverage or inferring defaults', () => {
  const before = fixture(); delete before.items[1].properties.Pan;
  const report = fieldCoverage(bytes(before));
  assert.deepEqual(report.keys.find(row => row.name === 'Pan'), { name: 'Pan', observedItems: 1, unobservedItems: 1, activeTimelineOnly: false });
  assert(report.items[1].unobservedDocumentedKeys.includes('Pan'));
  assert(!report.items[0].unobservedDocumentedKeys.includes('Pan'));
  assert(report.items.every(item => item.unobservedDocumentedKeys.includes('TransitionType')));
  assert.equal(report.keys.find(row => row.name === 'AudioVoiceIsolationAmount').activeTimelineOnly, true);
});

test('live Pan divergence is rejected by represented preservation and exact restoration remains bounded', () => {
  const before = live('live-properties-enabled.json');
  const changed = inspectPreservation(before, live('live-properties-pan-changed.json'));
  assert.equal(changed.propertyChanges.length, 1); assert.equal(changed.propertyChanges[0].field, 'Pan');
  assert.equal(changed.representedStateMatches, false);
  const restored = inspectPreservation(before, live('live-properties-restored.json'));
  assert.equal(restored.representedStateMatches, true);
  assert.equal(restored.representedReadsAvailable, true);
  assert.equal(restored.losslessRoundTripProven, false);
});

test('one explicit rename allowlist does not hide unrelated clip, property, or project changes', () => {
  const before = fixture(), after = fixture(); after.snapshot.timelines[0].items[0].name = 'Renamed';
  const options = { expectedRename: { timelineId: 'timeline', itemId: 'a', before: 'Repeated name', after: 'Renamed' } };
  assert.equal(inspectPreservation(bytes(before), bytes(after)).representedStateMatches, false);
  assert.equal(inspectPreservation(bytes(before), bytes(after), options).representedStateMatches, true);
  after.snapshot.timelines[0].items[1].name = 'Another edit';
  assert.equal(inspectPreservation(bytes(before), bytes(after), options).representedStateMatches, false);
  after.snapshot.timelines[0].items[1].name = 'Repeated name'; after.snapshot.project_name = 'Changed project name';
  const report = inspectPreservation(bytes(before), bytes(after), options);
  assert.equal(report.representedStateMatches, false); assert.equal(report.projectChanges.length, 1);
  assert.throws(() => inspectPreservation(bytes(before), bytes(before), options), /expected-rename-mismatch/);
  assert.throws(() => inspectPreservation(bytes(before), bytes(after), { expectedRename: { ...options.expectedRename, allowEverything: true } }), /invalid-expected-rename/);
});

test('missing reads and disappearing fields cannot become a preservation claim', () => {
  const before = fixture(), after = fixture(); delete after.items[0].properties.Pan;
  assert.equal(inspectPreservation(bytes(before), bytes(after)).representedStateMatches, false);
  const unavailable = fixture(); unavailable.items[0].propertyReadStatus = 'unavailable'; unavailable.items[0].properties = {};
  assert.equal(inspectPreservation(bytes(unavailable), bytes(unavailable)).representedReadsAvailable, false);
  unavailable.tracks[0].locked = null;
  assert.equal(fieldCoverage(bytes(unavailable)).unobservedTrackStates, 1);
  const legacy = JSON.parse(live('live-effects-enabled.json'));
  assert.equal(fieldCoverage(bytes(legacy)).status, 'unobserved');
  assert.equal(inspectPreservation(bytes(legacy), bytes(legacy)).representedStateMatches, false);
});

test('collection order and equivalent decimals do not create false preservation differences', () => {
  const before = fixture(), after = fixture();
  after.items.reverse(); after.tracks.reverse(); after.snapshot.timelines[0].items.reverse(); after.snapshot.timelines[0].tracks.reverse();
  after.items[0].properties.Pan.decimal = '-0.0000000000000000e+00';
  assert.equal(inspectPreservation(bytes(before), bytes(after)).representedStateMatches, true);
  assert.deepEqual(inspectIdentity(bytes(before), bytes(before)).trackWitnesses, inspectIdentity(bytes(after), bytes(before)).trackWitnesses);
});

test('corpus checks all four exact exports and fails on changed compressed bytes', () => {
  const report = inspectCorpus();
  assert.deepEqual(report.entries.map(entry => entry.expected.clips), [1, 50, 500, 10000]);
  assert.equal(report.releaseSupportRange, null); assert.equal(report.releaseVersionCoverageProven, false);
  const read = filename => filename.endsWith('.gz') ? Buffer.from('changed') : fs.readFileSync(filename);
  assert.throws(() => inspectCorpus(read), /corpus-storage-changed/);
  assert.equal(catalog.target.build, '21.1.20010');
});

test('pinned local SDK recomputes method availability without claiming runtime support', () => {
  const saved = require('../phase-0/resolve-api-capabilities.json');
  assert.equal(saved.referenceSha256, require('../src/resolve-property-contract.json').referenceSha256);
  assert(saved.methods.TimelineItem.includes('GetUniqueId'));
  assert(saved.methods.TimelineItem.includes('GetFades'));
  assert.deepEqual(saved.documentedTrackIdentityAccessor, []);
  assert.deepEqual(saved.documentedEffectParameterAccessors, []);
  assert.throws(() => inspectApi(Buffer.from('class Timeline:')), /api-reference-changed/);
  if (fs.existsSync(reference)) assert.deepEqual(inspectApi(fs.readFileSync(reference)), saved);
});

test('bounded input reader refuses symlinks, directories and oversize inputs; CLI errors do not expose filenames', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-integration-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private.json'); fs.writeFileSync(file, bytes(fixture()));
  assert.deepEqual(readInput(file), fs.readFileSync(file));
  fs.symlinkSync(file, path.join(directory, 'alias.json'));
  assert.throws(() => readInput(path.join(directory, 'alias.json')));
  assert.throws(() => readInput(directory));
  const huge = path.join(directory, 'oversize.json'); fs.closeSync(fs.openSync(huge, 'wx')); fs.truncateSync(huge, 24 * 1024 * 1024 + 1);
  assert.throws(() => readInput(huge), /input-invalid/);
  const run = spawnSync(process.execPath, [path.join(__dirname, '../phase-0/integration-gates.js'), 'inventory', path.join(directory, 'secret-missing')], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.equal(run.stdout, ''); assert.equal(run.stderr, 'resolve-integration-inspection-failed\n');
  if (process.platform !== 'win32') {
    const fifo = path.join(directory, 'fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const piped = spawnSync(process.execPath, [path.join(__dirname, '../phase-0/integration-gates.js'), 'inventory', fifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(piped.error, undefined); assert.equal(piped.status, 1);
    assert.equal(piped.stderr, 'resolve-integration-inspection-failed\n');
  }
});

test('five-gate audit is repeatable, path-free and keeps unresolved checkboxes open', () => {
  const a = auditIntegrationGates(), b = auditIntegrationGates();
  assert.deepEqual(a, b); assert.equal(a.gates.length, 5);
  assert.deepEqual(a.gates.map(g => g.status), ['blocked', 'not-required', 'blocked', 'partial', 'blocked']);
  assert.equal(a.safeToApply, false); assert.equal(a.releaseSupported, false);
  assert(!JSON.stringify(a).includes('/Users/'));
});

test('retained gate and benchmark observations remain bound to their named evidence', () => {
  const recorded = require('../phase-0/integration-gates-observation.json');
  const current = auditIntegrationGates();
  assert.deepEqual(recorded.sourceHashes, current.sourceHashes);
  assert.equal(recorded.firstEditorAuditSha256, current.firstEditorAuditSha256);
  assert.equal(recorded.firstEditorAuditSha256, require('../phase-0/editor-integration-decision.json').auditSha256);
  assert.equal(recorded.newRoadmapCheckboxesCompleted, 0); assert.equal(recorded.newLiveEditorRun, true);
  assert.deepEqual(recorded.nativeMenuInventory, current.nativeMenuInventory);
  assert.deepEqual(recorded.gates, current.gates);
  assert.equal(recorded.preservation.losslessRoundTripProven, false);
  const measured = require('../phase-0/integration-benchmark-observation.json');
  assert.equal(measured.results.length, 12);
  assert.equal(measured.editorWrite, null); assert.equal(measured.editorReopen, null);
  for (const result of measured.results) {
    assert(catalog.entries.some(entry => entry.sourceSha256 === result.sourceSha256 && entry.expected.clips === result.clips));
    assert(result.sourceUnchanged && result.elapsedMs >= 0 && result.processCpuMicros.user >= 0 && result.processCpuMicros.system >= 0);
    assert.equal(result.cacheHit, result.mode === 'cached-rescan');
  }
});

test('native menu evidence verifies the entire retained result while leaving five gates open', () => {
  const report = auditMenuInventoryEvidence();
  assert.deepEqual(report.timelineItemCounts, [50, 500, 10000]); assert.equal(report.itemCount, 10550);
  assert.equal(report.observedTracks, 6); assert.equal(report.capturePasses, 2);
  assert.equal(report.cpuMicros, 33156233); assert.equal(report.resultBytes, 3558671);
  assert.equal(report.inventory.effectMetadataObserved, false);
  assert.equal(report.completeEnumerationProven, false); assert.equal(report.safeToApply, false);
  const { gzipSync } = require('node:zlib');
  assert.throws(() => auditMenuInventoryEvidence(() => gzipSync(Buffer.from('{}'))), /evidence-changed/);
});

test('benchmark verifies fresh/cache scans, preserves sources and leaves native write timings unavailable', async () => {
  const result = await benchmark({ iterations: 1 });
  assert.equal(result.results.length, 4);
  assert(result.results.every(row => row.clips <= 50 && row.sourceUnchanged && row.elapsedMs >= 0));
  assert.deepEqual(result.results.map(row => row.cacheHit), [false, true, false, true]);
  assert.equal(result.editorWrite, null); assert.equal(result.editorReopen, null); assert.equal(result.fullGateCompleted, false);
  await assert.rejects(benchmark({ iterations: 11 }), /invalid-integration-benchmark-options/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(benchmark({ iterations: 1, signal: controller.signal }), { code: 'scan-cancelled' });
});
