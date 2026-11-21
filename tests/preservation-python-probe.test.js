'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),{spawnSync}=require('node:child_process');
const {preparePreservationPythonProbe,readPreservationPythonProbe}=require('../phase-0/prepare-preservation-python-probe');
test('internal Python probe proves only private sentinel fidelity and SDK identity, refusing changed bytes and replay',async()=>{
 for(const bad of[false,true]){const p=await preparePreservationPythonProbe(),r=JSON.parse(await fs.readFile(p.preparation));try{
  if(bad){const raw=await fs.readFile(r.sentinelPath);raw[0]^=1;await fs.writeFile(r.sentinelPath,raw);}
  const script=`import runpy,sys
class SDK:
 def GetVersion(self): return [21,1,2,10]
 def GetVersionString(self): return '21.1.2.10'
 def GetProductName(self): return 'DaVinci Resolve'
 def IsStudio(self): return False
 def __getattr__(self,key): raise AssertionError('Unexpected SDK call '+key)
runpy.run_path(sys.argv[1],init_globals={'resolve':SDK()})
`;
  const run=spawnSync('python3',['-B','-c',script,r.sourcePath],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});assert.equal(run.status,0,run.stderr);
  if(bad){const e=JSON.parse(await fs.readFile(r.paths.error));assert.equal(e.stage,'binary-read');assert.equal(e.errorType,'AssertionError');assert.equal(await fs.stat(r.paths.marker).catch(()=>null),null);}else{const v=await readPreservationPythonProbe(p.preparation);assert.equal(v.binarySentinelFidelityProven,true);assert.equal(v.sdkTargetConnected,true);assert.equal(v.resolveAccess,'provided-global');assert.equal(v.sourceDatabaseRead,false);assert.equal(v.projectLoadSaveClosePerformed,false);assert.equal(v.losslessValidated,false);const rerun=spawnSync('python3',['-B','-c',script,r.sourcePath],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});assert.notEqual(rerun.status,0);assert.equal((await readPreservationPythonProbe(p.preparation)).resultSha256,v.resultSha256);}
 }finally{await fs.rm(r.directory,{recursive:true,force:true});}}
});
