'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runVendorLuaMock } = require('../phase-0/run-vendor-lua-mock');
const { planStage, verifyTopologyDelta, renderStage } = require('../phase-0/prepare-native-track-topology');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const P = '10000000-0000-4000-8000-000000000001', T = '10000000-0000-4000-8000-000000000002';
const NAME = 'Frameline Integration Gate Fixture 20261120';
const lua = value => value === null ? '{}' : Array.isArray(value) ? `setmetatable({${value.map(lua).join(',')}},{__array=true})`
  : typeof value === 'object' ? `{${Object.entries(value).map(([key, field]) => `[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}` : JSON.stringify(value);
function observation(videos = 3) {
  const tracks = [...Array.from({ length: videos }, (_, index) => ({ type: 'video', index: index + 1, name: 'Same Track' })),
    ...[1, 2].map(index => ({ type: 'audio', index, name: 'Same Track' }))];
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    track_type: 'video', track_index: 1, type: 'video', name: 'Repeated clip', start_frame: index * 24, end_frame: (index + 1) * 24,
    source_start_frame: 0, source_end_frame: 24, media_pool_id: null, linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }));
  return { schemaVersion: 2, operation: 'resolve-effect-observation', readOnly: true, safeToApply: false,
    snapshot: { schema_version: 3, resolve_version: '21.1.2.10', project_id: P, project_name: NAME,
      timelines: [{ id: T, name: 'Timeline', start_frame: 0, tracks, items }] }, activeTimelineId: T,
    items: items.map(item => ({ timelineId: T, itemId: item.id, effects: [], propertyReadStatus: 'captured',
      properties: { Pan: { decimal: '0.0000000000000000e+00' }, TransformEnabled: true } })),
    tracks: tracks.map(track => ({ timelineId: T, type: track.type, index: track.index, enabled: true, locked: false })) };
}
function graph(ids) {
  let video = 0, audio = 0;
  const tracks = ids.map(id => { const kind = id.startsWith('a') ? 'audio' : 'video', index = kind === 'video' ? ++video : ++audio;
    return { nativeTrackId: id, kind, nativeOrdinal: index, nameSha256: 'same', itemIds: id === 'v1' ? Array.from({ length: 50 }, (_, i) => `item-${i}`) : [] }; });
  return { projectId: P, timelines: [{ timelineId: T, tracks }] };
}
const bindings = g => g.timelines[0].tracks.map(row => ({ timelineId: T, nativeTrackId: row.nativeTrackId, type: row.kind,
  index: row.nativeOrdinal, itemCount: row.itemIds.length }));
test('topology deltas use controlled UUID bindings, preserve fifty items, and reject ABA reuse or incorrect shifted bindings', () => {
  const first = graph(['v1', 'v2', 'v3', 'a1', 'a2']), appended = graph(['v1', 'v2', 'v3', 'v4', 'a1', 'a2']);
  const source = { graph: first, bindings: bindings(first), observedNativeTrackIds: ['v1', 'v2', 'v3', 'a1', 'a2'], retiredNativeTrackIds: [] };
  const add = verifyTopologyDelta(source, first, appended, bindings(appended), 'append-empty-video');
  assert.deepEqual(add.addedNativeTrackIds, ['v4']); assert.equal(add.allFiftyPictureItemsPreserved, true);
  const removed = graph(['v1', 'v3', 'v4', 'a1', 'a2']);
  const next = { graph: appended, bindings: bindings(appended), ...add };
  const deletion = verifyTopologyDelta(next, appended, removed, bindings(removed), 'delete-empty-video-2');
  assert.deepEqual(deletion.removedNativeTrackIds, ['v2']); assert.equal(deletion.indexShiftObservedByControlledBindings, true);
  assert(deletion.retainedTracks.some(row => row.nativeTrackId === 'v3' && row.apiIndexBefore === 3 && row.apiIndexAfter === 2));
  const wrong = bindings(removed); wrong.find(row => row.nativeTrackId === 'v3').index = 3;
  assert.throws(() => verifyTopologyDelta(next, appended, removed, wrong, 'delete-empty-video-2'), /misbound/);
  const replacement = graph(['v1', 'v3', 'fresh', 'a1', 'a2']);
  const replaced = verifyTopologyDelta({ graph: removed, bindings: bindings(removed), ...deletion }, removed, replacement, bindings(replacement), 'recreate-empty-video-3');
  assert.equal(replaced.deleteRecreateNegativeControlVerified, true); assert.deepEqual(replaced.addedNativeTrackIds, ['fresh']);
  const reused = graph(['v1', 'v3', 'v2', 'a1', 'a2']);
  assert.throws(() => verifyTopologyDelta({ graph: removed, bindings: bindings(removed), ...deletion }, removed, reused, bindings(reused), 'recreate-empty-video-3'), /reused/);
  assert.equal(replaced.stableTrackIdentityProven, false);
});

test('stage plans permit only fixed empty-track operations and preserve all source item/property data', () => {
  const initial = observation(), appended = planStage(initial, 'append-empty-video');
  assert.equal(appended.after.snapshot.timelines[0].tracks.length, 6);
  assert.deepEqual(appended.before.items, appended.after.items); assert.deepEqual(appended.before.snapshot.timelines[0].items, appended.after.snapshot.timelines[0].items);
  const deleted = planStage(appended.after, 'delete-empty-video-2'); assert.equal(deleted.after.snapshot.timelines[0].tracks.length, 5);
  assert.deepEqual(planStage(deleted.after, 'recreate-empty-video-3').after, deleted.after);
  assert.throws(() => planStage(initial, 'delete-empty-video-1'));
  assert.throws(() => planStage(initial, 'delete-empty-video-2'));
  const nonempty = observation(); nonempty.snapshot.timelines[0].items[0].track_index = 2;
  assert.throws(() => planStage(nonempty, 'recreate-empty-video-3'));
});

test('actual vendor Lua performs guarded append/delete/recreate followed by name challenge and restoration',
  { skip: !fs.existsSync(library) && 'Vendor Lua unavailable' }, async () => {
    for (const operation of ['append-empty-video', 'delete-empty-video-2', 'recreate-empty-video-3']) {
      const before = observation(operation === 'delete-empty-video-2' ? 4 : 3), plan = planStage(before, operation);
      const dir = '/private/tmp/track-topology-test', probeId = 'b'.repeat(32);
      const record = { before, after: plan.after, stageOperation: operation, projectId: P, probeId,
        backupPath: `${dir}/backup.drp`, backupBytes: 32, resultPath: `${dir}/result.json`, markerPath: `${dir}/complete.txt`,
        challengeResultPath: `${dir}/challenge.json`, challengeMarkerPath: `${dir}/challenge-complete.txt`,
        exports: Object.fromEntries(['before', 'after', 'challengeBefore', 'challenged', 'restored'].map(name => [name, `${dir}/${name}.drp`])) };
      const source = await renderStage(record);
      const prefix = `local data=${lua(before.snapshot)};local source_pan=0;local adds,deletes,saves,renames=0,0,0,0;local closed=false
        local files={[${JSON.stringify(record.backupPath)}]=string.rep('b',32)};local fusion={};function fusion:OpenFile(name,mode)
          if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1}
          function h:WriteLine(value)files[name]=value..'\\n';return#value+1 end;function h:Flush()return true end;function h:Close()end
          function h:GetFileSize()return#files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local v=files[name]:sub(self.offset);self.offset=#files[name]+1;return v end;return h end
        local timeline={};local function track(kind,index)for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind and v.index==index then return v end end;error('Unknown track')end
        function timeline:GetUniqueId()return ${JSON.stringify(T)}end;function timeline:GetName()return'Timeline'end;function timeline:GetStartFrame()return 0 end
        function timeline:GetTrackCount(kind)local n=0;for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind then n=n+1 end end;return n end
        function timeline:GetTrackName(kind,index)return track(kind,index).name end;function timeline:SetTrackName(kind,index,name)renames=renames+1;track(kind,index).name=name;return true end
        function timeline:GetIsTrackEnabled(kind,index)local v=track(kind,index).enabled;if v==nil then return true end;return v end
        function timeline:GetIsTrackLocked(kind,index)return track(kind,index).locked or false end
        function timeline:SetTrackEnable(kind,index,value)track(kind,index).enabled=value;return true end;function timeline:SetTrackLock(kind,index,value)track(kind,index).locked=value;return true end
        function timeline:AddTrack(kind)assert(kind=='video');adds=adds+1;data.timelines[1].tracks[#data.timelines[1].tracks+1]={type=kind,index=self:GetTrackCount(kind)+1,name='Default'};return true end
        function timeline:DeleteTrack(kind,index)assert(index~=1,'Picture track must survive');deletes=deletes+1;for i=#data.timelines[1].tracks,1,-1 do local v=data.timelines[1].tracks[i];if v.type==kind and v.index==index then table.remove(data.timelines[1].tracks,i)end end;for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind and v.index>index then v.index=v.index-1 end end;return true end
        function timeline:GetItemListInTrack(kind,index)local found={};for _,v in ipairs(data.timelines[1].items)do if v.track_type==kind and v.track_index==index then
          local item={};function item:GetUniqueId()return v.id end;function item:GetName()return v.name end;function item:GetType()return v.type end
          function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end;function item:GetSourceStartFrame()return v.source_start_frame end;function item:GetSourceEndFrame()return v.source_end_frame end
          function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return{}end;function item:GetEffects()return{}end;function item:GetProperties()return{Pan=source_pan,TransformEnabled=true}end;found[#found+1]=item end end;return found end
        local project={};function project:GetName()return data.project_name end;function project:GetUniqueId()return data.project_id end;function project:GetTimelineCount()return 1 end
        function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
        local manager={};function manager:GetCurrentProject()if not closed then return project end end;function manager:SaveProject()saves=saves+1;return true end
        function manager:CloseProject()closed=true;return true end;function manager:LoadProject(name)assert(name==data.project_name);closed=false;return project end
        function manager:ExportProject(name,filename)assert(name==data.project_name);files[filename]='native-export';return true end
        resolve={};function resolve:GetProjectManager()return manager end;function resolve:GetVersionString()return'21.1.2.10'end;function resolve:Fusion()return fusion end;`;
      const suffix = `print('TOPOLOGY:'..(files[${JSON.stringify(record.resultPath)}]or'absent'));print('CHALLENGE:'..(files[${JSON.stringify(record.challengeResultPath)}]or'absent'));print('COUNTERS:'..adds..':'..deletes..':'..saves);assert(#data.timelines[1].items==50);for _,v in ipairs(data.timelines[1].tracks)do assert(v.name=='Same Track')end`;
      const run = extra => runVendorLuaMock(prefix + extra + '\n' + source + '\n' + suffix, { library, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
      const ok = run(''); assert.equal(ok.status, 0, ok.stderr);
      const row = (output, label) => JSON.parse(output.split('\n').find(line => line.startsWith(label)).slice(label.length));
      assert.equal(row(ok.stdout, 'TOPOLOGY:').status, 'ready-for-challenge');
      assert.equal(row(ok.stdout, 'CHALLENGE:').status, 'restored');
      assert(ok.stdout.includes(`COUNTERS:${operation === 'delete-empty-video-2' ? 0 : 1}:${operation === 'append-empty-video' ? 0 : 1}:3`));
      const stale = run('source_pan=13.25'); assert.equal(stale.status, 0, stale.stderr);
      assert.equal(row(stale.stdout, 'TOPOLOGY:').status, 'refused'); assert(stale.stdout.includes('COUNTERS:0:0:0'));
    }
  });
