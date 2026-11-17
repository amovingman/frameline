'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCaptureRequest, readCaptureResponse } = require('../src/resolve-companion-protocol');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');

const fixture = path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json');
const companion = path.join(__dirname, '../src/companion/resolve-internal.py');
const expectedProjectName = 'Frameline API Relink Test';
const fakeResolve = `import json, runpy, sys
bridge = runpy.run_path(sys.argv[1])
snapshot = json.load(open(sys.argv[3], encoding='utf-8'))
bridge['capture_request'].__globals__['runpy'].run_path = lambda _: {'capture': lambda resolve: snapshot}
class Project:
    def GetName(self): return sys.argv[4]
class Manager:
    def GetCurrentProject(self): return Project()
class Resolve:
    def GetProjectManager(self): return Manager()
bridge['capture_request'](Resolve(), sys.argv[2])`;

test('private internal companion handoff validates exact request and Resolve snapshot', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-companion-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const created = await createCaptureRequest({ directory, expectedProjectName, now: () => now });
  assert.match(created.requestId, /^[a-f0-9]{32}$/);
  execFileSync('python3', ['-c', fakeResolve, companion, created.requestFile, fixture, expectedProjectName]);
  const read = await readCaptureResponse({ directory, ...created, now: () => now + 1000 });
  assert.equal(read.manifest.projectId, 'f9d4820a-47a6-42ba-b097-86a7fc23cfaf');
  assert.equal(read.manifest.readOnly, true);
  assert.equal(read.safeToApply, false);
  assert.equal(Object.hasOwn(read, 'snapshot'), false);
  const withSnapshot = await readCaptureResponse({ directory, ...created, now: () => now + 1000,
    includeSnapshot: true });
  assert.equal(withSnapshot.snapshot.project_id, read.manifest.projectId);
  assert.equal(withSnapshot.snapshotSha256, read.snapshotSha256);
  assert.equal(createResolveRevisionManifest(withSnapshot.snapshot).sourceHash, read.snapshotSha256);
  await assert.rejects(readCaptureResponse({ directory, ...created, now: () => now + 300001 }),
    { code: 'resolve-companion-invalid' });
  const responseFile = path.join(directory, `${created.requestId}.response.json`);
  const response = JSON.parse(await fs.readFile(responseFile, 'utf8'));
  const clipboardRead = await readCaptureResponse({ directory, ...created, now: () => now + 1000,
    responseText: JSON.stringify(response) });
  assert.equal(clipboardRead.snapshotSha256, read.snapshotSha256);
  response.requestSha256 = '0'.repeat(64);
  await fs.writeFile(responseFile, JSON.stringify(response));
  await assert.rejects(readCaptureResponse({ directory, ...created, now: () => now + 1000 }),
    { code: 'resolve-companion-invalid' });
  await assert.rejects(readCaptureResponse({ directory, ...created, now: () => now + 1000,
    responseText: JSON.stringify(response) }), { code: 'resolve-companion-invalid' });
});

test('internal companion refuses a different open project before writing', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-companion-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const created = await createCaptureRequest({ directory, expectedProjectName, now: () => now });
  assert.throws(() => execFileSync('python3', ['-c', fakeResolve, companion,
    created.requestFile, fixture, 'Different project'], { stdio: 'ignore' }));
  await assert.rejects(fs.stat(path.join(directory, `${created.requestId}.response.json`)), { code: 'ENOENT' });
  await assert.rejects(createCaptureRequest({ directory, expectedProjectName: '/private/project' }),
    { code: 'resolve-companion-invalid' });
});
