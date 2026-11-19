'use strict';
// Two real desktop processes with disposable source/history fixtures. OS picker
// results are supplied by this harness; no editor or production service writes.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/comparison-review-desktop');
const roles = ['base', 'local', 'incoming'];
const sha = value => createHash('sha256').update(value).digest('hex');

async function writeFixtures(directory) {
  const original = JSON.parse(await fs.readFile(path.join(root, 'phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8'));
  const template = original.timelines[0].items[0];
  const snapshot = { ...original, project_name: 'Disposable comparison review', timelines: [] };
  for (let t = 0; t < 2; t++) {
    const timeline = { id: `sequence-${t + 1}`, name: `Sequence ${t + 1}`, start_frame: 0,
      tracks: [{ type: 'video', index: 1, name: 'Picture one' }, { type: 'video', index: 2, name: 'Picture two' },
        { type: 'audio', index: 1, name: 'Production audio' }], items: [] };
    for (let n = 0; n < 60; n++) {
      const type = n % 3 === 0 ? 'audio' : 'video';
      timeline.items.push({ ...structuredClone(template), id: `sequence-${t + 1}-clip-${String(n).padStart(3, '0')}`,
        name: `Sequence ${t + 1} clip ${String(n).padStart(3, '0')}`, type, track_type: type, track_index: type === 'audio' ? 1 : n % 2 + 1,
        start_frame: n * 120, end_frame: n * 120 + 72, source_start_frame: 0, source_end_frame: 72,
        linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } });
    }
    snapshot.timelines.push(timeline);
  }
  const ids = { name: snapshot.timelines[0].items[0].id, timing: snapshot.timelines[0].items[1].id,
    property: snapshot.timelines[0].items[2].id, equivalent: snapshot.timelines[0].items[3].id,
    linked: snapshot.timelines[0].items[4].id, transition: snapshot.timelines[0].items[6].id,
    late: snapshot.timelines[1].items[59].id, secondTimeline: snapshot.timelines[1].id };
  snapshot.timelines[0].items[4].linked_item_ids = [snapshot.timelines[0].items[5].id];
  snapshot.timelines[0].items[5].linked_item_ids = [snapshot.timelines[0].items[4].id];
  Object.assign(snapshot.timelines[0].items[6], { type: 'transition', source_start_frame: null, source_end_frame: null });
  const values = Object.fromEntries(roles.map(role => [role, { schemaVersion: 2, operation: 'resolve-effect-observation', readOnly: true, safeToApply: false,
    snapshot: structuredClone(snapshot), activeTimelineId: snapshot.timelines[0].id,
    items: snapshot.timelines.flatMap(timeline => timeline.items.map(item => ({ timelineId: timeline.id, itemId: item.id,
      effects: [], propertyReadStatus: 'captured', properties: { Pan: { decimal: '1.0000000000000000e+00' }, TransformEnabled: true } }))),
    tracks: snapshot.timelines.flatMap(timeline => timeline.tracks.map(track => ({ timelineId: timeline.id, type: track.type, index: track.index, enabled: true, locked: false }))) }]));
  for (const role of ['local', 'incoming']) for (const timeline of values[role].snapshot.timelines) for (const item of timeline.items) {
    if ([ids.name, ids.timing, ids.property, ids.equivalent, ids.linked, ids.transition, ids.late].includes(item.id)) continue;
    if (role === 'incoming') item.name += ' incoming';
  }
  values.local.snapshot.timelines[0].items[0].name = 'Local named clip';
  values.incoming.snapshot.timelines[0].items[0].name = 'Incoming named clip';
  Object.assign(values.local.snapshot.timelines[0].items[1], { start_frame: 124, end_frame: 196 });
  Object.assign(values.incoming.snapshot.timelines[0].items[1], { start_frame: 128, end_frame: 200 });
  values.local.items.find(item => item.itemId === ids.property).properties.Pan.decimal = '1.0000000000000000e+01';
  values.incoming.items.find(item => item.itemId === ids.property).properties.Pan.decimal = '2.0000000000000000e+01';
  values.local.items.find(item => item.itemId === ids.equivalent).properties.Pan.decimal = '0.1000000000000000e+01';
  values.incoming.items.find(item => item.itemId === ids.equivalent).properties.Pan.decimal = '0.1000000000000000e+01';
  values.local.snapshot.timelines[0].items[4].end_frame += 3;
  values.incoming.snapshot.timelines[0].items[6].start_frame += 2;
  values.incoming.snapshot.timelines[1].items[59].source_start_frame = 1;
  values.local.snapshot.timelines[1].name = 'Local sequence two';
  values.incoming.snapshot.timelines[1].name = 'Incoming sequence two';
  values.local.tracks[1].enabled = false;
  const { validateEffectObservation } = require('../src/resolve-effect-observation');
  for (const role of roles) {
    validateEffectObservation(values[role]);
    await fs.writeFile(path.join(directory, `${role}.json`), JSON.stringify(values[role]));
  }
  const profile = path.join(directory, 'profile'); await fs.mkdir(profile);
  const store = require('../src/local-metadata').createLocalMetadataStore(profile);
  const { createResolveObservationManifest } = require('../src/resolve-revision-manifest');
  const project = await store.getResolveProjectId(snapshot.project_id, 'Comparison fixture history');
  const base = await store.saveRevision(project.id, createResolveObservationManifest(values.base), 'Base fixture');
  const incoming = await store.saveRevision(project.id, createResolveObservationManifest(values.incoming), 'Incoming fixture', base.id);
  return { ...ids, projectId: project.id, baseRevisionId: base.id, incomingRevisionId: incoming.id };
}

