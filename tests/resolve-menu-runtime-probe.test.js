'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { renderProbe, prepare, readResult } = require('../phase-0/prepare-menu-runtime-probe');
const { reference } = require('../phase-0/inspect-resolve-api');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const template = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-menu-runtime-probe.lua'), 'utf8');
const binding = { probeId: 'a'.repeat(32), resultPath: '/private/tmp/probe-test/result.json', completePath: '/private/tmp/probe-test/complete.txt' };
const expectedName = 'Frameline Large Scan Proof 20261119 corpus01';

test('menu probe source binds one disposable project and rejects invalid source substitutions', () => {
  const source = renderProbe(template, binding);
  assert(source.includes(expectedName));
  assert(!source.includes('__RESULT_PATH__'));
  assert.throws(() => renderProbe(template, { ...binding, completePath: binding.resultPath }));
  assert.throws(() => renderProbe(template, { ...binding, probeId: 'unsafe' }));
  assert.throws(() => renderProbe(template.replace('__RESULT_PATH__', 'missing'), binding));
  const literalPath = renderProbe(template, { ...binding, resultPath: '/private/tmp/$&-literal/result.json' });
  assert(literalPath.includes('"/private/tmp/$&-literal/result.json"'));
});

test('actual vendor Lua executes the menu probe without a project write and refuses replay or the wrong project',
  { skip: !fs.existsSync(library) && 'Vendor Lua library unavailable' }, () => {
    const source = renderProbe(template, binding);
    const prefix = `local files={};local fusion={};function fusion:OpenFile(name,mode)
      if mode==1 and files[name]==nil then return nil end
      if mode==2 then files[name]='' end
      local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end
      function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name] end
      function h:ReadLine()if self.offset>#files[name] then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;return value end
      return h end
      local project={};function project:GetName()return ${JSON.stringify(expectedName)} end
      function project:GetUniqueId()return 'project-id' end;function project:GetTimelineCount()return 3 end
      local manager={};function manager:GetCurrentProject()return project end
      function manager:SaveProject()error('Must not write project')end
      resolve={};function resolve:GetVersionString()return '21.1.2.10' end;function resolve:GetProjectManager()return manager end
      function resolve:Fusion()return fusion end;`;
    const suffix = `print('MOCK_RESULT:'..(files[${JSON.stringify(binding.resultPath)}] or 'absent'));print('MOCK_COMPLETE:'..(files[${JSON.stringify(binding.completePath)}] or 'absent'));`;
    const run = script => spawnSync('python3', [path.join(__dirname, '../phase-0/run-lua-observation-mock.py'), library], { input: script, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const successful = run(`${prefix}\n${source}\n${source}\n${suffix}`);
    assert.equal(successful.status, 0, successful.stderr);
    assert(successful.stdout.includes(`FRAMELINE_MENU_PROBE_OK_V1:${binding.probeId}`));
    assert(successful.stdout.includes(`FRAMELINE_MENU_PROBE_FAILED_V1:${binding.probeId}`));
    assert(successful.stdout.includes(`MOCK_COMPLETE:FRAMELINE_MENU_PROBE_COMPLETE_V1:${binding.probeId}`));
    const line = successful.stdout.split('\n').find(row => row.startsWith('MOCK_RESULT:'));
    const result = JSON.parse(line.slice('MOCK_RESULT:'.length));
    assert.equal(result.projectId, 'project-id'); assert.equal(result.timelineCount, 3); assert.equal(result.readOnly, true);
    const wrong = run(`${prefix.replace(JSON.stringify(expectedName), '"Wrong project"')}\n${source}\n${suffix}`);
    assert.equal(wrong.status, 0); assert(wrong.stdout.includes('MOCK_RESULT:absent'));
  });

test('private preparation and host reader require bound complete marker and reject extra output', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-menu-host-reader-'));
  fs.chmodSync(directory, 0o700);
  const probeId = 'b'.repeat(32);
  const prepared = { schemaVersion: 1, probeId, expectedProjectName: expectedName, directory,
    preparedPath: path.join(directory, `Frameline Runtime Probe ${probeId.slice(0, 12)}.lua`),
    resultPath: path.join(directory, `result-${probeId}.json`), completePath: path.join(directory, `complete-${probeId}.txt`),
    templateSha256: createHash('sha256').update(template).digest('hex') };
  const rendered = renderProbe(template, prepared);
  prepared.sourceSha256 = createHash('sha256').update(rendered).digest('hex');
  fs.writeFileSync(prepared.preparedPath, rendered, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'preparation.json'), JSON.stringify(prepared), { flag: 'wx', mode: 0o600 });
  t.after(() => fs.rmSync(prepared.directory, { recursive: true, force: true }));
  assert.equal(fs.statSync(prepared.directory).mode & 0o777, 0o700);
  const record = path.join(prepared.directory, 'preparation.json');
  const output = { schemaVersion: 1, operation: 'resolve-menu-runtime-probe', probeId: prepared.probeId, readOnly: true,
    safeToApply: false, resolveVersion: '21.1.2.10', projectName: expectedName, projectId: 'project-id', timelineCount: 3,
    standardLuaIoAvailable: false, fusionOpenFileAvailable: true };
  fs.writeFileSync(prepared.resultPath, JSON.stringify(output)+'\n', { flag: 'wx', mode: 0o600 });
  await assert.rejects(readResult(record));
  fs.writeFileSync(prepared.completePath, `FRAMELINE_MENU_PROBE_COMPLETE_V1:${prepared.probeId}\n`, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(prepared.resultPath, 0o666); fs.chmodSync(prepared.completePath, 0o666);
  assert.equal((await readResult(record)).completionMarkerVerified, true);
  assert.equal(fs.statSync(prepared.resultPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(prepared.completePath).mode & 0o777, 0o600);
  fs.chmodSync(directory, 0o755);
  await assert.rejects(readResult(record), /unsafe-probe-result-directory/);
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(prepared.resultPath, JSON.stringify({ ...output, privatePath: '/Users/private' }));
  await assert.rejects(readResult(record), /invalid-probe-result/);
  const outside = path.join(os.tmpdir(), `frameline-menu-outside-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(outside,'Unrelated file',{flag:'wx',mode:0o644});fs.chmodSync(outside,0o644);
  t.after(()=>fs.rmSync(outside,{force:true}));
  fs.unlinkSync(prepared.resultPath);fs.linkSync(outside,prepared.resultPath);
  await assert.rejects(readResult(record),/invalid-probe-output-file/);
  assert.equal(fs.statSync(outside).mode&0o777,0o644);
  fs.unlinkSync(prepared.resultPath);fs.writeFileSync(prepared.resultPath,JSON.stringify(output),{flag:'wx',mode:0o600});
  const altered = fs.readFileSync(prepared.preparedPath,'utf8')+'\n-- changed source';
  fs.writeFileSync(prepared.preparedPath,altered);
  const changedRecord={...prepared,sourceSha256:createHash('sha256').update(altered).digest('hex')};
  fs.writeFileSync(record,JSON.stringify(changedRecord));
  await assert.rejects(readResult(record),/probe-source-changed/);
  fs.writeFileSync(prepared.preparedPath,rendered);fs.writeFileSync(record,JSON.stringify(prepared));
  const fifo = path.join(directory, 'fifo');
  const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (mkfifo.status === 0) {
    const readFifo = spawnSync(process.execPath, [path.join(__dirname, '../phase-0/prepare-menu-runtime-probe.js'), 'read', fifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(readFifo.status, 1); assert.equal(readFifo.signal, null);
    assert.equal(readFifo.stderr, 'resolve-menu-runtime-probe-failed\n');
  }
});

test('preparer creates private inspection files without installing when the pinned SDK is present',
  { skip: !fs.existsSync(reference) && 'Installed SDK unavailable; host-reader test uses an isolated fixture' }, async t => {
    const prepared = await prepare();
    t.after(() => fs.rmSync(prepared.directory, { recursive: true, force: true }));
    assert.equal(fs.statSync(prepared.directory).mode & 0o777, 0o700);
    assert.equal(prepared.installedPath, null);
  });

test('native menu capability evidence pins the path-free result and exact source bindings without enabling writes', () => {
  const root = path.join(__dirname,'..');
  const observed = JSON.parse(fs.readFileSync(path.join(root,'phase-0/resolve-menu-runtime-live-observation.json')));
  const result = fs.readFileSync(path.join(root,observed.resultFile));
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(result),observed.resultSha256);
  assert.deepEqual(JSON.parse(result),observed.result);
  assert.equal(sha(template),observed.templateSha256);
  assert.equal(sha(fs.readFileSync(path.join(root,observed.knownWriterSource))),observed.knownWriterSourceSha256);
  assert.equal(sha(fs.readFileSync(path.join(root,observed.hostReaderSource))),observed.hostReaderSourceSha256);
  assert.equal(sha(observed.completionMarker),observed.completionMarkerSha256);
  assert.equal(observed.result.resolveVersion,'21.1.2.10');assert.equal(observed.result.timelineCount,3);
  assert.equal(observed.result.standardLuaIoAvailable,false);assert.equal(observed.result.fusionOpenFileAvailable,true);
  assert.equal(observed.projectMutationCalls,0);assert.equal(observed.safeToApply,false);
  assert.equal(observed.installedTestScriptRemoved,true);
  assert(!JSON.stringify(observed).includes('/Users/'));assert(!JSON.stringify(observed).includes('/var/folders/'));
});
