'use strict';
// Real shipped Electron main/preload/renderer, native media helper and disposable
// files. Only picker results and deterministic provider timing/faults are supplied.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'phase-0/media-jobs-desktop');
const proofRoot = process.env.FRAMELINE_MEDIA_JOBS_PROOF_ROOT;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));

async function canonicalSnapshot(directory) {
  const entries = [];
  async function walk(location) {
    for (const entry of await fs.readdir(location, { withFileTypes: true })) {
      if (['media-jobs', 'logs', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'].includes(entry.name)) continue;
      const filename = path.join(location, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (/^(metadata\.json(?:\.bak)?|.*(?:revision|sync-base).*\.json)$/.test(entry.name)
        || path.relative(directory, filename).split(path.sep).includes('revisions')) entries.push([path.relative(directory, filename), sha(await fs.readFile(filename))]);
    }
  }
  await walk(directory); return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-media-jobs-')));
    try {
      await fs.mkdir(path.join(directory, 'profile')); await fs.mkdir(evidenceDirectory, { recursive: true });
      await makeFixtures(directory, run);
      const helperParentDeath = await verifyIdleHelperParentDeath(directory, run);
      const stages = [];
      for (const stage of ['first', 'restart', 'tampered', 'corrupt-journal']) {
        const result = await run(require('electron'), [__filename], { cwd: root, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, FRAMELINE_MEDIA_JOBS_PROOF_ROOT: directory, FRAMELINE_MEDIA_JOBS_PROOF_STAGE: stage } });
        const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"stage"'));
        if (!line) throw new Error(`Missing native result for ${stage}: ${result.stderr}`);
        assert.ok(!result.stdout.includes(directory) && !result.stderr.includes(directory), 'private fixture paths absent from process logs');
        stages.push(JSON.parse(line));
        if (stage === 'restart') {
          const expected = JSON.parse(await fs.readFile(path.join(directory, 'expected.json'), 'utf8'));
          await fs.appendFile(expected.tamperPath, 'deliberately corrupted disposable cache');
        }
        if (stage === 'tampered') await fs.writeFile(path.join(directory, 'profile/media-jobs/desktop-media-jobs.json'), '{"version":');
      }
      const evidence = { schemaVersion: 1,
        scope: 'Four shipped Electron main/preload/renderer processes, abrupt first-process exit without disposal, and the actual Apple native media provider; disposable generated media and native picker fixture results only. The interruption barrier precedes helper launch, so active-encoder parent-death behavior is not claimed.',
        checks: ['idle native helper exits after its parent dies while independent FIFO writer remains open', 'default-off and rights-confirmed rendering', 'real source SHA-256 and asset inspection',
          'decoded nonblank PNG thumbnail', 'actual H.264 MP4 with video duration and frames',
          'ordered three-clip source-bound FCPXML storyboard', 'deduplication and measured metrics',
          'deterministic native-provider cancellation, retry, restart and policy fencing',
          'explicit resume after process restart', 'verified cache recovery and corrupt artifact rejection',
          'corrupt optional job journal leaves canonical project scanning and history available',
          'canonical source, revisions and sync bases preserved', 'private source paths absent from public DTOs',
          'unknown-to-configured storage estimate', '360–1440px layouts, keyboard and accessible action labels', 'no renderer errors'], helperParentDeath, stages };
      await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog, shell, nativeImage } = require('electron');
  const stage = process.env.FRAMELINE_MEDIA_JOBS_PROOF_STAGE;
  if (!proofRoot || !['first', 'restart', 'tampered', 'corrupt-journal'].includes(stage)) throw new Error('Disposable media proof required');
  const profile = path.join(proofRoot, 'profile'); app.setPath('userData', profile);
  const source = path.join(proofRoot, 'private-cut.fcpxml');
  let chosen = path.join(proofRoot, 'clip-red.mp4');
  const reveals = [];
  shell.showItemInFolder = filename => reveals.push(filename);
  dialog.showOpenDialog = async options => {
    assert.ok(['Choose a DaVinci Resolve timeline', 'Choose local media for background jobs'].includes(options.title));
    return { canceled: false, filePaths: [options.title === 'Choose a DaVinci Resolve timeline' ? source : chosen] };
  };
  // Delays/faults wrap the actual provider; successful output always comes from
  // the shipped helper, and cancellation must still fence a late real result.
  let providerControl = null, providerCalls = 0;
  const providerModule = require('../src/native-media-renderer');
  const realFactory = providerModule.createNativeMediaRenderer;
  providerModule.createNativeMediaRenderer = options => {
    const provider = realFactory(options);
    for (const method of ['inspect', 'renderThumbnail', 'renderProxy', 'renderStoryboard']) {
      const actual = provider[method].bind(provider);
      provider[method] = async (...args) => {
        providerCalls++;
        const control = method === 'inspect' ? null : providerControl;
        if (control) {
          providerControl = null; control.started = true;
          if (control.fail) throw Object.assign(new Error('Controlled disposable provider failure'), { code: 'native-media-unavailable' });
          if (control.delay) await pause(control.delay);
          if (control.ignoreAbort) args[1] = { progress: args[1]?.progress };
        }
        try { return await actual(...args); } finally { if (control) control.finished = true; }
      };
    }
    return provider;
  };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');

  async function verify(win, errors) {
    app.setAccessibilitySupportEnabled(true);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async (expression, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (!await js(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await pause(40); }
    };
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const api = (name, value) => js(`window.desktop.${name}(${value === undefined ? '' : JSON.stringify(value)})`);
    const state = () => api('getMediaJobsState');
    const assertPrivate = value => assert.doesNotMatch(JSON.stringify(value), /frameline-media-jobs-|\/Users\/|\/private\/|sourcePath|exportPath|outputPath/);
    const completed = async id => {
      await wait(`window.desktop.getMediaJobsState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(id)} && ['completed','failed','cancelled'].includes(j.status)))`);
      const job = (await state()).jobs.find(item => item.id === id); assert.equal(job.status, 'completed', JSON.stringify(job)); return job;
    };
    const enqueue = async input => {
      const answer = await api('enqueueMediaJob', input); assert.equal(answer.error ?? null, null, JSON.stringify(answer));
      assert.ok(answer.lastEnqueuedId); return answer.lastEnqueuedId;
    };
    const choose = async filename => { chosen = path.join(proofRoot, filename); const answer = await api('chooseMediaJobSource'); assert.ok(answer.source); return answer; };
    const artifactPath = async id => {
      const saved = JSON.parse(await fs.readFile(path.join(profile, 'media-jobs/desktop-media-jobs.json'), 'utf8'));
      const job = Array.isArray(saved.jobs) ? saved.jobs.find(item => item.id === id) : null;
      assert.ok(job?.artifact?.filename && job.artifact.projectBucket, 'private artifact receipt available to proof');
      return path.join(profile, 'media-jobs/artifacts', job.artifact.projectBucket, job.artifact.filename);
    };
    const inspectPNG = async id => {
      const preview = await api('previewMediaJob', id); assert.equal(preview.canonical, false); assert.match(preview.dataUrl, /^data:image\/png;base64,/);
      const bytes = Buffer.from(preview.dataUrl.split(',')[1], 'base64');
      assert.equal(sha(bytes), (await state()).jobs.find(job => job.id === id).result.sha256);
      if (process.platform !== 'win32') assert.equal((await fs.stat(await artifactPath(id))).mode & 0o777, 0o600);
      const image = nativeImage.createFromDataURL(preview.dataUrl); assert.equal(image.isEmpty(), false);
      const size = image.getSize(), bitmap = image.toBitmap(); assert.ok(size.width >= 100 && size.height >= 80);
      const colors = new Set(); for (let index = 0; index < bitmap.length; index += 4 * 97) colors.add(bitmap.subarray(index, index + 3).toString('hex'));
      assert.ok(colors.size > 3, 'render decodes to nonblank real pixels'); return { ...size, sampledColors: colors.size };
    };
    await wait("window.desktop?.getMediaJobsState && document.getElementById('media-jobs-panel')");
    await click('choose-file'); await wait("currentAppState?.scanStatus === 'ready'");
    await js("showView('media')");
    const sourceBytes = await fs.readFile(source), sourceHash = sha(sourceBytes);
    if (stage === 'first') await api('saveRevision', 'Before local media jobs');
    const canonicalBefore = await canonicalSnapshot(profile);
    assert.ok(canonicalBefore.some(([filename]) => filename.startsWith('revisions/')), 'real canonical revision exists before media work');
    const layouts = [], observations = {};

    if (stage === 'first') {
      const initial = await state(); assert.equal(initial.policy.enabled, false); assert.equal(initial.jobs.length, 0);
      const off = await api('enqueueMediaJob', { kind: 'thumbnail', rightsConfirmed: true });
      assert.ok(off.error); assert.equal((await state()).jobs.length, 0);
      await click('media-jobs-source-choose'); await wait("window.desktop.getMediaJobsState().then(s=>!!s.source)");
      await js("document.getElementById('media-jobs-enable').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      assert.equal(await js("document.getElementById('media-jobs-enable').checked"), true);
      await click('media-jobs-settings-save'); await wait("window.desktop.getMediaJobsState().then(s=>s.policy.enabled)");
      const noRights = await api('enqueueMediaJob', { kind: 'thumbnail' });
      assert.ok(noRights.error); assert.equal((await state()).jobs.length, 0);
      const hashId = await enqueue({ kind: 'hash' }), hashJob = await completed(hashId);
      assert.equal(hashJob.result.sha256, sha(await fs.readFile(path.join(proofRoot, 'clip-red.mp4'))));
      assert.equal(await enqueue({ kind: 'hash' }), hashId);
      const checkId = await enqueue({ kind: 'asset-check' }), checked = await completed(checkId);
      observations.sourceCheck = checked.result;
      await click('media-jobs-rights'); await click('media-jobs-settings-save');
      await wait("window.desktop.getMediaJobsState().then(s=>s.policy.rightsConfirmed)");
      await js("document.getElementById('media-jobs-kind').value='thumbnail'; document.getElementById('media-jobs-kind').dispatchEvent(new Event('change')); document.getElementById('media-jobs-form').requestSubmit()");
      await wait("window.desktop.getMediaJobsState().then(s=>s.jobs.some(j=>j.kind==='thumbnail'))");
      let thumbnailId = (await state()).jobs.find(job => job.kind === 'thumbnail').id;
      const thumbnail = await completed(thumbnailId); observations.thumbnail = await inspectPNG(thumbnailId);
      await fs.writeFile(path.join(evidenceDirectory, 'native-thumbnail.png'), Buffer.from((await api('previewMediaJob', thumbnailId)).dataUrl.split(',')[1], 'base64'));
      assert.equal(await enqueue({ kind: 'thumbnail', rightsConfirmed: true, frame: 0 }), thumbnailId);
      let proxyId = await enqueue({ kind: 'proxy', rightsConfirmed: true, width: 320, height: 180 });
      const proxy = await completed(proxyId), proxyPath = await artifactPath(proxyId);
      const proxyBytes = await fs.readFile(proxyPath); assert.equal(proxyBytes.subarray(4, 8).toString(), 'ftyp');
      assert.equal(sha(proxyBytes), proxy.result.sha256);
      if (process.platform !== 'win32') assert.equal((await fs.stat(proxyPath)).mode & 0o777, 0o600);
      assert.ok(proxyBytes.includes(Buffer.from('avc1'))); assert.ok(proxyBytes.length > 1024);
      await fs.writeFile(path.join(evidenceDirectory, 'native-proxy.mp4'), proxyBytes);
      const info = await realFactory().inspect({ sourcePath: proxyPath });
      assert.equal(info.kind, 'video'); assert.ok(info.durationSeconds > 1.5 && info.durationSeconds < 2.5); assert.ok(info.frameRate >= 23);
      const proxySamples = [];
      for (const seconds of [0, 1]) {
        const outputPath = path.join(proofRoot, `proxy-sample-${seconds}.png`);
        const rendered = await realFactory().renderThumbnail({ sourcePath: proxyPath, outputPath, seconds, width: 320, height: 180 });
        proxySamples.push(rendered.sha256);
      }
      assert.notEqual(proxySamples[0], proxySamples[1], 'proxy decodes different real video frames');
      observations.proxy = { byteLength: proxyBytes.length, ...info, distinctDecodedFrames: proxySamples.length };
      let boardId = await enqueue({ kind: 'timeline-preview', rightsConfirmed: true, width: 960, height: 360 });
      await completed(boardId); observations.storyboard = await inspectPNG(boardId);
      const board = nativeImage.createFromDataURL((await api('previewMediaJob', boardId)).dataUrl), bitmap = board.toBitmap();
      await fs.writeFile(path.join(evidenceDirectory, 'native-storyboard.png'), board.toPNG());
      const size = board.getSize(), centers = [0, 1, 2].map(column => {
        const offset = (Math.floor(size.height / 2) * size.width + Math.floor((column + 0.5) * size.width / 3)) * 4;
        return [...bitmap.subarray(offset, offset + 3)].reverse();
      });
      centers.forEach((pixel, index) => assert.ok(pixel[index] > pixel[(index + 1) % 3] + 70 && pixel[index] > pixel[(index + 2) % 3] + 70, `ordered RGB clip ${index}: ${pixel}`));
      observations.storyboard.orderedRGB = true;
      await api('revealMediaJob', boardId); assert.equal(reveals.length, 1);
      await choose('still.png');
      const stillId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 320, height: 180 });
      await completed(stillId); observations.stillThumbnail = await inspectPNG(stillId);
      await choose('clip-red.mp4');
      assert.equal((await state()).metrics.estimatedMonthlyStorageCostUSD, null);
      await js("document.querySelector('.media-jobs-cost-settings').open=true; document.getElementById('media-jobs-cost').value='0.15'");
      await click('media-jobs-settings-save'); await wait("window.desktop.getMediaJobsState().then(s=>s.policy.costPerGiBMonthUSD===0.15)");
      const measured = (await state()).metrics; assert.ok(measured.cacheBytes >= thumbnail.result.byteLength + proxy.result.byteLength);
      assert.ok(measured.processingMs > 0); assert.equal(measured.estimatedMonthlyStorageCostUSD, measured.cacheBytes / (1024 ** 3) * 0.15);
      observations.metrics = measured;

      providerControl = { fail: true };
      const failedId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 601, height: 340 });
      await wait(`window.desktop.getMediaJobsState().then(s=>s.jobs.find(j=>j.id===${JSON.stringify(failedId)})?.status==='failed')`);
      assert.ok((await state()).metrics.failures >= 1); observations.measuredFailure = true;
      await api('retryMediaJob', failedId); const retried = await completed(failedId); assert.equal(retried.attempts, 2);
      await api('restartMediaJob', failedId); const restarted = await completed(failedId); assert.ok(restarted.attempts >= 1);
      const delay = { delay: 1000 }; providerControl = delay;
      const cancelledId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 602, height: 340 });
      while (!delay.started) await pause(10);
      await api('cancelMediaJob', cancelledId); await pause(1100);
      assert.equal((await state()).jobs.find(item => item.id === cancelledId).status, 'cancelled');
      assert.ok((await api('previewMediaJob', cancelledId)).error);
      const fencedDelay = { delay: 1000, ignoreAbort: true }; providerControl = fencedDelay;
      const fencedId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 603, height: 340 });
      while (!fencedDelay.started) await pause(10);
      await api('saveMediaJobsPolicy', { enabled: false });
      const fenceDeadline = Date.now() + 10000;
      while (!fencedDelay.finished) { assert.ok(Date.now() < fenceDeadline, 'late actual render finishes'); await pause(20); }
      await pause(100);
      assert.notEqual((await state()).jobs.find(item => item.id === fencedId).status, 'completed');
      assert.ok((await api('previewMediaJob', fencedId)).error);
      await api('saveMediaJobsPolicy', { enabled: true, rightsConfirmed: true });
      observations.controls = { retry: true, restart: true, cancellation: true, disabledPolicyPreventsPublication: true };
      // A new consent epoch requires fresh derivatives; old results stay revoked.
      assert.ok((await api('previewMediaJob', thumbnailId)).error);
      thumbnailId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, frame: 0 }); await completed(thumbnailId);
      proxyId = await enqueue({ kind: 'proxy', rightsConfirmed: true, width: 320, height: 180 }); await completed(proxyId);
      boardId = await enqueue({ kind: 'timeline-preview', rightsConfirmed: true, width: 960, height: 360 }); await completed(boardId);

      await js(`document.querySelector('[data-job-id="${boardId}"] [data-media-action="preview"]').click()`);
      await wait("document.getElementById('media-jobs-preview')?.getAttribute('src')?.startsWith('data:image/png')");
      win.webContents.debugger.attach('1.3'); const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree'); win.webContents.debugger.detach();
      const buttons = tree.nodes.filter(node => node.role?.value === 'button' && /preview|reveal|retry|restart|cancel/i.test(node.name?.value ?? ''));
      assert.ok(buttons.length >= 4); assert.ok(buttons.every(node => node.name.value.trim().length > 3)); observations.accessibleActions = buttons.length;
      const frameHashes = new Set();
      for (let frame = 2; frame < 15; frame++) frameHashes.add((await completed(await enqueue({ kind: 'thumbnail', rightsConfirmed: true, frame, width: 240, height: 135 }))).result.sha256);
      assert.equal(frameHashes.size, 13, 'different source frames produce different native pixels'); observations.distinctSourceFrames = frameHashes.size;
      await wait("document.querySelectorAll('#media-jobs-list [data-job-id]').length===20");
      assert.equal(await js("document.getElementById('media-jobs-next').disabled"), false);
      await click('media-jobs-next');
      await wait("document.querySelectorAll('#media-jobs-list [data-job-id]').length>0 && document.querySelectorAll('#media-jobs-list [data-job-id]').length<20");
      observations.paging = { total: (await state()).jobs.length, pageSize: 20, secondPage: await js("document.querySelectorAll('#media-jobs-list [data-job-id]').length") };
      await click('media-jobs-previous'); await wait("document.querySelectorAll('#media-jobs-list [data-job-id]').length===20");
      for (const width of [1440, 768, 390, 360]) {
        win.setContentSize(width, 1100); await js("document.getElementById('media-jobs-panel').scrollIntoView({block:'start'})"); await pause(150);
        const layout = await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'); assert.equal(layout.width, layout.scrollWidth); layouts.push(layout);
        if (process.env.FRAMELINE_MEDIA_JOBS_CAPTURE !== '0' && [1440, 390].includes(width)) await fs.writeFile(path.join(evidenceDirectory, `media-jobs-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      const interrupted = { delay: 4000 }; providerControl = interrupted;
      const pausedId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 604, height: 340 });
      const interruptedDeadline = Date.now() + 10000;
      while (!interrupted.started) { assert.ok(Date.now() < interruptedDeadline, 'actual worker starts before process shutdown'); await pause(20); }
      const queuedId = await enqueue({ kind: 'thumbnail', rightsConfirmed: true, width: 605, height: 340 });
      const interruptedState = await state();
      assert.equal(interruptedState.jobs.find(job => job.id === pausedId).status, 'running');
      assert.equal(interruptedState.jobs.find(job => job.id === queuedId).status, 'queued');
      observations.abruptExitWithRunningAndQueuedJobs = true;
      await fs.writeFile(path.join(profile, 'media-jobs/artifacts/staging/unrelated.txt'), 'unrelated disposable file', { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(proofRoot, 'expected.json'), JSON.stringify({ sourceHash, thumbnailId, boardId, proxyId, pausedId, queuedId, tamperPath: await artifactPath(thumbnailId), canonical: canonicalBefore }));
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(proofRoot, 'expected.json'), 'utf8'));
      assert.equal(sourceHash, expected.sourceHash); assert.deepEqual(canonicalBefore, expected.canonical);
      if (stage === 'restart') {
        const restored = await state();
        assert.deepEqual(await fs.readdir(path.join(profile, 'media-jobs/artifacts/staging')), ['unrelated.txt']);
        assert.equal(await fs.readFile(path.join(profile, 'media-jobs/artifacts/staging/unrelated.txt'), 'utf8'), 'unrelated disposable file');
        observations.ownedStagingCleanedAndUnrelatedPreserved = true;
        for (const id of [expected.pausedId, expected.queuedId]) assert.equal(restored.jobs.find(item => item.id === id).status, 'paused');
        assert.ok(restored.metrics.backlog >= 2 && restored.metrics.counts.paused >= 2);
        assert.equal(providerCalls, 0); await pause(250); assert.equal(providerCalls, 0);
        observations.recoveredThumbnail = await inspectPNG(expected.thumbnailId);
        observations.recoveredStoryboard = await inspectPNG(expected.boardId);
        await api('resumeMediaJob', expected.pausedId); await completed(expected.pausedId);
        await api('resumeMediaJob', expected.queuedId); await completed(expected.queuedId);
        observations.explicitResume = true;
      } else if (stage === 'tampered') {
        const preview = await api('previewMediaJob', expected.thumbnailId); assert.equal(preview.error, 'media-artifact-unavailable');
        observations.corruptArtifactWithheld = true;
        assert.equal((await api('previewMediaJob', expected.boardId)).canonical, false);
      } else {
        const unavailable = await state();
        assert.equal(unavailable.available, false); assert.ok(unavailable.error); assert.deepEqual(unavailable.jobs, []); assertPrivate(unavailable);
        const project = await api('getAppState'); assert.equal(project.scanStatus, 'ready'); assert.equal(project.revisions.length, 1);
        assert.equal(project.scan.sourceHash, expected.sourceHash); observations.corruptOptionalJournalDoesNotBlockCanonicalProject = true;
      }
    }

    assert.equal(sha(await fs.readFile(source)), sourceHash);
    assert.deepEqual(await canonicalSnapshot(profile), canonicalBefore);
    assertPrivate(await state()); assert.deepEqual(errors, []);
    await new Promise(done => process.stdout.write(`${JSON.stringify({ stage, ...observations, sourceUnchanged: true, canonicalUnchanged: true, providerCalls, reveals: reveals.length,
      layouts, rendererErrors: errors.length, runtime: { electron: process.versions.electron, chromium: process.versions.chrome } })}\n`, done));
    if (stage === 'first') app.exit(0); // Deliberately bypasses before-quit/dispose.
    else app.quit();
  }
}

async function makeFixtures(directory, run) {
  const swift = String.raw`import Foundation
import AVFoundation
import AppKit
let directory = CommandLine.arguments[1]
let colors: [(String, UInt8, UInt8, UInt8)] = [("red",220,35,35),("green",35,205,35),("blue",35,35,220)]
for (name, red, green, blue) in colors {
 let url = URL(fileURLWithPath: directory).appendingPathComponent("clip-\(name).mp4")
 let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
 let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey:AVVideoCodecType.h264, AVVideoWidthKey:320, AVVideoHeightKey:180])
 let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input, sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey as String:320,kCVPixelBufferHeightKey as String:180])
 writer.add(input); writer.startWriting(); writer.startSession(atSourceTime:.zero)
 for frame in 0..<48 {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval:0.001) }
  var value: CVPixelBuffer?; CVPixelBufferCreate(kCFAllocatorDefault,320,180,kCVPixelFormatType_32ARGB,nil,&value)
  let buffer = value!; CVPixelBufferLockBaseAddress(buffer,[])
  let bytes = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to:UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
  for y in 0..<180 { for x in 0..<320 {
   let index = y*stride+x*4, moving = abs(x - (frame*6)%320) < 15
   bytes[index]=255; bytes[index+1]=moving ? 255:red; bytes[index+2]=moving ? 255:green; bytes[index+3]=moving ? 255:blue
  }}
  CVPixelBufferUnlockBaseAddress(buffer,[])
  guard adaptor.append(buffer,withPresentationTime:CMTime(value:Int64(frame),timescale:24)) else { fatalError("append failed") }
 }
 input.markAsFinished(); let semaphore = DispatchSemaphore(value:0); writer.finishWriting { semaphore.signal() }; semaphore.wait()
 guard writer.status == .completed else { fatalError("video fixture failed") }
}

