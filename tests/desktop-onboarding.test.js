const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDesktopOnboarding } = require('../src/desktop-onboarding');
const { createProjectSession } = require('../src/project-session');
const { createFirstRun } = require('../src/first-run');
const editor = 'resolve-free-21.1.2';
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'onboarding-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { directory: path.join(root, 'settings'), defaultDirectory: path.join(root, 'app') };
  const parent = path.join(root, 'studio'); await fs.mkdir(parent);
  return { root, parent, options, controller: await createDesktopOnboarding(options) };
}

test('chosen workspace stores a real scanned revision and restores the same history after restart', async t => {
  const { root, parent, options, controller } = await fixture(t);
  const file = path.join(root, 'cut.fcpxml');
  const original = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/sample.fcpxml'));
  await fs.writeFile(file, original);
  const selected = await controller.chooseDirectory(parent);
  assert.equal(selected.workspaceDirectory, path.join(parent, 'Frameline revisions'));
  await controller.configure({ editor, workspaceName: 'Cut room' });
  assert.equal(controller.getState().completed, false);
  const session = createProjectSession(undefined, controller.store);
  assert.equal((await session.select(file)).scanStatus, 'ready');
  const saved = await session.saveRevision('Initial scan');
  assert.equal(saved.revisions.length, 1);
  await controller.complete();
  assert.equal(controller.getState().completed, true);
  const reopened = await createDesktopOnboarding(options);
  const next = createProjectSession(undefined, reopened.store);
  const restored = await next.select(file);
  assert.equal(restored.revisions[0].id, saved.revisions[0].id);
  assert.equal(reopened.getState().workspaceName, 'Cut room');
  assert.match(reopened.getState().workspaceId, /^[a-f0-9-]{36}$/);
  assert.equal(reopened.getState().workspaceId, controller.getState().workspaceId);
  assert.equal((await fs.stat(path.join(parent, 'Frameline revisions/metadata.json'))).isFile(), true);
  await assert.rejects(fs.stat(path.join(options.defaultDirectory, 'metadata.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(file), original);
  const configPath = path.join(options.directory, 'first-run.json');
  if (process.platform !== 'win32') assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test('cancelled project selection keeps incomplete setup and restarts with the configured folder', async t => {
  const { parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent);
  await controller.configure({ editor, workspaceName: 'Saved choices' });
  const restarted = await createDesktopOnboarding(options);
  assert.equal(restarted.getState().completed, false);
  assert.equal(restarted.getState().configured, true);
  assert.equal(restarted.getState().workspaceDirectory, path.join(parent, 'Frameline revisions'));
});

test('passive history discovery allows choosing storage, but the first project operation locks it', async t => {
  const { parent, controller } = await fixture(t);
  await controller.store.listResolveProjects();
  await controller.chooseDirectory(parent);
  await controller.configure({ editor, workspaceName: 'Film' });
  await controller.store.getProjectId('/private/film.fcpxml');
  await assert.rejects(controller.chooseDirectory(parent), { code: 'workspace-locked' });
  assert.throws(() => controller.useDefaultDirectory(), { code: 'workspace-locked' });
  // Retrying a cancelled or failed project picker can reuse the same workspace.
  await controller.configure({ editor, workspaceName: 'Film' });
});

test('existing v1 users keep app storage and all existing project identities', async t => {
  const { options, controller } = await fixture(t);
  const project = await controller.store.getProjectId('/private/existing.fcpxml');
  await fs.mkdir(options.directory, { recursive: true });
  await fs.writeFile(path.join(options.directory, 'first-run.json'), JSON.stringify({ version: 1, editor, workspaceName: 'Legacy', completed: true }));
  const reopened = await createDesktopOnboarding(options);
  assert.equal(reopened.getState().workspaceDirectory, options.defaultDirectory);
  assert.equal(reopened.getState().completed, true);
  assert.equal((await reopened.store.getProjectId('/private/existing.fcpxml')).id, project.id);
  await assert.rejects(reopened.configure({ editor, workspaceName: 'New' }), { code: 'workspace-locked' });
});

test('renderer supplied storage paths are ignored; app storage is an explicit usable default', async t => {
  const { root, options, controller } = await fixture(t);
  await controller.chooseDirectory(root);
  controller.useDefaultDirectory();
  await controller.configure({ editor, workspaceName: 'Default', workspaceDirectory: '/untrusted/injected' });
  await controller.store.getProjectId('/private/cut.fcpxml');
  assert.equal(controller.getState().workspaceDirectory, options.defaultDirectory);
  assert.equal((await fs.stat(path.join(options.defaultDirectory, 'metadata.json'))).isFile(), true);
});

test('invalid folders, linked storage and corrupt metadata do not replace the active workspace', async t => {
  const { root, parent, options, controller } = await fixture(t);
  await assert.rejects(controller.chooseDirectory(path.join(root, 'missing')), { code: 'workspace-unavailable' });
  await assert.rejects(controller.chooseDirectory('relative'), { code: 'workspace-unavailable' });
  const target = path.join(root, 'outside'); await fs.mkdir(target);
  const storage = path.join(parent, 'Frameline revisions'); await fs.symlink(target, storage, 'dir');
  await controller.chooseDirectory(parent);
  await assert.rejects(controller.configure({ editor, workspaceName: 'Film' }), { code: 'workspace-unavailable' });
  await fs.unlink(storage); await fs.mkdir(storage); await fs.writeFile(path.join(storage, 'metadata.json'), 'corrupt');
  await assert.rejects(controller.configure({ editor, workspaceName: 'Film' }), { code: 'workspace-unavailable' });
  assert.equal(await fs.readFile(path.join(storage, 'metadata.json'), 'utf8'), 'corrupt');
  assert.equal((await createDesktopOnboarding(options)).getState().configured, false);
});

test('storage calls cannot race workspace configuration and failed validation is retryable', async t => {
  const { controller } = await fixture(t);
  const configuring = controller.configure({ editor, workspaceName: 'Film' });
  await assert.rejects(controller.store.getProjectId('/private/race.fcpxml'), { code: 'workspace-busy' });
  await assert.rejects(controller.configure({ editor, workspaceName: 'Second' }), { code: 'workspace-locked' });
  await configuring;
  await assert.rejects(controller.configure({ editor: 'unknown', workspaceName: 'Film' }), { code: 'first-run-invalid' });
  await controller.configure({ editor, workspaceName: 'Retry' });
  assert.equal(controller.getState().workspaceName, 'Retry');
});

test('an uncommitted folder choice cannot mislabel storage used through the regular file picker', async t => {
  const { parent, options, controller } = await fixture(t);
  await controller.configure({ editor, workspaceName: 'Film' });
  await controller.chooseDirectory(parent);
  await controller.store.getProjectId('/private/film.fcpxml');
  await controller.complete();
  assert.equal(controller.getState().workspaceDirectory, options.defaultDirectory);
  assert.equal((await createDesktopOnboarding(options)).getState().workspaceDirectory, options.defaultDirectory);
});

test('corrupt and unsupported onboarding settings fail closed instead of redirecting history', async t => {
  const { options } = await fixture(t);
  await fs.mkdir(options.directory, { recursive: true });
  for (const value of ['invalid', JSON.stringify({ version: 99 }), JSON.stringify({ version: 2, editor,
    workspaceName: 'Film', workspaceDirectory: 'relative', completed: false, configured: true })]) {
    await fs.writeFile(path.join(options.directory, 'first-run.json'), value);
    await assert.rejects(createDesktopOnboarding(options), { code: 'first-run-invalid' });
  }
  await assert.rejects(createFirstRun({ directory: options.directory }).save({ editor, workspaceName: 'bad/name' }), { code: 'first-run-invalid' });
});

test('moving a configured custom workspace blocks calls without recreating it, then accepts the restored workspace', async t => {
  const { root, parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent); await controller.configure({ editor, workspaceName: 'Film' });
  const original = await controller.store.getProjectId('/private/film.fcpxml');
  const workspace = controller.getState().workspaceDirectory, moved = path.join(root, 'moved-workspace');
  await fs.rename(workspace, moved);
  const restarted = await createDesktopOnboarding(options);
  for (const instance of [controller, restarted]) {
    await assert.rejects(instance.store.listResolveProjects(), { code: 'workspace-unavailable' });
    await assert.rejects(instance.store.getProjectId('/private/film.fcpxml'), { code: 'workspace-unavailable' });
  }
  await assert.rejects(fs.stat(workspace), { code: 'ENOENT' });
  await assert.rejects(restarted.configure({ editor, workspaceName: 'Retry' }), { code: 'workspace-unavailable' });
  await assert.rejects(fs.stat(workspace), { code: 'ENOENT' });
  await fs.rename(moved, workspace);
  assert.equal((await restarted.store.getProjectId('/private/film.fcpxml')).id, original.id);
});

test('deleting a configured custom workspace never recreates its folder or falls back to app storage', async t => {
  const { parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent); await controller.configure({ editor, workspaceName: 'Film' });
  const workspace = controller.getState().workspaceDirectory;
  await fs.rm(workspace, { recursive: true });
  const reopened = await createDesktopOnboarding(options);
  await assert.rejects(reopened.store.getProjectId('/private/new.fcpxml'), { code: 'workspace-unavailable' });
  await assert.rejects(fs.stat(workspace), { code: 'ENOENT' });
  await assert.rejects(fs.stat(options.defaultDirectory), { code: 'ENOENT' });
});

test('replacing a configured custom workspace with an empty folder or another workspace fails closed', async t => {
  const { root, parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent); await controller.configure({ editor, workspaceName: 'Film' });
  const workspace = controller.getState().workspaceDirectory;
  await fs.rename(workspace, path.join(root, 'saved'));
  await fs.mkdir(workspace);
  const reopened = await createDesktopOnboarding(options);
  await assert.rejects(reopened.store.getProjectId('/private/new.fcpxml'), { code: 'workspace-unavailable' });
  await assert.rejects(reopened.configure({ editor, workspaceName: 'Replaced' }), { code: 'workspace-unavailable' });
  await fs.writeFile(path.join(workspace, '.frameline-workspace.json'), JSON.stringify({ schemaVersion: 1,
    workspaceId: '12345678-1234-4321-8123-123456789abc' }));
  await assert.rejects(reopened.store.getProjectId('/private/new.fcpxml'), { code: 'workspace-unavailable' });
  await assert.rejects(fs.stat(path.join(workspace, 'metadata.json')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(workspace)), ['.frameline-workspace.json']);
});

test('replacing configured storage or its marker with a symlink cannot redirect project writes', async t => {
  const { root, parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent); await controller.configure({ editor, workspaceName: 'Film' });
  const workspace = controller.getState().workspaceDirectory, saved = path.join(root, 'saved');
  await fs.rename(workspace, saved); await fs.symlink(saved, workspace, 'dir');
  const reopened = await createDesktopOnboarding(options);
  await assert.rejects(reopened.store.getProjectId('/private/new.fcpxml'), { code: 'workspace-unavailable' });
  await fs.unlink(workspace); await fs.rename(saved, workspace);
  const marker = path.join(workspace, '.frameline-workspace.json'), external = path.join(root, 'marker.json');
  await fs.rename(marker, external); await fs.symlink(external, marker);
  await assert.rejects(reopened.store.getProjectId('/private/new.fcpxml'), { code: 'workspace-unavailable' });
  await assert.rejects(fs.stat(path.join(workspace, 'metadata.json')), { code: 'ENOENT' });
});

test('a corrupt identity marker blocks calls and explicit configure without altering metadata', async t => {
  const { parent, options, controller } = await fixture(t);
  await controller.chooseDirectory(parent); await controller.configure({ editor, workspaceName: 'Film' });
  await controller.store.getProjectId('/private/film.fcpxml');
  const workspace = controller.getState().workspaceDirectory;
  const before = await fs.readFile(path.join(workspace, 'metadata.json'));
  await fs.writeFile(path.join(workspace, '.frameline-workspace.json'), 'corrupt');
  const reopened = await createDesktopOnboarding(options);
  await assert.rejects(reopened.store.getProjectId('/private/another.fcpxml'), { code: 'workspace-unavailable' });
  await assert.rejects(reopened.configure({ editor, workspaceName: 'Retry' }), { code: 'workspace-unavailable' });
  assert.deepEqual(await fs.readFile(path.join(workspace, 'metadata.json')), before);
});

test('disconnecting the picker-selected parent before configure does not recreate it', async t => {
  const { root, parent, controller } = await fixture(t);
  await controller.chooseDirectory(parent);
  await fs.rename(parent, path.join(root, 'disconnected-parent'));
  await assert.rejects(controller.configure({ editor, workspaceName: 'Film' }), { code: 'workspace-unavailable' });
  await assert.rejects(fs.stat(parent), { code: 'ENOENT' });
});

test('v2 settings require a workspace identity and completed setup must be configured', async t => {
  const { options } = await fixture(t);
  const settings = createFirstRun({ directory: options.directory });
  await assert.rejects(settings.save({ editor, workspaceName: 'Film', workspaceDirectory: '/private/custom' }), { code: 'first-run-invalid' });
  await assert.rejects(settings.save({ editor, workspaceName: 'Film', configured: false, completed: true }), { code: 'first-run-invalid' });
  await fs.mkdir(options.directory, { recursive: true });
  await fs.writeFile(path.join(options.directory, 'first-run.json'), JSON.stringify({ version: 2, editor, workspaceName: 'Film',
    workspaceDirectory: null, workspaceId: null, configured: false, completed: true }));
  await assert.rejects(settings.read(), { code: 'first-run-invalid' });
});

test('settings sync the private temporary file before rename and the directory before acknowledging save', async t => {
  const { options } = await fixture(t);
  const events = [];
  const storage = { ...fs,
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args), kind = file === options.directory ? 'directory' : 'file';
      return { writeFile: async content => { events.push(`${kind}:write`); return handle.writeFile(content); },
        sync: async () => { events.push(`${kind}:sync`); return handle.sync(); }, close: () => handle.close() };
    },
    rename: async (...args) => { events.push('rename'); return fs.rename(...args); }
  };
  await createFirstRun({ directory: options.directory, storage }).save({ editor, workspaceName: 'Film' });
  assert.deepEqual(events, ['file:write', 'file:sync', 'rename', 'directory:sync']);
});

test('a temporary-file sync failure preserves prior settings and directory sync uncertainty is reported', async t => {
  const { options } = await fixture(t);
  const settings = createFirstRun({ directory: options.directory });
  await settings.save({ editor, workspaceName: 'Original' });
  for (const failingKind of ['file', 'directory']) {
    const storage = { ...fs, open: async (file, ...args) => {
      const handle = await fs.open(file, ...args), kind = file === options.directory ? 'directory' : 'file';
      return { writeFile: content => handle.writeFile(content), sync: async () => {
        if (kind === failingKind) throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
        return handle.sync();
      }, close: () => handle.close() };
    } };
    await assert.rejects(createFirstRun({ directory: options.directory, storage }).save({ editor, workspaceName: 'Changed' }),
      { code: failingKind === 'file' ? 'EIO' : 'first-run-storage-uncertain' });
    assert.equal((await settings.read()).workspaceName, failingKind === 'file' ? 'Original' : 'Changed');
    assert.deepEqual(await fs.readdir(options.directory), ['first-run.json']);
  }
});
