'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/copy-recovery-desktop');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const proofRoot = process.env.FRAMELINE_COPY_RECOVERY_ROOT;

if (process.argv[2] === '--seed') {
  const { createReviewCopyCleanup } = require('../src/review-copy-cleanup');
  const { prepareReviewCopySession } = require('../src/review-copy-session');
  const checkpoint = process.argv[3];
  const sourcePath = path.join(proofRoot, 'source.fcpxml');
  const cleanupJournal = createReviewCopyCleanup({ directory: path.join(proofRoot, 'profile/review-copy-cleanup'),
    onCheckpoint(phase, transaction) {
      if (phase !== checkpoint) return;
      const ready = path.join(proofRoot, 'seed-ready.json');
      fsSync.writeFileSync(`${ready}.tmp`, JSON.stringify({ phase, id: transaction.id, candidatePath: transaction.candidatePath || null }), { mode: 0o600 });
      fsSync.renameSync(`${ready}.tmp`, ready);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    } });
  prepareReviewCopySession({ sourcePath, destinationDirectory: path.join(proofRoot, 'copies'), preferredFilename: 'retained.fcpxml',
    expectedSha256: sha(fsSync.readFileSync(sourcePath)), cleanupJournal }).then(() => process.exit(2));
} else if (!process.versions.electron) {
  const { fork, execFile } = require('node:child_process');
  const run = require('node:util').promisify(execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-copy-recovery-')));
    const children = new Set();
    try {
      await fs.mkdir(path.join(directory, 'profile')); await fs.mkdir(path.join(directory, 'copies'));
      await fs.copyFile(path.join(root, 'phase-0/resolve-xml-proof/sample.fcpxml'), path.join(directory, 'source.fcpxml'));
      await fs.writeFile(path.join(directory, 'copies/unrelated.tmp'), 'user file');
      const retained = [];
      for (const checkpoint of ['staged', ...Array(21).fill('published'), 'validated']) {
        const ready = path.join(directory, 'seed-ready.json'); await fs.rm(ready, { force: true });
        const child = fork(__filename, ['--seed', checkpoint], { env: { ...process.env, FRAMELINE_COPY_RECOVERY_ROOT: directory }, stdio: 'ignore' });
        children.add(child); child.once('exit', () => children.delete(child));
        const deadline = Date.now() + 15000;
        while (!fsSync.existsSync(ready)) {
          if (child.exitCode !== null || child.signalCode || Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`Seed failed at ${checkpoint}`); }
          await new Promise(done => setTimeout(done, 15));
        }
        const receipt = JSON.parse(await fs.readFile(ready, 'utf8'));
        assert.equal(receipt.phase, checkpoint);
        child.kill('SIGKILL'); await new Promise(done => child.once('exit', done));
        if (receipt.candidatePath) retained.push(receipt.candidatePath);
      }
      await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify({ retained, sourceHash: sha(await fs.readFile(path.join(directory, 'source.fcpxml'))) }));
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const stages = [];
      for (const stage of ['first', 'restart']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 90000,
          env: { ...process.env, FRAMELINE_COPY_RECOVERY_ROOT: directory, FRAMELINE_COPY_RECOVERY_STAGE: stage } });
        stages.push(JSON.parse(result.stdout.trim().split('\n').findLast(line => line.startsWith('{"stage"'))));
      }
      const evidence = { schemaVersion: 1, scope: 'Real SIGKILL at private copy checkpoints followed by two shipped Electron main/preload/renderer processes; disposable files only',
        checks: ['startup removes only owned staged aliases', 'all 21 unvalidated published copies retained', 'validated copy retained after crash',
          'source and unrelated files preserved', 'public report contains no private paths', '20-entry server paging and retained-copy reveal',
          'invalid page input preserves usable journal', 'restart recovery does not re-delete or lose retained reports', '360–1440px layouts and no renderer errors'], stages };
      evidence.checks.push('ordinary successful copy uses the journal without adding recovery work');
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally {
      await Promise.all([...children].map(child => new Promise(done => {
        if (child.exitCode !== null || child.signalCode) return done();
        child.once('exit', done); child.kill('SIGKILL');
      })));
      await fs.rm(directory, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, shell, dialog } = require('electron');
  const stage = process.env.FRAMELINE_COPY_RECOVERY_STAGE;
  if (!proofRoot || !['first', 'restart'].includes(stage)) throw new Error('Disposable fixture required');
  app.setPath('userData', path.join(proofRoot, 'profile'));
  const revealed = []; shell.showItemInFolder = location => revealed.push(location);
  const successfulCopy = path.join(proofRoot, 'copies/user-success.fcpxml');
  dialog.showOpenDialog = async options => {
    assert.equal(options.title, 'Choose a DaVinci Resolve timeline');
    return { canceled: false, filePaths: [path.join(proofRoot, 'source.fcpxml')] };
  };
  dialog.showSaveDialog = async options => {
    assert.equal(options.title, 'Choose a location for a verified review copy');
    return { canceled: false, filePath: successfulCopy };
  };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');
  async function verify(win, errors) {
    app.setAccessibilitySupportEnabled(true);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async expression => {
      const until = Date.now() + 15000;
      while (!await js(expression)) { if (Date.now() > until) throw new Error(`Timed out: ${expression}`); await new Promise(done => setTimeout(done, 40)); }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    await wait("!document.getElementById('copy-recovery-panel').hidden && document.getElementById('copy-recovery-entries').children.length === 20");
    const report = await js('window.desktop.getCopyRecovery()');
    assert.equal(report.preservedCount, 21); assert.equal(report.pendingCount, 0); assert.equal(report.nextOffset, 20);
    assert.equal(report.removedCount, stage === 'first' ? 22 : 0);
    assert.doesNotMatch(JSON.stringify(report), /\/Users\/|frameline-copy-recovery-|source\.fcpxml|retained\.fcpxml/);
    assert.equal(await js("document.getElementById('copy-recovery-details').open"), false);
    await js("document.getElementById('copy-recovery-details').open = true");
    win.webContents.debugger.attach('1.3');
    const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const revealNames = tree.nodes.filter(node => node.role?.value === 'button' && node.name?.value?.startsWith('Reveal retained copy ')).map(node => node.name.value);
    assert.equal(revealNames.length, 20); assert.equal(new Set(revealNames).size, 20);
    win.webContents.debugger.detach();
    const invalid = await js('window.desktop.getCopyRecovery({offset:-1})'); assert.equal(invalid.error, 'review-copy-cleanup-input-invalid');
    assert.equal((await js('window.desktop.getCopyRecovery()')).preservedCount, 21);
    const expected = JSON.parse(await fs.readFile(path.join(proofRoot, 'expected.json'), 'utf8'));
    for (const filename of [path.join(proofRoot, 'source.fcpxml'), ...expected.retained]) assert.equal(sha(await fs.readFile(filename)), expected.sourceHash);
    if (expected.successfulCopy) assert.equal(sha(await fs.readFile(expected.successfulCopy)), expected.sourceHash);
    assert.equal(await fs.readFile(path.join(proofRoot, 'copies/unrelated.tmp'), 'utf8'), 'user file');
    const layouts = [];
    if (stage === 'first') {
      await click('copy-recovery-more'); await wait("document.getElementById('copy-recovery-entries').children.length === 1");
      assert.equal(await js("document.activeElement.id"), 'copy-recovery-status');
      await click('copy-recovery-previous'); await wait("document.getElementById('copy-recovery-entries').children.length === 20");
      await js("document.querySelector('#copy-recovery-entries button').click()"); await wait("!document.querySelector('#copy-recovery-entries button').disabled");
      assert.equal(revealed.length, 1); assert.ok(expected.retained.includes(revealed[0]));
      for (const width of [1440, 768, 390, 360]) {
        await js(`document.getElementById('copy-recovery-details').open = ${width < 800}`);
        if (width < 800) {
          const current = await js('window.desktop.getCopyRecovery({offset:20})'); assert.equal(current.entries.length, 1);
          if (await js("!document.getElementById('copy-recovery-more').hidden")) { await click('copy-recovery-more'); await wait("document.getElementById('copy-recovery-entries').children.length === 1"); }
        }
        win.setContentSize(width, 1100); await js("document.getElementById('copy-recovery-panel').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        const layout = await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
        assert.equal(layout.width, layout.scrollWidth); layouts.push(layout);
        if (process.env.FRAMELINE_COPY_RECOVERY_CAPTURE !== '0' && [1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `recovery-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await click('choose-file'); await wait("currentAppState?.scanStatus === 'ready' && !document.getElementById('prepare-review-copy').disabled");
      await click('prepare-review-copy'); await wait("document.getElementById('review-copy-result').textContent.includes('saved and verified unchanged')");
      assert.equal(sha(await fs.readFile(successfulCopy)), expected.sourceHash);
      const afterSuccess = await js('window.desktop.getCopyRecovery()');
      assert.equal(afterSuccess.removedCount, 22); assert.equal(afterSuccess.preservedCount, 21); assert.equal(afterSuccess.pendingCount, 0);
      expected.successfulCopy = successfulCopy;
      await fs.writeFile(path.join(proofRoot, 'expected.json'), JSON.stringify(expected));
    }
    await click('copy-recovery-refresh'); await wait("!document.getElementById('copy-recovery-refresh').disabled");
    assert.equal((await js('window.desktop.getCopyRecovery()')).preservedCount, 21);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage, removedCount: report.removedCount, preservedCount: report.preservedCount,
      retainedCopies: expected.retained.length, sourceUnchanged: true, layouts, rendererErrors: errors.length }));
    app.quit();
  }
}