let image = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:320,pixelsHigh:180,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
for y in 0..<180 { for x in 0..<320 { image.setColor(NSColor(calibratedRed:CGFloat(x)/320,green:CGFloat(y)/180,blue:0.4,alpha:1),atX:x,y:y) }}
try image.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:directory).appendingPathComponent("still.png"))
`;
  const script = path.join(directory, 'fixture.swift'), binary = path.join(directory, 'fixture');
  await fs.writeFile(script, swift, { mode: 0o600 });
  await run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(directory, 'modules'), script, '-o', binary], { timeout: 120000 });
  await run(binary, [directory], { timeout: 30000 });
  const { pathToFileURL } = require('node:url');
  const assets = ['red', 'green', 'blue'].map((color, index) => `<asset id="r${index + 2}" name="${color}" start="0s" duration="2s" hasVideo="1" format="r1"><media-rep kind="original-media" src="${pathToFileURL(path.join(directory, `clip-${color}.mp4`)).href}"/></asset>`).join('');
  const clips = ['red', 'green', 'blue'].map((color, index) => `<asset-clip name="${color}" ref="r${index + 2}" offset="${index}s" start="${index}/24s" duration="1s"/>`).join('');
  await fs.writeFile(path.join(directory, 'private-cut.fcpxml'), `<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.10"><resources><format id="r1" frameDuration="1/24s" width="320" height="180"/>${assets}</resources><library><event name="Fixture"><project name="Local media proof"><sequence format="r1" duration="3s" tcStart="0s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`);
}

async function verifyIdleHelperParentDeath(directory, run) {
  const fifo = path.join(directory, 'helper-parent-proof.fifo');
  await run('/usr/bin/mkfifo', [fifo]);
  // This independent RDWR descriptor prevents EOF when the helper's immediate
  // parent dies. The actual Swift helper must observe parent death itself.
  const holder = await fs.open(fifo, 'r+');
  const helper = path.join(root, 'src/native/bin/media-renderer');
  let owner, helperPid;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  try {
    owner = require('node:child_process').spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.argv[1], [], {stdio:[fs.openSync(process.argv[2], 'r'),'ignore','ignore']});
      child.on('error', () => process.exit(1));
      process.stdout.write(JSON.stringify({helperPid:child.pid})+'\\n');
      setInterval(() => {}, 1000);
    `, helper, fifo], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ownerExit = new Promise(done => owner.once('exit', done));
    helperPid = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('idle-helper-start-timeout')), 5000);
      owner.on('error', error => { clearTimeout(timer); reject(error); });
      owner.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.trim()).helperPid); } catch { reject(new Error('idle-helper-start-invalid')); }
      });
    });
    assert.ok(Number.isSafeInteger(helperPid) && helperPid > 1);
    await pause(400); assert.equal(alive(helperPid), true, 'actual helper blocks waiting for stdin');
    const started = Date.now(); owner.kill('SIGKILL'); await ownerExit;
    while (alive(helperPid) && Date.now() - started < 5000) await pause(20);
    assert.equal(alive(helperPid), false, 'actual helper exits despite independent FIFO remaining open');
    return { state: 'idle helper blocked on stdin', independentWriterKeptOpen: true, parentTerminated: 'SIGKILL', helperExited: true, elapsedMs: Date.now() - started, activeEncoderKillTested: false };
  } finally {
    if (owner && owner.exitCode === null && !owner.signalCode) owner.kill('SIGKILL');
    if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL');
    await holder.close(); await fs.rm(fifo, { force: true });
  }
}
