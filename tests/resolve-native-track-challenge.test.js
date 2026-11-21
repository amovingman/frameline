'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runVendorLuaMock } = require('../phase-0/run-vendor-lua-mock');
const { planObservation, renderChallenge, verifyNativeRetention } = require('../phase-0/prepare-native-track-challenge');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const projectName = 'Frameline Integration Gate Fixture 20261120';
const P = '10000000-0000-4000-8000-000000000001', T = '10000000-0000-4000-8000-000000000002';
const lua = value => value === null ? '{}' : Array.isArray(value) ? `setmetatable({${value.map(lua).join(',')}},{__array=true})`
  : typeof value === 'object' ? `{${Object.entries(value).map(([key, field]) => `[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}` : JSON.stringify(value);
function fixture() {
  const tracks = [['video', 1], ['video', 2], ['video', 3], ['audio', 1], ['audio', 2]].map(([type, index]) => ({ type, index, name: 'Same Track' }));
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    track_type: 'video', track_index: 1, type: 'video', name: 'Repeated clip', start_frame: index * 24, end_frame: (index + 1) * 24,
    source_start_frame: 0, source_end_frame: 24, media_pool_id: null, linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }));
  return { schemaVersion: 2, operation: 'resolve-effect-observation', readOnly: true, safeToApply: false,
    snapshot: { schema_version: 3, resolve_version: '21.1.2.10', project_id: P, project_name: projectName,
      timelines: [{ id: T, name: 'Timeline', start_frame: 0, tracks, items }] }, activeTimelineId: T,
    items: items.map(item => ({ timelineId: T, itemId: item.id, effects: [], propertyReadStatus: 'captured',
      properties: { Pan: { decimal: '0.0000000000000000e+00' }, TransformEnabled: true } })),
    tracks: tracks.map(track => ({ timelineId: T, type: track.type, index: track.index, enabled: true, locked: false })) };
}
function record() {
  return { ...planObservation(Buffer.from(JSON.stringify(fixture())), 'a'.repeat(32)), projectId: P, probeId: 'a'.repeat(32),
    resultPath: '/private/tmp/track-proof-test/result.json', markerPath: '/private/tmp/track-proof-test/complete.txt',
    backupPath: '/private/tmp/track-proof-test/backup.drp', backupBytes: 32,
    exports: { before: '/private/tmp/track-proof-test/before.drp', challenged: '/private/tmp/track-proof-test/challenged.drp', restored: '/private/tmp/track-proof-test/restored.drp' } };
}
test('track challenge plan is confined to complete richer fifty-item disposable source and five observed tracks', () => {
  const plan = record(); assert.equal(plan.bindings.length, 5);
  assert(plan.bindings.every(row => /^Frameline-TrackProof-a{32}-(video|audio)-[1-3]$/.test(row.challengeName)));
  assert(plan.observation.snapshot.timelines[0].tracks.every(track => track.name === 'Same Track'));
  assert(plan.challenged.snapshot.timelines[0].tracks.every(track => track.name.startsWith('Frameline-TrackProof-')));
  for (const mutate of [value => { value.snapshot.project_name = 'Real user project'; }, value => { value.items[0].properties = {}; },
    value => { value.tracks[0].locked = null; }]) {
    const value = fixture(); mutate(value); assert.throws(() => planObservation(Buffer.from(JSON.stringify(value)), 'a'.repeat(32)));
  }
});

test('native retention requires exact UUID parentage through name changes and restored names', () => {
  const before = { timelines: [{ timelineId: T, tracks: [{ nativeTrackId: 'track', kind: 'video', nativeOrdinal: 1,
    itemIds: ['item'], nameSha256: 'original' }, { nativeTrackId: 'empty', kind: 'audio', nativeOrdinal: 1, itemIds: [], nameSha256: 'same' }] }] };
  const challenged = structuredClone(before); challenged.timelines[0].tracks.forEach(track => { track.nameSha256 = 'challenge'; });
  challenged.apiBindings = [{ itemCount: 1 }, { itemCount: 0 }];
  const graphs = { before, challenged, restored: structuredClone(before) };
  assert.equal(verifyNativeRetention(before, graphs).emptyTrackChallengeBindings, 1);
  assert.equal(verifyNativeRetention(before, graphs).stableTrackIdentityProven, false);
  graphs.restored.timelines[0].tracks[1].nativeTrackId = 'recreated';
  assert.throws(() => verifyNativeRetention(before, graphs), /retention-failed/);
});

test('actual vendor Lua challenge saves/reopens, restores names and rolls back a partial rename failure',
  { skip: !fs.existsSync(library) && 'Vendor Lua unavailable' }, async () => {
    const plan = record(), source = await renderChallenge(plan), descriptor = fixture().snapshot;
    const prefix = `local data=${lua(descriptor)};local names={};for _,v in ipairs(data.timelines[1].tracks)do names[v.type..':'..v.index]=v.name end
      local files={[${JSON.stringify(plan.backupPath)}]=string.rep('b',32)};local saves,renames,closed=0,0,false;local fail_at=0;local source_pan=0
      local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]='' end
        local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end;function h:Flush()return true end;function h:Close()end
        function h:GetFileSize()return #files[name] end;function h:ReadLine()if self.offset>#files[name]then return nil end;local v=files[name]:sub(self.offset);self.offset=#files[name]+1;return v end;return h end
      local timeline={};function timeline:GetUniqueId()return data.timelines[1].id end;function timeline:GetName()return 'Timeline' end;function timeline:GetStartFrame()return 0 end
      function timeline:GetTrackCount(kind)local count=0;for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind then count=count+1 end end;return count end
      function timeline:GetTrackName(kind,index)return names[kind..':'..index] end
      function timeline:SetTrackName(kind,index,value)renames=renames+1;if renames==fail_at then return false end;names[kind..':'..index]=value;return true end
      function timeline:GetIsTrackEnabled()return true end;function timeline:GetIsTrackLocked()return false end
      function timeline:GetItemListInTrack(kind,index)local result={};for _,v in ipairs(data.timelines[1].items)do if v.track_type==kind and v.track_index==index then
        local item={};function item:GetUniqueId()return v.id end;function item:GetType()return v.type end;function item:GetName()return v.name end
        function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end;function item:GetSourceStartFrame()return v.source_start_frame end
        function item:GetSourceEndFrame()return v.source_end_frame end;function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return {} end
        function item:GetEffects()return {} end;function item:GetProperties()return {Pan=source_pan,TransformEnabled=true} end;result[#result+1]=item end end;return result end
      local project={};function project:GetName()return data.project_name end;function project:GetUniqueId()return data.project_id end
      function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
      local manager={};function manager:GetCurrentProject()if not closed then return project end end;function manager:SaveProject()saves=saves+1;return true end
      function manager:CloseProject(value)assert(value==project);closed=true;return true end;function manager:LoadProject(name)assert(name==data.project_name);closed=false;return project end
      function manager:ExportProject(name,filename)assert(name==data.project_name);files[filename]='native-export';return true end
      resolve={};function resolve:GetProjectManager()return manager end;function resolve:GetVersionString()return '21.1.2.10' end;function resolve:Fusion()return fusion end;`;
    const suffix = `print('RESULT:'..(files[${JSON.stringify(plan.resultPath)}]or'absent'));print('COUNTERS:'..saves..':'..renames);for _,v in pairs(names)do assert(v=='Same Track','Names not restored')end`;
    const run = extra => runVendorLuaMock(prefix + extra + '\n' + source + '\n' + suffix, { library, maxBuffer: 3 * 1024 * 1024, timeout: 15000 });
    const ok = run(''); assert.equal(ok.status, 0, ok.stderr);
    const parse = output => JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
    assert.equal(parse(ok.stdout).status, 'restored'); assert.equal(parse(ok.stdout).representedStateRestored, true);
    assert(ok.stdout.includes('COUNTERS:2:10'));
    const failed = run('fail_at=2'); assert.equal(failed.status, 0, failed.stderr); assert.equal(parse(failed.stdout).status, 'rolled-back');
    const stale = run('source_pan=13.25'); assert.equal(stale.status, 0, stale.stderr); assert.equal(parse(stale.stdout).status, 'refused');
    assert(stale.stdout.includes('COUNTERS:0:0'));
    const wrong = run("data.project_name='Another project'"); assert.equal(wrong.status, 0, wrong.stderr); assert(wrong.stdout.includes('RESULT:absent'));
    const replay = runVendorLuaMock(prefix + '\ndo\n' + source + '\nend\nlocal saved_saves,saved_renames=saves,renames\ndo\n' + source
        + '\nend\nassert(saves==saved_saves and renames==saved_renames,"Completed trial replay wrote to editor")\n' + suffix,
      { library, maxBuffer: 3 * 1024 * 1024, timeout: 15000 });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(parse(replay.stdout).status, 'restored');
  });
