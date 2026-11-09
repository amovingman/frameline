const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectSession } = require('../src/project-session');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { scanFcpXml } = require('../src/fcpxml-adapter');

test('rescans the privately held path and replaces stale media results', async () => {
  const calls = [];
  const session = createProjectSession(async filePath => {
    calls.push(filePath);
    return { clips: [], media: [{ name: 'a.mov', availability: calls.length === 1 ? 'missing' : 'local' }], warnings: [] };
  });
  const filePath = '/private/project/cut.fcpxml';
  const initial = await session.select(filePath);
  assert.equal(initial.scan.media[0].availability, 'missing');
  const refreshed = await session.rescan();
  assert.equal(refreshed.scan.media[0].availability, 'local');
  assert.deepEqual(calls, [filePath, filePath]);
  assert.doesNotMatch(JSON.stringify(refreshed), /\/private\/project/);
});

test('rescan retries a failed scan and clears its error on success', async () => {
  let attempts = 0;
  const session = createProjectSession(async () => {
    if (++attempts === 1) throw Object.assign(new Error('missing'), { code: 'file-unavailable' });
    return { clips: [], media: [], warnings: [] };
  });
  const failed = await session.select('/private/project/cut.fcpxml');
  assert.equal(failed.scanStatus, 'error');
  assert.equal(failed.error, 'file-unavailable');
  assert.equal(failed.scan, null);
  const recovered = await session.rescan();
  assert.equal(recovered.scanStatus, 'ready');
  assert.equal(recovered.error, null);
});

test('an older scan cannot overwrite the newest selection', async () => {
  let finishFirst;
  const session = createProjectSession(filePath => filePath.endsWith('first.fcpxml')
    ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve({ sequence: { name: 'Second' }, clips: [], media: [], warnings: [] }));
  const first = session.select('/private/first.fcpxml');
  const second = await session.select('/private/second.fcpxml');
  finishFirst({ sequence: { name: 'First' }, clips: [], media: [], warnings: [] });
  await first;
  assert.equal(second.selectedProject.name, 'second.fcpxml');
  assert.equal(session.getState().scan.sequence.name, 'Second');
});

test('rescan with no selected file does not invoke the adapter', async () => {
  const session = createProjectSession(() => { throw new Error('should not scan'); });
  assert.deepEqual(await session.rescan(), session.getState());
});

test('selection exposes a stable project ID but never its path', async () => {
  const session = createProjectSession(async () => ({ clips: [], media: [], warnings: [] }), {
    getProjectId: async () => ({ id: 'local-project-id', recovered: false })
  });
  const state = await session.select('/private/project/cut.fcpxml');
  assert.equal(state.selectedProject.id, 'local-project-id');
  assert.equal(state.scanStatus, 'ready');
  assert.doesNotMatch(JSON.stringify(state), /\/private\/project/);
});

test('rescan retries a metadata failure before scanning', async () => {
  let attempts = 0;
  let scans = 0;
  const session = createProjectSession(async () => { scans += 1; return { clips: [], media: [], warnings: [] }; }, {
    getProjectId: async () => {
      if (++attempts === 1) throw Object.assign(new Error('disk full'), { code: 'metadata-unavailable' });
      return { id: 'local-project-id', recovered: false };
    }
  });
  assert.equal((await session.select('/private/cut.fcpxml')).error, 'metadata-unavailable');
  assert.equal(scans, 0);
  assert.equal((await session.rescan()).selectedProject.id, 'local-project-id');
  assert.equal(scans, 1);
});

test('saving a revision updates real history without exposing the selected path', async () => {
  let saved;
  const scan = { sourceHash: 'a'.repeat(64), schemaVersion: 2, clips: [], media: [], warnings: [] };
  const store = {
    getProjectId: async () => ({ id: 'local-project-id', recovered: false }),
    listRevisions: async () => [],
    saveRevision: async (_id, manifest, message, parent) => {
      saved = { manifest, message, parent };
      return { id: 'revision-id', message, createdAt: '2026-11-09T00:00:00.000Z', contentHash: manifest.sourceHash, manifestVersion: 2 };
    }
  };
  const session = createProjectSession(async () => scan, store, async () => {});
  await session.select('/private/project/cut.fcpxml');
  const state = await session.saveRevision('  First cut  ');
  assert.equal(saved.message, 'First cut');
  assert.equal(saved.parent, null);
  assert.equal(state.revisions[0].id, 'revision-id');
  assert.doesNotMatch(JSON.stringify(state), /\/private\/project/);
});

test('revisions persist across sessions and require a fresh scan after source changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-revisions-'));
  try {
    const projectPath = path.join(directory, 'cut.fcpxml');
    await fs.copyFile(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml'), projectPath);
    const metadataPath = path.join(directory, 'app-data');
    const first = createProjectSession(scanFcpXml, createLocalMetadataStore(metadataPath));
    await first.select(projectPath);
    const saved = await first.saveRevision('First cut');
    assert.equal(saved.revisions.length, 1);
    assert.equal(saved.revisionError, null);

    const reopened = createProjectSession(scanFcpXml, createLocalMetadataStore(metadataPath));
    const restored = await reopened.select(projectPath);
    assert.equal(restored.revisions[0].id, saved.revisions[0].id);
    const detail = await reopened.openRevision(saved.revisions[0].id);
    assert.equal(detail.selectedRevision.manifest.sequence.name, 'Mountain sample');
    assert.equal(detail.selectedRevision.message, 'First cut');
    assert.doesNotMatch(JSON.stringify(detail.selectedRevision), /frameline-revisions-|file:\/\//);
    const missing = await reopened.openRevision('22222222-2222-4222-8222-222222222222');
    assert.equal(missing.revisionDetailError, 'revision-not-found');
    assert.equal(missing.selectedRevision, null);
    await fs.appendFile(projectPath, '\n');
    const stale = await reopened.saveRevision('Changed cut');
    assert.equal(stale.revisionError, 'revision-source-changed');
    assert.equal(stale.revisions.length, 1);
    await reopened.rescan();
    const next = await reopened.saveRevision('Changed cut');
    assert.equal(next.revisionError, null);
    assert.equal(next.revisions[0].parentRevisionId, saved.revisions[0].id);
    const branch = await reopened.createBranch('alternate-cut');
    assert.equal(branch.currentBranch, 'alternate-cut');
    assert.deepEqual(branch.branches, ['main', 'alternate-cut']);
    const alternate = await reopened.saveRevision('Alternate cut');
    assert.equal(alternate.revisions[0].message, 'Alternate cut');
    const main = await reopened.switchBranch('main');
    assert.equal(main.currentBranch, 'main');
    assert.equal(main.revisions[0].message, 'Changed cut');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
