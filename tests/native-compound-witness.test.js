'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('bounded separate native compound reader proves explicit references and refuses ambiguous parentage',()=>{
 const result=spawnSync('python3',[path.join(__dirname,'../phase-0/test_native_compound_witness.py')],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 3 tests/);
});