if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-comparison-proof-')));
    try {
      await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(await writeFixtures(directory)));
      if (process.argv.includes('--fixture-only')) { console.log('Disposable rich fixture and immutable history validated.'); return; }
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const stages = [];
      for (const stage of ['first', 'restore']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 120000,
          env: { ...process.env, FRAMELINE_COMPARISON_PROOF_ROOT: directory, FRAMELINE_COMPARISON_PROOF_STAGE: stage } });
        const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"stage"'));
        if (!line) throw new Error(`Missing native proof result: ${result.stdout}\n${result.stderr}`);
        stages.push(JSON.parse(line));
      }
      const evidence = { schemaVersion: 1,
        scope: 'Shipped main/preload/renderer in two real Electron processes, disposable rich observation/history fixtures, fixture-supplied OS pickers; no editor write or external service',
        checks: ['equivalent decimal spelling does not create a change', 'source-bound sequence, track, clip, frame and field context',
          'timecode defaults to unknown rate and optional user-selected non-drop display', 'full-diff timeline/track/kind/status filtering before bounded paging',
          'grouping and trusted keyboard paging', 'property, timing, timeline and name choice consequences',
          'linked/transition/nested/ripple risks remain blocked after complete review', 'history exposes verified before/after frame context',
          'same sources and immutable audit recover after native process restart', 'source refresh clears stale choices/guidance',
          'all source bytes preserved', 'apply remains disabled', '360–1440px layouts without overflow', 'no renderer console errors'], stages };
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  const directory = process.env.FRAMELINE_COMPARISON_PROOF_ROOT, stage = process.env.FRAMELINE_COMPARISON_PROOF_STAGE;
  if (!directory || !['first', 'restore'].includes(stage) || !fsSync.existsSync(path.join(directory, 'fixture.json'))) throw new Error('Disposable fixture required');
  app.setPath('userData', path.join(directory, 'profile'));
  let pickerCalls = 0;
  dialog.showOpenDialog = async options => {
    const match = /^Choose (base|local|incoming) Resolve capture or snapshot$/.exec(options.title);
    assert.ok(match, `Unexpected picker ${options.title}`); pickerCalls++;
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
      const deadline = Date.now() + 20000;
      while (!await js(expression)) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`);
        await new Promise(done => setTimeout(done, 40));
      }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const set = (id, value) => js(`{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change'));}`);
    const getState = () => js('window.desktop.getResolveReviewState()');
    const fixture = JSON.parse(await fs.readFile(path.join(directory, 'fixture.json'), 'utf8'));
    const initialBytes = Object.fromEntries(await Promise.all(roles.map(async role => [role, await fs.readFile(path.join(directory, `${role}.json`))])));
    await wait("window.desktop && !document.getElementById('resolve-choose').disabled");
    await js("showView('resolve');document.getElementById('first-run').hidden=true");
    await click('resolve-choose'); await wait("resolveState?.status === 'ready' && !!resolveState.guidance?.changeContext && !resolveBusy");
    let state = await getState();
    const changes = state.plan.classification.decisions;
    assert.ok(changes.length > 80); assert.equal(changes.some(value => value.itemId === fixture.equivalent), false);
    assert.deepEqual(state.guidance.sourceHashes, state.sourceHashes);
    assert.equal(state.guidance.riskPolicy.gate, 'blocked');
    assert.ok(state.guidance.riskPolicy.decisions.some(value => value.itemId === fixture.linked && value.warningCodes.includes('linked-clips-review-required')));
    assert.ok(state.guidance.riskPolicy.decisions.some(value => value.itemId === fixture.transition && value.warningCodes.includes('transition-observed')));
    for (const code of ['nested-coverage-unknown', 'ripple-semantics-unknown', 'transition-coverage-unknown']) assert.ok(state.guidance.riskPolicy.warnings.some(value => value.code === code));
    const applyDisabled = await js("[...document.querySelectorAll('#view-resolve button')].some(button=>button.textContent==='Apply unavailable'&&button.disabled)");
    assert.equal(applyDisabled, true);
    const layouts = [];
    const recordFor = itemId => state.guidance.changeContext.records.find(value => value.itemId === itemId);
    const resetFilters = async () => { for (const id of ['resolve-filter', 'resolve-timeline', 'resolve-track', 'resolve-kind', 'resolve-field']) await set(id, 'all'); };
    const inspect = async (itemId, field) => {
      await resetFilters();
      await set('resolve-filter', 'conflict');
      if (field) await set('resolve-field', field);
      const timeline = changes.find(value => value.itemId === itemId && (!field || value.field === field))?.timelineId;
      if (timeline) await set('resolve-timeline', timeline);
      await js(`{const b=[...document.querySelectorAll('#resolve-queue button')].find(n=>n.textContent.includes(${JSON.stringify(itemId)}) || n.textContent.includes(${JSON.stringify(recordFor(itemId)?.itemName || '')}));if(!b)throw new Error('Target conflict absent from filtered page');b.click();}`);
      await wait("document.querySelectorAll('#resolve-detail .resolve-choice-consequence').length===2");
    };
    if (stage === 'first') {
      assert.equal(await js("document.getElementById('resolve-timecode-rate').value"), '');
      assert.ok(await js("document.querySelectorAll('#resolve-queue button').length<=40"));
      const initialRange = await js("document.getElementById('resolve-changes-range').textContent");
      await js("document.getElementById('resolve-changes-next').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(`document.getElementById('resolve-changes-range').textContent!==${JSON.stringify(initialRange)}`);
      assert.ok(await js("document.querySelectorAll('#resolve-queue button').length<=40"));
      const late = recordFor(fixture.late); assert.ok(late);
      await set('resolve-timeline', fixture.secondTimeline); await set('resolve-track', late.tracks[0]);
      await set('resolve-kind', late.kind); await set('resolve-filter', changes.find(value => value.itemId === fixture.late).status);
      assert.ok(await js(`document.getElementById('resolve-queue').textContent.includes(${JSON.stringify(late.itemName)})`));
      for (const group of ['timeline', 'track', 'status', 'kind', 'none']) {
        await set('resolve-group', group);
        const headings = await js("document.querySelectorAll('#resolve-queue .resolve-change-group').length");
        assert.equal(group === 'none' ? headings === 0 : headings > 0, true, `group headings for ${group}`);
      }
      await inspect(fixture.name, 'name');
      assert.match(await js("document.getElementById('resolve-change-context').textContent"), /Sequence|Local named clip/);
      assert.match(await js("document.getElementById('resolve-change-context').textContent"), /frame|rate/i);
      assert.match(await js("document.getElementById('resolve-change-context').textContent"), /SMPTE unavailable \(frame rate not captured\)/);
      assert.equal(await js("document.querySelectorAll('#resolve-change-context .resolve-context-role').length"), 3);
      await set('resolve-timecode-rate', '24');
      assert.match(await js("document.getElementById('resolve-change-context').textContent"), /NDF|non.drop|user.selected/i);
      await set('resolve-timecode-rate', '24000/1001');
      assert.match(await js("document.getElementById('resolve-change-context').textContent"), /24000|user.selected/i);
      const displayOnly = await getState();
      assert.equal(displayOnly.guidance.guidanceHash, state.guidance.guidanceHash);
      assert.deepEqual(displayOnly.sourceHashes, state.sourceHashes);
      assert.deepEqual(displayOnly.decisions, []); assert.equal(displayOnly.audit, null);
      for (const [itemId, field] of [[fixture.name, 'name'], [fixture.timing, 'startFrame'], [fixture.property, 'properties.Pan']]) {
        await inspect(itemId, field);
        const text = await js("[...document.querySelectorAll('#resolve-detail .resolve-choice-consequence')].map(n=>n.textContent)");
        assert.equal(text.length, 2); assert.ok(text.every(value => value.length > 15)); assert.notEqual(text[0], text[1]);
        assert.match(await js("document.getElementById('resolve-risk-summary').textContent"), /blocked|unproven|unknown|unavailable/i);
      }
      await resetFilters();
      for (const width of [1440, 768, 390, 360]) {
        win.setContentSize(width, 1100); await js("document.getElementById('resolve-detail').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,queueRows:document.querySelectorAll('#resolve-queue button').length})");
        assert.equal(layout.width, layout.scrollWidth, `overflow at ${width}`); assert.ok(layout.queueRows <= 40); layouts.push(layout);
        if ([1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `context-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      const history = await js(`window.desktop.openResolveRevision(${JSON.stringify(fixture.projectId)},${JSON.stringify(fixture.incomingRevisionId)})`);
      assert.equal(history.ready, true);
      assert.ok(history.changes.some(change => change.beforeContext || change.afterContext));
      await wait("[...document.querySelectorAll('#resolve-history-list button')].some(b=>b.textContent.includes('Incoming fixture'))");
      await js("[...document.querySelectorAll('#resolve-history-list button')].find(b=>b.textContent.includes('Incoming fixture')).click()");
      await wait("document.querySelectorAll('#resolve-history-detail .resolve-history-frame-context').length>0");
      assert.match(await js("document.getElementById('resolve-history-detail').textContent"), /Before|After/);
      assert.match(await js("document.getElementById('resolve-history-detail').textContent"), /Frame|frame|NDF/);
      for (const width of [1440, 390]) {
        win.setContentSize(width, 1100); await js("document.getElementById('resolve-history-detail').scrollIntoView({block:'start'})");
        await new Promise(done => setTimeout(done, 120));
        assert.equal(await js('document.documentElement.scrollWidth===innerWidth'), true, `history overflow at ${width}`);
        await fs.writeFile(path.join(evidenceDirectory, `history-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await resetFilters();
      while ((await getState()).decisions.length < state.review.conflicts.length) {
        await click('resolve-next');
        const count = (await getState()).decisions.length;
        await js("[...document.querySelectorAll('#resolve-detail .resolve-decisions button')].find(b=>b.textContent==='Keep local').click()");
        await wait(`!resolveBusy&&resolveState.decisions.length===${count + 1}`);
      }
      state = await getState(); assert.ok(state.audit); assert.equal(state.guidance.riskPolicy.gate, 'blocked');
      assert.ok(state.guidance.riskPolicy.decisions.every(value => value.gate === 'blocked'));
      await click('resolve-save-review'); await wait("!resolveBusy&&!!resolveState.reviewArtifactId"); state = await getState();
      await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify({ artifactId: state.reviewArtifactId, decisions: state.decisions,
        auditHash: state.audit.auditHash, guidanceHash: state.guidance.guidanceHash, sourceHashes: state.sourceHashes }));
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(directory, 'expected.json'), 'utf8'));
      await js(`document.getElementById('resolve-review-artifact').value=${JSON.stringify(expected.artifactId)};document.getElementById('resolve-review-recover-form').requestSubmit()`);
      await wait("!resolveBusy&&!!resolveState.reviewArtifactId"); state = await getState();
      assert.deepEqual(state.decisions, expected.decisions); assert.equal(state.audit.auditHash, expected.auditHash);
      assert.equal(state.guidance.guidanceHash, expected.guidanceHash); assert.deepEqual(state.sourceHashes, expected.sourceHashes);
      assert.equal(state.guidance.riskPolicy.gate, 'blocked');
      const local = JSON.parse(initialBytes.local); local.snapshot.project_name += ' changed';
      await fs.writeFile(path.join(directory, 'local.json'), JSON.stringify(local));
      await click('resolve-refresh'); await wait("!resolveBusy&&resolveState.sourceVerification?.changed===true");
      const next = await getState(); assert.deepEqual(next.decisions, []); assert.equal(next.audit, null);
      assert.notEqual(next.guidance.guidanceHash, expected.guidanceHash);
      await fs.writeFile(path.join(directory, 'local.json'), initialBytes.local);
    }
    for (const role of roles) assert.deepEqual(await fs.readFile(path.join(directory, `${role}.json`)), initialBytes[role]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ stage, pickerCalls, classifiedChanges: changes.length, conflicts: state.review.conflicts.length,
      contextRecords: state.guidance.changeContext.records.length, riskGate: state.guidance.riskPolicy.gate,
      sourceHashes: Object.fromEntries(roles.map(role => [role, sha(initialBytes[role])])), sourceBytesUnchanged: true, applyDisabled, layouts,
      runtime: { electron: process.versions.electron, chromium: process.versions.chrome } }));
    app.quit();
  }
}
