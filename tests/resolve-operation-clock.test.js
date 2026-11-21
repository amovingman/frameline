'use strict';
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderClockProbe, prepareClockProbe, readClockProbe } = require('../phase-0/prepare-operation-clock-probe');
const { validateClockResult } = require('../phase-0/prepare-operation-clock-probe');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const base = fs.readFileSync(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
const clock = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-operation-clock.lua'), 'utf8');
const run = source => runVendorLuaMock(source, {library: library, maxBuffer: 1024 * 1024});
const active = fs.existsSync(library);

test('clock source reads real POSIX monotonic wall time with reported resolution and preserves callback returns', { skip: !active && 'Vendor Lua unavailable' }, () => {
  const script = `local module=(function() ${clock} end)();local timer=module.open();assert(timer.description.id=='posix-clock-monotonic');assert(timer.description.monotonic);assert(timer.description.reportedResolutionNs>0);local before=timer.read();local ok,values,err,measured=timer.measure(function()return true,nil,'third'end);assert(ok and values.n==3 and values[1]==true and values[2]==nil and values[3]=='third');assert(measured.wallStatus=='captured' and measured.wallNs>=0);local good,results,failure,bad=timer.measure(function()error('controlled')end);assert(not good and bad.returnedNormally==false and failure:find('controlled'));print('CLOCK_OK')`;
  const result = run(script); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /CLOCK_OK/);
});

test('wall clock fallback stays coarse/nonmonotonic and clock regressions remain unavailable', { skip: !active && 'Vendor Lua unavailable' }, () => {
  const script = `require=function()error('No ffi')end;local module=(function()${clock}end)();local timer=module.open();assert(timer.description.id=='lua-os-time' and timer.description.reportedResolutionNs==1000000000 and timer.description.monotonic==false);assert(module.delta_ns({sec=2,nano=0},{sec=1,nano=0})==nil);os=nil;local missing=module.open();assert(missing.description.status=='unavailable');local ok,values,err,measured=missing.measure(function()return false end);assert(ok and values[1]==false and measured.wallStatus=='unavailable-or-regressed' and measured.cpuStatus=='unavailable');print('FALLBACK_OK')`;
  const result = run(script); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /FALLBACK_OK/);
});

test('clock probe runs through Fusion file handoff and wrong project creates no output', { skip: !active && 'Vendor Lua unavailable' }, () => {
  const binding = { base, clock, probeId: 'a'.repeat(32), resultPath: '/private/tmp/clock-result', completePath: '/private/tmp/clock-complete' };
  const source = renderClockProbe(binding);
  const prefix = `local files={};local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end;function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;return value end;return h end;local p={GetName=function()return 'Frameline Integration Gate Fixture 20261120'end,GetUniqueId=function()return 'project-id'end};resolve={GetVersionString=function()return '21.1.2.10'end,GetProjectManager=function()return{GetCurrentProject=function()return p end}end,Fusion=function()return fusion end};`;
  const good = run(prefix+'\n'+source+`\nassert(files['${binding.completePath}']=='FRAMELINE_OPERATION_CLOCK_COMPLETE_V1:${binding.probeId}\\n');print('PROBE_OK')`);
  assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /PROBE_OK/);
  const bad = run(prefix.replace('Frameline Integration Gate Fixture 20261120', 'Wrong project')+'\n'+source+`\nassert(files['${binding.resultPath}']==nil);print('REFUSED_OK')`);
  assert.equal(bad.status, 0, bad.stderr); assert.match(bad.stdout, /REFUSED_OK/);
});

test('host clock reader requires source/nonce/marker and does not change unrelated hardlink permissions', async t => {
  const prepared = await prepareClockProbe(); t.after(() => fs.rmSync(prepared.directory, { recursive: true, force: true }));
  const preparation = path.join(prepared.directory, 'preparation.json');
  const result = { schemaVersion: 1, operation: 'resolve-operation-clock-probe', probeId: prepared.probeId,
    readOnly: true, safeToApply: false, resolveVersion: '21.1.2.10', projectName: prepared.expectedProjectName,
    projectId: 'fixture-id', wallClock: { status: 'captured', id: 'posix-clock-monotonic', monotonic: true,
      clockId: 6, binding: 'LuaJIT-FFI-clock_gettime', reportedResolutionNs: 1000, observedMinimumStepNs: 1000 }, emptyCallSample: { wallStatus: 'captured', wallNs: 1000, cpuStatus: 'captured', cpuMicros: 1, returnedNormally: true } };
  fs.writeFileSync(prepared.resultPath, JSON.stringify(result)+'\n', { flag: 'wx', mode: 0o600 });
  await assert.rejects(readClockProbe(preparation));
  fs.writeFileSync(prepared.completePath, `FRAMELINE_OPERATION_CLOCK_COMPLETE_V1:${prepared.probeId}\n`, { flag: 'wx', mode: 0o600 });
  assert.equal((await readClockProbe(preparation)).completionMarkerVerified, true);
  fs.writeFileSync(prepared.resultPath, JSON.stringify({ ...result, rawPrivateError: '/Users/private' }));
  await assert.rejects(readClockProbe(preparation), /invalid-clock-result/);
  const outside = path.join(prepared.directory, 'unrelated'); fs.writeFileSync(outside, 'untouched', { mode: 0o644 });
  fs.unlinkSync(prepared.resultPath); fs.linkSync(outside, prepared.resultPath);
  await assert.rejects(readClockProbe(preparation), /invalid-clock-output/);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
});

test('clock reader rejects a forged parent alias before tightening outside outputs', async t => {
  const os=require('node:os');const prepared=await prepareClockProbe();t.after(()=>fs.rmSync(prepared.directory,{recursive:true,force:true}));
  const holder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'clock-alias-test-'));t.after(()=>fs.rmSync(holder,{recursive:true,force:true}));
  const alias=path.join(holder,'alias');fs.symlinkSync(path.dirname(prepared.directory),alias);
  const forged=path.join(alias,path.basename(prepared.directory));
  const record=JSON.parse(JSON.stringify(prepared).replaceAll(prepared.directory,forged));
  const prep=path.join(forged,'forged-preparation.json');fs.writeFileSync(prep,JSON.stringify(record));
  fs.writeFileSync(prepared.resultPath,'outside owned output',{mode:0o644});
  await assert.rejects(readClockProbe(prep),/invalid-clock-directory/);
  assert.equal(fs.statSync(prepared.resultPath).mode&0o777,0o644);
});

test('native menu clock proof retains coarse fallback despite a faster mock-process clock', () => {
  const { createHash } = require('node:crypto');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const observed = require('../phase-0/resolve-operation-clock-live-observation.json');
  const bytes = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-operation-clock-live-result.json'));
  assert.equal(hash(bytes), observed.resultSha256);
  const result = validateClockResult(JSON.parse(bytes));
  assert.equal(result.wallClock.id, 'lua-os-time'); assert.equal(result.wallClock.monotonic, false);
  assert.equal(result.wallClock.reportedResolutionNs, 1000000000); assert.equal(result.emptyCallSample.wallNs, 0);
  assert.equal(hash(Buffer.from(clock)), observed.clockSourceSha256);
  assert.equal(hash(Buffer.from(base)), observed.baseSourceSha256);
  assert.equal(observed.projectMutationCalls, 0); assert.equal(observed.safeToApply, false);
});
