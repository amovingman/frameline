const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDiagnosticsReport, diagnosticsOptions } = require('../src/diagnostics-report');
const { createDesktopDiagnostics } = require('../src/desktop-diagnostics');

const input = () => ({
  appVersion: '0.1.0',
  state: { selectedProject: { format: 'FCPXML' }, scanStatus: 'ready', error: null,
    scan: { schemaVersion: 1, clips: [{}, {}], media: [{}] }, revisions: [{}] },
  syncState: { status: 'connected', operations: [{}, {}] },
  adapterUsage: { attempts: 3, succeeded: 2, failed: 1, cancelled: 0, averageDurationMs: 14,
    recentSampleCount: 3, recentP50Ms: 12, recentP95Ms: 20, errorCodes: { 'file-unavailable': 1 } },
  runtime: { platform: 'darwin', architecture: 'arm64', electron: '41.10.7', chromium: '146.0.7680.0', node: '24.14.0', packaged: false }
});

async function fixture(t, overrides = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'report.json');
  const state = input();
  let dialogCount = 0;
  const controller = createDesktopDiagnostics({ getInput: () => state,
    chooseDestination: async () => { dialogCount++; return destination; }, ...overrides });
  const approve = preview => ({ reviewId: preview.reviewId, sha256: preview.sha256, confirmed: true });
  return { directory, destination, state, controller, approve, dialogs: () => dialogCount };
}

test('diagnostics only export allowed runtime values, counts and known error codes', () => {
  const source = input();
  const secret = 'private-client-codename';
  source.state.selectedProject = { format: 'FCPXML', path: '/Users/private/film.fcpxml', name: secret };
  source.state.error = secret; // A path-free-looking secret must not become an error code.
  source.state.scan.clips[0] = { name: secret, source: 'C:\\Private\\take.mov' };
  source.state.scan.media[0] = { url: 'https://account:password@example.test/private' };
  source.state.revisions[0] = { message: secret, authorId: 'person@example.test' };
  source.syncState.account = { email: 'person@example.test', token: secret };
  source.syncState.operations[0] = { path: '/private/queue', token: secret };
  source.adapterUsage.succeeded = { private: secret };
  source.adapterUsage.failed = secret;
  source.adapterUsage.cancelled = -1;
  source.adapterUsage.averageDurationMs = Infinity;
  source.adapterUsage.recentSampleCount = 0.5;
  source.adapterUsage.recentP50Ms = Number.MAX_SAFE_INTEGER + 1;
  source.adapterUsage.recentP95Ms = '12';
  source.adapterUsage.errorCodes = { 'file-unavailable': 1, [secret]: 3, '/private/error': 2, 'scan-failed': secret };
  source.runtime.platform = secret;
  source.runtime.architecture = secret;
  source.runtime.electron = '41.10.7 /private/secret';
  source.runtime.node = { version: secret };
  source.runtime.hostName = secret;
  const { report, bytes } = createDiagnosticsReport(source);
  assert.equal(report.pictureClipCount, 2);
  assert.equal(report.mediaReferenceCount, 1);
  assert.equal(report.revisionCount, 1);
  assert.equal(report.syncConnected, true);
  assert.equal(report.queuedSyncCount, 2);
  assert.equal(report.scanErrorCode, null);
  assert.deepEqual(report.adapterUsage, { attempts: 3, succeeded: null, failed: null, cancelled: null,
    averageDurationMs: null, recentSampleCount: null, recentP50Ms: null, recentP95Ms: null,
    errorCodes: { 'file-unavailable': 1 } });
  assert.equal(report.runtime.platform, 'unknown');
  assert.equal(report.runtime.architecture, 'unknown');
  assert.equal(report.runtime.electron, null);
  assert.equal(report.runtime.node, null);
  assert.doesNotMatch(bytes.toString(), /private|Private|account|password|person@|example\.test|token|film\.fcpxml|take\.mov/);
});

test('optional project and adapter details are absent when excluded, without losing runtime support data', () => {
  const { report } = createDiagnosticsReport({ ...input(), options: { includeProject: false, includeAdapter: false } });
  for (const field of ['selectedFormat', 'scanStatus', 'scanErrorCode', 'scanManifestVersion', 'pictureClipCount', 'mediaReferenceCount', 'revisionCount', 'adapterUsage']) {
    assert.equal(Object.hasOwn(report, field), false, field);
  }
  assert.equal(report.runtime.electron, '41.10.7');
  assert.equal(report.syncStatus, 'connected');
  assert.deepEqual(report.includedSections, { includeProject: false, includeAdapter: false });
});

