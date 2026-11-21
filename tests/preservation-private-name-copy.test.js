'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('private SQLite Name copy preserves every other typed cell and refuses stale names, trigger side effects and reused outputs',()=>{
 const result=spawnSync('python3',['-B',path.join(__dirname,'../phase-0/test_native_sqlite_name_copy.py')],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 2 tests/);
});
