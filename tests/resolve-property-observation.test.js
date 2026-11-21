'use strict';
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validateEffectObservation, compareEffectObservations, parseEffectObservation } = require('../src/resolve-effect-observation');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { createEffectCaptureCommand } = require('../src/resolve-effect-console');
const { prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, exportRenameTrialAudit,
  prepareRenameTrialRecovery, readRenameTrialRecoveryCapture, issueRenameTrialRecovery } = require('../src/resolve-rename-trial');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveRevisionManifest, validateResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const contract = require('../src/resolve-property-contract.json');
const fixture = path.join(__dirname, '../phase-0/resolve-xml-proof/live-effects-enabled.json');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
async function rich() {
  const observation = JSON.parse(await fs.readFile(fixture));
  observation.schemaVersion = 2; observation.activeTimelineId = observation.snapshot.timelines[0].id;
  observation.tracks = observation.snapshot.timelines.flatMap(timeline => timeline.tracks.map(track => ({
    timelineId: timeline.id, type: track.type, index: track.index, enabled: true, locked: false })));
  for (const item of observation.items) { item.propertyReadStatus = 'captured'; item.properties = {}; }
  observation.items[0].properties = { TransformEnabled: true, Pan: { decimal: '1.0000000000000001e-01' }, Opacity: { decimal: '9.9500000000000000e+01' } };
  return observation;
}

test('live saved Pan evidence detects exactly one property change and restores the complete richer observation', async () => {
  const directory = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const before = await fs.readFile(path.join(directory, 'live-properties-enabled.json'));
  const changed = await fs.readFile(path.join(directory, 'live-properties-pan-changed.json'));
  const restored = await fs.readFile(path.join(directory, 'live-properties-restored.json'));
  assert.equal(createHash('sha256').update(before).digest('hex'), '903af23882b20e93beb42532b7ac101917d045d7d06d749352b080f9e7d66e21');
  assert.equal(createHash('sha256').update(changed).digest('hex'), 'd181b2cc1c2cd4fd06b97bc388ec245dafcbc7b05ceee085e6c532613f42d7fd');
  assert.deepEqual(before, restored);
  const observation = parseEffectObservation(before), diff = compareEffectObservations(before, changed);
  assert.equal(observation.items.length, 53); assert.equal(observation.tracks.length, 2);
  assert.equal(new Set(observation.items.flatMap(item => Object.keys(item.properties))).size, 43);
  assert(observation.items.every(item => item.propertyReadStatus === 'captured'));
  assert.deepEqual(diff.snapshotChanges, []); assert.deepEqual(diff.effectChanges, []); assert.deepEqual(diff.trackStateChanges, []);
  assert.equal(diff.propertyChanges.length, 1); assert.equal(diff.propertyChanges[0].field, 'Pan');
  assert.deepEqual(diff.propertyChanges[0].before, { decimal: '0.0000000000000000e+00' });
  assert.deepEqual(diff.propertyChanges[0].after, { decimal: '1.3250000000000000e+01' });
  const legacy = { schemaVersion: 1, operation: observation.operation, readOnly: true, safeToApply: false,
    snapshot: observation.snapshot, items: observation.items.map(({ timelineId, itemId, effects }) => ({ timelineId, itemId, effects })) };
  assert.equal(json(legacy) + '\n', await fs.readFile(fixture, 'utf8'));
});

test('rich observations detect decimal properties and track state invisible to legacy captures', async () => {
  const before = await rich(), after = structuredClone(before);
  assert.equal(Object.keys(contract.properties).length, 51);
  after.items[0].properties.Pan.decimal = '2.0000000000000001e-01'; after.tracks[0].locked = true;
  const diff = compareEffectObservations(json(before), json(after));
  assert.deepEqual(diff.snapshotChanges, []); assert.deepEqual(diff.effectChanges, []);
  assert.equal(diff.propertyChanges.length, 1); assert.equal(diff.propertyChanges[0].field, 'Pan');
  assert.deepEqual(diff.propertyChanges[0].before, { decimal: '1.0000000000000001e-01' });
  assert.equal(diff.trackStateChanges.length, 1); assert.equal(diff.trackStateChanges[0].field, 'locked');
  assert.equal(diff.safeToApply, false); assert.equal(diff.propertyCoverage, 'returned-documented-properties-only');
  const legacy = await fs.readFile(fixture);
  const mixed = compareEffectObservations(legacy, json(before));
  assert.equal(mixed.propertyCoverage, 'not-comparable'); assert.equal(mixed.propertyChanges, null);
});

