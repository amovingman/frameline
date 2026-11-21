'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {gunzipSync}=require('node:zlib');
const {loadCalibration,verifyLocationCalibration,joinCalibratedTracks}=require('../phase-0/native-track-readonly-join');
const {renderReadOnly}=require('../phase-0/prepare-native-track-readonly');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const ROOT=path.resolve(__dirname,'..');
const reports=()=>['native-track-challenge-live-observation.json',...['append','delete','recreate'].map(label=>`native-track-topology-${label}-live-observation.json`)]
  .map(file=>JSON.parse(fs.readFileSync(path.join(ROOT,'phase-0',file))));
const observation=()=>JSON.parse(gunzipSync(fs.readFileSync(path.join(ROOT,'phase-0/native-track-topology-recreate-challenge-result.json.gz')))).restored;
const copy=value=>structuredClone(value);

test('independent challenge ledger calibrates 21 current locations including shifted and recreated empty tracks',()=>{
  const calibration=loadCalibration();assert.equal(calibration.independentlyChallengedAssociations,21);
  const state=observation(),result=joinCalibratedTracks(calibration,[state,state,state],[calibration.graph,calibration.graph]);
  assert.equal(result.bindings.length,5);assert.equal(result.emptyDuplicateNameTracksBound,4);
  assert.equal(result.challengeFreeReadOnlyRebindingVerified,true);assert.equal(result.stableTrackIdentityProven,false);
  assert.equal(result.ordinaryApplySupported,false);assert.equal(result.vendorDocumentedMappingContract,false);
  assert.equal(result.bindings.find(row=>row.type==='video'&&row.index===2).nativeTrackId,'5690d038-9896-4252-83e1-1aab62c25289');
  assert.equal(result.bindings.find(row=>row.type==='video'&&row.index===3).nativeTrackId,'d196e846-3ce4-4ece-af4a-98690db4ce0a');
});

test('location calibration rejects an independent counterexample or incomplete ledger',()=>{
  for(const mutate of [values=>{values[1].graphs.challenged.apiBindings[0].index=99;},values=>{values[2].graphs.challenged.apiBindings.pop();},
    values=>{values[3].graphs.challenged.apiBindings[1].nativeTrackId=values[3].graphs.challenged.apiBindings[0].nativeTrackId;}]){
    const values=reports();mutate(values);assert.throws(()=>verifyLocationCalibration(values));
  }
});

test('read-only join rejects drift, swapped identical empty tracks, recreated IDs, missing parentage and wrong scope',()=>{
  const calibration=loadCalibration(),state=observation();
  for(const mutate of [
    (_,states)=>{states[1].tracks[1].locked=!states[1].tracks[1].locked;},
    (_,states)=>{states[2].items[0].properties.Pan={decimal:'1.0000000000000000e+00'};},
    (_,states)=>{for(const s of states)s.snapshot.resolve_version='21.1.3.10';},
    (_,states)=>{for(const s of states)s.snapshot.timelines[0].tracks[1].name='different';},
    (_,__,graphs)=>{const tracks=graphs[0].timelines[0].tracks.filter(row=>row.kind==='audio');[tracks[0].nativeOrdinal,tracks[1].nativeOrdinal]=[tracks[1].nativeOrdinal,tracks[0].nativeOrdinal];},
    (_,__,graphs)=>{graphs[1].timelines[0].tracks[0].nativeTrackId='00000000-0000-4000-8000-000000000001';},
    (_,__,graphs)=>{graphs[0].timelines[0].nativeSequenceId='00000000-0000-4000-8000-000000000002';},
    (_,__,graphs)=>{delete graphs[0].timelines[0].tracks[0].nativeContainerId;},
    (_,__,graphs)=>{graphs[1].timelines[0].tracks.find(row=>row.itemIds.length).itemIds.pop();},
    (c)=>{c.bindings.find(row=>row.type==='video'&&row.index===2).nativeTrackId='00000000-0000-4000-8000-000000000003';}
  ]){const c=copy(calibration),states=[copy(state),copy(state),copy(state)],graphs=[copy(c.graph),copy(c.graph)];mutate(c,states,graphs);
    assert.throws(()=>joinCalibratedTracks(c,states,graphs));}
});

