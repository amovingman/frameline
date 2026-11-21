'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{gunzipSync}=require('node:zlib');
const{semanticState,renderContinuation}=require('../phase-0/prepare-native-blind-continuation');
const{renderBlindCapture}=require('../phase-0/prepare-native-blind-capture');
const{sha,json}=require('../phase-0/native-track-location-binding');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('continuation validates enumeration order by namespaced identity without masking changed values',async()=>{
 const source=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/native-blind-identity-evidence/initial-initial-result.json.gz')))).after;
 const reordered=structuredClone(source);reordered.snapshot.timelines[0].items.push(reordered.snapshot.timelines[0].items.shift());reordered.items.push(reordered.items.shift());
 assert.notEqual(json(source),json(reordered));assert.deepEqual(semanticState(source),semanticState(reordered));
 const changed=structuredClone(reordered);changed.snapshot.timelines[0].items[0].name='Changed';assert.notDeepEqual(semanticState(source),semanticState(changed));
 const captureRecord={stage:'capture',probeId:'a'.repeat(32),expectedObservation:reordered,emptyBackupPath:'/private/tmp/unused.drp',paths:{first:'/private/tmp/first.drp',second:'/private/tmp/second.drp',result:'/private/tmp/result.json',marker:'/private/tmp/complete.txt'}};
 captureRecord.sourceSha256=sha(await renderBlindCapture(captureRecord));
 const record={captureRecord,projectId:source.snapshot.project_id,probeId:'a'.repeat(32),observation:reordered,backupPath:'/private/tmp/backup.drp',backupBytes:100,
  resultPath:'/private/tmp/checkpoint-result.json',markerPath:'/private/tmp/checkpoint-complete.txt',startedPath:'/private/tmp/checkpoint-started.txt',exports:{before:'/private/tmp/before.drp',after:'/private/tmp/after.drp'},diagnosticResultSha256:'b'.repeat(64),originalFailedSourceSha256:'c'.repeat(64)};
 const rendered=await renderContinuation(record);assert(!/:\s*(Set\w+|AddTrack|DeleteTrack|MoveItems|Import\w+)\s*\(/.test(rendered));
 assert(rendered.indexOf('Source changed after barrier')<rendered.indexOf('manager:SaveProject()'));
 assert(rendered.indexOf('manager:SaveProject()')<rendered.indexOf('manager:CloseProject(p)'));
 assert(rendered.indexOf('manager:CloseProject(p)')<rendered.indexOf('manager:LoadProject('));
 if(fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')){const output=runVendorLuaMock('assert(loadstring('+JSON.stringify(rendered)+'));print("compiled")');assert.equal(output.status,0,output.stderr);assert.match(output.stdout,/compiled/);}
});
