'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { prepareClosedProjectApplyCompanion, readClosedProjectApplyCompanion, admitClosedProjectApplyCompanion } = require('../src/closed-project-apply-companion');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const native = { skip: !syncFs.existsSync(library) && 'Vendor Lua unavailable' };
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bound = () => ({ transactionId: U(1), planId: 'a'.repeat(64), projectId: U(2), projectName: 'Personal project',
  timelineId: U(3), itemId: U(4), expectedName: 'Café "new"', expectedDatabaseSha256: 'b'.repeat(64), timelineIds: [U(3), U(5)],
  sourceBinding: { schemaVersion: 1, sourcePath: '/private/library/Personal project/Project.db', projectName: 'Personal project',
    libraryRoot: '/private/library', configPath: '/private/config', configSha256: 'c'.repeat(64),
    expectedCurrentDatabase: { DbType: 'Disk', DbName: 'Local Database' }, expectedCurrentFolder: 'Root' } });
function nativeReady(f) {
  return { schemaVersion: 1, operation: 'closed-project-native-source-ready', token: f.record.token,
    requestSha256: f.record.requestSha256, projectId: f.input.projectId, projectName: f.input.projectName,
    currentDatabase: f.input.sourceBinding.expectedCurrentDatabase, currentFolder: 'Root' };
}
function sourceObservation(f) {
  return { actualOpenFileBindingVerified: true, concurrentWriterResistanceProven: false,
    process: { pid: 123, started: 'Sat Nov 21 12:00:00 2026' },
    source: { path: f.input.sourceBinding.sourcePath, sha256: f.input.expectedDatabaseSha256, device: '1', inode: '2', size: 4096 },
    configSha256: f.input.sourceBinding.configSha256 };
}
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'closed-apply-companion-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { ...bound(), directory: path.join(root, 'verification'), ...options };
  const result = await prepareClosedProjectApplyCompanion(input);
  const record = JSON.parse(await fs.readFile(result.preparationPath));
  return { root, input, result, record, source: await fs.readFile(result.scriptPath, 'utf8') };
}
function luaMock(b, variant = '') {
  return `local calls=0;local mutations=0
local function touch()calls=calls+1 end
local forbidden=function()mutations=mutations+1;error('Unexpected mutator')end
local item={GetUniqueId=function()touch();return ${JSON.stringify(b.itemId)}end,GetName=function()touch();return ${JSON.stringify(variant === 'wrong-name' ? 'Wrong' : b.expectedName)}end,SetName=forbidden,GetEffects=forbidden,GetProperties=forbidden}
local function timeline(id)return{GetUniqueId=function()touch();return id end,GetTrackCount=function(_,kind)touch();assert(kind=='video');return 1 end,GetItemListInTrack=function()touch();return ${variant === 'sparse' ? '{[2]=item}' : variant === 'duplicate-item' ? '{item,item}' : '{item}'}end}end
local timelines={timeline(${JSON.stringify(b.timelineId)}),timeline(${JSON.stringify(variant === 'duplicate-timeline' ? b.timelineId : b.timelineIds[0])})}
local p={GetUniqueId=function()touch();return ${JSON.stringify(variant === 'wrong-project' ? U(99) : b.projectId)}end,GetName=function()touch();return ${JSON.stringify(b.projectName)}end,
 GetTimelineCount=function()touch();return 2 end,GetTimelineByIndex=function(_,i)touch();return timelines[i]end}
local pm={GetCurrentProject=function()touch();return p end,GetCurrentDatabase=function()touch();return{DbType='Disk',DbName=${JSON.stringify(variant === 'wrong-library' ? 'Duplicate Library' : 'Local Database')}}end,GetCurrentFolder=function()touch();return ${JSON.stringify(variant === 'wrong-folder' ? 'Nested' : '')}end,LoadProject=forbidden,SaveProject=forbidden,CloseProject=forbidden}
local fusion={};function fusion:OpenFile(file,mode)
 local h=io.open(file,mode==1 and'rb'or'wb');if not h then return nil end
 return{GetFileSize=function()local current=h:seek();local size=h:seek('end');h:seek('set',current);return size end,
 ReadLine=function()local text=h:read('*a');if text==''then return nil end;return text end,
 WriteLine=function(_,text)h:write(text..'\\n');return #text+1 end,Flush=function()h:flush();return true end,Close=function()h:close()end}
end
resolve={Fusion=function()return fusion end,GetVersionString=function()touch();return'21.1.2.10'end,
 GetProductName=function()touch();return'DaVinci Resolve'end,IsStudio=function()touch();return ${variant === 'studio' ? 'true' : 'false'} end,GetProjectManager=function()touch();return pm end}
bmd={wait=function()os.execute('sleep 0.01')end}
`;
}
async function execute(f, variant = '', replay = false) {
  // The deliberately reversed host input ensures the native observed inventory
  // is compared as a complete UUID set, independent of visible timeline order.
  const b = { ...f.input, timelineIds: [...f.input.timelineIds].reverse() };
  const program = luaMock(b, variant) + f.source + (replay
    ? '\nassert(calls==0 and mutations==0);print("refused-before-editor-read")'
    : '\nassert(mutations==0);print("no-mutations")');
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {runVendorLuaMock}=require(workerData.runner);parentPort.postMessage(runVendorLuaMock(workerData.source,{library:workerData.library}));`,
    { eval: true, workerData: { runner: path.join(__dirname, '../phase-0/run-vendor-lua-mock'), library,
      source: `local program=[==[${program}]==];local chunk,err=loadstring(program);if not chunk then print(err);error('compile failed')end;local ok,err=pcall(chunk);if not ok then print(err);error('execution failed')end` } });
  let done = false;
  const result = new Promise((resolve, reject) => { worker.once('message', value => { done = true; resolve(value); }); worker.once('error', reject); });
  if (!replay) {
    for (let attempt = 0; attempt < 1000 && !done; attempt++) {
      if (syncFs.existsSync(path.join(f.input.directory, 'error.json'))) break;
      if (syncFs.existsSync(path.join(f.input.directory, 'started.txt')) && syncFs.statSync(path.join(f.input.directory, 'started.txt')).size > 0) {
        try { await admitClosedProjectApplyCompanion(f.result.preparationPath, { observeSource: async () => sourceObservation(f), expectedBinding: f.input }); }
        catch (error) { await worker.terminate(); throw error; }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return result;
}

test('preparation binds a private immutable request and source without requiring phase-0 at runtime', async t => {
  const f = await fixture(t);
  const pending = await readClosedProjectApplyCompanion(f.result.preparationPath, f.input);
  assert.deepEqual(pending, { status: 'pending', started: false, doNotReplay: false, editorVerified: false });
  assert.doesNotMatch(f.source, /:(?:SaveProject|LoadProject|CloseProject|SetName|SetCurrentTimeline|GetEffects|GetProperties)\(/);
  assert.doesNotMatch(await fs.readFile(path.join(__dirname, '../src/closed-project-apply-companion.js'), 'utf8'), /require\(['"].*phase-0/);
  await assert.rejects(prepareClosedProjectApplyCompanion(f.input));
});

test('native readback normalizes the installed empty root folder and verifies UUIDs and Unicode Name without setters', native, async t => {
  const f = await fixture(t), run = await execute(f);
  assert.equal(run.status, 0, run.stdout + run.stderr); assert.match(run.stdout, /no-mutations/);
  const result = await readClosedProjectApplyCompanion(f.result.preparationPath, f.input);
  assert.equal(result.status, 'verified-open'); assert.equal(result.storedName, f.input.expectedName);
  assert.equal(result.expectedDatabaseSha256, f.input.expectedDatabaseSha256);
  assert.equal(result.sourceSha256, f.result.sourceSha256);
  assert.equal(result.editorVerified, true); assert.equal(result.postCloseDatabaseValidated, false);
  assert.equal(result.actualOpenFileBindingVerified, true); assert.equal(result.sourceBinding.source.path, f.input.sourceBinding.sourcePath);
  assert.equal(result.postCloseDatabaseValidationRequired, true);
  const replay = await execute(f, '', true);
  assert.equal(replay.status, 0, replay.stdout + replay.stderr); assert.match(replay.stdout, /refused-before-editor-read/);
  assert.equal((await readClosedProjectApplyCompanion(f.result.preparationPath)).status, 'verified-open');
});

test('native mismatches retain a failed readback and never publish a success marker', native, async t => {
  for (const variant of ['wrong-project', 'wrong-name', 'studio', 'sparse', 'duplicate-item', 'duplicate-timeline', 'wrong-library', 'wrong-folder']) {
    const f = await fixture(t), run = await execute(f, variant);
    assert.equal(run.status, 0, variant + ': ' + run.stdout + run.stderr);
    const result = await readClosedProjectApplyCompanion(f.result.preparationPath);
    assert.equal(result.status, 'native-error', variant); assert.equal(result.editorVerified, false);
    await assert.rejects(fs.access(path.join(f.input.directory, 'complete.txt')));
    const replay = await execute(f, '', true); assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  }
});

test('host rejects changed request, script, expected transaction binding and malformed output order', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.input.directory, 'native-source.json'), JSON.stringify(nativeReady(f)) + '\n');
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath, { ...f.input, expectedDatabaseSha256: 'c'.repeat(64) }));
  await fs.appendFile(f.result.scriptPath, '\n-- changed');
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
  await fs.writeFile(f.result.scriptPath, f.source);
  await fs.appendFile(path.join(f.input.directory, 'request.json'), ' ');
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
  await fs.writeFile(path.join(f.input.directory, 'request.json'), f.record.requestBytes);
  await fs.writeFile(path.join(f.input.directory, 'started.txt'), `FRAMELINE_CLOSED_APPLY_STARTED:${f.record.token}:${f.record.requestSha256}\n`);
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
});

test('a partially written handshake is retained and never authorizes Apply completion', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.input.directory, 'native-source.json'), JSON.stringify(nativeReady(f)) + '\n');
  await fs.writeFile(path.join(f.input.directory, 'ready.txt'), `FRAMELINE_CLOSED_APPLY_READY:${f.record.token}:${f.record.requestSha256}\n`);
  const result = await readClosedProjectApplyCompanion(f.result.preparationPath);
  assert.equal(result.status, 'pending'); assert.equal(result.doNotReplay, true); assert.equal(result.editorVerified, false);
});

test('host cannot admit before native identity and start, and refuses a mismatched loaded source', async t => {
  const f = await fixture(t); let calls = 0;
  assert.deepEqual(await admitClosedProjectApplyCompanion(f.result.preparationPath, { observeSource: async () => { calls++; return sourceObservation(f); } }),
    { admitted: false, status: 'pending' });
  assert.equal(calls, 0);
  await fs.writeFile(path.join(f.input.directory, 'native-source.json'), JSON.stringify(nativeReady(f)) + '\n');
  for (const stage of ['ready', 'started']) await fs.writeFile(path.join(f.input.directory, stage + '.txt'),
    `FRAMELINE_CLOSED_APPLY_${stage.toUpperCase()}:${f.record.token}:${f.record.requestSha256}\n`);
  await assert.rejects(admitClosedProjectApplyCompanion(f.result.preparationPath, { observeSource: async () => ({ ...sourceObservation(f), source: { ...sourceObservation(f).source, path: '/different/Project.db' } }) }));
  await assert.rejects(fs.access(path.join(f.input.directory, 'ticket.txt')));
  const admitted = await admitClosedProjectApplyCompanion(f.result.preparationPath, { observeSource: async () => sourceObservation(f) });
  assert.equal(admitted.admitted, true); assert.match(admitted.receiptSha256, /^[a-f0-9]{64}$/);
  const repeated = await admitClosedProjectApplyCompanion(f.result.preparationPath, { observeSource: async () => { throw new Error('Must not recapture after ticket'); } });
  assert.deepEqual(repeated, admitted);
  assert.equal((await readClosedProjectApplyCompanion(f.result.preparationPath)).editorVerified, false);
});

test('host rejects result claims with additional fields, changed Name or missing native start marker', native, async t => {
  const f = await fixture(t); assert.equal((await execute(f)).status, 0);
  const resultPath = path.join(f.input.directory, 'result.json'), bytes = await fs.readFile(resultPath);
  const parsed = JSON.parse(bytes);
  for (const altered of [{ ...parsed, postCloseDatabaseValidated: true }, { ...parsed, storedName: 'Other' }]) {
    await fs.writeFile(resultPath, JSON.stringify(altered) + '\n');
    await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
  }
  await fs.writeFile(resultPath, bytes); await fs.unlink(path.join(f.input.directory, 'started.txt'));
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
});

test('host rejects linked and symlinked protocol files and a changed installed script', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'closed-apply-menu-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = await fixture(t, { scriptsDirectory: root });
  const installed = path.join(root, f.result.menuName + '.lua');
  await fs.appendFile(installed, '\n-- changed');
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
  await fs.writeFile(installed, f.source);
  const request = path.join(f.input.directory, 'request.json');
  await fs.link(request, path.join(f.root, 'linked'));
  await assert.rejects(readClosedProjectApplyCompanion(f.result.preparationPath));
});
