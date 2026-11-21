'use strict';
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRelinkIdentityCommand, readRelinkIdentityResult } = require('../phase-0/resolve-relink-identity');
const { auditRelinkIdentity } = require('../phase-0/audit-relink-identity');
const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
const library = process.env.FRAMELINE_LUA_LIBRARY || '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const luaAvailable = syncFs.existsSync(library);
const runLua = script => runVendorLuaMock(script, {library: library, maxBuffer: 4 * 1024 * 1024});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'relink-proof-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDirectory = path.join(directory, 'source'), targetDirectory = path.join(directory, 'target');
  await fs.mkdir(sourceDirectory); await fs.mkdir(targetDirectory);
  const receipts = JSON.parse(await fs.readFile(path.join(root, 'live-relink-identity-receipts.json')));
  const media = [];
  for (const asset of receipts.media) {
    const bytes = Buffer.from(`Synthetic compiler guard fixture: ${asset.name}`);
    await fs.writeFile(path.join(sourceDirectory, asset.name), bytes);
    await fs.writeFile(path.join(targetDirectory, asset.name), bytes);
    media.push({ mediaPoolId: asset.mediaPoolId, name: asset.name, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { sourceDirectory, targetDirectory, media,
    observationBytes: await fs.readFile(path.join(root, 'live-relink-identity-baseline.json')) };
}

test('relink experiment refuses changed, missing or symlinked candidate bytes before issuing a command', async t => {
  const options = await fixture(t), asset = options.media[0];
  const source = path.join(options.sourceDirectory, asset.name), target = path.join(options.targetDirectory, asset.name);
  await fs.writeFile(target, 'Changed candidate');
  await assert.rejects(createRelinkIdentityCommand(options), /relink-media-content-mismatch/);
  await fs.unlink(target);
  await assert.rejects(createRelinkIdentityCommand(options), { code: 'ENOENT' });
  await fs.symlink(source, target);
  await assert.rejects(createRelinkIdentityCommand(options), { code: 'symlink-unsupported' });
});

test('relink experiment binds complete named-project observations and every referenced media identity', async t => {
  const options = await fixture(t), observation = JSON.parse(options.observationBytes);
  observation.snapshot.project_name = 'Another project';
  await assert.rejects(createRelinkIdentityCommand({ ...options, observationBytes: JSON.stringify(observation) }), /invalid-relink/);
  await assert.rejects(createRelinkIdentityCommand({ ...options, media: options.media.slice(1) }), /invalid-relink/);
  await assert.rejects(createRelinkIdentityCommand({ ...options, targetDirectory: options.sourceDirectory }), /invalid-relink/);
  const altered = structuredClone(options.media); altered[0].name = '../elsewhere';
  await assert.rejects(createRelinkIdentityCommand({ ...options, media: altered }), /invalid-relink/);
  const prepared = await createRelinkIdentityCommand(options);
  assert.equal(prepared.sourceSha256, createHash('sha256').update(options.observationBytes).digest('hex'));
  assert.equal(prepared.runtimeContentHashGuard, false); assert.equal(prepared.safeToApply, false);
});

test('generated relink command compiles in the installed Resolve Lua runtime',
  { skip: !luaAvailable && 'Set FRAMELINE_LUA_LIBRARY to run the Lua compiler' }, async t => {
    const options = await fixture(t), prepared = await createRelinkIdentityCommand(options);
    const result = runLua(`assert(loadstring(${JSON.stringify(prepared.command)}))`);
    assert.equal(result.status, 0, result.stderr);
  });

async function mockSpike(scenario) {
  const spike = await fs.readFile(path.join(__dirname, '../phase-0/resolve-relink-identity-spike.lua'), 'utf8');
  return runLua(`local spike=(function() ${spike} end)();local scenario=${JSON.stringify(scenario)};
    local mutations,saves,closes,reopens=0,0,0,0;local generation=1;local paths={a='/source/a.jpg',b='/source/b.wav'};
    local function media(id)return{GetUniqueId=function()return id end,GetClipProperty=function()return paths[id]end}end;
    local function project()
      local created=generation;
      local pool={GetRootFolder=function()return{GetClipList=function()return scenario=='duplicate-media' and {media('a'),media('a')}
        or scenario=='missing-media' and {media('a')} or {media('a'),media('b')}end}end,
        RelinkClips=function(self,items,target)assert(created==generation,'Stale pool object');mutations=mutations+1;for _,item in ipairs(items)do paths[item:GetUniqueId()]=target..'/'..(item:GetUniqueId()=='a' and 'a.jpg' or 'b.wav')end;return true end};
      return{GetName=function()return'Frameline Relink Identity Proof'end,
        GetUniqueId=function()return scenario=='wrong-project' and 'wrong' or scenario=='reopened-id' and generation>1 and 'changed' or 'project'end,
        GetMediaPool=function()assert(created==generation,'Stale project object');return pool end}
    end;
    local current=project();local pm={GetCurrentProject=function()return current end,
      SaveProject=function()saves=saves+1;return true end,
      CloseProject=function()closes=closes+1;current=nil;return true end,
      LoadProject=function()reopens=reopens+1;generation=generation+1;current=project();return current end};
    local resolve={GetVersionString=function()return'21.1.2.10'end,GetProjectManager=function()return pm end};
    bmd={fileexists=function(filename)return not(scenario=='missing-target' and filename=='/target/b.wav')end};
    if scenario=='location-changed' then paths.b='/unexpected/b.wav'end;
    local function capture()return (scenario=='stale-source' or scenario=='changed-after-reopen' and generation>1) and 'changed' or 'expected'end;
    local ok,result=pcall(function()return spike.run(resolve,capture,function(v)return v end,
      {projectId='project',expectedObservation='expected',sourceDirectory='/source',targetDirectory='/target',
        media={{mediaPoolId='a',name='a.jpg'},{mediaPoolId='b',name='b.wav'}}})end);
    if scenario=='success' then assert(ok,tostring(result));assert(mutations==1 and saves==1 and closes==1 and reopens==1);assert(#result.media==2 and result.savedAndReopened and not result.safeToApply)
    elseif scenario=='changed-after-reopen' or scenario=='reopened-id' then assert(not ok and mutations==1 and reopens==1)
    else assert(not ok and mutations==0 and saves==0 and closes==0 and reopens==0)end;`);
}
test('Lua relink guards reject stale observations, wrong projects, changed locations and missing targets before mutation',
  { skip: !luaAvailable && 'Set FRAMELINE_LUA_LIBRARY to run the Lua mock' }, async () => {
    for (const scenario of ['wrong-project', 'stale-source', 'location-changed', 'missing-target', 'duplicate-media', 'missing-media']) {
      const result = await mockSpike(scenario); assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    }
  });
test('Lua relink reacquires editor objects after reopen and refuses an altered resulting observation or identity',
  { skip: !luaAvailable && 'Set FRAMELINE_LUA_LIBRARY to run the Lua mock' }, async () => {
    for (const scenario of ['success', 'changed-after-reopen', 'reopened-id']) {
      const result = await mockSpike(scenario); assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    }
  });

test('Console relink results require complete ordered parts, exact observation and all matching media receipts', async t => {
  const options = await fixture(t), captureId = 'a'.repeat(32);
  const result = { schemaVersion: 1, operation: 'resolve-relink-identity-result', projectId: JSON.parse(options.observationBytes).snapshot.project_id,
    experimental: true, safeToApply: false, savedAndReopened: true,
    media: options.media.map(({ mediaPoolId, name }) => ({ mediaPoolId, name, pathMatches: true })), observation: JSON.parse(options.observationBytes) };
  const output = value => {
    const chunks = JSON.stringify(value).match(/[\s\S]{1,4000}/g);
    return chunks.map((chunk, index) => `FRAMELINE_RELINK_IDENTITY_PART_V1:${captureId}:${index + 1}:${chunks.length}:${chunk}`).join('\n');
  };
  const read = (text, id = captureId) => readRelinkIdentityResult({ ...options, captureId: id, output: text });
  assert.equal(read(output(result)).result.savedAndReopened, true);
  const rows = output(result).split('\n');
  for (const text of [rows.slice(1).join('\n'), rows.toReversed().join('\n'), [...rows, rows[0]].join('\n'),
    `FRAMELINE_RELINK_IDENTITY_ERROR_V1:${captureId}:failed\n${output(result)}`]) assert.throws(() => read(text));
  assert.throws(() => read(output(result), 'b'.repeat(32)));
  for (const mutate of [r => { r.media[0].pathMatches = false; }, r => { r.media[0].name = '/Users/private'; },
    r => { r.media[1] = r.media[0]; }, r => { r.projectId = 'wrong'; },
    r => { r.observation.items[0].properties.Pan.decimal = '1.3250000000000000e+01'; }]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => read(output(changed)));
  }
});

test('native relink evidence recomputes retained repeated-media identities without closing the broader identity gates', async () => {
  const report = auditRelinkIdentity();
  assert.equal(report.occurrenceCount, 5); assert.equal(report.mediaPoolItemCount, 3);
  assert.equal(report.repeatedMediaGroups, 2); assert.equal(report.propertyValueCount, 110);
  assert.equal(report.observedIdentitiesRetained, true);
  assert.equal(report.originalPathsRestoredAndReopened, true); assert.equal(report.reusableCommandsVerified, true);
  assert.equal(report.runtimeContentHashGuard, false); assert.equal(report.stableTrackIdentityProven, false);
  assert.equal(report.apiToExportMappingProven, false); assert.equal(report.safeToApply, false);
  const run = spawnSync(process.execPath, [path.join(__dirname, '../phase-0/audit-relink-identity.js')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), report);
  assert(!run.stdout.includes('/Users/')); assert(!run.stdout.includes('/private/'));
});

test('native relink audit rejects altered evidence bytes and altered command sources', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relink-audit-tamper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'resolve-xml-proof'));
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/relink-identity-live-observation.json')));
  for (const name of ['relink-identity-live-observation.json', 'resolve-relink-identity.js', 'resolve-relink-identity-spike.lua']) {
    await fs.copyFile(path.join(__dirname, '../phase-0', name), path.join(directory, name));
  }
  for (const source of Object.values(manifest.files)) await fs.copyFile(path.join(root, source.name), path.join(directory, 'resolve-xml-proof', source.name));
  assert.equal(auditRelinkIdentity(directory).observedIdentitiesRetained, true);
  const filename = path.join(directory, 'resolve-xml-proof', manifest.files.reopened.name);
  const original = await fs.readFile(filename); await fs.appendFile(filename, ' ');
  assert.throws(() => auditRelinkIdentity(directory), /evidence-mismatch/);
  await fs.writeFile(filename, original); await fs.appendFile(path.join(directory, 'resolve-relink-identity-spike.lua'), '\n');
  assert.throws(() => auditRelinkIdentity(directory), /evidence-mismatch/);
});
