'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{renderEnumerationRetry}=require('../phase-0/prepare-enumeration-fixture-retry');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('separate retry omits failed settings call, pins projectUUID and preserves replay/postbarrier guards',
 {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frameline-enumeration-retry-test-'));
 try{
  const inputPath=path.join(directory,'input.fcpxml');fs.writeFileSync(inputPath,'fixture-input');
  const project='10000000-0000-4000-8000-000000000001',record={expectedProjectId:project,probeId:'a'.repeat(32),inputPath,moviePath:path.join(directory,'movie.mov'),movieBytes:32,
   paths:Object.fromEntries(['empty','saved','started','baseline','result','marker','error'].map(key=>[key,path.join(directory,key)]))};
  const source=renderEnumerationRetry(record);assert(!source.includes(':SetSettings('));assert(source.includes('local project_id='+JSON.stringify(project)));
  const prefix=`local files={[${JSON.stringify(inputPath)}]='fixture-input',[${JSON.stringify(record.moviePath)}]=string.rep('m',32)}
local saves,exports,sets,imports=0,0,0,0;local count=0;local drift=false;local project_id='${project}'
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1}
function h:WriteLine(v)files[name]=v..'\\n';if name==${JSON.stringify(record.paths.started)}and drift then count=1 end;return #v+1 end
function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end
function h:ReadLine()if self.offset>#files[name]then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;return value end;return h end
local p={};function p:GetName()return'Frameline Enumeration Fixture 20261120'end;function p:GetUniqueId()return project_id end
function p:GetTimelineCount()return count end;function p:SetSettings()sets=sets+1;return false end;function p:GetMediaPool()imports=imports+1;error('Construction reached after omitted setting')end
local pm={};function pm:GetCurrentProject()return p end;function pm:SaveProject()saves=saves+1;return true end
function pm:ExportProject(_,filename)exports=exports+1;files[filename]='native-empty';return true end
resolve={};function resolve:Fusion()return fusion end;function resolve:GetProjectManager()return pm end;function resolve:GetVersionString()return'21.1.2.10'end
function resolve:GetProductName()return'DaVinci Resolve'end;function resolve:IsStudio()return false end
`;
  const suffix=`print('ERROR:'..(files[${JSON.stringify(record.paths.error)}]or'absent'));print('COUNTS:'..saves..':'..exports..':'..sets..':'..imports)`;
  const forward=runVendorLuaMock(prefix+'\n'+source+'\n'+suffix);assert.equal(forward.status,0,forward.stderr);assert.match(forward.stdout,/COUNTS:1:1:0:1/);
  const error=JSON.parse(forward.stdout.split('\n').find(line=>line.startsWith('ERROR:')).slice(6));assert.equal(error.stage,'import-picture');assert.equal(error.mutated,true);
  const wrong=runVendorLuaMock(prefix+"project_id='20000000-0000-4000-8000-000000000001'\n"+source+'\n'+suffix);assert.equal(wrong.status,0,wrong.stderr);assert.match(wrong.stdout,/COUNTS:0:0:0:0/);assert.match(wrong.stdout,/ERROR:absent/);
  const drift=runVendorLuaMock(prefix+'drift=true\n'+source+'\n'+suffix);assert.equal(drift.status,0,drift.stderr);assert.match(drift.stdout,/COUNTS:1:1:0:0/);
  const replay=runVendorLuaMock(prefix+`files[${JSON.stringify(record.paths.result)}]='old-result';files[${JSON.stringify(record.paths.marker)}]='old-completion'\n`+source+`\nassert(files[${JSON.stringify(record.paths.result)}]=='old-result'and files[${JSON.stringify(record.paths.marker)}]=='old-completion'and files[${JSON.stringify(record.paths.error)}]==nil)\n`+suffix);
  assert.equal(replay.status,0,replay.stderr);assert.match(replay.stdout,/COUNTS:0:0:0:0/);assert.match(replay.stdout,/ERROR:absent/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