test('unknown format, status and invalid numeric values cannot carry arbitrary text into reports', () => {
  const source = input();
  source.state.selectedProject.format = '/private/source';
  source.state.scanStatus = '/private/state';
  source.state.scan.schemaVersion = -1;
  source.syncState.status = 'secret-account';
  source.adapterUsage.attempts = 'secret-account';
  const { report } = createDiagnosticsReport(source);
  assert.equal(report.selectedFormat, 'unknown');
  assert.equal(report.scanStatus, 'unknown');
  assert.equal(report.scanManifestVersion, null);
  assert.equal(report.syncStatus, 'unknown');
  assert.equal(report.adapterUsage, null);
});

test('privacy options and app versions reject unexpected data rather than silently exporting it', () => {
  for (const options of [null, [], 'yes', { includeProject: 'false' }, { privatePath: '/private/path' }]) {
    assert.throws(() => diagnosticsOptions(options), { code: 'diagnostics-input-invalid' });
  }
  for (const appVersion of ['0.1.0 /private/path', 'secret', '0.1.0-secret']) {
    assert.throws(() => createDiagnosticsReport({ ...input(), appVersion }), { code: 'diagnostics-input-invalid' });
  }
});

test('approved export writes exactly the reviewed JSON bytes, matching hash and private file permissions', async t => {
  const { destination, controller, approve, dialogs } = await fixture(t);
  const preview = controller.preview({ includeAdapter: false });
  const result = await controller.exportReviewed(approve(preview));
  assert.equal(result.saved, true);
  const bytes = await fs.readFile(destination);
  assert.equal(bytes.toString(), `${JSON.stringify(preview.report, null, 2)}\n`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), preview.sha256);
  assert.equal(result.sha256, preview.sha256);
  assert.equal(result.byteLength, bytes.length);
  assert.equal(dialogs(), 1);
  if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await controller.exportReviewed(approve(preview)), { saved: false, error: 'diagnostics-review-required' });
});

test('export requires a current preview and explicit approval before opening a save dialog', async t => {
  const { controller, approve, dialogs } = await fixture(t);
  assert.deepEqual(await controller.exportReviewed(), { saved: false, error: 'diagnostics-review-required' });
  const preview = controller.preview();
  for (const request of [null, {}, { ...approve(preview), confirmed: false }, { ...approve(preview), confirmed: 'yes' },
    { ...approve(preview), sha256: 'a'.repeat(64) }, { ...approve(preview), reviewId: 'different' }]) {
    assert.deepEqual(await controller.exportReviewed(request), { saved: false, error: 'diagnostics-review-required' });
  }
  assert.equal(dialogs(), 0);
});