test('property coverage preserves unavailable values and rejects undocumented, malformed or context-invalid evidence', async () => {
  const before = await rich(), absent = structuredClone(before);
  absent.items[0].propertyReadStatus = 'unavailable'; absent.items[0].properties = {};
  assert.equal(validateEffectObservation(absent), absent);
  const diff = compareEffectObservations(json(before), json(absent));
  assert(diff.propertyChanges.some(change => change.field === 'propertyReadStatus'));
  assert(diff.propertyChanges.some(change => change.field === 'Pan' && change.after === null));
  for (const mutate of [value => { delete value.items[0].properties; }, value => value.tracks.pop(),
    value => value.tracks.push(value.tracks[0]), value => { value.activeTimelineId = 'missing'; },
    value => { value.items[0].properties.Mystery = 'do not collect'; },
    value => { value.items[0].properties.TransformEnabled = 'true'; },
    value => { value.items[0].properties.Pan = 0.1; },
    value => { value.items[0].properties.Pan.decimal = '1.0000000000000000e+999'; },
    value => { value.items[0].properties.Pan.decimal = '1.0000000000000000e-999'; },
    value => { value.items[0].properties.TransitionType = '/Users/private'; },
    value => { value.items[0].properties.TransitionAlignment = 'unknown'; },
    value => { value.items[0].propertyReadStatus = 'unavailable'; },
    value => { value.tracks[0].enabled = 'true'; },
    value => { value.activeTimelineId = null; value.items[0].properties.AudioVoiceIsolationAmount = { decimal: '1.0000000000000000e+01' }; }]) {
    const invalid = structuredClone(before); mutate(invalid); assert.throws(() => validateEffectObservation(invalid));
  }
  absent.tracks[0].enabled = null; assert.equal(validateEffectObservation(absent).tracks[0].enabled, null);
});

test('property capture is explicitly opted in and leaves the default effect command on legacy schema', async () => {
  const standard = await createEffectCaptureCommand('Frameline Restore Probe');
  const extended = await createEffectCaptureCommand('Frameline Restore Probe', { includeProperties: true });
  assert(!standard.command.includes('base,{types=')); assert(extended.command.includes('base,{types='));
  assert(extended.command.includes('["Pan"]="decimal"'));
  assert(!extended.command.includes(':SetProperties(')); assert(!extended.command.includes(':SetCurrentTimeline('));
  await assert.rejects(createEffectCaptureCommand('Frameline Restore Probe', { includeProperties: 'true' }));
});

async function issued(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rich-resolve-trial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const observation = await rich(), before = observation.snapshot, incoming = structuredClone(before);
  incoming.timelines[0].items[0].name = 'Rich guarded rename';
  const sources = { base: JSON.stringify(before), local: JSON.stringify(before), incoming: JSON.stringify(incoming) };
  const plan = createResolvePreviewPlan(sources), audit = createResolveDecisionAudit(plan, sources, []);
  const trial = await prepareReviewedRenameTrial({ sources, plan, audit, destinationDir: root, disposableProjectName: before.project_name,
    effectObservationBytes: json(observation) });
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const file = path.join(trial.directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', trial.backupPath, 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: trial.directory }).status, 0);
  const command = await issueRenameTrial({ directory: trial.directory, forceFailure: true });
  assert(command.command.includes('c,{types='));
  return { trial, observation, sources };
}

test('reviewed trials reject changed property results and retain richer evidence in portable revisions', async t => {
  const { trial, observation, sources } = await issued(t), changed = structuredClone(observation);
  changed.items[0].properties.Pan.decimal = '2.0000000000000001e-01';
  await assert.rejects(recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: sources.local,
    effectObservationBytes: json(changed) }));
  await recordRenameTrialResult({ directory: trial.directory, status: 'rolled-back', snapshotBytes: sources.local,
    effectObservationBytes: json(observation) });
  const audit = await exportRenameTrialAudit(trial.directory);
  const manifest = createResolveRevisionManifest(observation.snapshot, audit);
  assert.equal(validateResolveRevisionManifest(manifest), manifest);
  assert.deepEqual(JSON.parse(manifest.transactionAudit.effects.after).items[0].properties, observation.items[0].properties);
});

test('rich recovery requests retain the original capture contract and refuse divergent property inspections', async t => {
  const { trial, observation } = await issued(t), recovery = await prepareRenameTrialRecovery({ directory: trial.directory });
  assert(recovery.command.includes('base,{types='));
  const changed = structuredClone(observation); changed.tracks[0].enabled = false;
  const bytes = json(changed), parts = [];
  for (let index = 0; index < bytes.length; index += 8192) parts.push(bytes.slice(index, index + 8192));
  const consoleOutput = parts.map((part, index) => `FRAMELINE_EFFECT_PART_V1:${recovery.attemptId}:${index + 1}:${parts.length}:${part}`).join('\n');
  const inspection = await readRenameTrialRecoveryCapture({ directory: trial.directory, attemptId: recovery.attemptId, consoleOutput });
  assert.equal(inspection.classification, 'diverged');
  await assert.rejects(issueRenameTrialRecovery({ directory: trial.directory, attemptId: recovery.attemptId }), /manual-recovery-required/);
});

