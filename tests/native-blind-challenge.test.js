'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {gunzipSync}=require('node:zlib'),{randomUUID}=require('node:crypto');
const {planChallenge,renderBlindChallenge}=require('../phase-0/prepare-native-blind-challenge');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
function fixture(){
 const value=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/native-track-topology-recreate-challenge-result.json.gz')))).restored;
 const project=randomUUID(),timeline=randomUUID(),t=value.snapshot.timelines[0];value.snapshot.project_id=project;value.snapshot.project_name='Frameline Identity Blind Fixture 20261120';
 t.id=timeline;value.activeTimelineId=timeline;t.tracks=['video','audio'].flatMap(type=>Array.from({length:4},(_,i)=>({type,index:i+1,name:'Blind duplicate track'})));
 value.items.forEach(item=>item.timelineId=timeline);value.tracks=t.tracks.map(track=>({timelineId:timeline,type:track.type,index:track.index,enabled:true,locked:false}));
 for(let index=2;index<=3;index++){const id=randomUUID(),item={...t.items[0],id,type:'audio',track_type:'audio',track_index:index,name:'Repeated audio',start_frame:(index-2)*48,end_frame:(index-1)*48,linked_item_ids:[]};
  t.items.push(item);value.items.push({...structuredClone(value.items[0]),timelineId:timeline,itemId:id});}
 return value;
}
test('blind challenge changes only all8 current labels and retains52 populated/empty source identities',async()=>{
 const observation=fixture(),plan=planChallenge(observation,'a'.repeat(32));assert.equal(plan.bindings.length,8);assert.equal(plan.observation.items.length,52);
 for(const binding of plan.bindings)assert.equal(binding.challengeName,`Frameline-TrackProof-${'a'.repeat(32)}-${binding.type}-${binding.index}`);
 const restored=structuredClone(plan.challenged);restored.snapshot.timelines[0].tracks.forEach(track=>track.name='Blind duplicate track');
 // Original video/audio fixture names are deliberately made uniform above.
 assert.deepEqual(restored,observation);
 const record={...plan,projectId:observation.snapshot.project_id,probeId:'a'.repeat(32),backupPath:'/private/tmp/blind-backup.drp',backupBytes:100,
  resultPath:'/private/tmp/blind-result.json',markerPath:'/private/tmp/blind-complete.txt',exports:{before:'/private/tmp/before.drp',challenged:'/private/tmp/challenged.drp',restored:'/private/tmp/restored.drp'},
  predictionPath:'/private/tmp/frozen-prediction.json',frozenPredictionBytes:'{}\n',predictionSha256:require('../phase-0/native-track-location-binding').sha('{}\n'),predictionCanonicalSha256:require('../phase-0/native-track-location-binding').sha('{}')};
 const source=await renderBlindChallenge(record);assert(source.includes('DaVinci Resolve'));assert(!source.includes('__EXPECTED_'));
 if(fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')){
  const result=runVendorLuaMock('local source='+JSON.stringify(source)+'\nassert(loadstring(source));print("compiled")');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/compiled/);
  const guard=source.split('-- Disposable track-name challenge;')[0];
  const fake=`local bytes='{}\\n';local offset=1;resolve={GetProductName=function()return'DaVinci Resolve'end,IsStudio=function()return false end,Fusion=function()return{OpenFile=function()return{GetFileSize=function()return #bytes end,ReadLine=function()if offset>#bytes then return nil end;offset=#bytes+1;return bytes end,Close=function()end}end}end};`;
  const valid=runVendorLuaMock(fake+'local reached=false;local ok=pcall(function()'+guard+'\nreached=true end);assert(ok and reached);print("guard-passed")');assert.equal(valid.status,0,valid.stderr);assert.match(valid.stdout,/guard-passed/);
  const changed=runVendorLuaMock(fake+"bytes='{ }\\n';local reached=false;local ok=pcall(function()"+guard+'\nreached=true end);assert(not ok and not reached);print("guard-refused")');assert.equal(changed.status,0,changed.stderr);assert.match(changed.stdout,/guard-refused/);
 }
 const wrong=fixture();wrong.snapshot.project_name='Real project';assert.throws(()=>planChallenge(wrong,'a'.repeat(32)));
});