test('state changes after preview prevent export before the save dialog', async t => {
  const { destination, state, controller, approve, dialogs } = await fixture(t);
  const preview = controller.preview();
  state.state.scanStatus = 'error';
  assert.deepEqual(await controller.exportReviewed(approve(preview)), { saved: false, error: 'diagnostics-changed' });
  assert.equal(dialogs(), 0);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('state changes while the native save dialog is open prevent any file creation', async t => {
  const source = input();
  let destination;
  const fixtureState = await fixture(t, { getInput: () => source,
    chooseDestination: async () => { source.syncState.operations.push({}); return destination; } });
  destination = fixtureState.destination;
  const preview = fixtureState.controller.preview();
  assert.deepEqual(await fixtureState.controller.exportReviewed(fixtureState.approve(preview)), { saved: false, error: 'diagnostics-changed' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('a changed preview revokes the earlier review even when report bytes match', async t => {
  const { controller, approve, dialogs } = await fixture(t);
  const first = controller.preview();
  const second = controller.preview();
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.reviewId, second.reviewId);
  assert.deepEqual(await controller.exportReviewed(approve(first)), { saved: false, error: 'diagnostics-review-required' });
  assert.equal(dialogs(), 0);
});

test('cancelling a save leaves the review available for an explicit retry', async t => {
  let attempts = 0, destination;
  const { controller, approve, destination: file } = await fixture(t, { chooseDestination: async () => ++attempts === 1 ? null : destination });
  destination = file;
  const review = controller.preview();
  assert.deepEqual(await controller.exportReviewed(approve(review)), { saved: false, cancelled: true });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.equal((await controller.exportReviewed(approve(review))).saved, true);
});

test('concurrent exports cannot open a second native dialog', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { controller, approve } = await fixture(t, { chooseDestination: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const request = approve(controller.preview());
  const first = controller.exportReviewed(request);
  await waiting;
  assert.deepEqual(await controller.exportReviewed(request), { saved: false, error: 'diagnostics-busy' });
  release(null);
  assert.deepEqual(await first, { saved: false, cancelled: true });
});

test('replacing the preview while a save dialog is open prevents the previous report from being written', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { controller, approve, destination } = await fixture(t, { chooseDestination: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const first = controller.exportReviewed(approve(controller.preview()));
  await waiting;
  controller.preview({ includeProject: false });
  release(destination);
  assert.deepEqual(await first, { saved: false, error: 'diagnostics-changed' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('existing files and symlinks are never overwritten by diagnostics export', async t => {
  const { directory, destination, controller, approve } = await fixture(t);
  await fs.writeFile(destination, 'keep existing bytes');
  const request = approve(controller.preview());
  assert.deepEqual(await controller.exportReviewed(request), { saved: false, error: 'diagnostics-save-failed' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'keep existing bytes');
  assert.deepEqual(await fs.readdir(directory), ['report.json']);
  await fs.unlink(destination);
  const target = path.join(directory, 'target.json');
  await fs.writeFile(target, 'keep linked bytes');
  await fs.symlink(target, destination);
  assert.deepEqual(await controller.exportReviewed(request), { saved: false, error: 'diagnostics-save-failed' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep linked bytes');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['report.json', 'target.json']);
});

for (const phase of ['write', 'sync', 'publish']) {
  test(`${phase} failure removes staging data and allows retry at the same destination`, async t => {
    let opened = 0, closed = 0, linked = 0;
    const { directory, destination, controller, approve } = await fixture(t, { storage: {
      ...fs,
      open: async (...args) => {
        const file = await fs.open(...args);
        const first = ++opened === 1;
        return {
          writeFile: async bytes => {
            if (first && phase === 'write') {
              await file.writeFile(bytes.subarray(0, 16));
              throw new Error('/private/secret-write-failure');
            }
            await file.writeFile(bytes);
          },
          sync: async () => {
            if (first && phase === 'sync') throw new Error('/private/secret-sync-failure');
            await file.sync();
          },
          close: async () => { closed++; await file.close(); }
        };
      },
      link: async (...args) => {
        if (++linked === 1 && phase === 'publish') throw new Error('/private/secret-publish-failure');
        await fs.link(...args);
      }
    } });
    const preview = controller.preview();
    assert.deepEqual(await controller.exportReviewed(approve(preview)), { saved: false, error: 'diagnostics-save-failed' });
    assert.equal(closed, 1);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(directory), []);
    assert.equal((await controller.exportReviewed(approve(preview))).saved, true);
    assert.equal(closed, 2);
    assert.equal(await fs.readFile(destination, 'utf8'), `${JSON.stringify(preview.report, null, 2)}\n`);
    assert.deepEqual(await fs.readdir(directory), ['report.json']);
  });
}

test('a state change during disk staging prevents publication and cleans the temporary file', async t => {
  let release, entered, pause = true;
  const waiting = new Promise(resolve => { entered = resolve; });
  const source = input();
  const { directory, destination, controller, approve } = await fixture(t, { getInput: () => source, storage: {
    ...fs,
    open: async (...args) => {
      const file = await fs.open(...args);
      return {
        writeFile: async bytes => {
          await file.writeFile(bytes);
          if (pause) { entered(); await new Promise(resolve => { release = resolve; }); }
        },
        sync: () => file.sync(), close: () => file.close()
      };
    }
  } });
  const request = approve(controller.preview());
  const exporting = controller.exportReviewed(request);
  await waiting;
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.equal((await fs.readdir(directory)).length, 1);
  source.state.scanStatus = 'error';
  pause = false; release();
  assert.deepEqual(await exporting, { saved: false, error: 'diagnostics-changed' });
  assert.deepEqual(await fs.readdir(directory), []);
  source.state.scanStatus = 'ready';
  assert.equal((await controller.exportReviewed(request)).saved, true);
  assert.deepEqual(await fs.readdir(directory), ['report.json']);
});

test('atomic publication only receives fully written and synced reviewed bytes', async t => {
  let synced = false, linked = false;
  let expected;
  const { directory, controller, approve } = await fixture(t, { storage: {
    ...fs,
    open: async (...args) => {
      const file = await fs.open(...args);
      return { writeFile: bytes => file.writeFile(bytes), sync: async () => { await file.sync(); synced = true; }, close: () => file.close() };
    },
    link: async (source, destination) => {
      assert.equal(synced, true);
      assert.equal(await fs.readFile(source, 'utf8'), expected);
      if (process.platform !== 'win32') assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      await fs.link(source, destination); linked = true;
    }
  } });
  const preview = controller.preview();
  expected = `${JSON.stringify(preview.report, null, 2)}\n`;
  assert.equal((await controller.exportReviewed(approve(preview))).saved, true);
  assert.equal(linked, true);
  assert.deepEqual(await fs.readdir(directory), ['report.json']);
});
