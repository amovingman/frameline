'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('native Name writer preserves opaque bytes and ZIP metadata, refuses stale identities and unsafe envelopes',()=>{
 const result=spawnSync('python3',[path.join(__dirname,'../phase-0/test_native_preserving_name_writer.py')],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 6 tests/);
});
