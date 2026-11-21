'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {gunzipSync}=require('node:zlib');
const {planPerturb,intermediateStates,renderPerturb}=require('../phase-0/prepare-native-blind-perturb');
const {renderBlindCapture}=require('../phase-0/prepare-native-blind-capture');
const {sha}=require('../phase-0/native-track-location-binding');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const source=()=>JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/native-blind-identity-evidence/initial-initial-result.json.gz')))).after;
test('blind perturb plan preserves52UUIDs, shifts empty tracks, moves and renames exactly one occurrence',async()=>{
 const state=source(),plan=planPerturb(state,'append-delete-move-rename','a'.repeat(32));
 assert.equal(plan.after.snapshot.timelines[0].tracks.length,8);assert.equal(plan.after.items.length,52);
 assert.deepEqual(plan.after.items,plan.before.items);
 const a=new Map(plan.before.snapshot.timelines[0].items.map(i=>[i.id,i])),b=plan.after.snapshot.timelines[0].items;
 assert.equal(b.filter(i=>i.name!==a.get(i.id).name).length,1);assert.equal(b.filter(i=>i.track_index!==a.get(i.id).track_index).length,1);
 const moved=b.find(i=>i.id===plan.movedItemId);assert.equal(moved.track_type,'video');assert.equal(moved.track_index,2);assert.equal(moved.start_frame,a.get(moved.id).start_frame);
 for(const type of['video','audio'])assert.equal(plan.after.snapshot.timelines[0].tracks.filter(t=>t.type===type&&!b.some(i=>i.track_type===type&&i.track_index===t.index)).length,2);
 const intermediate=intermediateStates(state,plan.operation);assert.equal(intermediate.appended.tracks.length,9);assert.equal(intermediate.deleted.tracks.length,8);
 const replaced=planPerturb(plan.after,'recreate-empty-video-4','b'.repeat(32));assert.deepEqual(replaced.before,replaced.after);
 const bad=structuredClone(state);bad.snapshot.timelines[0].items[0].track_index=2;assert.throws(()=>planPerturb(bad,'append-delete-move-rename','a'.repeat(32)),/nonempty/);
 const captureRecord={stage:'capture',expectedObservation:plan.after,probeId:'a'.repeat(32),emptyBackupPath:'/private/tmp/empty.drp',paths:{first:'/private/tmp/first.drp',second:'/private/tmp/second.drp',result:'/private/tmp/result.json',marker:'/private/tmp/complete.txt'}};
 captureRecord.sourceSha256=sha(await renderBlindCapture(captureRecord));
 const record={before:state,plan,stageOperation:plan.operation,probeId:'a'.repeat(32),captureRecord,projectId:state.snapshot.project_id,backupPath:'/private/tmp/backup.drp',backupBytes:100,
  resultPath:'/private/tmp/stage.json',markerPath:'/private/tmp/stage-complete.txt',startedPath:'/private/tmp/stage-started.txt',exports:{before:'/private/tmp/before.drp',appended:'/private/tmp/appended.drp',deleted:'/private/tmp/deleted.drp',after:'/private/tmp/after.drp'}};
 const rendered=await renderPerturb(record);assert(rendered.indexOf("stage='source-check'")<rendered.indexOf("stage='mutating'"));assert(rendered.indexOf('FRAMELINE_BLIND_PERTURB_STARTED:')<rendered.indexOf("stage='pre-write-recheck'"));assert(rendered.indexOf("stage='pre-write-recheck'")<rendered.indexOf("assert(timeline:AddTrack('video')"));
 if(fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')){
  const result=runVendorLuaMock('assert(loadstring('+JSON.stringify(rendered)+'));print("compiled")');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/compiled/);
  const recheck=rendered.slice(rendered.indexOf("stage='pre-write-recheck'"),rendered.indexOf("stage='mutating'"));
  const prefix=`local calls=0;local mutated=false;local stage,p,timeline=nil,nil,nil;local value=${JSON.stringify(require('../phase-0/native-track-location-binding').json(plan.before))};local effects={encode=function()return value end};local function capture()return{}end;local function current()calls=calls+1;return{GetTimelineCount=function()return 1 end,GetTimelineByIndex=function()return{GetUniqueId=function()return ${JSON.stringify(state.snapshot.timelines[0].id)}end}end}end;`;
  const stale=runVendorLuaMock(prefix+"value='changed-after-barrier';local ok=pcall(function()"+recheck+'\nmutated=true end);assert(not ok and not mutated and calls==0);print("refused-before-reacquire-or-setter")');assert.equal(stale.status,0,stale.stderr);assert.match(stale.stdout,/refused-before-reacquire-or-setter/);
  const current=runVendorLuaMock(prefix+'local ok=pcall(function()'+recheck+'\nmutated=true end);assert(ok and mutated and calls==1);print("reacquired-after-full-recheck")');assert.equal(current.status,0,current.stderr);assert.match(current.stdout,/reacquired-after-full-recheck/);
 }
});
