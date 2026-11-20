'use strict';
// Shipped Electron main/preload/controllers against real fixture-CA HTTPS.
// Disposable accounts, canonical media and picker destinations only.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidenceDirectory = path.join(root, 'phase-0/owner-operations-desktop');
const fixtureRoot = process.env.FRAMELINE_OWNER_PROOF_ROOT;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const safe = value => assert.doesNotMatch(JSON.stringify(value), /\/private\/|\/Users\/|frameline-owner-proof-|accessToken|refreshToken|idempotencyKey/);

if (!process.versions.electron && process.argv[2] === '--seed') {
  (async () => {
    const input = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
    const { createRevisionHttpClient } = require('../src/revision-http-client');
    const { createAssetHttpClient } = require('../src/asset-http-client');
    const { captureMediaBoundScanManifest } = require('../src/media-revision-manifest');
    const engine = require('../src/asset-file-transfer');
    const auth = createRevisionHttpClient({ origin: input.origin, getAccessToken: () => null });
    const session = await auth.signIn(input.email, input.password);
    const revisions = createRevisionHttpClient({ origin: input.origin, getAccessToken: () => session.accessToken });
    const assets = createAssetHttpClient({ origin: input.origin, getAccessToken: () => session.accessToken });
    const policy = await assets.getPolicy('lifecycle-film'); await assets.setPolicy('lifecycle-film', { expectedVersion: policy.version, syncClasses: ['original'] });
    const ids = {};
    for (const name of ['retained', 'garbage', 'spare']) {
      const filename = path.join(fixtureRoot, `${name}.bin`), { identity } = await engine.inspectAssetFile(filename, { assetClass: 'original' });
      await engine.uploadAssetFile({ client: assets, projectId: 'lifecycle-film', filename, identity }); ids[name] = identity.contentId;
    }
    const manifest = await captureMediaBoundScanManifest({ exportPath: path.join(fixtureRoot, 'source.fcpxml') });
    const stored = await revisions.putManifest('lifecycle-film', manifest), revision = await revisions.createRevision({ projectId: 'lifecycle-film', manifestId: stored.id,
      parentRevisionId: null, message: 'Retained canonical media', sourceRevisionId: 'fixture-source', idempotencyKey: 'seed-revision', requireMedia: true });
    await revisions.compareAndSwapBranch({ projectId: 'lifecycle-film', branch: 'main', expectedRevisionId: null, revisionId: revision.id, idempotencyKey: 'seed-branch' });
    const retention = await assets.getRetentionPolicy('lifecycle-film');
    await assets.setRetentionPolicy('lifecycle-film', { expectedVersion: retention.version, minimumArchiveAgeMs: 0, idempotencyKey: 'seed-retention' });
    for (const id of Object.values(ids)) await assets.setArchived('lifecycle-film', id, { expectedArchived: false, archived: true });
    await auth.signOut(session.refreshToken);
    await fs.writeFile(path.join(fixtureRoot, 'assets.json'), JSON.stringify({ ...ids, retainedRevision: revision.id }), { mode: 0o600 });
  })().catch(error => { console.error(error.code || 'owner-proof-seed-failed'); process.exitCode = 1; });
} else if (!process.versions.electron) {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-owner-proof-')));
    let host;
    try {
      const { createKeyring } = require('../src/security-controls');
      const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
      const { createLocalMetadataStore } = require('../src/local-metadata');
      const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
      const { startServiceHost } = require('../src/service-host');
      const { pathToFileURL } = require('node:url');
      const profile = path.join(directory, 'profile'); await fs.mkdir(profile);
      for (const name of ['retained', 'garbage', 'spare']) await fs.writeFile(path.join(directory, `${name}.bin`), `Small disposable ${name} bytes`, { mode: 0o600 });
      const clips = Array.from({ length: 50 }, (_, index) => `<asset-clip name="Owner clip ${index + 1}" ref="a" offset="${index}s" start="0s" duration="1s"/>`).join('');
      const xml = `<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="retained.bin"><media-rep kind="original-media" src="${pathToFileURL(path.join(directory, 'retained.bin')).href}"/></asset></resources><library><event><project name="Small owner fixture"><sequence format="f" duration="50s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`;
      await fs.writeFile(path.join(directory, 'source.fcpxml'), xml, { mode: 0o600 });
      const snapshot = { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'synthetic-owner-resolve', project_name: 'Small synthetic Resolve', timelines: [{ id: 'timeline', name: 'Timeline', start_frame: 0,
        tracks: [{ type: 'video', index: 1, name: 'Video 1' }], items: [{ id: 'clip', track_type: 'video', track_index: 1, type: 'video', name: 'Synthetic clip', start_frame: 0, end_frame: 24,
          source_start_frame: 0, source_end_frame: 24, media_pool_id: 'media', linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }] }] };
      const local = createLocalMetadataStore(profile), resolveProject = await local.getResolveProjectId(snapshot.project_id, snapshot.project_name);
      const resolveRevision = await local.saveRevision(resolveProject.id, createResolveRevisionManifest(snapshot), 'Synthetic observation baseline');
      const originalResolveRecord = await local.getRevision(resolveProject.id, resolveRevision.id);
      const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture'), serviceDirectory = path.join(directory, 'service');
      const runtime = await createDurableCollaborationService({ directory: serviceDirectory, keyring, initialize: true, assetPolicyDefaultsEnabled: true });
      const email = 'owner@owner-operations.example.test', password = 'Disposable owner operations password';
      const otherEmail = 'other@owner-operations.example.test';
      await runtime.identity.createAccount(email, password); await runtime.identity.createAccount(otherEmail, password);
      const context = { accessToken: (await runtime.identity.signIn(email, password)).accessToken }, team = await runtime.teams.create(context, 'Personal operations');
      for (const projectId of ['lifecycle-film', 'scan-history-film', 'resolve-history-film']) await runtime.projects.create(context, { projectId, name: projectId, teamId: team.id });
      await runtime.close();
      const tls = path.join(root, 'tests/fixtures/network-tls');
      host = await startServiceHost({ config: { directory: serviceDirectory, keyring, host: '127.0.0.1', port: 0,
        tls: { cert: await fs.readFile(path.join(tls, 'server.pem')), key: await fs.readFile(path.join(tls, 'server-key.pem')) },
        assets: { directory: path.join(directory, 'assets'), signingKey: randomBytes(32), ownerBoundaryDeduplication: true } }, initialize: true, allowEphemeralPort: true });
      const fixture = { origin: `https://127.0.0.1:${host.address.port}`, email, otherEmail, password, resolveProjectId: resolveProject.id,
        resolveRevisionId: resolveRevision.id, snapshot, sourceHash: hash(xml) };
      await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
      const env = { ...process.env, FRAMELINE_OWNER_PROOF_ROOT: directory, NODE_EXTRA_CA_CERTS: path.join(tls, 'ca.pem') };
      await run(process.execPath, [__filename, '--seed'], { cwd: root, env, timeout: 30000 });
      await fs.mkdir(evidenceDirectory, { recursive: true }); const stages = [];
      for (const stage of ['interrupted', 'recovered']) {
        const result = await run(require('electron'), [__filename], { cwd: root, env: { ...env, FRAMELINE_OWNER_PROOF_STAGE: stage }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        const line = result.stdout.trim().split('\n').findLast(line => line.startsWith('{"stage"')); assert.ok(line); stages.push(JSON.parse(line));
      }
      assert.equal(hash(await fs.readFile(path.join(directory, 'source.fcpxml'))), fixture.sourceHash);
      assert.deepEqual(await local.getRevision(resolveProject.id, resolveRevision.id), originalResolveRecord);
      const state = keyring.decrypt(JSON.parse(await fs.readFile(path.join(directory, 'assets/assets.enc.json'), 'utf8')).record);
      const assets = JSON.parse(await fs.readFile(path.join(directory, 'assets.json'), 'utf8'));
      assert.ok(state.assets.some(item => item.assetId === assets.retained)); assert.ok(!state.assets.some(item => item.assetId === assets.garbage));
      assert.equal(state.garbageCollection.receipts.length, 1);
      const evidence = { schemaVersion: 1, scope: 'Two actual shipped Electron main/preload/renderer processes and real fixture-CA HTTPS; small synthetic 50-clip export, one synthetic saved Resolve observation, disposable accounts and native picker results. No editor operation or real user data.',
        sourceUnchanged: true, originalResolveRevisionUnchanged: true, retainedCanonicalAssetPreserved: true, collectionReceiptCount: 1,
        visualQa: { rounds: 2, initialFinding: 'Publication consent checkbox inherited full-width input styling; corrected to explicit18px control.', confirmation: 'Publication and collection at390/768/1440; native AX and keyboard consent.' }, stages };
      safe(evidence); await fs.writeFile(path.join(evidenceDirectory, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence, null, 2));
    } finally { await host?.close(); await fs.rm(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, dialog } = require('electron');
  const stage = process.env.FRAMELINE_OWNER_PROOF_STAGE;
  if (!fixtureRoot || !['interrupted', 'recovered'].includes(stage)) throw new Error('Disposable owner fixture required');
  app.setPath('userData', path.join(fixtureRoot, 'profile'));
  dialog.showOpenDialog = async options => { assert.equal(options.title, 'Choose a DaVinci Resolve timeline'); return { canceled: false, filePaths: [path.join(fixtureRoot, 'source.fcpxml')] }; };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(fixtureRoot, 'reviewed-receipt.json') });
  let requests = 0, metadataWrites = 0, loseAck = stage === 'interrupted'; const wireMetadata = [];
  const https = require('node:https'), ca = require('node:fs').readFileSync(path.join(root, 'tests/fixtures/network-tls/ca.pem'));
  const send = (url, options) => new Promise((resolve, reject) => {
    requests++;
    const target = new URL(url); if (options.method === 'PUT' && /\/manifests$/.test(target.pathname) || options.method === 'POST' && /\/revisions$/.test(target.pathname)) { metadataWrites++; wireMetadata.push({ route: target.pathname, body: JSON.parse(options.body) }); }
    const request = https.request(url, { method: options.method, headers: options.headers, signal: options.signal, ca }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    }); request.on('error', reject); request.end(options.body);
  });
  const revisions = require('../src/revision-http-client'), revisionFactory = revisions.createRevisionHttpClient;
  revisions.createRevisionHttpClient = options => revisionFactory({ ...options, fetch: send });
  const assets = require('../src/asset-http-client'), assetFactory = assets.createAssetHttpClient;
  assets.createAssetHttpClient = options => {
    const client = assetFactory({ ...options, fetch: send }), actual = client.garbageCollect.bind(client);
    client.garbageCollect = async (...args) => { const receipt = await actual(...args); if (loseAck) { loseAck = false; throw Object.assign(new Error('Disposable lost acknowledgment'), { code: 'asset-network-unavailable' }); } return receipt; };
    return client;
  };
  app.on('browser-window-created', (_event, win) => {
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.once('did-finish-load', () => verify(win, errors).catch(error => { console.error(error); app.exit(1); }));
  });
  require('../src/main');
  async function verify(win, errors) {
    app.setAccessibilitySupportEnabled(true); win.focus();
    const fixture = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
    const assetIds = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'assets.json'), 'utf8'));
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async expression => { const deadline = Date.now() + 30000; while (!await js(`Promise.resolve(${expression}).then(Boolean)`)) { if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await pause(40); } };
    const click = async id => { await wait(`!document.getElementById(${JSON.stringify(id)}).disabled`); return js(`document.getElementById(${JSON.stringify(id)}).click()`); };
    const api = (method, input) => js(`window.desktop.${method}(${input === undefined ? '' : JSON.stringify(input)})`);
    const paint = async () => { await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(80); };
    const lifecycle = () => api('getAssetLifecycleState');
    async function connect(email = fixture.email) {
      await js(`showView('history');document.getElementById('service-origin').value=${JSON.stringify(fixture.origin)};document.getElementById('service-email').value=${JSON.stringify(email)};document.getElementById('service-password').value=${JSON.stringify(fixture.password)};document.getElementById('service-connect-form').requestSubmit()`);
      await wait("window.desktop.getServiceState().then(s=>s.connected && s.account?.email===" + JSON.stringify(email) + ")");
    }
    async function report() {
      await api('selectLifecycleProject', 'lifecycle-film'); await api('refreshLifecycleReport');
      await wait("window.desktop.getAssetLifecycleState().then(s=>s.ready && !s.busy)"); return lifecycle();
    }
    async function plan(id) {
      const current = await lifecycle(); await api('selectLifecyclePlanAssets', { scopeId: current.scopeId, assetIds: [id] });
      const selected = await lifecycle(); await api('prepareLifecyclePlan', { scopeId: selected.scopeId });
      await wait("window.desktop.getAssetLifecycleState().then(s=>!!s.plan && !s.busy)"); return lifecycle();
    }
    await wait("window.desktop?.getAssetLifecycleState && document.getElementById('lifecycle-project')");
    if (stage === 'interrupted') await connect();
    else await wait("window.desktop.getServiceState().then(s=>s.connected)");
    await js("showView('history')");
    const observations = {}, layouts = [];
    if (stage === 'interrupted') {
      let state = await report(); assert.equal(state.report.schemaVersion, 2); assert.equal(state.report.referenceCoverage, 'complete');
      assert.equal(state.report.totalAssets, 3); assert.ok(state.items.find(item => item.assetId === assetIds.retained).retainedBy.includes(assetIds.retainedRevision));
      state = await plan(assetIds.retained); assert.equal(state.plan.ready, false); assert.equal(await js("document.getElementById('lifecycle-collect-review').disabled"), true);
      assert.ok(state.plan.items[0].blockers.includes('retained-revision'));
      state = await plan(assetIds.garbage); assert.equal(state.plan.ready, true);
      const before = requests; const refused = await api('executeLifecycleCollection', { scopeId: state.scopeId, planId: state.plan.planId, confirmed: false });
      assert.ok(refused.error); assert.equal(requests, before);
      await plan(assetIds.garbage);
      await click('lifecycle-collect-review'); await wait("!document.getElementById('lifecycle-mutation-review').hidden");
      await click('lifecycle-mutation-confirm'); await wait("window.desktop.getAssetLifecycleState().then(s=>!!s.pending && !s.busy)");
      state = await lifecycle(); assert.ok(state.pending); safe(state); Object.assign(observations, { authoritativeReport: true, retainedBlocked: true, confirmationRequired: true, committedAcknowledgmentLost: !loseAck });
    } else {
      await wait("!document.getElementById('lifecycle-retry').disabled"); await click('lifecycle-retry');
      await wait("window.desktop.getAssetLifecycleState().then(s=>!s.pending && !!s.receipt && !s.busy)");
      let state = await lifecycle(); assert.equal(state.receipt.deletionPerformed, true); safe(state);
      await api('selectLifecycleProject', 'lifecycle-film');
      await click('lifecycle-receipt-export'); await wait("!document.getElementById('lifecycle-export-save').disabled"); await click('lifecycle-export-save');
      await wait("document.getElementById('lifecycle-status').textContent.includes('export saved')");
      const artifact = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'reviewed-receipt.json'), 'utf8')); assert.equal(artifact.content.deletionPerformed, true); safe(artifact);
      await report(); state = await plan(assetIds.spare); assert.equal(state.plan.ready, true);
      await api('chooseProject'); await wait("window.desktop.getAppState().then(s=>s.scanStatus==='ready')");
      const saved = await api('saveRevision', 'Owner private first revision'); assert.equal(saved.revisionError, null);
      await api('bindServiceProject', { remoteProjectId: 'scan-history-film', remoteBranch: 'main' });
      const beforePrivacy = metadataWrites;
      assert.equal((await api('pushServiceRevisions')).error, 'publication-review-required'); assert.equal(metadataWrites, beforePrivacy);
      const staleHead = await api('previewServicePublication', { action: 'push' }); assert.ok(staleHead.reviewId);
      await api('saveRevision', 'Owner private second revision');
      assert.ok(['publication-review-stale', 'publication-review-required'].includes((await api('pushServiceRevisions', { reviewId: staleHead.reviewId, sha256: staleHead.sha256, confirmed: true })).error));
      assert.equal(metadataWrites, beforePrivacy);
      const staleAccount = await api('previewServicePublication', { action: 'push' }); assert.ok(staleAccount.reviewId);
      await js("window.FramePublicationReview.start('fcpxml')"); await wait("!document.getElementById('publication-consent').disabled");
      await js("document.getElementById('publication-consent').checked=true;document.getElementById('publication-consent').dispatchEvent(new Event('change'))");
      await connect(fixture.otherEmail);
      await wait("document.getElementById('publication-review').hidden && document.getElementById('publication-json').textContent==='' && !document.getElementById('publication-consent').checked");
      const wrongAccount = await api('pushServiceRevisions', { reviewId: staleAccount.reviewId, sha256: staleAccount.sha256, confirmed: true });
      assert.ok(wrongAccount.error); assert.equal(metadataWrites, beforePrivacy);
      await connect(); await api('checkServiceSync');
      async function review(kind) {
        const previewMethod = kind === 'resolve' ? 'previewResolvePublication' : 'previewServicePublication';
        // Independently reconstruct the exact paged document, then reopen the UI
        // review so the final approval references the currently displayed copy.
        const data = await api(previewMethod, { action: 'push' }); assert.ok(data.reviewId, JSON.stringify(data)); let text = data.text;
        for (let page = 1; page < data.pageCount; page++) text += (await api(kind === 'resolve' ? 'getResolvePublicationPage' : 'getServicePublicationPage', { reviewId: data.reviewId, page })).text;
        assert.equal(hash(text), data.sha256); assert.equal(Buffer.byteLength(text), data.byteLength);
        assert.equal(JSON.parse(text).mediaBytesIncluded, false); safe(JSON.parse(text));
        await js(`showView('history');window.FramePublicationReview.start(${JSON.stringify(kind)})`); await wait("!document.getElementById('publication-consent').disabled");
        assert.equal(await js("document.getElementById('publication-consent').checked"), false);
        assert.equal(await js("document.getElementById('publication-approve').disabled"), true);
        return { ...data, document: JSON.parse(text) };
      }
      function verifiedWire(reviewed, start) {
        const records = reviewed.document.publications.flatMap(publication => publication.revisions), writes = wireMetadata.slice(start);
        assert.ok(writes.some(write => write.route.endsWith('/manifests')) && writes.some(write => write.route.endsWith('/revisions')));
        for (const write of writes) {
          if (write.route.endsWith('/manifests')) assert.ok(records.some(record => require('node:util').isDeepStrictEqual(record.manifest, write.body.manifest)));
          else assert.ok(records.some(record => record.sourceRevisionId === write.body.sourceRevisionId && record.message === write.body.message));
        }
      }
      const reviewedScan = await review('fcpxml'), scanWireStart = wireMetadata.length;
      const beforeConsent = metadataWrites; await js("document.getElementById('publication-approve').click()"); assert.equal(metadataWrites, beforeConsent);
      await js("document.getElementById('publication-consent').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait("!document.getElementById('publication-approve').disabled"); await click('publication-approve');
      await wait("document.getElementById('publication-status').textContent.includes('publication finished')");
      assert.ok(metadataWrites > beforeConsent); assert.equal((await api('getServiceState')).sync.status, 'in-sync');
      verifiedWire(reviewedScan, scanWireStart); assert.equal(await js("document.getElementById('publication-json').textContent"), '');
      const scanWrites = metadataWrites;
      await api('selectResolveServiceProject', fixture.resolveProjectId);
      await api('bindResolveServiceProject', { remoteProjectId: 'resolve-history-film', remoteBranch: 'main' });
      assert.equal((await api('pushResolveServiceRevisions')).error, 'publication-review-required'); assert.equal(metadataWrites, scanWrites);
      const reviewedResolve = await review('resolve'), resolveWireStart = wireMetadata.length;
      await js("document.getElementById('publication-consent').checked=true;document.getElementById('publication-consent').dispatchEvent(new Event('change'))");
      await click('publication-approve'); await wait("document.getElementById('publication-status').textContent.includes('publication finished')");
      assert.ok(metadataWrites > scanWrites); assert.equal((await api('getResolveServiceState')).sync.status, 'in-sync');
      verifiedWire(reviewedResolve, resolveWireStart);
      await click('publication-cancel'); await api('saveRevision', 'Reviewable private third revision'); await review('fcpxml');
      Object.assign(observations, { publicationWithoutReviewRefused: true, staleHeadRefused: true, staleAccountRefused: true,
        exactPagedReviewHashVerified: true, exactReviewedWireMetadataVerified: true, privateReviewClearedOnAccountSwitch: true,
        unconfirmedPublicationRefused: true, keyboardConsent: true, fcpxmlPublishedViaHttps: true, savedResolvePublishedViaHttps: true });
      observations.lostAcknowledgmentRecovered = true; observations.receiptExported = true;
      win.webContents.debugger.attach('1.3');
      const nativeAx = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree'); win.webContents.debugger.detach();
      assert.ok(nativeAx.nodes.some(node=>node.role?.value==='checkbox' && node.name?.value?.includes('I approve sending this revision metadata')));
      assert.ok(nativeAx.nodes.some(node=>node.role?.value==='button' && node.name?.value==='Publish reviewed metadata'));
      observations.nativeAccessibilityLabelsVerified = true;
      for (const width of [390, 768, 1440]) {
        win.setContentSize(width, 1050); await paint();
        await js("document.getElementById('publication-review').scrollIntoView({block:'start'});window.scrollTo({left:0,top:scrollY})"); await paint();
        const layout = await js(`(()=>{const p=document.getElementById('publication-review'),r=p.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelWidth:r.width,consentLabel:document.getElementById('publication-consent').labels[0]?.textContent.trim(),approveText:document.getElementById('publication-approve').textContent.trim()}})()`);
        if (process.env.FRAMELINE_OWNER_LAYOUT_INSPECT) console.log('layout-publication '+JSON.stringify({ ...layout, diagnosis: await js(`({scrollX,bodyWidth:document.body.getBoundingClientRect().width,rootWidth:document.documentElement.getBoundingClientRect().width,elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().width>0&&(e.scrollWidth>e.clientWidth+2||e.getBoundingClientRect().right>innerWidth+1)).slice(-25).map(e=>({id:e.id,className:e.className,tag:e.tagName,right:e.getBoundingClientRect().right,left:e.getBoundingClientRect().left,width:e.getBoundingClientRect().width,client:e.clientWidth,scroll:e.scrollWidth,overflow:getComputedStyle(e).overflowX}))})`) }));
        assert.ok(layout.panelWidth > 250 && layout.panelWidth <= width); assert.ok(layout.consentLabel && layout.approveText);
        if (!process.env.FRAMELINE_OWNER_LAYOUT_INSPECT) await fs.writeFile(path.join(evidenceDirectory, `publication-${width}.png`), (await win.webContents.capturePage()).toPNG()); layouts.push(layout);
      }
      await click('publication-cancel'); await report(); await plan(assetIds.spare);
      for (const width of [390, 768, 1440]) {
        win.setContentSize(width, 1050); await paint(); await js("document.getElementById('lifecycle-plan').scrollIntoView({block:'start'})"); await paint();
        const layout = await js("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})"); layouts.push({kind:'collection',...layout});
        if (process.env.FRAMELINE_OWNER_LAYOUT_INSPECT) console.log('layout-collection '+JSON.stringify(layout));
        else await fs.writeFile(path.join(evidenceDirectory, `collection-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      assert.ok(layouts.every(layout=>layout.scrollWidth<=layout.width+1), JSON.stringify(layouts));
    }
    assert.deepEqual(errors, []); safe(await lifecycle());
    console.log(JSON.stringify({ stage, ...observations, requests, metadataWrites, layouts, rendererErrors: errors.length })); app.quit();
  }
}
