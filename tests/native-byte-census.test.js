'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('complete native byte census preserves unknown ranges and keeps raw adapters owner-only',()=>{const result=spawnSync('python3',['-B',path.join(__dirname,'../phase-0/test_resolve_native_byte_census.py')],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stderr,/Ran 4 tests/);});
