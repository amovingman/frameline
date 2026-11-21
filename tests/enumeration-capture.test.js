'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {renderEnumerationCapture}=require('../phase-0/prepare-enumeration-capture');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('actual capture refuses a foreign project and replay before timeline selection/export, preserving existing outcomes',
 {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},()=>{
 const record={projectId:'10000000-0000-4000-8000-000000000001',probeId:'a'.repeat(32),backupPath:'/private/tmp/enum-backup.drp',backupBytes:12,
  baseline:{activeTimelineId:'timeline-a'},checkpoint:{resultSha256:'b'.repeat(64)},timelineIds:['timeline-a','timeline-b'],
  orientations:[{before:'/private/tmp/a-before',after:'/private/tmp/a-after',archive:'/private/tmp/a.drp'},{before:'/private/tmp/b-before',after:'/private/tmp/b-after',archive:'/private/tmp/b.drp'}],
  resultPath:'/private/tmp/enum-result',markerPath:'/private/tmp/enum-marker',errorPath:'/private/tmp/enum-error'};
 const source=renderEnumerationCapture(record);
 assert(!/:\s*(?:Save\w*|CloseProject|LoadProject|Import\w*|Delete\w*|Add\w*|SetName|SetProperties)\s*\(/.test(source));
 const prefix=`local files={};local exports,selections=0,0;local id=PROJECT_ID
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1};function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local v=files[name]:sub(self.offset);self.offset=#files[name]+1;return v end;function h:WriteLine(v)files[name]=v..'\\n';return #v+1 end;function h:Flush()return true end;function h:Close()end;return h end
local p={};function p:GetName()return'Frameline Enumeration Fixture 20261120'end;function p:GetUniqueId()return id end;function p:SetCurrentTimeline()selections=selections+1;error('Selection reached')end
local pm={};function pm:GetCurrentProject()return p end;function pm:ExportProject()exports=exports+1;error('Export reached')end
resolve={};function resolve:Fusion()return fusion end;function resolve:GetProjectManager()return pm end;function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProductName()return'DaVinci Resolve'end;function resolve:IsStudio()return false end
`;
 const suffix=`assert(selections==0 and exports==0 and files['/private/tmp/enum-error']==nil);print('refused-without-context-change')`;
 const foreign=runVendorLuaMock(prefix.replace('PROJECT_ID',JSON.stringify('foreign-project'))+'\n'+source+'\n'+suffix);
 assert.equal(foreign.status,0,foreign.stderr);assert.match(foreign.stdout,/refused-without-context-change/);
 const replay=runVendorLuaMock(prefix.replace('PROJECT_ID',JSON.stringify(record.projectId))+`files['/private/tmp/enum-result']='previous-result';files['/private/tmp/enum-marker']='previous-marker'\n`+source+'\n'+suffix+`;assert(files['/private/tmp/enum-result']=='previous-result'and files['/private/tmp/enum-marker']=='previous-marker')`);
 assert.equal(replay.status,0,replay.stderr);assert.match(replay.stdout,/refused-without-context-change/);
});
