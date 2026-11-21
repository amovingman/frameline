'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const hostCli = path.resolve(__dirname, '../src/service-host-cli.js');
const adminCli = path.resolve(__dirname, '../src/service-admin-cli.js');
const fixtureTls = path.resolve(__dirname, '../tests/fixtures/network-tls');
function fail(code) { return Object.assign(new Error(code), { code }); }
function environment(trustFixtureCa = false) {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
  if (trustFixtureCa) env.NODE_EXTRA_CA_CERTS = path.join(fixtureTls, 'ca.pem');
  return env;
}
// Actual HTTPS metadata; copied observation fixtures are protocol evidence, not live editor provenance.
const clientScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createHash, randomBytes } = require('node:crypto');
  const { createRevisionHttpClient } = require('./src/revision-http-client');
  const { createLocalMetadataStore } = require('./src/local-metadata');
  const { createResolveObservationManifest } = require('./src/resolve-revision-manifest');
  const { createResolvePreviewPlan, verifyResolvePreviewPlan } = require('./src/resolve-preview-plan');
  const { createResolveReviewSession } = require('./src/resolve-review-session');
  const { createDesktopResolveServiceSync } = require('./src/desktop-resolve-service-sync');
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    const wrappers = [];
    try {
      const config = JSON.parse(input); let requests = 0;
      const send = (...args) => { requests++; return globalThis.fetch(...args); };
      function client(session) { return createRevisionHttpClient({ origin: config.origin, getAccessToken: () => session?.accessToken || null, fetch: send }); }
      let ownerSession = config.ownerSession, viewerSession = config.viewerSession;
      if (!ownerSession) { ownerSession = await client(null).signIn(config.ownerEmail, config.password); viewerSession = await client(null).signIn(config.viewerEmail, config.password); }
      const owner = client(ownerSession), viewer = client(viewerSession);
      const base = JSON.parse(await fs.readFile(path.resolve('phase-0/resolve-xml-proof/live-properties-enabled.json'), 'utf8'));
      const pan = (value, decimal) => { const copy = structuredClone(value); copy.items[0].properties.Pan.decimal = decimal; return copy; };
      const incomingObservation = pan(base, '1.3250000000000000e+01');
      const localObservation = pan(base, '2.6500000000000000e+01');
      localObservation.items[0].properties.Tilt.decimal = '5.0000000000000000e+00';
      const baseManifest = createResolveObservationManifest(base), incomingManifest = createResolveObservationManifest(incomingObservation),
        localManifest = createResolveObservationManifest(localObservation);
      assert.equal(baseManifest.snapshotHash, incomingManifest.snapshotHash);
      assert.notEqual(baseManifest.sourceHash, incomingManifest.sourceHash);
      const ownerStore = createLocalMetadataStore(config.ownerLocalDirectory), viewerStore = createLocalMetadataStore(config.viewerLocalDirectory);
      let localId = config.localId, baseId = config.baseId, remoteChildId = config.remoteChildId;
      if (config.phase === 'initial') {
        localId = (await ownerStore.getResolveProjectId(base.snapshot.project_id, base.snapshot.project_name)).id;
        baseId = (await ownerStore.saveRevision(localId, baseManifest, 'Shared complete observation')).id;
        await ownerStore.recordSyncBase(localId, 'main', baseId, baseId);
        await fs.cp(config.ownerLocalDirectory, config.viewerLocalDirectory, { recursive: true });
      }
      const state = (id, email, role) => ({ version: 1, status: 'connected', connected: true, busy: false, origin: config.origin,
        account: { id, email }, projects: [{ id: config.projectId, name: 'Disposable Resolve service preview', role, branches: ['main'] }], error: null });
      const ownerState = state(config.ownerId, config.ownerEmail, 'owner'), viewerState = state(config.viewerId, config.viewerEmail, 'viewer');
      let receipt = { mode: 'verified-capture', generation: 1, requestId: randomBytes(16).toString('hex'),
        requestSha256: randomBytes(32).toString('hex'), acceptedAt: Date.now() };
      let captureManifest = localManifest, invalidations = 0;
      const create = (directory, store, state, remote) => {
        const wrapper = createDesktopResolveServiceSync({ directory, store,
          connection: { getState: () => structuredClone(state), getClient: () => remote },
          getCapture: () => ({ manifest: structuredClone(captureManifest), verification: structuredClone(receipt) }),
          onInvalidate: () => { invalidations++; } });
        wrappers.push(wrapper); return wrapper;
      };
      const publisher = create(config.ownerControllerDirectory, ownerStore, ownerState, owner),
        reader = create(config.viewerControllerDirectory, viewerStore, viewerState, viewer);
      await publisher.select(localId); await reader.select(localId);
      const noNetworkBeforeState = requests;
      const restored = await reader.getState(); assert.equal(requests, noNetworkBeforeState);
      if (config.phase === 'initial') {
        assert.equal((await owner.getAccount()).id, config.ownerId); assert.equal((await viewer.getAccount()).id, config.viewerId);
        assert.equal((await owner.listProjects()).projects[0].role, 'owner'); assert.equal((await viewer.listProjects()).projects[0].role, 'viewer');
        await publisher.bind({ remoteProjectId: config.projectId, remoteBranch: 'main' });
        assert.equal((await publisher.push()).error, null);
        await reader.bind({ remoteProjectId: config.projectId, remoteBranch: 'main' });
        const child = await ownerStore.saveRevision(localId, incomingManifest, 'Property-only incoming Pan', baseId);
        await publisher.select(localId);
        const pushed = await publisher.push(); assert.equal(pushed.error, null);
        remoteChildId = (await owner.getBranch(config.projectId, 'main')).revisionId;
        assert.equal((await owner.getRevision(config.projectId, remoteChildId)).sourceRevisionId, child.id);
        const fetched = await reader.fetch(); assert.equal(fetched.error, null); assert.equal(fetched.fetched.total, 2);
        assert.equal(fetched.base.localRevisionId, baseId);
      } else {
        assert.equal(config.phase, 'restarted'); assert.equal(noNetworkBeforeState, 0);
        assert.equal(restored.fetched.total, 2); assert.equal(restored.base.localRevisionId, baseId);
        assert.equal(restored.comparison.status, 'none');
      }
      async function snapshotFiles() {
        const result = [];
        async function read(directory, prefix) {
          for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, item.name), key = prefix + '/' + item.name;
            if (item.isDirectory()) await read(filename, key);
            else if (item.name !== 'metadata.lock') result.push([key, createHash('sha256').update(await fs.readFile(filename)).digest('hex')]);
          }
        }
        await read(config.viewerLocalDirectory, 'local'); await read(config.viewerControllerDirectory, 'controller'); return result;
      }
      async function preview(source) {
        const files = await snapshotFiles(), before = requests;
        const state = await reader.preview({ source }); assert.equal(state.error, null); assert.equal(state.comparison.status, 'ready');
        assert.equal(requests, before); assert.deepEqual(await snapshotFiles(), files);
        const value = await reader.getPreview(); assert(value); assert.equal(value.readOnly, true); assert.equal(value.safeToApply, false);
        assert.equal(value.binding.scope.accountId, config.viewerId); assert.equal(value.binding.scope.remoteProjectId, config.projectId);
        assert.equal(value.binding.baseLocalRevisionId, baseId); assert.equal(value.binding.incomingRevisionId, remoteChildId);
        assert.equal(verifyResolvePreviewPlan(value.plan, value.sources).valid, true);
        assert.deepEqual(value.plan, createResolvePreviewPlan(value.sources));
        assert.deepEqual(await reader.readPreviewSources(value.binding), value.sources);
        assert.equal(requests, before); assert.deepEqual(await snapshotFiles(), files);
        const summary = state.comparison.result;
        for (const forbidden of ['sources', 'plan', 'originHash', 'proofHash', 'recordHash', 'accessToken']) assert(!JSON.stringify(summary).includes(forbidden));
        return value;
      }
      const saved = await preview('saved-head');
      assert.equal(saved.plan.classification.decisions.length, 1);
      assert.equal(saved.plan.classification.decisions[0].field, 'properties.Pan');
      assert.equal(saved.plan.classification.decisions[0].status, 'incoming-only');
      assert.equal(JSON.parse(saved.sources.local).schemaVersion, 2);
      assert.deepEqual(JSON.parse(saved.sources.incoming), incomingObservation);
      assert.equal(saved.binding.localVerification.mode, 'saved-head');
      const captured = await preview('verified-capture');
      assert.equal(captured.binding.localVerification.mode, 'verified-capture');
      const decisions = captured.plan.classification.decisions;
      assert.equal(decisions.find(item => item.field === 'properties.Pan').status, 'conflict');
      assert.equal(decisions.find(item => item.field === 'properties.Tilt').status, 'local-only');
      assert.equal(captured.plan.classification.observationCoverage.gaps.length, 0);
      assert.equal(captured.plan.schemaVersion, 2);
      const review = createResolveReviewSession({ artifactDirectory: path.join(config.viewerControllerDirectory, 'reviews') });
      const reviewed = review.load(captured.sources, { sourceMode: 'service-history' });
      assert.equal(reviewed.status, 'ready'); assert.equal(reviewed.sourceMode, 'service-history');
      const complete = review.setDecision(reviewed.review.conflicts[0].id, 'keep-local'); assert(complete.audit);
      assert.throws(() => review.getVerifiedReview(captured.sources), /service-review-read-only/);
      for (const altered of [
        { ...captured.binding, scope: { ...captured.binding.scope, accountId: config.ownerId } },
        { ...captured.binding, baseVersion: captured.binding.baseVersion + 1 },
        { ...captured.binding, incomingRevisionId: captured.binding.baseRemoteRevisionId }
      ]) await assert.rejects(reader.readPreviewSources(altered), { code: 'service-resolve-preview-stale' });
      // Substituting a receipt generation or observed bytes cannot reuse a binding.
      receipt = { ...receipt, generation: receipt.generation + 1, requestId: randomBytes(16).toString('hex'), acceptedAt: Date.now() };
      await assert.rejects(reader.readPreviewSources(captured.binding), { code: 'service-resolve-preview-stale' });
      const renewed = await preview('verified-capture');
      captureManifest = createResolveObservationManifest(pan(localObservation, '3.9750000000000000e+01'));
      await assert.rejects(reader.readPreviewSources(renewed.binding), { code: 'service-resolve-preview-stale' });
      captureManifest = localManifest;
      receipt = { ...receipt, acceptedAt: Date.now() - 300001 };
      const expired = await reader.preview({ source: 'verified-capture' });
      assert.equal(expired.error, 'service-resolve-comparison-capture-expired'); assert.equal(expired.comparison.result, null);
      receipt = { ...receipt, acceptedAt: Date.now() + 60000 };
      const future = await reader.preview({ source: 'verified-capture' });
      assert.equal(future.error, 'service-resolve-comparison-capture-expired'); assert.equal(future.comparison.result, null);
      receipt = { ...receipt, generation: receipt.generation + 1, acceptedAt: Date.now() };
      const final = await preview('verified-capture');
      const denied = await reader.push(); assert.equal(denied.error, 'service-viewer-read-only');
      await reader.select(null);
      await assert.rejects(reader.readPreviewSources(final.binding), { code: 'service-resolve-preview-stale' });
      const activity = await owner.listActivity(config.projectId, { limit: 100 });
      assert(!activity.items.some(event => event.type === 'pull.completed'));
      assert.equal((await viewerStore.exportRevisions(localId)).records.length, 1);
      assert.equal((await ownerStore.exportRevisions(localId)).records.length, 2);
      assert.equal(await viewerStore.getSyncBase(localId, 'main'), baseId);
      for (const wrapper of wrappers) await wrapper.dispose();
      process.send({ type: 'result', data: { ownerSession, viewerSession, requests, localId, baseId, remoteChildId,
        invalidations, propertyOnlyIncoming: true, savedHeadPreview: true, captureConflict: true,
        generationSubstitutionRefused: true, observationSubstitutionRefused: true, expiredCaptureRefused: true } }, () => process.disconnect());
    } catch (error) {
      for (const wrapper of wrappers) await wrapper.dispose().catch(() => {});
      const line = /\[eval\]:(\d+):\d+/.exec(error.stack || '')?.[1];
      if (process.connected) process.send({ type: 'failure', data: { code: /^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'assertion-failed', line: line ? Number(line) : null } });
      process.stderr.write('service-resolve-preview-client-proof-failed\n'); process.exitCode = 1; if (process.connected) process.disconnect();
    }
  });
