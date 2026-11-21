'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const{gunzipSync}=require('node:zlib');
const{createHash}=require('node:crypto');
const{profileFixtureScan}=require('../phase-0/profile-gate-fixture-scan');

test('same fifty-clip export gets actual fresh/cache scans without rewriting its bytes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gate-scan-profile-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const bytes=gunzipSync(sync.readFileSync(path.join(__dirname,'../phase-0/large-projects/corpus/small-editor.fcpxml.gz')));
  const filename=path.join(directory,'fixture.fcpxml');await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600});
  const expectedSha256=createHash('sha256').update(bytes).digest('hex');const result=await profileFixtureScan({selectedPath:filename,expectedSha256,iterations:1});
  assert.equal(result.results.length,2);assert.deepEqual(result.results.map(row=>row.cacheHit),[false,true]);
  assert(result.results.every(row=>row.sourceSha256===expectedSha256&&row.clips===50&&row.sourceUnchanged&&row.elapsedMs>=0));
  assert.deepEqual(await fs.readFile(filename),bytes);assert(!JSON.stringify(result).includes(directory));
  await assert.rejects(profileFixtureScan({selectedPath:filename,expectedSha256:'0'.repeat(64)}),/source-mismatch/);
  const controller=new AbortController();controller.abort();await assert.rejects(profileFixtureScan({selectedPath:filename,iterations:1,signal:controller.signal}),{code:'scan-cancelled'});
});
