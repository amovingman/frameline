'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installResolveCompanion } = require('../src/resolve-companion-install');
const { createCaptureRequest, readCaptureResponse } = require('../src/resolve-companion-protocol');
const { installResolveMenuCompanion, activateResolveMenuRequest,
  createLuaCaptureCommand } = require('../src/resolve-menu-companion');

const fixture = path.join(__dirname, '..', 'phase-0/resolve-xml-proof/live-mapping-before-schema3.json');
const projectName = 'Frameline API Relink Test';
const fakeResolve = `import json, runpy, sys
snapshot = json.load(open(sys.argv[2], encoding='utf-8'))
original = runpy.run_path
def with_snapshot(filename, *args, **kwargs):
    if str(filename).endswith('resolve_snapshot.py'):
        return {'capture': lambda resolve: snapshot}
    return original(filename, *args, **kwargs)
runpy.run_path = with_snapshot
class Project:
    def GetName(self): return sys.argv[3]
class Manager:
    def GetCurrentProject(self): return Project()
class Resolve:
    def GetProjectManager(self): return Manager()
runpy.run_path(sys.argv[1], init_globals={'resolve': Resolve()})`;

test('Scripts menu command runs only the active private read-only request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-menu-companion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = await installResolveCompanion({
    bundledDirectory: path.join(__dirname, '..', 'src/companion'),
    dataDirectory: path.join(root, 'private')
  });
  const pointerPath = path.join(path.dirname(installed.scriptPath), 'active-request.txt');
  const scriptsDirectory = path.join(root, 'Resolve Scripts');
  assert.deepEqual(await installResolveMenuCompanion({ scriptsDirectory,
    scriptPath: installed.scriptPath, pointerPath }),
  { installed: true, menuName: 'Frameline Read Only Capture' });
  const menuPath = path.join(scriptsDirectory, 'Utility', 'Frameline Read Only Capture.py');
  assert.equal((await fs.stat(menuPath)).mode & 0o077, 0);
  assert.equal((await installResolveMenuCompanion({ scriptsDirectory,
    scriptPath: installed.scriptPath, pointerPath })).installed, false);
  const created = await createCaptureRequest({ directory: installed.requestsDirectory,
    expectedProjectName: projectName });
  await activateResolveMenuRequest({ pointerPath, requestFile: created.requestFile,
    requestsDirectory: installed.requestsDirectory });
  execFileSync('python3', ['-c', fakeResolve, menuPath, fixture, projectName]);
  const response = await readCaptureResponse({ directory: installed.requestsDirectory, ...created });
  assert.equal(response.readOnly, true);
  assert.equal(response.safeToApply, false);
  assert.equal(response.manifest.projectId, 'f9d4820a-47a6-42ba-b097-86a7fc23cfaf');
  await assert.rejects(activateResolveMenuRequest({ pointerPath,
    requestFile: fixture, requestsDirectory: installed.requestsDirectory }),
  { code: 'resolve-menu-companion-invalid' });
  await fs.writeFile(menuPath, 'changed');
  await assert.rejects(installResolveMenuCompanion({ scriptsDirectory,
    scriptPath: installed.scriptPath, pointerPath }),
  { code: 'resolve-menu-companion-invalid' });
});

test('Lua Console command embeds only the matching private request and prints a marked result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-lua-companion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = await installResolveCompanion({
    bundledDirectory: path.join(__dirname, '..', 'src/companion'),
    dataDirectory: path.join(root, 'private')
  });
  const first = await createCaptureRequest({ directory: installed.requestsDirectory,
    expectedProjectName: projectName });
  const luaSource = await fs.readFile(installed.luaScriptPath, 'utf8');
  const command = createLuaCaptureCommand({ luaScriptPath: installed.luaScriptPath,
    luaSource, request: first,
    expectedProjectName: projectName });
  assert.equal(command.includes('\n'), false);
  assert.match(command, /FRAMELINE_CAPTURE_RESULT_V1:/);
  assert.match(command, new RegExp(first.requestId));
  assert.doesNotMatch(command, /\bio\.open\b|\bdofile\b|SetClipboard/);
  assert.throws(() => createLuaCaptureCommand({ luaScriptPath: installed.luaScriptPath,
    luaSource, request: { ...first,
      requestFile: path.join(root, 'other.request.json') }, expectedProjectName: projectName }),
  { code: 'resolve-menu-companion-invalid' });
});

const luaLibrary = process.env.FRAMELINE_LUA_LIBRARY || '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
test('generated richer Console command executes the bundled modules and completes the bound response protocol',
  { skip: !require('node:fs').existsSync(luaLibrary) && 'Set FRAMELINE_LUA_LIBRARY to execute the Lua mock on this host' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-rich-lua-companion-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const installed = await installResolveCompanion({ bundledDirectory: path.join(__dirname, '../src/companion'), dataDirectory: root });
    const request = await createCaptureRequest({ directory: installed.requestsDirectory,
      expectedProjectName: 'Frameline Empty Capture', includeProperties: true });
    const command = createLuaCaptureCommand({ luaScriptPath: installed.luaScriptPath,
      luaSource: await fs.readFile(installed.luaScriptPath, 'utf8'), effectSource: await fs.readFile(installed.effectScriptPath, 'utf8'),
      request, expectedProjectName: 'Frameline Empty Capture' });
    const script = `local timeline={};function timeline:GetUniqueId()return 'empty-timeline' end;function timeline:GetName()return 'Empty timeline' end;
      function timeline:GetStartFrame()return 86400 end;function timeline:GetTrackCount()return 0 end;
      local project={};function project:GetName()return 'Frameline Empty Capture' end;function project:GetUniqueId()return 'empty-project' end;
      function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end;
      local manager={};function manager:GetCurrentProject()return project end;resolve={};function resolve:GetProjectManager()return manager end;
      function resolve:GetVersionString()return '21.1.2.10' end;${command}`;
    const output = execFileSync('python3', [path.join(__dirname, '../phase-0/run-lua-observation-mock.py'), luaLibrary], { input: script, encoding: 'utf8' });
    const { acceptConsoleOutput } = require('../src/resolve-console-transfer');
    const response = acceptConsoleOutput({ output, requestId: request.requestId, requestSha256: request.requestSha256 });
    assert.equal(response.complete, true);
    const read = await readCaptureResponse({ directory: installed.requestsDirectory, ...request, responseText: response.responseText, includeSnapshot: true });
    assert.equal(read.observation.schemaVersion, 2); assert.equal(read.coverage.propertyValueCount, 0);
    assert.equal(read.observation.activeTimelineId, 'empty-timeline'); assert.deepEqual(read.observation.items, []);
    assert.equal(read.safeToApply, false);
    assert.doesNotMatch(command, /SetName|SetProperties|SaveProject|ExportProject/);
  });
