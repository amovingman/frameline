'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installResolveCompanion } = require('../src/resolve-companion-install');
const { createCaptureRequest, readCaptureResponse } = require('../src/resolve-companion-protocol');
const { installResolveMenuCompanion, activateResolveMenuRequest } = require('../src/resolve-menu-companion');

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
