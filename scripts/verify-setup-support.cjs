'use strict';
// Runs the shipped main process, preload and renderer twice with a disposable
// profile. Only the OS picker results are supplied by this local fixture.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/setup-support-desktop');

if (!process.versions.electron) {
  const { execFile } = require('node:child_process');
  const run = require('node:util').promisify(execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-setup-proof-')));
    try {
      await fs.mkdir(path.join(directory, 'studio'));
      await fs.copyFile(path.join(root, 'phase-0/resolve-xml-proof/sample.fcpxml'), path.join(directory, 'private-cut.fcpxml'));
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const stages = [];
      for (const stage of ['first', 'restore']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 90000,
          env: { ...process.env, FRAMELINE_SETUP_PROOF_ROOT: directory, FRAMELINE_SETUP_PROOF_STAGE: stage } });
        stages.push(JSON.parse(result.stdout.trim().split('\n').findLast(line => line.startsWith('{"stage"'))));
      }
      const evidence = { schemaVersion: 1, scope: 'Shipped main/preload/renderer in two real Electron processes; OS picker results supplied by a disposable fixture',
        checks: ['native directory and project picker IPC wiring', 'picker cancellation preserves incomplete setup',
          'failed-scan recovery completes setup after rescan', 'custom storage contains real scanned revisions', 'source export unchanged', 'first-run completion survives process restart',
          'same project and history restored from custom storage', 'optional diagnostics sections and explicit consent',
          'changed reports require new review', 'cancelled export preserves review', 'export bytes equal displayed reviewed bytes',
          'private output mode and no paths, media names or credentials', 'desktop and narrow layouts', 'no renderer errors'], stages };
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, dialog } = require('electron');
  const directory = process.env.FRAMELINE_SETUP_PROOF_ROOT;
  const stage = process.env.FRAMELINE_SETUP_PROOF_STAGE;
  if (!directory || !['first', 'restore'].includes(stage) || !fsSync.existsSync(path.join(directory, 'private-cut.fcpxml'))) throw new Error('Disposable proof fixture required');
  const profile = path.join(directory, 'profile'); fsSync.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
  const source = path.join(directory, 'private-cut.fcpxml'), studio = path.join(directory, 'studio');
  let directoryCalls = 0, projectCalls = 0, saveCalls = 0;
  dialog.showOpenDialog = async options => {
    if (options.title === 'Choose a revision workspace folder') {
      directoryCalls++; return { canceled: directoryCalls === 1, filePaths: directoryCalls === 1 ? [] : [studio] };
    }
    assert.equal(options.title, 'Choose a DaVinci Resolve timeline');
    projectCalls++;
    const cancel = stage === 'first' && projectCalls === 1;
    return { canceled: cancel, filePaths: cancel ? [] : [source] };
  };
  const destination = path.join(directory, 'diagnostics.json');
  dialog.showSaveDialog = async options => {
    assert.equal(options.title, 'Export reviewed diagnostics'); saveCalls++;
    return saveCalls === 1 ? { canceled: true } : { canceled: false, filePath: destination };
  };
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');

  async function verify(win, errors) {
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async expression => {
      const deadline = Date.now() + 15000;
      while (!await js(expression)) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`);
        await new Promise(done => setTimeout(done, 50));
      }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    await wait("window.desktop && document.querySelector('.project-context div > span').textContent === '" + (stage === 'first' ? 'Local workspace' : 'Cut room') + "'");
    const original = await fs.readFile(source);
    const layouts = [];
    if (stage === 'first') {
      assert.equal(await js("document.getElementById('first-run').hidden"), false);
      await js("document.getElementById('first-run-workspace').value='Cut room'");
      const initialDirectory = await js("document.getElementById('first-run-directory').textContent");
      await click('first-run-choose-directory'); await wait("!document.getElementById('first-run-choose-directory').disabled");
      assert.equal(await js("document.getElementById('first-run-directory').textContent"), initialDirectory);
      await click('first-run-choose-directory'); await wait("document.getElementById('first-run-directory').textContent.endsWith('Frameline revisions')");
      assert.equal(await js("document.getElementById('first-run-workspace').value"), 'Cut room');
      for (const width of [1440, 768, 390, 360]) {
        win.setContentSize(width, 1100);
        await js("document.getElementById('first-run').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelWidth:document.getElementById('first-run').getBoundingClientRect().width})");
        assert.equal(layout.width, layout.scrollWidth, `overflow at ${width}`); layouts.push(layout);
        if ([1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `onboarding-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      win.setContentSize(1440, 1100);
      await js("document.getElementById('first-run-form').requestSubmit()");
      await wait("!document.getElementById('first-run-continue').disabled && document.getElementById('first-run-status').textContent.includes('Cancelling')");
      assert.equal((await js('window.desktop.getFirstRun()')).completed, false);
      await fs.writeFile(source, '<invalid>');
      await js("document.getElementById('first-run-form').requestSubmit()");
      await wait("!document.getElementById('first-run-continue').disabled && currentAppState.scanStatus === 'error'");
      assert.equal((await js('window.desktop.getFirstRun()')).completed, false);
      await fs.writeFile(source, original);
      await click('rescan-project');
      await wait("document.getElementById('first-run').hidden");
      const state = await js('window.desktop.getAppState()'); assert.equal(state.scanStatus, 'ready');
      await js("showView('history'); document.getElementById('revision-message').value='Initial scan'; document.getElementById('revision-form').requestSubmit()");
      await wait("currentAppState.revisions.length === 1");
      // A project change after review must require another review.
      await click('diagnostics-review'); await wait("!document.getElementById('diagnostics-preview').hidden");
      assert.equal(await js("document.getElementById('diagnostics-export').disabled"), true);
      await js("window.desktop.saveRevision('Second scan')");
      await click('diagnostics-confirm'); await click('diagnostics-export');
      await wait("document.getElementById('diagnostics-status').textContent.includes('App state changed')");
      assert.equal(saveCalls, 0);
      await click('diagnostics-project'); await click('diagnostics-adapter'); await click('diagnostics-review');
      await wait("!document.getElementById('diagnostics-preview').hidden");
      const previewBytes = await js("document.getElementById('diagnostics-content').textContent");
      assert.equal(Object.hasOwn(JSON.parse(previewBytes), 'pictureClipCount'), false);
      assert.equal(Object.hasOwn(JSON.parse(previewBytes), 'adapterUsage'), false);
      await click('diagnostics-confirm');
      for (const width of [1440, 390]) {
        win.setContentSize(width, 1100); await js("document.getElementById('diagnostics-panel').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        assert.equal(await js('document.documentElement.scrollWidth === innerWidth'), true);
        await fs.writeFile(path.join(evidenceDirectory, `diagnostics-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await click('diagnostics-export'); await wait("document.getElementById('diagnostics-status').textContent.includes('cancelled')");
      assert.equal(await js("document.getElementById('diagnostics-export').disabled"), false);
      await click('diagnostics-export'); await wait("document.getElementById('diagnostics-status').textContent.includes('saved (')");
      const exported = await fs.readFile(destination, 'utf8'); assert.equal(exported, previewBytes);
      assert.doesNotMatch(exported, /private-cut|frameline-setup-proof|\/Users\/|Cut room|password|token/);
      if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
      const end = await js('window.desktop.getAppState()');
      await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify({ projectId: end.selectedProject.id, revisionIds: end.revisions.map(item => item.id) }));
      await assert.rejects(fs.stat(path.join(profile, 'metadata.json')), { code: 'ENOENT' });
    } else {
      assert.equal(await js("document.getElementById('first-run').hidden"), true);
      await click('choose-file'); await wait("currentAppState.scanStatus === 'ready'");
      const state = await js('window.desktop.getAppState()'), expected = JSON.parse(await fs.readFile(path.join(directory, 'expected.json'), 'utf8'));
      assert.equal(state.selectedProject.id, expected.projectId); assert.deepEqual(state.revisions.map(item => item.id), expected.revisionIds);
      assert.equal(state.revisions.length, 2);
      const blocked = await js("window.desktop.saveFirstRun({editor:'resolve-free-21.1.2',workspaceName:'Other'})");
      assert.equal(blocked.error, 'workspace-locked');
    }
    assert.deepEqual(await fs.readFile(source), original); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage, directoryPickerCalls: directoryCalls, projectPickerCalls: projectCalls, saveDialogCalls: saveCalls,
      sourceUnchanged: true, layouts, runtime: { electron: process.versions.electron, chromium: process.versions.chrome } }));
    app.quit();
  }
}
