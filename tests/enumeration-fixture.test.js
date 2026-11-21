'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {renderEnumerationFixture}=require('../phase-0/prepare-enumeration-fixture');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('fixture refuses nonempty or post-barrier changed sources before synthetic construction and retains failure state',
 {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frameline-enumeration-fixture-test-'));
 try{
  const inputPath=path.join(directory,'input.fcpxml');fs.writeFileSync(inputPath,'fixture-input');
  const record={probeId:'a'.repeat(32),inputPath,moviePath:path.join(directory,'movie.mov'),movieBytes:32,
   paths:Object.fromEntries(['empty','saved','started','baseline','result','marker','error'].map(key=>[key,path.join(directory,key)]))};
  const source=renderEnumerationFixture(record);
  const prefix=`local files={[${JSON.stringify(inputPath)}]='fixture-input',[${JSON.stringify(record.moviePath)}]=string.rep('m',32)}
local saves,exports,sets,imports=0,0,0,0;local count=INITIAL_COUNT;local drift=SHOULD_DRIFT
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1}
function h:WriteLine(v)files[name]=v..'\\n';if name==${JSON.stringify(record.paths.started)}and drift then count=1 end;return #v+1 end
function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end
function h:ReadLine()if self.offset>#files[name]then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;return value end;return h end
local p={};function p:GetName()return'Frameline Enumeration Fixture 20261120'end;function p:GetUniqueId()return'10000000-0000-4000-8000-000000000001'end
function p:GetTimelineCount()return count end;function p:SetSettings()sets=sets+1;return false end;function p:GetMediaPool()imports=imports+1;error('Construction reached')end
local pm={};function pm:GetCurrentProject()return p end;function pm:SaveProject()saves=saves+1;return true end
function pm:ExportProject(_,filename)exports=exports+1;files[filename]='native-empty';return true end
resolve={};function resolve:Fusion()return fusion end;function resolve:GetProjectManager()return pm end;function resolve:GetVersionString()return'21.1.2.10'end
function resolve:GetProductName()return'DaVinci Resolve'end;function resolve:IsStudio()return false end
`;
  const suffix=`print('ERROR:'..(files[${JSON.stringify(record.paths.error)}]or'absent'));print('COUNTS:'..saves..':'..exports..':'..sets..':'..imports);assert(files[${JSON.stringify(record.paths.marker)}]==nil)`;
  for(const [count,drift,counts,stage,mutated]of [[1,false,'0:0:0:0','initial',false],[0,true,'1:1:0:0','empty-backup',false],[0,false,'1:1:1:0','settings',true]]){
   const result=runVendorLuaMock(prefix.replace('INITIAL_COUNT',String(count)).replace('SHOULD_DRIFT',String(drift))+'\n'+source+'\n'+suffix);
   assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp('COUNTS:'+counts));
   const error=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('ERROR:')).slice(6));assert.equal(error.stage,stage);assert.equal(error.mutated,mutated);
  }
  const replayPrefix=prefix.replace('INITIAL_COUNT','1').replace('SHOULD_DRIFT','false')+`files[${JSON.stringify(record.paths.result)}]='previous-result';files[${JSON.stringify(record.paths.marker)}]='previous-completion'`;
  const replay=runVendorLuaMock(replayPrefix+'\n'+source+`\nassert(files[${JSON.stringify(record.paths.result)}]=='previous-result'and files[${JSON.stringify(record.paths.marker)}]=='previous-completion'and files[${JSON.stringify(record.paths.error)}]==nil);assert(saves==0 and exports==0 and sets==0 and imports==0);print('replay-retained')`);
  assert.equal(replay.status,0,replay.stderr);assert.match(replay.stdout,/replay-retained/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
