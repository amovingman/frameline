'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runVendorLuaMock } = require('../phase-0/run-vendor-lua-mock');
const { getSources, renderItemStateMenu, readItemStateMenu, projectName, projectId } = require('../phase-0/prepare-item-state-menu');
const { parseItemStateObservation } = require('../src/resolve-item-state-observation');
const { renderItemStateDiagnostic,validateDiagnostic,readItemStateDiagnostic }=require('../phase-0/prepare-item-state-diagnostic');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function baseline() {
  const tracks = [...[1,2,3].map(index => ({ type:'video',index,name:'Duplicate' })), ...[1,2].map(index => ({type:'audio',index,name:'Duplicate'}))];
  const items = Array.from({length:50}, (_,i) => ({id:`item-${i}`,track_type:'video',track_index:1,type:'video',name:`Clip ${i}`,
    start_frame:i*24,end_frame:(i+1)*24,source_start_frame:0,source_end_frame:23,media_pool_id:i===0?null:'media',linked_item_ids:[],effect_counts:{fusion:0,ofx:0,audio:0}}));
  const snapshot={schema_version:3,resolve_version:'21.1.2.10',project_id:projectId,project_name:projectName,timelines:[{id:'timeline',name:'Timeline',start_frame:0,tracks,items}]};
  return {schemaVersion:2,operation:'resolve-effect-observation',readOnly:true,safeToApply:false,snapshot,activeTimelineId:'timeline',
    items:items.map(item=>({timelineId:'timeline',itemId:item.id,effects:[],propertyReadStatus:'captured',properties:{Pan:{decimal:'0.0000000000000000e+00'}}})),
    tracks:tracks.map(track=>({timelineId:'timeline',type:track.type,index:track.index,enabled:true,locked:false}))};
}
function lua(value) {
  if(value===null)return'nil';
  if(Array.isArray(value))return`{${value.map(lua).join(',')}}`;
  if(value&&typeof value==='object')return`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function prepared(t) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'frameline-item-state-menu-test-')));fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const sources=await getSources(), id='d'.repeat(32), paths=Object.fromEntries(Object.entries({result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json',baseline:'baseline-observation.json'}).map(([k,v])=>[k,path.join(directory,v)]));
  const raw=JSON.stringify(baseline())+'\n';
  const record={schemaVersion:1,operation:'prepare-item-state-menu',id,directory,paths,projectName,projectId,baselineSha256:sha(raw),
    sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(v)])),sourcePath:path.join(directory,`Frameline Item State ${id.slice(0,12)}.lua`),installedPath:null};
  const source=renderItemStateMenu(sources,record,baseline().snapshot);record.sourceSha256=sha(source);
  fs.writeFileSync(paths.baseline,raw,{mode:0o600});fs.writeFileSync(record.sourcePath,source,{mode:0o600});
  const file=path.join(directory,'preparation.json');fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});
  return {file,record,source};
}
function observation() {
  const rich=baseline();return {schemaVersion:1,operation:'resolve-item-state-observation',readOnly:true,safeToApply:false,snapshot:rich.snapshot,
    activeTimelineId:'timeline',capturePasses:2,representedStateUnchangedAcrossReads:true,colorGraphScope:'first-layer-count-only',capturePage:'edit',colorGraphReadPolicy:'color-page-only',readOrderPolicy:'color-graph-before-item-state',
    items:rich.items.map(item=>({timelineId:item.timelineId,itemId:item.itemId,clipEnabled:{status:'captured',value:true},speed:{status:'captured',value:{Percentage:{decimal:'1.0000000000000000e+02'}}},
      fades:{status:'captured',value:{FadeIn:0,FadeOut:0}},outputBlanking:{status:'captured',value:{}},usesTimelineOutputBlanking:{status:'captured',value:true},
      fusionCompCount:{status:'captured',value:0},firstColorLayerNodeCount:{status:'unavailable',value:null}}))};
}
function writeResult(record) {
  const raw=JSON.stringify(observation())+'\n';fs.writeFileSync(record.paths.observation,raw,{mode:0o666});
  fs.writeFileSync(record.paths.result,JSON.stringify({schemaVersion:1,operation:'resolve-item-state-menu',requestId:record.id,readOnly:true,safeToApply:false,projectId,itemCount:50,observationBytes:Buffer.byteLength(raw)-1})+'\n',{mode:0o666});
  fs.writeFileSync(record.paths.marker,`FRAMELINE_ITEM_STATE_MENU_COMPLETE_V1:${record.id}\n`,{mode:0o666});
}
test('host validates exact source, UUID, expected snapshot, complete marker and owned output modes',async t=>{
  const {file,record}=await prepared(t);writeResult(record);const read=await readItemStateMenu(file);
  assert.equal(read.status,'complete');assert.equal(read.coverage.itemCount,50);assert.equal(read.projectMutationCalls,0);
  assert.equal(fs.statSync(record.paths.observation).mode&0o777,0o600);
  fs.writeFileSync(record.sourcePath,'unreviewed program');record.sourceSha256=sha('unreviewed program');fs.writeFileSync(file,JSON.stringify(record));
  await assert.rejects(readItemStateMenu(file),/source-changed/);
});
test('hardlink outputs, nonprivate containing dirs, wrong markers and mismatched snapshots fail closed',async t=>{
  const {file,record}=await prepared(t);writeResult(record);
  const outside=path.join(record.directory,'outside');fs.writeFileSync(outside,'retained',{mode:0o644});fs.unlinkSync(record.paths.observation);fs.linkSync(outside,record.paths.observation);
  await assert.rejects(readItemStateMenu(file),/invalid-item-state-menu-file/);assert.equal(fs.statSync(outside).mode&0o777,0o644);
  fs.unlinkSync(record.paths.observation);writeResult(record);fs.chmodSync(record.directory,0o755);await assert.rejects(readItemStateMenu(file),/unsafe-item-state-menu-directory/);fs.chmodSync(record.directory,0o700);
  fs.writeFileSync(record.paths.marker,'wrong');await assert.rejects(readItemStateMenu(file),/result-mismatch/);
  writeResult(record);const changed=observation();changed.snapshot.timelines[0].items[0].name='Changed';const raw=JSON.stringify(changed)+'\n';fs.writeFileSync(record.paths.observation,raw);
  const result=JSON.parse(fs.readFileSync(record.paths.result));result.observationBytes=Buffer.byteLength(raw)-1;fs.writeFileSync(record.paths.result,JSON.stringify(result));await assert.rejects(readItemStateMenu(file),/result-mismatch/);
});
test('only allowlisted failure records are reported and never become observations',async t=>{
  const {file,record}=await prepared(t);
  const failure={schemaVersion:1,operation:'resolve-item-state-menu-failure',requestId:record.id,readOnly:true,safeToApply:false,stage:'capture',errorCode:'unsupported-field'};
  fs.writeFileSync(record.paths.failure,JSON.stringify(failure));const value=await readItemStateMenu(file);assert.equal(value.status,'failed');assert.equal(value.errorCode,'unsupported-field');assert.equal(value.observation,undefined);
  fs.writeFileSync(record.paths.failure,JSON.stringify({...failure,errorCode:'/private/path'}));await assert.rejects(readItemStateMenu(file),/invalid-item-state-menu-failure/);
});
test('diagnostic reader retains divergent typed readings without promoting them to a stable observation',async t=>{
  const {file,record}=await prepared(t),sources=await getSources();record.operation='prepare-item-state-diagnostic';record.sourcePath=path.join(record.directory,`Frameline Item State Diagnostic ${record.id.slice(0,12)}.lua`);
  const source=renderItemStateDiagnostic(sources,record,baseline().snapshot);record.sourceSha256=sha(source);fs.writeFileSync(record.sourcePath,source,{mode:0o600});fs.writeFileSync(file,JSON.stringify(record));
  const o=observation(),reading={snapshot:o.snapshot,activeTimelineId:o.activeTimelineId,capturePage:o.capturePage,colorGraphScope:o.colorGraphScope,colorGraphReadPolicy:o.colorGraphReadPolicy,items:o.items};
  const after=structuredClone(reading);after.items[0].clipEnabled.value=false;
  const value={schemaVersion:1,operation:'resolve-item-state-diagnostic',requestId:record.id,readOnly:true,safeToApply:false,stableObservationAccepted:false,first:reading,second:after,afterSnapshot:o.snapshot,richBefore:baseline(),richAfter:baseline(),capturePageAfter:'edit',activeTimelineAfter:'timeline',expectedSnapshotMatchesAtStart:true};
  const raw=JSON.stringify(value)+'\n';fs.writeFileSync(record.paths.observation,raw);fs.writeFileSync(record.paths.result,JSON.stringify({schemaVersion:1,operation:'resolve-item-state-diagnostic-menu',requestId:record.id,readOnly:true,safeToApply:false,projectId,itemCount:50,observationBytes:Buffer.byteLength(raw)-1}));fs.writeFileSync(record.paths.marker,`FRAMELINE_ITEM_STATE_DIAGNOSTIC_COMPLETE_V1:${record.id}\n`);
  const read=await readItemStateDiagnostic(file);assert.equal(read.status,'diagnostic-complete');assert.equal(read.stableObservationAccepted,false);assert.equal(read.itemStateChanges.length,1);assert.equal(read.itemStateChanges[0].field,'clipEnabled');assert.equal(read.richBeforeMatchesBaseline,true);assert.equal(read.richAfterMatchesBaseline,true);assert.throws(()=>parseItemStateObservation(raw));
  const bad=structuredClone(value);bad.first.items[0].speed.value.Secret='/Users/private';assert.throws(()=>validateDiagnostic(bad,record.id));
});
test('actual vendor Lua menu validates the baseline with nulls/arrays, rereads output, and refuses hidden drift or wrong project',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
    const {source,record}=await prepared(t);
    const prefix=`local descriptor=${lua(baseline().snapshot)};local files={};local unstable=false;local enabled_calls=0;local page='edit';local graph_calls=0;local graph_navigates=false;local blanking_depends=false;local blanking_ready={['item-0']=true}
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]='' end;local h={offset=1};function h:WriteLine(s)files[name]=s..'\\n';return #s+1 end;function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name] end;function h:ReadLine()if self.offset>#files[name] then return nil end;local s=files[name]:sub(self.offset);self.offset=#files[name]+1;return s end;return h end
local data=descriptor.timelines[1];local timeline={};function timeline:GetUniqueId()return data.id end;function timeline:GetName()return data.name end;function timeline:GetStartFrame()return data.start_frame end
function timeline:GetTrackCount(kind)local n=0;for _,v in ipairs(data.tracks)do if v.type==kind then n=n+1 end end;return n end
function timeline:GetTrackName(kind,index)for _,v in ipairs(data.tracks)do if v.type==kind and v.index==index then return v.name end end end
function timeline:GetIsTrackEnabled()return true end;function timeline:GetIsTrackLocked()return false end
function timeline:GetItemListInTrack(kind,index)local found={};for _,v in ipairs(data.items)do if v.track_type==kind and v.track_index==index then
local item={};function item:GetUniqueId()return v.id end;function item:GetName()return v.name end;function item:GetType()return v.type end
function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end;function item:GetSourceStartFrame()return v.source_start_frame end;function item:GetSourceEndFrame()return v.source_end_frame end
function item:GetMediaPoolItem()if not v.media_pool_id then return nil end;return {GetUniqueId=function()return v.media_pool_id end}end;function item:GetLinkedItems()return {}end;function item:GetEffects()return {__flags=0}end
function item:GetClipEnabled()enabled_calls=enabled_calls+1;return not(unstable and enabled_calls>50)end;function item:GetSpeed()return{Percentage=100}end;function item:GetFades()return{FadeIn=0,FadeOut=0}end
function item:GetProperties()return{Pan=0}end
function item:GetOutputBlanking()if blanking_depends and not blanking_ready[v.id]then return nil end;return{__flags=0}end;function item:GetUseTimelineForOutputBlanking()if blanking_depends and not blanking_ready[v.id]then return nil end;return true end;function item:GetFusionCompCount()return 0 end;function item:GetNodeGraph()graph_calls=graph_calls+1;blanking_ready[v.id]=true;if graph_navigates then page='edit'end;return {GetNumNodes=function()return 1 end}end
found[#found+1]=item end end;return found end
local project={};function project:GetName()return descriptor.project_name end;function project:GetUniqueId()return descriptor.project_id end;function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
local manager={};function manager:GetCurrentProject()return project end;resolve={};function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProjectManager()return manager end;function resolve:Fusion()return fusion end;function resolve:GetCurrentPage()return page end
`;
    const suffix=`print('MOCK_OBS:'..(files[${JSON.stringify(record.paths.observation)}]or'absent'));print('MOCK_MARKER:'..(files[${JSON.stringify(record.paths.marker)}]or'absent'));print('MOCK_FAILURE:'..(files[${JSON.stringify(record.paths.failure)}]or'absent'));print('MOCK_GRAPH_CALLS:'..graph_calls)`;
    const run=setup=>runVendorLuaMock(`${prefix}\n${setup}\n${source}\n${suffix}`,{library,maxBuffer:4*1024*1024});
    const good=run('');assert.equal(good.status,0,good.stderr);const raw=good.stdout.split('\n').find(row=>row.startsWith('MOCK_OBS:')).slice(9);assert.equal(parseItemStateObservation(raw).items.length,50);assert(good.stdout.includes(`MOCK_MARKER:FRAMELINE_ITEM_STATE_MENU_COMPLETE_V1:${record.id}`));
    assert(good.stdout.includes('MOCK_GRAPH_CALLS:0'));
    const color=run("page='color';");assert.equal(color.status,0);const colorRaw=color.stdout.split('\n').find(row=>row.startsWith('MOCK_OBS:')).slice(9);assert.equal(parseItemStateObservation(colorRaw).items[0].firstColorLayerNodeCount.value,1);assert(color.stdout.includes('MOCK_GRAPH_CALLS:100'));
    const context=run("page='color';blanking_depends=true;");assert.equal(context.status,0);const contextRaw=context.stdout.split('\n').find(row=>row.startsWith('MOCK_OBS:')).slice(9);const contextObservation=parseItemStateObservation(contextRaw);assert.equal(contextObservation.readOrderPolicy,'color-graph-before-item-state');assert(contextObservation.items.every(item=>item.outputBlanking.status==='captured'&&item.usesTimelineOutputBlanking.value===true));
    const navigation=run("page='color';graph_navigates=true;");assert(navigation.stdout.includes('"errorCode":"page-context-diverged"'));assert(navigation.stdout.includes('MOCK_OBS:absent'));
    const drift=run('unstable=true;');assert.equal(drift.status,0);assert(drift.stdout.includes('"errorCode":"item-state-diverged"'));assert(drift.stdout.includes('MOCK_OBS:absent'));
    const wrong=run("function project:GetUniqueId()return'wrong'end;");assert.equal(wrong.status,0);assert(wrong.stdout.includes('MOCK_OBS:absent'));assert(wrong.stdout.includes('MOCK_FAILURE:absent'));
    const diagnosticSource=renderItemStateDiagnostic(await getSources(),record,baseline().snapshot);
    const diagnostic=runVendorLuaMock(`${prefix}\nunstable=true;\n${diagnosticSource}\n${suffix}`,{library,maxBuffer:4*1024*1024});assert.equal(diagnostic.status,0,diagnostic.stderr);
    const diagnosticRaw=diagnostic.stdout.split('\n').find(row=>row.startsWith('MOCK_OBS:')).slice(9);const details=validateDiagnostic(JSON.parse(diagnosticRaw),record.id);assert.equal(details.first.items[0].clipEnabled.value,true);assert.equal(details.second.items[0].clipEnabled.value,false);assert.equal(details.stableObservationAccepted,false);
    const legacySources=await getSources();legacySources['src/companion/resolve-item-state.lua']=fs.readFileSync(path.join(__dirname,'../phase-0/item-state-history/page-aware-before-order.lua'),'utf8');
    assert.equal(sha(legacySources['src/companion/resolve-item-state.lua']),'346d53684759a694fb3193be49407e43768d00d2b3cc20906ac15f3fd6043132');
    const legacySource=renderItemStateDiagnostic(legacySources,record,baseline().snapshot);const legacy=runVendorLuaMock(`${prefix}\npage='color';blanking_depends=true;\n${legacySource}\n${suffix}`,{library,maxBuffer:4*1024*1024});assert.equal(legacy.status,0,legacy.stderr);
    const legacyRaw=legacy.stdout.split('\n').find(row=>row.startsWith('MOCK_OBS:')).slice(9);const legacyDetails=validateDiagnostic(JSON.parse(legacyRaw),record.id);assert.equal(legacyDetails.first.items.filter(item=>item.outputBlanking.status==='unavailable').length,49);assert(legacyDetails.second.items.every(item=>item.outputBlanking.status==='captured'));
  });
