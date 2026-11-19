'use strict';
// Shipped main process + preload + renderer, two disposable Electron processes.
// Only the OS source-picker results are fixture-supplied; no Resolve write runs.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/conflict-policy-desktop');
const roles = ['base', 'local', 'incoming'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeFixtures(directory) {
  const source = JSON.parse(await fs.readFile(path.join(root, 'phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8'));
  source.project_name = 'Disposable conflict policy proof';
  source.timelines = [source.timelines[0]];
  source.timelines[0].name = 'Policy fixture timeline';
  source.timelines[0].items = source.timelines[0].items.slice(0, 3);
  for (const item of source.timelines[0].items) item.linked_item_ids = [];
  const values = { base: source, local: structuredClone(source), incoming: structuredClone(source) };
  const targetId = source.timelines[0].items[0].id;
  values.local.timelines[0].items[0].name = 'Locally edited clip';
  values.incoming.timelines[0].items.shift();
  Object.assign(values.local.timelines[0].items[1], { start_frame: 190, end_frame: 286 });
  Object.assign(values.incoming.timelines[0].items[0], { start_frame: 205, end_frame: 301 });
  // Distinct-ID additions compete for observed intervals; IDs never imply placement.
  for (let n = 0; n < 24; n++) for (const [role, offset] of [['local', 0], ['incoming', 10]]) {
    const start = 600 + n * 20 + offset;
    values[role].timelines[0].items.push({ ...structuredClone(source.timelines[0].items[0]),
      id: `${role}-addition-${String(n).padStart(2, '0')}`, name: `${role === 'local' ? 'Local' : 'Incoming'} addition ${n + 1}`,
      start_frame: start, end_frame: start + 30 });
  }
  for (const role of roles) await fs.writeFile(path.join(directory, `${role}.json`), JSON.stringify(values[role]));
  return { targetId, unchangedBlockerId: source.timelines[0].items[2].id };
}

if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-conflict-proof-')));
    try {
      await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(await writeFixtures(directory)));
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const stages = [];
      for (const stage of ['first', 'restore']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 90000,
          env: { ...process.env, FRAMELINE_CONFLICT_PROOF_ROOT: directory, FRAMELINE_CONFLICT_PROOF_STAGE: stage } });
        const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"stage"'));
        if (!line) throw new Error(`Missing proof result: ${result.stdout}\n${result.stderr}`);
        stages.push(JSON.parse(line));
      }
      const evidence = { schemaVersion: 1,
        scope: 'Two shipped main/preload/renderer Electron processes with a disposable profile and fixture-supplied OS source picker results. No editor write or production service is exercised.',
        checks: ['explicit local-edit/incoming-deletion warning and per-choice consequences',
          'conflict decisions required before a complete review audit', 'whole-entity local retention is recorded',
          'concurrent additions and divergent moves expose conservative placement policy', 'unchanged interval blockers are included',
          'bounded paged report, keyboard-operable next/previous, desktop/narrow layouts',
          'review choices, audit hash and source-bound guidance survive real process restart',
          'source refresh changes guidance and clears prior review choices', 'source bytes unchanged by review and recovery',
          'apply remains disabled', 'no renderer console errors'], stages };
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  const directory = process.env.FRAMELINE_CONFLICT_PROOF_ROOT, stage = process.env.FRAMELINE_CONFLICT_PROOF_STAGE;
  if (!directory || !['first', 'restore'].includes(stage) || !fsSync.existsSync(path.join(directory, 'fixture.json'))) throw new Error('Disposable fixture required');
  const profile = path.join(directory, 'profile'); fsSync.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
  let pickerCalls = 0;
  dialog.showOpenDialog = async options => {
    const match = /^Choose (base|local|incoming) Resolve capture or snapshot$/.exec(options.title);
    assert.ok(match, `Unexpected native picker: ${options.title}`); pickerCalls++;
    return { canceled: false, filePaths: [path.join(directory, `${match[1]}.json`)] };
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
        await new Promise(done => setTimeout(done, 40));
      }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const getState = () => js('window.desktop.getResolveReviewState()');
    const fixture = JSON.parse(await fs.readFile(path.join(directory, 'fixture.json'), 'utf8'));
    const initialBytes = Object.fromEntries(await Promise.all(roles.map(async role => [role, await fs.readFile(path.join(directory, `${role}.json`))])));
    await wait("window.desktop && document.getElementById('resolve-choose') && !document.getElementById('resolve-choose').disabled");
    await js("showView('resolve'); document.getElementById('first-run').hidden = true");
    await click('resolve-choose'); await wait("resolveState?.status === 'ready' && !!resolveState.guidance && !resolveBusy");
    let state = await getState();
    assert.equal(state.guidance.safeToApply, false); assert.equal(state.guidance.readOnly, true);
    assert.deepEqual(state.guidance.sourceHashes, state.sourceHashes);
    assert.equal(state.guidance.deletionPolicy.conflicts.some(value => value.itemId === fixture.targetId && value.deletedBy === 'incoming'), true);
    assert.equal(state.guidance.placementPolicy.automaticTimelineOrdering, false);
    assert.equal(state.guidance.placementPolicy.interactions.some(value => value.itemIds.includes(fixture.unchangedBlockerId)), true);
    const applyDisabled = await js("[...document.querySelectorAll('#view-resolve button')].some(button => button.textContent === 'Apply unavailable' && button.disabled)");
    assert.equal(applyDisabled, true);
    const layouts = [];
    if (stage === 'first') {
      assert.equal(state.audit, null); assert.equal(state.decisions.length, 0);
      await js("document.getElementById('resolve-filter').value='conflict';document.getElementById('resolve-filter').dispatchEvent(new Event('change'))");
      await js(`{ const values = resolveChanges().filter(value => value.status === 'conflict'); const index=values.findIndex(value => value.itemId===${JSON.stringify(fixture.targetId)} && value.field==='existence'); if(index<0)throw new Error('Missing deletion conflict'); document.querySelectorAll('#resolve-queue button')[index].click(); }`);
      assert.match(await js("document.getElementById('resolve-deletion-warning').textContent"), /local|incoming|delet/i);
      assert.match(await js("document.getElementById('resolve-deletion-fields').textContent"), /name/i);
      const consequences = await js("[...document.querySelectorAll('#resolve-detail .resolve-choice-consequence')].map(node => node.textContent)");
      assert.equal(consequences.length, 2); assert.ok(consequences.every(value => value.length > 15));
      assert.notEqual(consequences[0], consequences[1]);
      const pageBefore = await js("document.getElementById('resolve-placement-range').textContent");
      assert.equal(await js("document.getElementById('resolve-placement-records').children.length <= 12"), true);
      await js("document.getElementById('resolve-placement-next').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(`document.getElementById('resolve-placement-range').textContent !== ${JSON.stringify(pageBefore)}`);
      assert.equal(await js("document.getElementById('resolve-placement-records').children.length <= 12"), true);
      await js("document.getElementById('resolve-placement-previous').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(`document.getElementById('resolve-placement-range').textContent === ${JSON.stringify(pageBefore)}`);
      for (const width of [1440, 768, 390, 360]) {
        win.setContentSize(width, 1100); await js("document.getElementById('resolve-placement-policy').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,records:document.getElementById('resolve-placement-records').children.length})");
        assert.equal(layout.scrollWidth, layout.width, `overflow at ${width}`); assert.ok(layout.records <= 12); layouts.push(layout);
        if ([1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `ordering-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      for (const width of [1440, 390]) {
        win.setContentSize(width, 1100); await js("document.getElementById('resolve-detail').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        assert.equal(await js('document.documentElement.scrollWidth === innerWidth'), true);
        await fs.writeFile(path.join(evidenceDirectory, `deletion-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      // Select and record every conflict through the actual decision controls.
      let remaining = state.review.conflicts.length;
      while (remaining) {
        await click('resolve-next');
        const prior = (await getState()).decisions.length;
        await js("[...document.querySelectorAll('#resolve-detail .resolve-decisions button')].find(button=>button.textContent==='Keep local').click()");
        await wait(`!resolveBusy && resolveState.decisions.length === ${prior + 1}`);
        remaining--;
      }
      state = await getState(); assert.ok(state.audit); assert.equal(state.audit.choices.length, state.review.conflicts.length);
      assert.equal(state.audit.choices.find(value => value.itemId === fixture.targetId).selectedValue.name, 'Locally edited clip');
      await click('resolve-save-review'); await wait("!resolveBusy && !!resolveState.reviewArtifactId");
      state = await getState();
      await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify({ artifactId: state.reviewArtifactId, decisions: state.decisions,
        auditHash: state.audit.auditHash, guidanceHash: state.guidance.guidanceHash, sourceHashes: state.sourceHashes }));
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(directory, 'expected.json'), 'utf8'));
      await js(`document.getElementById('resolve-review-artifact').value=${JSON.stringify(expected.artifactId)};document.getElementById('resolve-review-recover-form').requestSubmit()`);
      await wait("!resolveBusy && !!resolveState.reviewArtifactId");
      state = await getState(); assert.deepEqual(state.decisions, expected.decisions); assert.equal(state.audit.auditHash, expected.auditHash);
      assert.equal(state.guidance.guidanceHash, expected.guidanceHash); assert.deepEqual(state.sourceHashes, expected.sourceHashes);
      for (const role of roles) assert.deepEqual(await fs.readFile(path.join(directory, `${role}.json`)), initialBytes[role]);
      // A fixture-only source mutation invalidates the earlier exact-byte review.
      const local = JSON.parse(initialBytes.local); local.project_name += ' changed';
      await fs.writeFile(path.join(directory, 'local.json'), JSON.stringify(local));
      await click('resolve-refresh'); await wait("!resolveBusy && resolveState.sourceVerification?.changed === true");
      const refreshed = await getState(); assert.deepEqual(refreshed.decisions, []); assert.equal(refreshed.audit, null);
      assert.notEqual(refreshed.guidance.guidanceHash, expected.guidanceHash); assert.notEqual(refreshed.sourceHashes.local, expected.sourceHashes.local);
      await fs.writeFile(path.join(directory, 'local.json'), initialBytes.local);
    }
    for (const role of roles) assert.deepEqual(await fs.readFile(path.join(directory, `${role}.json`)), initialBytes[role]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage, pickerCalls, conflicts: state.review.conflicts.length, placementChanges: state.guidance.placementPolicy.summary.totalChanges,
      observedInteractions: state.guidance.placementPolicy.summary.observedInteractions, sourceHashes: Object.fromEntries(roles.map(role => [role, sha(initialBytes[role])])),
      sourceBytesUnchanged: true, applyDisabled, layouts, runtime: { electron: process.versions.electron, chromium: process.versions.chrome } }));
    app.quit();
  }
}
