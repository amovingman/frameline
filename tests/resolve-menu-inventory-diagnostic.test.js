'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {renderDiagnostic,readDiagnostic}=require('../phase-0/prepare-menu-inventory-diagnostic');
const template=fs.readFileSync(path.join(__dirname,'../phase-0/resolve-menu-inventory.lua'),'utf8');
const base=fs.readFileSync(path.join(__dirname,'../src/companion/resolve-internal.lua'),'utf8');
const library='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const projectName='Frameline Large Scan Proof 20261119 corpus01';
const binding={probeId:'f'.repeat(32),directory:'/private/tmp/virtual-diagnostic',resultPath:'/private/tmp/virtual-diagnostic/result.json',completePath:'/private/tmp/virtual-diagnostic/complete.txt'};

test('diagnostic wraps only read-only capture with bounded stage and private error handling',()=>{
  const source=renderDiagnostic(template,base,binding);
  assert(source.includes('diagnostic_step("first-capture"'));
  assert(!/:(SaveProject|LoadProject|CloseProject|SetName|SetCurrentTimeline|CreateProject)\(/.test(source));
  assert(source.includes('text:sub(1,4096)'));
  assert.throws(()=>renderDiagnostic(template.replace('local ok = pcall(function()','local incompatible = pcall(function()'),base,binding));
});

test('vendor Lua diagnostic preserves stage evidence and classifies snapshot failure without publishing raw error',
 {skip:!fs.existsSync(library)&&'Vendor Lua library unavailable'},()=>{
  const source=renderDiagnostic(template,base,binding);
  const prefix=`local files={};local fusion={};function fusion:OpenFile(name,mode)
    if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]='' end
    local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end
    function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name] end
    function h:ReadLine()if self.offset>#files[name]then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;return value end;return h end
    local project={};function project:GetName()return ${JSON.stringify(projectName)} end
    function project:GetUniqueId()return 'project-id' end;function project:GetTimelineCount()return 0 end
    local manager={};function manager:GetCurrentProject()return project end
    resolve={};function resolve:GetVersionString()return '21.1.2.10' end;function resolve:GetProjectManager()return manager end;function resolve:Fusion()return fusion end;`;
  const report=path.join(binding.directory,`diagnostic-${binding.probeId}.json`),raw=path.join(binding.directory,`error-${binding.probeId}.txt`);
  const suffix=`print('MOCK_DIAGNOSTIC:'..(files[${JSON.stringify(report)}]or 'absent'));print('MOCK_RAW_PRESENT:'..tostring(files[${JSON.stringify(raw)}]~=nil));`;
  const run=script=>spawnSync('python3',[path.join(__dirname,'../phase-0/run-lua-observation-mock.py'),library],{input:script,encoding:'utf8',maxBuffer:1024*1024});
  const good=run(prefix+'\n'+source+'\n'+suffix);assert.equal(good.status,0,good.stderr);
  const parse=out=>JSON.parse(out.split('\n').find(line=>line.startsWith('MOCK_DIAGNOSTIC:')).slice('MOCK_DIAGNOSTIC:'.length));
  assert.equal(parse(good.stdout).status,'complete');assert.equal(parse(good.stdout).stage,'complete');
  const bad=run(prefix+"\nfunction project:GetUniqueId()return nil end\n"+source+'\n'+suffix);
  assert.equal(bad.status,0,bad.stderr);assert.equal(parse(bad.stdout).stage,'first-capture');
  assert.equal(parse(bad.stdout).errorCode,'unsafe-or-missing-snapshot-text');assert(bad.stdout.includes('MOCK_RAW_PRESENT:true'));
  const sensitive=run(prefix+"\nfunction project:GetUniqueId()error('private /Users/hidden/source.mov')end\n"+source+'\n'+suffix);
  assert.equal(sensitive.status,0,sensitive.stderr);assert.equal(parse(sensitive.stdout).errorCode,'unclassified-runtime-error');
  assert(!sensitive.stdout.includes('/Users/hidden'));
});

test('diagnostic host returns only allowlisted stage/error status and hashes raw errors privately',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frameline-diagnostic-reader-'));fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const probeId='e'.repeat(32);
  const record={schemaVersion:1,operation:'prepare-resolve-menu-inventory-diagnostic',probeId,directory,
    resultPath:path.join(directory,'result.json'),completePath:path.join(directory,'complete.txt'),preparedPath:path.join(directory,`Frameline Inventory Diagnostic ${probeId.slice(0,12)}.lua`)};
  const source=renderDiagnostic(template,base,record);record.sourceSha256=createHash('sha256').update(source).digest('hex');
  fs.writeFileSync(record.preparedPath,source,{flag:'wx',mode:0o600});const preparation=path.join(directory,'preparation.json');fs.writeFileSync(preparation,JSON.stringify(record),{flag:'wx',mode:0o600});
  assert.equal((await readDiagnostic(preparation)).status,'incomplete-or-not-run');
  fs.writeFileSync(path.join(directory,`stage-${probeId}-first-capture.txt`),`FRAMELINE_MENU_INVENTORY_STAGE_V1:${probeId}:first-capture\n`,{flag:'wx',mode:0o600});
  const report={schemaVersion:1,operation:'resolve-menu-inventory-diagnostic',probeId,readOnly:true,safeToApply:false,status:'failed',stage:'first-capture',errorCode:'unclassified-runtime-error'};
  const reportFile=path.join(directory,`diagnostic-${probeId}.json`);fs.writeFileSync(reportFile,JSON.stringify(report),{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(directory,`error-${probeId}.txt`),'private /Users/hidden/source.mov',{flag:'wx',mode:0o600});
  const read=await readDiagnostic(preparation);assert.equal(read.stage,'first-capture');assert.equal(read.rawError.retainedPrivately,true);
  assert(!JSON.stringify(read).includes('/Users/'));fs.writeFileSync(reportFile,JSON.stringify({...report,privatePath:'/Users/hidden'}));
  await assert.rejects(readDiagnostic(preparation),/invalid-diagnostic-report/);
});
