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
// A fresh worker uses default TLS verification and real controller/local metadata.
// Private fixture paths and sessions arrive on stdin/IPC, never stdout.
const clientScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { createRevisionHttpClient } = require('./src/revision-http-client');
  const { createDesktopRevisionSync } = require('./src/desktop-revision-sync');
  const { createLocalMetadataStore } = require('./src/local-metadata');
  const { fingerprint } = require('./src/project-api-contracts');
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    const controllers = [];
    try {
      const config = JSON.parse(input); let requests = 0, discard = false, discarded = 0;
      const send = async (...args) => {
        requests++; const response = await globalThis.fetch(...args);
        if (discard && args[1]?.method === 'PUT' && new URL(args[0]).pathname.endsWith('/branches/main') && response.status === 200) {
          discard = false; discarded++; await response.arrayBuffer();
          throw Object.assign(new Error('deliberately discarded successful acknowledgment'), { code: 'ECONNRESET' });
        }
        return response;
      };
      function client(session) { return createRevisionHttpClient({ origin: config.origin, getAccessToken: () => session?.accessToken || null, fetch: send }); }
      let ownerSession = config.ownerSession, viewerSession = config.viewerSession;
      if (config.phase === 'initial') {
        ownerSession = await client(null).signIn(config.ownerEmail, config.password);
        viewerSession = await client(null).signIn(config.viewerEmail, config.password);
      }
      const owner = client(ownerSession), viewer = client(viewerSession);
      const store = createLocalMetadataStore(config.localDirectory);
      const manifest = index => ({ schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
        sourceHash: createHash('sha256').update('Shared base synthetic revision ' + index).digest('hex'),
        sequence: { name: 'Disposable shared sequence', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] });
      let localId = config.localId, firstId = config.firstId, secondId = config.secondId, thirdId = config.thirdId;
      if (config.phase === 'initial') {
        localId = (await store.getProjectId(path.join(config.localDirectory, 'disposable.fcpxml'))).id;
        firstId = (await store.saveRevision(localId, manifest(1), 'First disposable cut')).id;
        secondId = (await store.saveRevision(localId, manifest(2), 'Second disposable cut', firstId)).id;
        await store.recordSyncBase(localId, 'main', firstId, secondId);
      }
      const scope = accountId => ({ originHash: fingerprint(config.origin), accountId, localProjectId: localId,
        localBranch: 'main', remoteProjectId: config.projectId, remoteBranch: 'main' });
      const accountState = (id, email, role) => ({ version: 1, status: 'connected', connected: true, busy: false, origin: config.origin,
        account: { id, email }, projects: [{ id: config.projectId, name: 'Disposable shared-base film', role, branches: ['main'] }], error: null });
      function controller(remote, state) {
        const value = createDesktopRevisionSync({ directory: config.controllerDirectory, store,
          connection: { getState: () => structuredClone(state), getClient: () => remote },
          getSelection: () => ({ localProjectId: localId, branch: 'main' }) });
        controllers.push(value); value.connectionChanged(); return value;
      }
      const ownerController = controller(owner, accountState(config.ownerId, config.ownerEmail, 'owner'));
      const viewerController = controller(viewer, accountState(config.viewerId, config.viewerEmail, 'viewer'));
      const before = requests, restored = await ownerController.getState(), viewerRestored = await viewerController.getState();
      assert.equal(requests, before, 'Opening controller state must perform no network requests');
      let lostAckQueued = false, restoredWithoutNetwork = config.phase !== 'initial', remoteAheadPreserved = false;
      if (config.phase === 'initial') {
        assert.equal(restored.base.status, 'none'); assert.equal(viewerRestored.base.status, 'none');
        assert.equal((await owner.getAccount()).id, config.ownerId);
        assert.equal((await viewer.getAccount()).id, config.viewerId);
        assert.equal((await owner.listProjects()).projects[0].role, 'owner');
        assert.equal((await viewer.listProjects()).projects[0].role, 'viewer');
        const linked = await ownerController.bind({ remoteProjectId: config.projectId, remoteBranch: 'main' });
        assert.equal(linked.sync.status, 'local-ahead');
        const pushed = await ownerController.push(); assert.equal(pushed.error, null); assert.equal(pushed.base.status, 'recorded');
        assert.equal(pushed.base.localRevisionId, secondId); assert.equal(pushed.fetched, null);
        assert.equal((await ownerController.fetch()).fetched.total, 2);
        const viewed = await viewerController.bind({ remoteProjectId: config.projectId, remoteBranch: 'main' });
        assert.equal(viewed.base.status, 'recorded'); assert.equal(viewed.base.localRevisionId, secondId); assert.equal(viewed.fetched, null);
        const ownerBase = await store.getServiceSyncBase(scope(config.ownerId)), viewerBase = await store.getServiceSyncBase(scope(config.viewerId));
        assert.equal(ownerBase.remoteAuthorId, config.ownerId); assert.equal(viewerBase.remoteAuthorId, config.ownerId);
        assert.notEqual(ownerBase.proofHash, viewerBase.proofHash); assert.notDeepEqual(ownerBase.scope, viewerBase.scope);
        const viewerPush = await viewerController.push(); assert.equal(viewerPush.error, 'service-viewer-read-only');
      } else {
        assert.equal(before, 0); assert.equal(restored.base.status, 'recorded'); assert.equal(restored.base.localRevisionId, secondId);
        assert.equal(viewerRestored.base.localRevisionId, secondId); assert.equal(restored.fetched.total, 2);
        if (config.phase === 'lost-ack') {
          assert.deepEqual(restored.operations, []);
          thirdId = (await store.saveRevision(localId, manifest(3), 'Third disposable cut', secondId)).id;
          discard = true; const failed = await ownerController.push();
          assert.equal(discarded, 1); assert.equal(failed.operations.length, 1); assert.equal(failed.operations[0].status, 'retry-wait');
          assert.equal(failed.base.localRevisionId, secondId); assert.equal(failed.fetched.total, 2);
          assert.equal((await store.getServiceSyncBase(scope(config.ownerId))).localRevisionId, secondId);
          const actual = await owner.getBranch(config.projectId, 'main');
          assert.equal((await owner.getRevision(config.projectId, actual.revisionId)).sourceRevisionId, thirdId);
          lostAckQueued = true;
        } else {
          assert.equal(config.phase, 'repair'); assert.equal(restored.operations.length, 1); assert.equal(restored.operations[0].status, 'retry-wait');
          const repaired = await ownerController.retry(restored.operations[0].id);
          assert.equal(repaired.error, null); assert.deepEqual(repaired.operations, []); assert.equal(repaired.base.localRevisionId, thirdId);
          assert.equal(repaired.sync.status, 'in-sync'); assert.equal(repaired.fetched.total, 2);
          const checked = await ownerController.check(); assert.equal(checked.base.localRevisionId, thirdId); assert.equal(checked.fetched.total, 2);
          const viewerChecked = await viewerController.check(); assert.equal(viewerChecked.base.localRevisionId, thirdId);
          assert.equal((await store.getServiceSyncBase(scope(config.viewerId))).remoteAuthorId, config.ownerId);
          const thirdHead = (await owner.getBranch(config.projectId, 'main')).revisionId;
          const saved = await owner.putManifest(config.projectId, manifest(4));
          const fourth = await owner.createRevision({ projectId: config.projectId, manifestId: saved.id, parentRevisionId: thirdHead,
            sourceRevisionId: 'service-only-fourth', message: 'Service-only fourth cut', idempotencyKey: 'shared-proof-fourth' });
          await owner.compareAndSwapBranch({ projectId: config.projectId, branch: 'main', expectedRevisionId: thirdHead,
            revisionId: fourth.id, idempotencyKey: 'shared-proof-fourth-head' });
          const snapshot = await store.exportRevisions(localId), fetched = await viewerController.fetch();
          assert.equal(fetched.error, null); assert.equal(fetched.fetched.total, 4); assert.equal(fetched.sync.status, 'remote-ahead');
          assert.equal(fetched.base.localRevisionId, thirdId); assert.equal(fetched.base.remoteRevisionId, thirdHead);
          assert.deepEqual(await store.exportRevisions(localId), snapshot); remoteAheadPreserved = true;
          const remote = await owner.getBranch(config.projectId, 'main');
          let id = remote.revisionId, count = 0, sources = new Set();
          while (id) { const revision = await owner.getRevision(config.projectId, id); count++; assert(!sources.has(revision.sourceRevisionId));
            sources.add(revision.sourceRevisionId); id = revision.parentRevisionId; }
          assert.equal(count, 4); assert(sources.has(thirdId));
        }
      }
      assert.equal(await store.getSyncBase(localId, 'main'), firstId);
      const local = await store.exportRevisions(localId); assert.equal(local.records.length, config.phase === 'initial' ? 2 : 3);
      const final = await ownerController.getState();
      const publicState = JSON.stringify(final);
      for (const forbidden of [config.localDirectory, config.controllerDirectory, ownerSession.accessToken, viewerSession.accessToken,
        'originHash', 'proofSnapshotHash', 'recordHash', 'proofHash', 'remoteAuthorId']) assert(!publicState.includes(forbidden));
      for (const value of controllers) await value.dispose();
      process.send({ type: 'result', data: { ownerSession, viewerSession, requests, localId, firstId, secondId, thirdId,
        discarded, lostAckQueued, restoredWithoutNetwork, remoteAheadPreserved } }, () => process.disconnect());
    } catch (error) {
      for (const controller of controllers) await controller.dispose().catch(() => {});
      const line = /\[eval\]:(\d+):\d+/.exec(error.stack || '')?.[1];
      if (process.connected) process.send({ type: 'failure', data: { code: /^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'assertion-failed', line: line ? Number(line) : null } });
      process.stderr.write('service-shared-base-client-proof-failed\n'); process.exitCode = 1; if (process.connected) process.disconnect();
    }
  });