const lua=value=>value===null?'{}':Array.isArray(value)?`setmetatable({${value.map(lua).join(',')}},{__array=true})`
  :typeof value==='object'?`{${Object.entries(value).map(([key,field])=>`[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}`:JSON.stringify(value);
test('vendor runtime uses only getters and two exports; rejects state drift and replay before more exports',
  {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},async()=>{
  const state=observation();state.items.forEach(item=>{item.properties={Pan:{decimal:'0.0000000000000000e+00'},TransformEnabled:true};});
  state.snapshot.timelines[0].items.forEach(item=>{item.media_pool_id=null;item.linked_item_ids=[];item.effect_counts={fusion:0,ofx:0,audio:0};});
  const record={projectId:state.snapshot.project_id,observation:state,probeId:'a'.repeat(32),resultPath:'/private/tmp/readonly-test/result.json',
    markerPath:'/private/tmp/readonly-test/complete.txt',exports:{first:'/private/tmp/readonly-test/first.drp',second:'/private/tmp/readonly-test/second.drp'}};
  const source=await renderReadOnly(record);
  // The complete rendered source has no editor mutation or page-navigation API.
  assert(!/:\s*(Set\w+|SaveProject|CloseProject|LoadProject|Import\w+|AddTrack|DeleteTrack|OpenPage)\s*\(/.test(source));
  const prefix=`local data=${lua(state.snapshot)};local files={};local exports=0;local drift=false;local drift_after=99
    local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end
      local h={offset=1};function h:WriteLine(v)files[name]=v..'\\n';return #v+1 end;function h:Flush()return true end;function h:Close()end
      function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local v=files[name]:sub(self.offset);self.offset=#files[name]+1;return v end;return h end
    local timeline={};function timeline:GetUniqueId()return data.timelines[1].id end;function timeline:GetName()return data.timelines[1].name end;function timeline:GetStartFrame()return data.timelines[1].start_frame end
    function timeline:GetTrackCount(kind)local n=0;for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind then n=n+1 end end;return n end
    function timeline:GetTrackName(kind,index)for _,v in ipairs(data.timelines[1].tracks)do if v.type==kind and v.index==index then return v.name end end end
    function timeline:GetIsTrackEnabled()return true end;function timeline:GetIsTrackLocked()return false end
    function timeline:GetItemListInTrack(kind,index)local result={};for _,v in ipairs(data.timelines[1].items)do if v.track_type==kind and v.track_index==index then
      local item={};function item:GetUniqueId()return v.id end;function item:GetType()return v.type end;function item:GetName()return v.name end
      function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end;function item:GetSourceStartFrame()return v.source_start_frame end
      function item:GetSourceEndFrame()return v.source_end_frame end;function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return {}end
      function item:GetEffects()return {}end;function item:GetProperties()return {Pan=drift and 1 or 0,TransformEnabled=true}end;result[#result+1]=item end end;return result end
    local project={};function project:GetName()return data.project_name end;function project:GetUniqueId()return data.project_id end;function project:GetTimelineCount()return 1 end
    function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
    local manager={};function manager:GetCurrentProject()return project end
    function manager:ExportProject(name,filename)assert(name==data.project_name);exports=exports+1;files[filename]='native-export';if exports==drift_after then drift=true end;return true end
    resolve={};function resolve:GetProjectManager()return manager end;function resolve:GetVersionString()return '21.1.2.10'end;function resolve:Fusion()return fusion end;function resolve:GetCurrentPage()return 'color'end;`;
  const rendered=source;
  const suffix=`print('RESULT:'..(files[${JSON.stringify(record.resultPath)}]or'absent'));print('EXPORTS:'..exports)`;
  const run=extra=>runVendorLuaMock(prefix+extra+'\ndo\n'+rendered+'\nend\n'+suffix);
  const parse=output=>JSON.parse(output.split('\n').find(line=>line.startsWith('RESULT:')).slice(7));
  const ok=run('');assert.equal(ok.status,0,ok.stderr);assert.equal(parse(ok.stdout).status,'captured');assert(ok.stdout.includes('EXPORTS:2'));
  const stale=run('drift=true');assert.equal(stale.status,0,stale.stderr);assert.equal(parse(stale.stdout).status,'refused');assert(stale.stdout.includes('EXPORTS:0'));
  const during=run('drift_after=1');assert.equal(during.status,0,during.stderr);assert.equal(parse(during.stdout).status,'refused');assert(during.stdout.includes('EXPORTS:1'));
  const replay=runVendorLuaMock(prefix+'\ndo\n'+rendered+'\nend\nlocal prior=exports\ndo\n'+rendered+'\nend\nassert(exports==prior)\n'+suffix);
  assert.equal(replay.status,0,replay.stderr);assert.equal(parse(replay.stdout).status,'captured');assert(replay.stdout.includes('EXPORTS:2'));
});