function lua(value) {
  if (value === null) return '{}';
  if (Array.isArray(value)) return `setmetatable({${value.map(lua).join(',')}},{__array=true})`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, field]) => `[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}`;
  return JSON.stringify(value);
}
const library = process.env.FRAMELINE_LUA_LIBRARY || '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
test('vendor Lua runtime executes the read-only supplement, preserves decimal guard bytes and handles unavailable reads',
  { skip: !syncFs.existsSync(library) && 'Set FRAMELINE_LUA_LIBRARY to execute the Lua mock on this host' }, async () => {
    const original = JSON.parse(await fs.readFile(fixture)), source = await fs.readFile(path.join(__dirname, '../src/companion/resolve-effects.lua'), 'utf8');
    const script = `local effects=(function() ${source} end)();local snapshot=${lua(original.snapshot)};local records=${lua(original.items)};
      local project,timelines={},{};local calls=0;
      for ti,descriptor in ipairs(snapshot.timelines) do
        local timeline={};timelines[ti]=timeline;function timeline:GetUniqueId() return descriptor.id end;
        function timeline:GetTrackCount(kind) local n=0;for _,track in ipairs(descriptor.tracks) do if track.type==kind then n=n+1 end end;return n end;
        function timeline:GetIsTrackEnabled(kind,index) return true end;function timeline:GetIsTrackLocked(kind,index) return false end;
        function timeline:GetItemListInTrack(kind,index) local found={};for _,data in ipairs(descriptor.items) do if data.track_type==kind and data.track_index==index then
          local item={};function item:GetUniqueId()return data.id end;
          function item:GetProperties() if data.type=='transition' then error('Unavailable mock property read') end;return {Pan=0.1,Opacity=99.5,TransformEnabled=true} end;
          function item:GetEffects(category) local found={};for _,record in ipairs(records) do if record.itemId==data.id then for _,entry in ipairs(record.effects) do if entry.category==category then
            local effect={};function effect:GetInfo()return {category=entry.category,id=entry.typeId,name=entry.name} end;
            function effect:GetIsEnabled()return entry.enabled end;function effect:GetIndex()return entry.index end;found[#found+1]=effect end end end end;return found end;
          found[#found+1]=item end end;return found end;
      end;
      function project:GetTimelineCount()return #timelines end;function project:GetTimelineByIndex(index)return timelines[index] end;
      function project:GetCurrentTimeline()return timelines[1] end;
      local manager={};function manager:GetCurrentProject()return project end;local resolve={};function resolve:GetProjectManager()return manager end;
      local base={capture=function()return snapshot end,encode=effects.encode,array=function()return setmetatable({},{__array=true})end};
      local observed=effects.capture(resolve,base,${propertyCaptureConfig()});print(effects.encode(observed));`;
    const run = runVendorLuaMock(script, {library, maxBuffer: 4 * 1024 * 1024});
    assert.equal(run.status, 0, run.stderr);
    const observation = parseEffectObservation(run.stdout.trimEnd());
    assert.equal(observation.schemaVersion, 2); assert.equal(observation.items.length, 53);
    assert.equal(observation.items[0].properties.Pan.decimal, '1.0000000000000001e-01');
    assert(observation.items.some(item => item.propertyReadStatus === 'unavailable'));
    assert.equal(run.stdout.trimEnd(), json(observation));
    const legacy = runVendorLuaMock(script.replace(`effects.capture(resolve,base,${propertyCaptureConfig()})`, 'effects.capture(resolve,base)'), {library, maxBuffer: 4 * 1024 * 1024});
    assert.equal(legacy.status, 0, legacy.stderr); assert.equal(legacy.stdout.trimEnd(), json(original));
    const unknown = runVendorLuaMock(script.replace('return {Pan=0.1,Opacity=99.5,TransformEnabled=true}', 'return {UndocumentedSecret="Never emit this value"}'), {library, maxBuffer: 4 * 1024 * 1024});
    assert.notEqual(unknown.status, 0); assert(!unknown.stdout.includes('Never emit this value'));
    const switched = runVendorLuaMock(script.replace('function project:GetCurrentTimeline()return timelines[1] end',
        'function project:GetCurrentTimeline()calls=calls+1;if calls==1 then return timelines[1] end;return nil end'), {library, maxBuffer: 4 * 1024 * 1024});
    assert.notEqual(switched.status, 0);
  });
