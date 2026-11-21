'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runVendorLuaMock } = require('../phase-0/run-vendor-lua-mock');
const { validateItemStateObservation, parseItemStateObservation, compareItemStateObservations, describeItemStateCoverage } = require('../src/resolve-item-state-observation');
const { createItemStateCaptureCommand, readItemStateConsoleResult } = require('../src/resolve-item-state-console');
const root = path.resolve(__dirname, '..');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const json = value => JSON.stringify(value);
const captured = value => ({ status: 'captured', value });

function fixture() {
  return { schemaVersion: 1, operation: 'resolve-item-state-observation', readOnly: true, safeToApply: false,
    snapshot: { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'project', project_name: 'Disposable', timelines: [{
      id: 'timeline', name: 'Timeline', start_frame: 0, tracks: [{ type: 'video', index: 1, name: 'Video' }], items: [{
        id: 'item', track_type: 'video', track_index: 1, type: 'video', name: 'Clip', start_frame: 0, end_frame: 24,
        source_start_frame: 0, source_end_frame: 23, media_pool_id: null, linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 }
      }] }] }, activeTimelineId: 'timeline', capturePasses: 2, representedStateUnchangedAcrossReads: true,
    colorGraphScope: 'first-layer-count-only', capturePage: 'color', colorGraphReadPolicy: 'color-page-only', readOrderPolicy: 'color-graph-before-item-state', items: [{ timelineId: 'timeline', itemId: 'item', clipEnabled: captured(true),
      speed: captured({ Percentage: { decimal: '1.0000000000000000e+02' }, PitchCorrection: false }),
      fades: captured({ FadeIn: 0, FadeOut: 12 }), outputBlanking: captured({}), usesTimelineOutputBlanking: captured(true),
      fusionCompCount: captured(0), firstColorLayerNodeCount: { status: 'unavailable', value: null } }] };
}

test('supplement distinguishes captured false/zero, returned empty dictionaries and unavailable reads', () => {
  const observed = fixture(); observed.items[0].clipEnabled.value = false;
  assert.equal(validateItemStateObservation(observed), observed);
  const coverage = describeItemStateCoverage(observed);
  assert.equal(coverage.reads.clipEnabled.captured, 1);
  assert.equal(coverage.reads.firstColorLayerNodeCount.unavailable, 1);
  assert.equal(coverage.reads.outputBlanking.captured, 1);
  assert.deepEqual(coverage.reads.outputBlanking.returnedKeys, { Top: 0, Bottom: 0, Left: 0, Right: 0 });
  assert.equal(coverage.completeEditorStateObserved, false);
});

test('comparison detects enabled/speed/fade/blanking/graph changes absent from schema 3', () => {
  const before = fixture(), after = fixture();
  after.items[0].clipEnabled.value = false;
  after.items[0].speed.value.Percentage.decimal = '5.0000000000000000e+01';
  after.items[0].fades.value.FadeIn = 8;
  after.items[0].outputBlanking.value.Top = 120;
  after.items[0].firstColorLayerNodeCount = captured(2);
  const diff = compareItemStateObservations(json(before), json(after));
  assert.deepEqual(diff.snapshotChanges, []);
  assert.deepEqual(diff.itemStateChanges.map(row => row.field), ['clipEnabled', 'speed', 'fades', 'outputBlanking', 'firstColorLayerNodeCount']);
  assert.equal(diff.safeToApply, false); assert.equal(diff.losslessRoundTripProven, false);
  assert.match(diff.sourceHashes.before, /^[0-9a-f]{64}$/);
  assert.notEqual(diff.sourceHashes.before, diff.sourceHashes.after);
});

test('decimal equivalence preserves digits and missing keys are not substituted with defaults', () => {
  const before = fixture(), after = fixture();
  after.items[0].speed.value.Percentage.decimal = '1.0000000000000000e+002';
  assert.deepEqual(compareItemStateObservations(json(before), json(after)).itemStateChanges, []);
  delete after.items[0].speed.value.PitchCorrection;
  assert.equal(compareItemStateObservations(json(before), json(after)).itemStateChanges.length, 1);
  after.items[0].speed = { status: 'unavailable', value: null };
  assert.equal(compareItemStateObservations(json(before), json(after)).afterCoverage.reads.speed.unavailable, 1);
});

test('strict validation rejects unbound membership, malformed reads, undocumented fields and paths', () => {
  const edits = [
    value => { value.items[0].itemId = 'unknown'; },
    value => { value.items.push(structuredClone(value.items[0])); },
    value => { value.items[0].speed.value.MediaPath = '/Users/private'; },
    value => { value.items[0].firstColorLayerNodeCount = captured(-1); },
    value => { value.items[0].clipEnabled = captured('true'); },
    value => { value.items[0].speed = { status: 'unavailable', value: {} }; },
    value => { value.items[0].speed.value.Percentage.decimal = '1e2'; },
    value => { value.activeTimelineId = 'missing'; },
    value => { value.snapshot.timelines[0].items[0].name = '/private/source'; },
    value => { value.safeToApply = true; }
  ];
  for (const edit of edits) { const value = fixture(); edit(value); assert.throws(() => parseItemStateObservation(json(value))); }
  const getter = fixture(); Object.defineProperty(getter.items[0], 'speed', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => validateItemStateObservation(getter), /invalid-item-state-observation/);
  const other = fixture(); other.snapshot.project_id = 'other';
  assert.throws(() => compareItemStateObservations(json(fixture()), json(other)), /item-state-project-mismatch/);
});

