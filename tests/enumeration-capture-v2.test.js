'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const{renderEnumerationCaptureV2}=require('../phase-0/prepare-enumeration-capture-v2');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('versioned capture supports three owner contexts without introducing content/save methods',
 {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},()=>{
 const record={projectId:'10000000-0000-4000-8000-000000000001',probeId:'a'.repeat(32),backupPath:'/private/tmp/backup.drp',backupBytes:42,
  baseline:{activeTimelineId:'main'},checkpoint:{resultSha256:'b'.repeat(64)},timelineIds:['main','secondary','heldout'],orientations:[1,2,3].map(i=>({before:'/private/tmp/b'+i,after:'/private/tmp/a'+i,archive:'/private/tmp/'+i+'.drp'})),
  resultPath:'/private/tmp/result',markerPath:'/private/tmp/marker',errorPath:'/private/tmp/error'};
 const source=renderEnumerationCaptureV2(record);
 assert(!/:\s*(Save\w*|CloseProject|LoadProject|Import\w*|Delete\w*|Add\w*|SetName|SetProperties)\s*\(/.test(source));
 assert(source.includes('local orientation_ids={"main","secondary","heldout"}'));
 assert(source.indexOf("stage='restore-active'")<source.indexOf("stage='complete'"));
 const result=runVendorLuaMock('assert(loadstring('+JSON.stringify(source)+'));print("three-owner-capture-compiled")');
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/three-owner-capture-compiled/);
});