`;

async function runServiceSharedBaseProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-service-shared-base-proof-'));
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
  async function waitForExit(record, timeoutMs = 15000) {
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
    const projectId = 'operator-proof-film';
    const project = await admin({ action: 'project-create', email: ownerEmail, password,
      projectId, name: 'Disposable operator film', teamName: 'Disposable operator team' });
    assert.equal(project.ownerId, owner.id);
    const membership = await admin({ action: 'member-add', ownerEmail, ownerPassword: password,
      memberEmail: viewerEmail, memberPassword: password, projectId, role: 'viewer' });
    assert.equal(membership.userId, viewer.id); assert.equal(membership.role, 'viewer');
    await assertStatePrivate();
    const localDirectory = path.join(directory, 'local-metadata'), controllerDirectory = path.join(directory, 'desktop-service');
    const input = { phase: 'initial', origin: `https://127.0.0.1:${port}`, ownerEmail, viewerEmail,
      password, projectId, ownerId: owner.id, viewerId: viewer.id, localDirectory, controllerDirectory };
    const firstHost = await launchHost(), first = await runClient(input); await stopHost(firstHost);
    await assertStatePrivate();
    const secondHost = await launchHost(), second = await runClient({ ...input, ...first, phase: 'lost-ack' });
    await stopHost(secondHost); await assertStatePrivate();
    const thirdHost = await launchHost(), third = await runClient({ ...input, ...second, phase: 'repair' });
    await stopHost(thirdHost); await assertStatePrivate();
    assert(second.lostAckQueued); assert.equal(second.discarded, 1); assert(third.restoredWithoutNetwork); assert(third.remoteAheadPreserved);
    let privateFileCount = 0, proofSnapshots = 0;
    async function inspectPrivateFiles(target) {
      for (const item of await fs.readdir(target, { withFileTypes: true })) {
        const filename = path.join(target, item.name), stat = await fs.lstat(filename);
        assert(!stat.isSymbolicLink());
        if (item.isDirectory()) { assert.equal(stat.mode & 0o777, 0o700); await inspectPrivateFiles(filename); }
        else {
          assert(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600); privateFileCount++;
          if (filename.includes(`${path.sep}snapshots${path.sep}`)) proofSnapshots++;
          const bytes = await fs.readFile(filename);
          for (const secret of [...privateValues.filter(value => value !== directory && value !== configPath), ownerEmail, viewerEmail]) {
            assert(!bytes.includes(Buffer.from(secret)), 'Local files must omit service credentials');
          }
        }
      }
    }
    await inspectPrivateFiles(localDirectory); await inspectPrivateFiles(controllerDirectory);
    assert(proofSnapshots >= 4); assert(privateFileCount >= 10);
    const metadata = JSON.parse(await fs.readFile(path.join(localDirectory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.schemaVersion, 5);
    assert(children.every(record => record.terminal));
    for (const record of children) assertPrivateLogs(record);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(),
      scope: 'Disposable HTTPS shared-base controller and local metadata process proof', transport: 'https-numeric-loopback-test-ca',
      authorizedAccounts: 2, hostProcesses: hostProcesses.length, clientControllerProcesses: 3,
      networkRequests: first.requests + second.requests + third.requests, localRevisionCount: 3, remoteRevisionCount: 4,
      discardedCommittedBranchAcknowledgments: second.discarded, privateFileCount, proofSnapshots, localMetadataSchema: 5,
      independentAccountScopedBases: true, originalPublisherPreservedForViewer: true,
      proofChecksDoNotPublishFetchedHistory: true, explicitFetchOnlyUpdatesFetchedHistory: true,
      recordedBaseAndQueueRestoredWithoutNetwork: true, committedAckLossPreservedPriorBase: true,
      explicitRetryRepairedBaseWithoutDuplicateRevision: true, immutableProofSurvivedProcessRestart: true,
      remoteAheadFetchPreservedLocalHeadAndCommonBase: true, legacyUnscopedBaseUnchanged: true,
      viewerPushDenied: true, revisionsImported: false, mediaFetched: false,
      privateLocalFilesMode: '0600', encryptedStateMode: '0600', stdinOnlyAdministration: true,
      gracefulSigtermExit: true, priorSubprocessesTerminalBeforeRelaunch: true, allOwnedSubprocessesTerminated: true,
      publicStateOmitsProofHashesAndPrivatePaths: true, publicLogsOmitCredentialsAndPrivatePaths: true,
      limits: ['The disposable test CA was trusted only in isolated worker processes; system TLS trust was unchanged.',
        'Only one successful real HTTPS branch acknowledgment was deliberately discarded after its response arrived.',
        'Restarts used graceful shutdown after committed writes; no mid-write crash or power-loss guarantee is claimed.',
        'The connection adapter used real HTTPS account/project checks and private session input; Electron safeStorage and live UI are separate checks.',
        'No production host, public account, operating-system delivery, editor apply, media transfer, or revision import was configured.'] };
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
if (require.main === module) runServiceSharedBaseProof().then(async receipt => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 });
  else process.stdout.write(output);
}).catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'service-shared-base-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runServiceSharedBaseProof };
