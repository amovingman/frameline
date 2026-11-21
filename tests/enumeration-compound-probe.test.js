'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const{ownerRich,renderEnumerationCompoundProbe}=require('../phase-0/prepare-enumeration-compound-probe');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
test('compound control compares each owner separately and refuses foreign context/replay before construction',
 {skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},()=>{
 const rich={activeTimelineId:'main',snapshot:{timelines:[{id:'main'},{id:'secondary'}]},items:[{timelineId:'main',itemId:'v1',properties:{Pan:1}},{timelineId:'secondary',itemId:'v2',properties:{Pan:2}}],tracks:[{timelineId:'main'},{timelineId:'secondary'}]};
 const selected=ownerRich(rich,'main');assert.equal(selected.items.length,1);const changed=structuredClone(rich);changed.items[0].properties.Pan=3;assert.notDeepEqual(ownerRich(changed,'main'),selected);assert.equal(ownerRich(rich,'secondary').items[0].properties.Pan,2);
 const record={projectId:'10000000-0000-4000-8000-000000000001',probeId:'a'.repeat(32),backupPath:'/private/tmp/compound-backup',backupBytes:12,
  roles:{mainTimelineId:'main',mainVideo1:'video',movieMediaPoolId:'media'},owners:[{id:'main',strict:{},rich:{}},{id:'secondary',strict:{},rich:{}}],
  observationPaths:['/private/tmp/c1','/private/tmp/c2','/private/tmp/c3'],resultPath:'/private/tmp/compound-result',markerPath:'/private/tmp/compound-marker',startedPath:'/private/tmp/compound-started',errorPath:'/private/tmp/compound-error',savedArchivePath:'/private/tmp/compound.drp',
  negativeName:'Negative',compoundName:'Compound',sourceCaptureResultSha256:'b'.repeat(64)};
 const source=renderEnumerationCompoundProbe(record);
 assert(source.indexOf("stage='source-after-barrier';guard_owners(2)")<source.indexOf("stage='negative-timeline-create'"));
 assert(source.includes('negative:CreateCompoundClip({video,audio}'));
 const prefix=`local files={};local saves,selections,imports=0,0,0;local id=PROJECT_ID
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;error('Unexpected writer')end
local p={};function p:GetName()return'Frameline Enumeration Fixture 20261120'end;function p:GetUniqueId()return id end;function p:SetCurrentTimeline()selections=selections+1;error('Selection reached')end;function p:GetMediaPool()imports=imports+1;error('Construction reached')end
local pm={};function pm:GetCurrentProject()return p end;function pm:SaveProject()saves=saves+1;error('Save reached')end
resolve={};function resolve:Fusion()return fusion end;function resolve:GetProjectManager()return pm end;function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProductName()return'DaVinci Resolve'end;function resolve:IsStudio()return false end
`;
 const suffix=`assert(saves==0 and selections==0 and imports==0 and files['/private/tmp/compound-error']==nil);print('guarded')`;
 const foreign=runVendorLuaMock(prefix.replace('PROJECT_ID',JSON.stringify('foreign'))+'\n'+source+'\n'+suffix);assert.equal(foreign.status,0,foreign.stderr);assert.match(foreign.stdout,/guarded/);
 const replay=runVendorLuaMock(prefix.replace('PROJECT_ID',JSON.stringify(record.projectId))+`files['/private/tmp/compound-result']='previous';\n`+source+'\n'+suffix+`;assert(files['/private/tmp/compound-result']=='previous')`);assert.equal(replay.status,0,replay.stderr);assert.match(replay.stdout,/guarded/);
});