test('console transport is ordered, nonce-bound, bounded and rejects capture errors', async () => {
  const prepared = await createItemStateCaptureCommand('Disposable');
  assert.equal(prepared.maxItems, 50); assert.equal(prepared.safeToApply, false);
  const raw = json(fixture()), output = `FRAMELINE_ITEM_STATE_PART_V1:${prepared.captureId}:1:1:${raw}`;
  assert.equal(readItemStateConsoleResult({ captureId: prepared.captureId, output }), `${raw}\n`);
  assert.throws(() => readItemStateConsoleResult({ captureId: 'f'.repeat(32), output }));
  assert.throws(() => readItemStateConsoleResult({ captureId: prepared.captureId, output: `${output}\n${output}` }));
  assert.throws(() => readItemStateConsoleResult({ captureId: prepared.captureId, output: `${output}\nFRAMELINE_ITEM_STATE_ERROR_V1:${prepared.captureId}` }));
  await assert.rejects(createItemStateCaptureCommand('/Users/private'));
  await assert.rejects(createItemStateCaptureCommand('Disposable', { maxItems: 201 }));
  assert(!/:(SaveProject|LoadProject|CloseProject|SetName|SetSpeed|SetFades|SetClipEnabled|SetCurrentTimeline)\(/.test(prepared.command));
});

const prefix = `local core_calls=0;local enabled_calls=0;local unstable=false;local unknown=false;local unavailable=false
local item={};function item:GetUniqueId()core_calls=core_calls+1;return 'item' end
function item:GetName()return 'Clip' end;function item:GetType()return 'video' end
function item:GetStart()return 0 end;function item:GetEnd()return 24 end
function item:GetSourceStartFrame()return 0 end;function item:GetSourceEndFrame()return 23 end
function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return {} end;function item:GetEffects()return {__flags=0} end
function item:GetClipEnabled()enabled_calls=enabled_calls+1;return not (unstable and enabled_calls>1) end
function item:GetSpeed()if unavailable then error('API read unavailable') end;if unknown then return {MediaPath='/Users/private'} end;return {Percentage=100,PitchCorrection=false,__flags=0} end
function item:GetFades()return {FadeIn=0,FadeOut=12} end;function item:GetOutputBlanking()return {__flags=0} end
function item:GetUseTimelineForOutputBlanking()return true end;function item:GetFusionCompCount()return 0 end
function item:GetNodeGraph()return nil end
local timeline={};function timeline:GetUniqueId()return 'timeline' end;function timeline:GetName()return 'Timeline' end
function timeline:GetStartFrame()return 0 end;function timeline:GetTrackCount(kind)return kind=='video' and 1 or 0 end
function timeline:GetTrackName()return 'Video' end;function timeline:GetItemListInTrack()return {item} end
local project={};function project:GetName()return 'Disposable' end;function project:GetUniqueId()return 'project' end
function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end
function project:GetCurrentTimeline()return timeline end
local manager={};function manager:GetCurrentProject()return project end
resolve={};function resolve:GetProjectManager()return manager end;function resolve:GetVersionString()return '21.1.2.10' end;function resolve:GetCurrentPage()return'edit'end;`;

test('actual vendor Lua captures omitted fields and refuses hidden-state instability, unknown values and oversize projects',
  { skip: !fs.existsSync(library) && 'Vendor Lua library unavailable' }, async () => {
    const prepared = await createItemStateCaptureCommand('Disposable', { maxItems: 1 });
    const run = setup => runVendorLuaMock(`${prefix}\n${setup}\n${prepared.command}\nprint('CORE_CALLS:'..core_calls)`, { library, maxBuffer: 4 * 1024 * 1024 });
    const good = run(''); assert.equal(good.status, 0, good.stderr);
    const captured = parseItemStateObservation(readItemStateConsoleResult({ captureId: prepared.captureId, output: good.stdout }));
    assert.deepEqual(captured.items[0].outputBlanking, { status: 'captured', value: {} });
    assert.deepEqual(captured.items[0].firstColorLayerNodeCount, { status: 'unavailable', value: null });
    assert.equal(captured.items[0].speed.value.Percentage.decimal, '1.0000000000000000e+02');
    const unavailable = run('unavailable=true;');
    assert.equal(parseItemStateObservation(readItemStateConsoleResult({ captureId: prepared.captureId, output: unavailable.stdout })).items[0].speed.status, 'unavailable');
    for (const setup of ['unstable=true;', 'unknown=true;', "function project:GetName()return 'Other' end",
      "function item:GetFades()return {FadeIn='12'} end", 'function project:GetTimelineCount()return 21 end',
      "function timeline:GetTrackCount(kind)return 201 end"]) {
      const bad = run(setup); assert.equal(bad.status, 0); assert(bad.stdout.includes(`FRAMELINE_ITEM_STATE_ERROR_V1:${prepared.captureId}`));
      assert(!bad.stdout.includes('/Users/private'));
      assert.throws(() => readItemStateConsoleResult({ captureId: prepared.captureId, output: bad.stdout }));
    }
    const large = run('function timeline:GetItemListInTrack()return {item,item} end;');
    assert(large.stdout.includes('CORE_CALLS:0')); assert(large.stdout.includes(`FRAMELINE_ITEM_STATE_ERROR_V1:${prepared.captureId}`));
  });
