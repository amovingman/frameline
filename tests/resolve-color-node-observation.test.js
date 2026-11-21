'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {gunzipSync}=require('node:zlib');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const {executeCommand,library}=require('./fixtures/resolve-editor-mock/execute-command');
const {prepareColorNodeObservation,readColorNodeObservation}=require('../phase-0/prepare-color-node-observation');
const {validateColorNodeObservation,parseColorNodeObservation,describeColorNodeCoverage,compareColorNodeObservations}=require('../src/resolve-color-node-observation');
const root=path.resolve(__dirname,'..');
const captured=value=>({status:'captured',value});
const unavailable=()=>({status:'unavailable',value:null});
function snapshot(){return{schema_version:3,resolve_version:'21.1.2.10',project_id:'project',project_name:'Disposable',timelines:[{id:'timeline',name:'Timeline',start_frame:0,tracks:[{type:'video',index:1,name:'Video'}],items:[{id:'item',track_type:'video',track_index:1,type:'video',name:'Clip',start_frame:0,end_frame:24,source_start_frame:0,source_end_frame:23,media_pool_id:null,linked_item_ids:[],effect_counts:{fusion:0,ofx:0,audio:0}}]}]};}
function fixture(){return{schemaVersion:1,operation:'resolve-color-node-observation',readOnly:true,safeToApply:false,snapshot:snapshot(),activeTimelineId:'timeline',capturePage:'color',capturePasses:2,representedStateUnchangedAcrossReads:true,graphScope:'first-layer-node-slots',graphReadPolicy:'color-page-only',nodeIdentity:'capture-local-one-based-index',topologyObserved:false,persistentNodeIdsObserved:false,completeGraphObserved:false,items:[{timelineId:'timeline',itemId:'item',graph:{status:'captured',count:2,nodes:[{index:1,tools:captured(['Primary']),color:captured(''),cacheMode:captured(2)},{index:2,tools:captured([]),color:captured('Blue'),cacheMode:unavailable()}]}}]};}
test('slot coverage preserves empty tools, empty color and unavailable cache without inventing node identity',()=>{
  const value=fixture();assert.equal(validateColorNodeObservation(value),value);
  assert.deepEqual(describeColorNodeCoverage(value),{itemCount:1,capturedGraphs:1,unavailableGraphs:0,nonemptyGraphs:1,nodeSlots:2,fields:{tools:{captured:2,unavailable:0},color:{captured:2,unavailable:0},cacheMode:{captured:1,unavailable:1}},nodeSlotsWithNonemptyTools:1,topologyObserved:false,persistentNodeIdsObserved:false,completeGraphObserved:false});
  const after=fixture();after.items[0].graph.nodes[0].tools=unavailable();after.items[0].graph.nodes[1].color.value='Green';
  const diff=compareColorNodeObservations(JSON.stringify(value),JSON.stringify(after));
  assert.equal(diff.slotChanges.length,1);assert.deepEqual(diff.snapshotChanges,[]);assert.equal(diff.completeEnumerationProven,false);assert.equal(diff.losslessRoundTripProven,false);assert.notEqual(diff.sourceHashes.before,diff.sourceHashes.after);
});
test('strict color-node schema rejects paths, duplicate membership, invented topology, sparse slots and unsafe objects',()=>{
  for(const edit of [v=>v.items[0].graph.nodes[0].tools.value=['/private/LUT'],v=>v.items[0].graph.nodes[0].tools.value=['C:\\private'],v=>v.items[0].graph.nodes[1].index=1,v=>v.items[0].graph.count=3,v=>v.items.push(structuredClone(v.items[0])),v=>v.items[0].graph.nodes[0].uuid='invented',v=>v.completeGraphObserved=true,v=>v.capturePage='edit',v=>v.items[0].graph.nodes[1].cacheMode.value=0,v=>v.items[0].graph.nodes[0].color.value='Magenta',v=>v.items[0].graph.nodes[0].cacheMode.value=0.5,v=>v.items[0].itemId='missing']){const value=fixture();edit(value);assert.throws(()=>parseColorNodeObservation(JSON.stringify(value)));}
  const getter=fixture();Object.defineProperty(getter.items[0].graph.nodes[0],'tools',{enumerable:true,get(){throw new Error('must not invoke getter');}});assert.throws(()=>validateColorNodeObservation(getter),/invalid-color-node-observation/);
});
const moduleSource=sync.readFileSync(path.join(root,'src/companion/resolve-color-nodes.lua'),'utf8');
const encoderSource=sync.readFileSync(path.join(root,'src/companion/resolve-effects.lua'),'utf8');
const lua=value=>value===null?'{}':Array.isArray(value)?`setmetatable({${value.map(lua).join(',')}},{__array=true})`:value&&typeof value==='object'?`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`:JSON.stringify(value);
function moduleMock(setup=''){
  return`local encoded=(function()${encoderSource}end)().encode;local calls=0;local changed=false;local page='color';local graphs=0;local graph={};function graph:GetNumNodes()return 2 end;function graph:GetToolsInNode(i)calls=calls+1;return i==1 and {'Primary',__flags=0}or{}end;function graph:GetNodeColor()return''end;function graph:GetNodeCacheMode()return nil end
local item={GetUniqueId=function()return'item'end,GetNodeGraph=function()graphs=graphs+1;return graph end};local timeline={GetUniqueId=function()return'timeline'end,GetTrackCount=function(_,kind)return kind=='video'and 1 or 0 end,GetItemListInTrack=function()return{item}end};local project={GetTimelineCount=function()return 1 end,GetTimelineByIndex=function()return timeline end,GetCurrentTimeline=function()return timeline end};local resolve={GetProjectManager=function()return{GetCurrentProject=function()return project end}end,GetCurrentPage=function()return page end};local captures=0;local base={array=function()return setmetatable({},{__array=true})end,encode=encoded,capture=function()captures=captures+1;return ${lua(snapshot())}end};local nodes=(function()${moduleSource}end)();${setup};local good,result=pcall(function()return nodes.capture(resolve,base,encoded,1,4)end);if good then print('OBS:'..encoded(result))else print('REFUSED:'..tostring(result))end;print('CAPTURES:'..captures);print('GRAPHS:'..graphs)`;
}
test('actual vendor Lua reads node contents twice and rejects count, token, context and hidden-state divergence',{skip:!sync.existsSync(library)&&'Vendor Lua unavailable'},()=>{
  const run=setup=>runVendorLuaMock(moduleMock(setup),{library});
  const good=run('');assert.equal(good.status,0,good.stderr);const raw=good.stdout.split('\n').find(s=>s.startsWith('OBS:')).slice(4);const result=parseColorNodeObservation(raw);assert.equal(result.items[0].graph.nodes[0].tools.value[0],'Primary');assert.deepEqual(result.items[0].graph.nodes[1].tools.value,[]);
  for(const setup of ["function graph:GetNumNodes()return 257 end","function graph:GetToolsInNode()return{'/private/value'}end","function graph:GetToolsInNode()page='edit';return{}end","function graph:GetToolsInNode()calls=calls+1;return calls>2 and{'OFX'}or{'Primary'}end","function graph:GetToolsInNode()return{[1]='Primary',[3]='OFX'}end"]){const bad=run(setup);assert.equal(bad.status,0,bad.stderr);assert.match(bad.stdout,/REFUSED:/);assert.doesNotMatch(bad.stdout,/OBS:/);}
  const skipped=run("page='edit';function item:GetNodeGraph()error('must not call off Color')end");assert.equal(skipped.status,0,skipped.stderr);const observation=parseColorNodeObservation(skipped.stdout.split('\n').find(s=>s.startsWith('OBS:')).slice(4));assert.equal(observation.items[0].graph.status,'unavailable');
  const oversized=run("function timeline:GetItemListInTrack()return{item,item}end");assert.match(oversized.stdout,/CAPTURES:0/);assert.match(oversized.stdout,/GRAPHS:0/);
});
const nativeBaseline=gunzipSync(sync.readFileSync(path.join(root,'phase-0/resolve-operation-baseline-observation.json.gz')));
async function prepare(t){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'color-node-test-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'baseline.json');await fs.writeFile(file,nativeBaseline,{mode:0o600});const record=await prepareColorNodeObservation({baselineFile:file});t.after(()=>fs.rm(record.directory,{recursive:true,force:true}));return{record,source:await fs.readFile(record.sourcePath,'utf8'),observation:JSON.parse(nativeBaseline)};}
const editorExtension=`local page='color';function resolve:GetCurrentPage()return page end;local p=resolve:GetProjectManager():GetCurrentProject();local old=p.GetTimelineByIndex;local reads=0;function p:GetTimelineByIndex(i)local t=old(self,i);local list=t.GetItemListInTrack;function t:GetItemListInTrack(kind,index)local out=list(self,kind,index);for _,item in ipairs(out)do function item:GetNodeGraph()local graph={};function graph:GetNumNodes()return 1 end;function graph:GetToolsInNode()reads=reads+1;return{'Primary'}end;function graph:GetNodeColor()return''end;function graph:GetNodeCacheMode()return 2 end;return graph end end;return out end;return t end;`;
test('generated menu reads and verifies fifty-item node slots without save, selection or mutation',{skip:!sync.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  const f=await prepare(t);const run=executeCommand(editorExtension+f.source,f.observation);assert.equal(run.ok,true,run.error);assert.match(run.consoleOutput,/FRAMELINE_COLOR_NODE_OK_V1/);
  const report=await readColorNodeObservation(f.record.preparationFile);assert.equal(report.status,'complete');assert.equal(report.coverage.nodeSlots,50);assert.equal(report.coverage.nodeSlotsWithNonemptyTools,50);assert.equal(report.projectMutationCalls,0);assert.equal(run.counters.setName+run.counters.save+run.counters.close+run.counters.load,0);
  const replay=executeCommand(editorExtension+f.source,f.observation);assert.equal(replay.counters.writeLine,0);
  assert(!/:(SaveProject|LoadProject|CloseProject|SetName|SetCurrentTimeline|SetCurrentPage|OpenPage|SetNodeEnabled|SetNodeColor|SetNodeCacheMode)\(/.test(f.source));
});
test('menu rejects stale represented source; host rejects output hardlinks and noncanonical directories',{skip:!sync.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  const f=await prepare(t),changed=structuredClone(f.observation);changed.items[0].properties.Pan={decimal:'1.0000000000000000e+00'};
  const rejected=executeCommand(editorExtension+f.source,changed);assert.match(rejected.consoleOutput,/FRAMELINE_COLOR_NODE_FAILED/);assert.equal((await readColorNodeObservation(f.record.preparationFile)).status,'failed');await fs.unlink(f.record.paths.failure);
  executeCommand(editorExtension+f.source,f.observation);await readColorNodeObservation(f.record.preparationFile);
  const outside=path.join(f.record.directory,'outside');await fs.writeFile(outside,'owned output',{mode:0o644});await fs.unlink(f.record.paths.observation);await fs.link(outside,f.record.paths.observation);await assert.rejects(readColorNodeObservation(f.record.preparationFile),/invalid-color-node-file/);assert.equal((await fs.stat(outside)).mode&0o777,0o644);
  const alias=path.join(path.dirname(outside),'alias');await fs.symlink(f.record.directory,alias);await assert.rejects(readColorNodeObservation(path.join(alias,'preparation.json')),/invalid-color-node-directory/);
});
test('pinned native capture recomputes actual unavailable tools separately from captured slot annotations',()=>{
  const {auditColorNodeEvidence}=require('../phase-0/color-node-evidence');
  const read=file=>sync.readFileSync(path.join(root,file));const report=auditColorNodeEvidence(read);
  assert.equal(report.rawObservationProofRecomputed,true);assert.equal(report.coverage.fields.tools.unavailable,50);assert.equal(report.coverage.fields.tools.captured,0);assert.equal(report.coverage.fields.color.captured,50);assert.equal(report.coverage.fields.cacheMode.captured,50);assert.equal(report.completeEnumerationProven,false);
  for(const file of['phase-0/color-node-evidence/baseline.json.gz','phase-0/color-node-evidence/baseline-result.json','src/companion/resolve-color-nodes.lua'])assert.throws(()=>auditColorNodeEvidence(name=>name===file?Buffer.concat([read(name),Buffer.from('changed')]):read(name)),/invalid-color-node-live-evidence/);
  assert.throws(()=>auditColorNodeEvidence(file=>{const bytes=read(file);if(file!=='phase-0/color-node-evidence/receipt.json')return bytes;const receipt=JSON.parse(bytes);receipt.coverage.fields.tools={captured:50,unavailable:0};return Buffer.from(JSON.stringify(receipt));}),/invalid-color-node-live-evidence/);
});