`;

async function runServiceResolvePreviewProof({ processTimeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(processTimeoutMs) || processTimeoutMs < 1000 || processTimeoutMs > 120000) throw fail('service-host-proof-timeout-invalid');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-service-resolve-preview-proof-'));
  const dataDirectory = path.join(directory, 'data'), configPath = path.join(directory, 'config.json');
  const certFile = path.join(directory, 'test-only-server.pem'), keyFile = path.join(directory, 'test-only-server-key.pem');
  const encryptionKey = randomBytes(32).toString('base64'), password = 'disposable host fixture password';
  const ownerEmail = 'operator-owner@disposable.example.test', viewerEmail = 'operator-viewer@disposable.example.test';
  const privateValues = [directory, configPath, encryptionKey, Buffer.from(encryptionKey, 'base64').toString('hex'), password];
  const receiptSecrets = [...privateValues, ownerEmail, viewerEmail];
  const children = [], hostProcesses = [];
  let port;
  function assertPrivateLogs(record) {
    for (const value of privateValues) assert(!(record.stdout + record.stderr).includes(value), 'Process log must omit private paths and credentials');
    assert(!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(record.stdout + record.stderr));
  }
  function start(args, { ipc = false, trust = false } = {}) {
    for (const secret of privateValues.filter(value => value !== directory && value !== configPath)) {
      assert(!args.some(arg => String(arg).includes(secret)), 'Credentials must not appear in process arguments');
    }
    const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, '..'), env: environment(trust),
      stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    const record = { child, stdout: '', stderr: '', terminal: false, exit: null }; children.push(record);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { record.stdout += chunk; if (Buffer.byteLength(record.stdout) > 128 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { record.stderr += chunk; if (Buffer.byteLength(record.stderr) > 128 * 1024) child.kill('SIGKILL'); });
    child.stdin.on('error', () => {});
    record.closed = new Promise(resolve => {
      child.once('error', () => {});
      child.once('close', (code, signal) => { record.terminal = true; record.exit = { code, signal }; resolve(record.exit); });
    });
    return record;
  }
  async function waitForExit(record, timeoutMs = processTimeoutMs) {
    let timer;
    try {
      await Promise.race([record.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('service-host-proof-process-timeout')), timeoutMs);
      })]);
    } catch (error) {
      if (!record.terminal) record.child.kill('SIGKILL');
      await record.closed; throw error;
    } finally { clearTimeout(timer); }
    assertPrivateLogs(record); return record;
  }
  async function command(args, input) {
    assert(hostProcesses.every(record => record.terminal), 'Administrative commands run only while this proof host is stopped');
    const record = start(args); record.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    return waitForExit(record);
  }
  function hostEvents(record) {
    return record.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async function launchHost() {
    assert(children.every(record => record.terminal), 'Every prior owned subprocess must be terminal before host launch');
    const record = start([hostCli, 'serve', '--config', configPath]); hostProcesses.push(record); record.child.stdin.end();
    let timer;
    const ready = new Promise((resolve, reject) => {
      const inspect = () => {
        for (const line of record.stdout.split('\n').slice(0, -1)) {
          let value; try { value = JSON.parse(line); } catch { reject(fail('service-host-proof-invalid-ready')); return; }
          if (value.event === 'service-ready') { resolve(value); return; }
        }
      };
      record.child.stdout.on('data', inspect);
      record.child.once('close', () => reject(fail('service-host-proof-start-failed')));
      timer = setTimeout(() => reject(fail('service-host-proof-start-timeout')), 10000); inspect();
    });
    try {
      const value = await ready;
      assert.equal(value.address.address, '127.0.0.1'); assert.equal(value.address.port, port);
      assertPrivateLogs(record); return record;
    } finally { clearTimeout(timer); }
  }
  async function stopHost(record) {
    if (record.terminal) return;
    record.child.kill('SIGTERM'); await waitForExit(record);
    assert.equal(record.exit.code, 0); assert.equal(record.exit.signal, null);
    assert.deepEqual(hostEvents(record).map(event => event.event), ['service-ready', 'service-stopped']);
  }
  async function runClient(input) {
    const record = start(['-e', clientScript], { ipc: true, trust: true });
    let result = null, failure;
    record.child.on('message', message => { if (message?.type === 'result') result = message.data;
      if (message?.type === 'failure') failure = message.data; });
    record.child.stdin.end(JSON.stringify(input)); await waitForExit(record);
    assert.equal(record.exit.code, 0, `Actual HTTPS client must finish ${input.phase}: ${failure?.code || 'unknown'} at worker line ${failure?.line || 'unknown'}`);
    assert(result); assert.equal(record.stdout, '');
    for (const session of [result.ownerSession, result.viewerSession]) {
      privateValues.push(session.accessToken, session.refreshToken); receiptSecrets.push(session.accessToken, session.refreshToken);
    }
    return result;
  }
  async function assertStatePrivate() {
    const filename = path.join(dataDirectory, 'collaboration.enc.json'), bytes = await fs.readFile(filename);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(dataDirectory)).mode & 0o777, 0o700);
    for (const value of [...privateValues, ownerEmail, viewerEmail]) assert(!bytes.includes(Buffer.from(value)), 'Service state must not contain plaintext credentials');
    assert.equal(JSON.parse(bytes).record.algorithm, 'aes-256-gcm'); return bytes;
  }
  try {
    // Reserve a disposable numeric-loopback port without hard-coding a shared
    // port; the production CLI intentionally does not accept ephemeral port0.
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    await fs.copyFile(path.join(fixtureTls, 'server.pem'), certFile); await fs.chmod(certFile, 0o644);
    await fs.copyFile(path.join(fixtureTls, 'server-key.pem'), keyFile); await fs.chmod(keyFile, 0o600);
    const config = { schemaVersion: 1, directory: dataDirectory, host: '127.0.0.1', port,
      tls: { certFile, keyFile }, keyring: { activeKeyId: 'proof', keys: { proof: encryptionKey } } };
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const missing = await command([hostCli, 'serve', '--config', configPath]);
    assert.equal(missing.exit.code, 1); assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /^\{"event":"service-error","code":"[a-z0-9-]+"\}\n$/);
    await assert.rejects(fs.access(path.join(dataDirectory, 'collaboration.enc.json')), { code: 'ENOENT' });
    await fs.chmod(configPath, 0o644);
    const publicConfig = await command([hostCli, 'initialize', '--config', configPath]);
    assert.equal(publicConfig.exit.code, 1); assert.equal(publicConfig.stdout, '');
    await fs.chmod(configPath, 0o600);
    const initialized = await command([hostCli, 'initialize', '--config', configPath]);
    assert.equal(initialized.exit.code, 0); assert.deepEqual(hostEvents(initialized), [{ event: 'service-initialized' }]);
    await fs.chmod(keyFile, 0o644);
    const publicKey = await command([hostCli, 'serve', '--config', configPath]);
    assert.equal(publicKey.exit.code, 1); assert.equal(publicKey.stdout, ''); await fs.chmod(keyFile, 0o600);
    const admin = async input => {
      const result = await command([adminCli, '--config', configPath], input);
      assert.equal(result.exit.code, 0, 'Private stdin-only administration must succeed'); assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };
    const owner = await admin({ action: 'account-create', email: ownerEmail, password });
    const viewer = await admin({ action: 'account-create', email: viewerEmail, password });
    const projectId = 'resolve-preview-proof-film';
    const project = await admin({ action: 'project-create', email: ownerEmail, password,
      projectId, name: 'Disposable comparison film', teamName: 'Disposable comparison team' });
    assert.equal(project.ownerId, owner.id);
    await admin({ action: 'member-add', ownerEmail, ownerPassword: password, memberEmail: viewerEmail, memberPassword: password, projectId, role: 'viewer' });
    await assertStatePrivate();
    const ownerLocalDirectory = path.join(directory, 'owner-local'), viewerLocalDirectory = path.join(directory, 'viewer-local');
    const ownerControllerDirectory = path.join(directory, 'owner-controller'), viewerControllerDirectory = path.join(directory, 'viewer-controller');
    const input = { phase: 'initial', origin: `https://127.0.0.1:${port}`, ownerEmail, viewerEmail,
      password, projectId, ownerId: owner.id, viewerId: viewer.id, ownerLocalDirectory, viewerLocalDirectory,
      ownerControllerDirectory, viewerControllerDirectory };
    const firstHost = await launchHost(), first = await runClient(input); await stopHost(firstHost); await assertStatePrivate();
    const secondHost = await launchHost(), second = await runClient({ ...input, ...first, phase: 'restarted' });
    await stopHost(secondHost); await assertStatePrivate();
    let privateFileCount = 0;
    async function inspectPrivateFiles(target) {
      for (const item of await fs.readdir(target, { withFileTypes: true })) {
        const filename = path.join(target, item.name), stat = await fs.lstat(filename); assert(!stat.isSymbolicLink());
        if (item.isDirectory()) { assert.equal(stat.mode & 0o777, 0o700); await inspectPrivateFiles(filename); }
        else {
          assert(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600); privateFileCount++;
          const bytes = await fs.readFile(filename);
          for (const secret of [...privateValues.filter(value => value !== directory && value !== configPath), ownerEmail, viewerEmail]) assert(!bytes.includes(Buffer.from(secret)));
        }
      }
    }
    for (const target of [ownerLocalDirectory, viewerLocalDirectory, ownerControllerDirectory, viewerControllerDirectory]) await inspectPrivateFiles(target);
    assert(children.every(record => record.terminal)); for (const record of children) assertPrivateLogs(record);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(),
      scope: 'Disposable real HTTPS Resolve history preview and source provenance proof', transport: 'https-numeric-loopback-test-ca',
      authorizedAccounts: 2, hostProcesses: hostProcesses.length, clientControllerProcesses: 2,
      networkRequests: first.requests + second.requests, manifestVersion: 3, copiedFixtureObservationOnly: true,
      privateFileCount, privateFilesMode: '0600',
      publisherRevisionCount: 2, viewerRevisionCount: 1, mediaFetched: false, editorWrites: false, revisionsImported: false,
      liveEditorProvenance: false, safeToApply: false,
      propertyOnlyIncomingRetainedCompleteObservation: true, savedHeadIncomingPanPreview: true,
      capturePanConflictAndIndependentTilt: true, completePlanRecomputedFromExactRoleSources: true,
      previewAndSourceRecheckDispatchNoNetwork: true, previewAndSourceRecheckDoNotMutatePrivateFiles: true,
      scopeBaseIncomingSubstitutionRefused: true, captureGenerationSubstitutionRefused: true,
      changedObservationSubstitutionRefused: true, expiredAndFutureCapturesRefused: true,
      viewerPushDenied: true, selectionChangeRetiresPreview: true, legacyBaseUnchanged: true,
      completeServiceReviewCannotAuthorizeRenameDrill: true,
      cachedHistoryAndBaseRecoveredAfterRestart: true, previewNotAutomaticallyRestored: true, noPullCompletedEvent: true,
      publicStateOmitsPrivateSourcesAndProofHashes: true,
      gracefulSigtermExit: true, priorSubprocessesTerminalBeforeRelaunch: true, allOwnedSubprocessesTerminated: true,
      limits: ['Complete Resolve observation fixtures use one original API project ID; cross-project collaborator identity is not established.',
        'Capture receipts exercise the disposable request protocol and freshness guards, not live editor authenticity.',
        'The test CA is trusted only in isolated workers; production hosting, native UI, editor writes, and power-loss recovery are separate checks.'] };
    for (const secret of receiptSecrets) assert(!JSON.stringify(receipt).includes(secret), 'Proof receipt must omit secrets and private paths');
    return receipt;
  } finally {
    try {
      for (const record of children) {
        if (!record.terminal) {
          record.child.kill('SIGTERM');
          try { await waitForExit(record); } catch { /* waitForExit terminates and reaps the owned child on timeout. */ }
        }
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}
if (require.main === module) runServiceResolvePreviewProof().then(async receipt => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 });
  else process.stdout.write(output);
}).catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'service-resolve-preview-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runServiceResolvePreviewProof };
