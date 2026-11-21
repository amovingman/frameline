'use strict';
// Shipped Electron main/preload/renderer and actual SQLite/transaction modules.
// Hardware observations and native readback are injected only in this isolated
// test process. This evidence does not claim a live Resolve editor run.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/safe-apply-desktop');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (!process.versions.electron) {
  const { closedProjectFixture } = require('../tests/helpers/closed-project-apply-fixture');
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const cleanup = [], fixture = await closedProjectFixture({ after: callback => cleanup.push(callback) });
    try {
      await fs.mkdir(path.join(fixture.root, 'profile'), { mode: 0o700 });
      for (const [role, bytes] of Object.entries(fixture.review.sources)) await fs.writeFile(path.join(fixture.root, role + '.json'), bytes, { mode: 0o600 });
      const config = { root: fixture.root, sourcePath: fixture.sourcePath, metadata: fixture.metadata,
        originalSha256: sha(await fs.readFile(fixture.sourcePath)), projectName: fixture.fixture.projectName };
      await fs.writeFile(path.join(fixture.root, 'fixture.json'), JSON.stringify(config), { mode: 0o600 });
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const stages = [];
      for (const stage of ['apply', 'restore']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 90000,
          env: { ...process.env, FRAMELINE_SAFE_APPLY_FIXTURE: fixture.root, FRAMELINE_SAFE_APPLY_STAGE: stage } });
        const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"stage"'));
        assert(line, result.stdout + result.stderr); stages.push(JSON.parse(line));
      }
      assert.equal(sha(await fs.readFile(fixture.sourcePath)), config.originalSha256);
      const evidence = { schemaVersion: 1, scope: 'Disposable synthetic SQLite project in two real Electron processes. Shipped main, preload, renderer, session, transaction and native SQLite helpers; hardware observations, publication and editor readback supplied by a trusted test adapter. No live Resolve claim.',
        checks: ['production review/source-picker IPC', 'review locks across prepared and published states',
          'real private backup and strict SQLite Name comparison', 'path-free renderer state',
          'editor readback remains separate from final validation', 'native revision and backup retained',
          'restart discovery, guarded rollback and original byte restoration', 'desktop and 600px layouts', 'zero renderer errors'], stages };
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify(evidence, null, 2));
    } finally { for (const callback of cleanup.reverse()) await callback(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog, shell } = require('electron');
  const fixtureRoot = process.env.FRAMELINE_SAFE_APPLY_FIXTURE, stage = process.env.FRAMELINE_SAFE_APPLY_STAGE;
  if (!fixtureRoot || !['apply', 'restore'].includes(stage) || !fsSync.existsSync(path.join(fixtureRoot, 'fixture.json'))) throw new Error('Disposable fixture required');
  const config = JSON.parse(fsSync.readFileSync(path.join(fixtureRoot, 'fixture.json')));
  assert.equal(config.root, fixtureRoot);
  app.setPath('userData', path.join(fixtureRoot, 'profile'));
  const { createDesktopClosedProjectApply } = require('../src/desktop-closed-project-apply');
  const { createClosedProjectApplyAdapter } = require('../src/closed-project-apply-adapter');
  let controller;
  const publications = [], revealed = [];
  shell.showItemInFolder = filename => revealed.push(filename);
  dialog.showOpenDialog = async options => {
    if (options.title === 'Choose the closed Resolve project’s Project.db') return { canceled: false, filePaths: [config.sourcePath] };
    const role = /^Choose (base|local|incoming) Resolve capture or snapshot$/.exec(options.title)?.[1];
    assert(role, 'Unexpected picker: ' + options.title);
    return { canceled: false, filePaths: [path.join(fixtureRoot, role + '.json')] };
  };
  const guard = { async inspect({ sourcePath, expectedSourceHash }) {
    assert.equal(sourcePath, config.sourcePath); const bytes = await fs.readFile(sourcePath), stat = await fs.stat(sourcePath);
    if (expectedSourceHash) assert.equal(sha(bytes), expectedSourceHash);
    return { schemaVersion: 1, sourcePath, sha256: sha(bytes), size: bytes.length,
      identity: { device: String(stat.dev), inode: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
      directoryIdentity: {}, metadata: config.metadata, installedBuild: { version: 'test-only' }, freshObservationOnly: true, safeToApply: false };
  } };
  const sourceBinding = { schemaVersion: 1, sourcePath: config.sourcePath, projectName: config.projectName, libraryRoot: fixtureRoot,
    configPath: path.join(fixtureRoot, 'dblist.conf'), configSha256: sha('test-library-config'),
    expectedCurrentDatabase: { DbType: 'Disk', DbName: 'Test-only Library' }, expectedCurrentFolder: 'Root' };
  async function observation(expectedSha256) {
    const bytes = await fs.readFile(config.sourcePath), stat = await fs.stat(config.sourcePath); assert.equal(sha(bytes), expectedSha256);
    return { actualOpenFileBindingVerified: true, concurrentWriterResistanceProven: false,
      process: { pid: 123, started: 'test-only' }, source: { path: config.sourcePath, sha256: sha(bytes), device: String(stat.dev), inode: String(stat.ino), size: bytes.length }, configSha256: sourceBinding.configSha256 };
  }
  const companion = {
    async prepareClosedProjectApplyCompanion(binding) {
      await fs.mkdir(binding.directory, { mode: 0o700 });
      const preparationPath = path.join(binding.directory, 'preparation.json');
      await fs.writeFile(preparationPath, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
      return { preparationPath, menuName: 'Frameline test-only verification', scriptPath: path.join(binding.directory, 'check.lua') };
    },
    async readClosedProjectApplyCompanion(preparationPath, expected) {
      const binding = JSON.parse(await fs.readFile(preparationPath)); for (const key of Object.keys(expected)) assert.deepEqual(binding[key], expected[key]);
      try {
        const proof = JSON.parse(await fs.readFile(path.join(path.dirname(preparationPath), 'test-observation.json')));
        return { status: 'verified-open', actualOpenFileBindingVerified: true, sourceBinding: proof,
          hostAdmissionReceiptSha256: sha(JSON.stringify(proof)), transactionId: expected.transactionId, planId: expected.planId };
      } catch (error) { if (error.code !== 'ENOENT') throw error; return { status: 'pending', started: true }; }
    },
    async admitClosedProjectApplyCompanion(preparationPath, { observeSource, expectedBinding }) {
      const proof = await observeSource({ binding: expectedBinding.sourceBinding, expectedSha256: expectedBinding.expectedDatabaseSha256 });
      await fs.writeFile(path.join(path.dirname(preparationPath), 'test-observation.json'), JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
      return { admitted: true, receiptSha256: sha(JSON.stringify(proof)) };
    }
  };
  // Production has no environment switch for this injection. Replacing this one
  // module export affects only the verifier's isolated Electron process.
  require.cache[require.resolve('../src/desktop-closed-project-apply')].exports = { createDesktopClosedProjectApply(options) {
    const adapter = createClosedProjectApplyAdapter({ directory: path.join(options.directory, 'adapter'), getCurrentReview: options.getVerifiedReview, guard, companion,
      sourceBindingService: { prepareClosedProjectSourceBinding: async () => sourceBinding,
        observeLoadedProjectSource: async ({ expectedSha256 }) => observation(expectedSha256) },
      publishFile: async ({ plan, sourcePath, expectedSource, artifact, transactionId, direction }) => {
        assert.equal(sourcePath, config.sourcePath); assert.equal(sha(await fs.readFile(sourcePath)), expectedSource.sha256);
        const temporary = sourcePath + '.stage'; await fs.copyFile(artifact.path, temporary); await fs.rename(temporary, sourcePath); publications.push(direction);
        return { transactionId, planId: plan.planId, direction, sourceSha256: artifact.sha256, atomic: true,
          applicationSourceLockHeld: true, editorOfflineRechecked: true, concurrentWriterResistanceProven: false, metadataPreserved: true };
      } });
    controller = createDesktopClosedProjectApply({ ...options, adapter }); return controller;
  } };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');

  async function verify(win, errors) {
    const js = source => win.webContents.executeJavaScript(source);
    const wait = async expression => {
      const deadline = Date.now() + 15000;
      while (!await js(expression)) { if (Date.now() > deadline) throw new Error('Timed out: ' + expression); await new Promise(resolve => setTimeout(resolve, 40)); }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    await wait("window.desktop && !document.getElementById('closed-apply-prepare').disabled");
    await js("showView('resolve')"); await click('closed-apply-show');
    if (stage === 'apply') {
      await click('resolve-choose'); await wait("resolveState?.audit && !document.getElementById('resolve-choose').disabled");
      await click('closed-apply-prepare'); await wait("!document.getElementById('closed-apply-apply').hidden && !document.getElementById('closed-apply-apply').disabled");
      assert.equal(controller.getState().transaction.state, 'prepared');
      assert.equal(await js("document.getElementById('resolve-choose').disabled"), true);
      await click('closed-apply-apply'); await wait("document.getElementById('closed-apply-check').textContent.includes('Frameline test-only verification') && !document.getElementById('closed-apply-read-check').disabled");
      assert.equal(controller.getState().transaction.state, 'pending-editor-validation');
      assert.equal(controller.isReviewLocked(), true);
    } else {
      assert.equal(controller.getState().transaction.state, 'completed');
      await click('closed-apply-recover'); await wait("!document.getElementById('closed-apply-rollback').hidden && !document.getElementById('closed-apply-rollback').disabled");
      await click('closed-apply-rollback'); await wait("document.getElementById('closed-apply-status').textContent.includes('Original restored') && !document.getElementById('closed-apply-read-check').disabled");
      assert.equal(controller.getState().transaction.state, 'pending-rollback-editor-validation');
    }
    const report = await js('window.desktop.getClosedApplyState()');
    assert.doesNotMatch(JSON.stringify(report), /\/private\/|\/Users\/|closed-project-adapter-|Project\.db/);
    const layouts = [];
    for (const width of [1440, 600]) {
      win.setContentSize(width, 1000); await js("document.getElementById('closed-apply-panel').scrollIntoView({block:'start'})");
      await new Promise(resolve => setTimeout(resolve, 100));
      const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelWidth:document.getElementById('closed-apply-panel').getBoundingClientRect().width})");
      assert.equal(layout.scrollWidth, layout.width); layouts.push(layout);
      await fs.writeFile(path.join(evidenceDirectory, `${stage}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await click('closed-apply-read-check'); await wait("document.getElementById('closed-apply-check').textContent.includes('Resolve check passed')");
    assert.equal(controller.isReviewLocked(), true);
    await click('closed-apply-validate');
    await wait(`document.getElementById('closed-apply-status').textContent.includes(${JSON.stringify(stage === 'apply' ? 'Apply complete' : 'Restoration complete')})`);
    const final = controller.getState();
    assert.equal(final.transaction.state, stage === 'apply' ? 'completed' : 'rolled-back');
    assert.equal(final.reviewLocked, false); assert.match(final.transaction.resultingRevision.revisionId, /^[a-f0-9]{64}$/);
    assert.equal(final.transaction.resultingRevision.revisionId, sha(await fs.readFile(config.sourcePath)));
    await click('closed-apply-reveal'); await wait("!document.getElementById('closed-apply-reveal').disabled");
    assert.equal(revealed.length, 1); assert.equal(sha(await fs.readFile(revealed[0])), config.originalSha256);
    assert.deepEqual(publications, [stage === 'apply' ? 'apply' : 'rollback']);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage, finalState: final.transaction.state, exactOriginalRestored: stage === 'restore',
      retainedBackupVerified: true, pathFreePublicState: true, layouts, rendererErrors: errors.length, publicationCount: publications.length }));
    app.quit();
  }
}
