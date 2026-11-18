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
// Fresh worker: real HTTPS metadata, actual scanned sources and private disk state.
const clientScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { createRevisionHttpClient } = require('./src/revision-http-client');
  const { createDesktopRevisionSync } = require('./src/desktop-revision-sync');
  const { createLocalMetadataStore } = require('./src/local-metadata');
  const { createProjectSession } = require('./src/project-session');
  const { scanFcpXml } = require('./src/fcpxml-adapter');
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    let controller;
    try {
      const config = JSON.parse(input); let requests = 0, sourceReads = 0, mutateOnSecond = false;
      const send = (...args) => { requests++; return globalThis.fetch(...args); };
      let session = config.ownerSession;
      const anonymous = createRevisionHttpClient({ origin: config.origin, fetch: send });
      if (!session) session = await anonymous.signIn(config.ownerEmail, config.password);
      const client = createRevisionHttpClient({ origin: config.origin, getAccessToken: () => session.accessToken, fetch: send });
      const store = createLocalMetadataStore(config.localDirectory), projectSession = createProjectSession(scanFcpXml, store);
      const sourcePath = path.join(config.localDirectory, 'current.fcpxml'), remotePath = path.join(config.localDirectory, 'incoming.fcpxml');
      const xml = (name, frameDuration, duration) => '<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.10"><resources><format id="f" frameDuration="'
        + frameDuration + '"/><asset id="a" name="Fixture media"/></resources><library><event><project name="' + name + '"><sequence format="f" duration="' + duration
        + '"><spine><asset-clip ref="a" name="Fixture clip" offset="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>';
      const currentBytes = xml('Local', '2/48s', '5s');
      let localId = config.localId, baseId = config.baseId, localHead = config.localHead;
      if (config.phase === 'initial') {
        await fs.mkdir(config.localDirectory, { recursive: true, mode: 0o700 });
        await fs.writeFile(sourcePath, xml('Film', '1/24s', '25/6s'), { mode: 0o600 });
        let state = await projectSession.select(sourcePath); localId = state.selectedProject.id;
        state = await projectSession.saveRevision('Common root'); baseId = state.revisions[0].id;
        await store.recordSyncBase(localId, 'main', baseId, baseId);
      } else await projectSession.select(sourcePath);
      const account = { version: 1, status: 'connected', connected: true, busy: false, origin: config.origin,
        account: { id: config.ownerId, email: config.ownerEmail },
        projects: [{ id: config.projectId, name: 'Disposable comparison film', role: 'owner', branches: ['main'] }], error: null };
      controller = createDesktopRevisionSync({ directory: config.controllerDirectory, store,
        connection: { getState: () => structuredClone(account), getClient: () => client },
        getSelection: () => { const value = projectSession.getState(); return { localProjectId: value.selectedProject?.id, branch: value.currentBranch }; },
        getLocalComparisonSource: async options => {
          sourceReads++;
          if (mutateOnSecond && sourceReads === 2) await fs.writeFile(sourcePath, xml('Changed during compare', '2/48s', '5s'), { mode: 0o600 });
          return projectSession.readComparisonSource(options);
        } });
      controller.connectionChanged();
      async function appendIncoming(name, sourceRevisionId) {
        await fs.writeFile(remotePath, xml(name, '1/30s', '4s'), { mode: 0o600 });
        const manifest = await scanFcpXml(remotePath), saved = await client.putManifest(config.projectId, manifest);
        const head = (await client.getBranch(config.projectId, 'main')).revisionId;
        const revision = await client.createRevision({ projectId: config.projectId, manifestId: saved.id, parentRevisionId: head,
          sourceRevisionId, message: 'Incoming comparison observation', idempotencyKey: sourceRevisionId });
        await client.compareAndSwapBranch({ projectId: config.projectId, branch: 'main', expectedRevisionId: head,
          revisionId: revision.id, idempotencyKey: sourceRevisionId + '-branch' }); return revision.id;
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
        await read(config.localDirectory, 'local'); await read(config.controllerDirectory, 'controller'); return result;
      }
      function comparison(value) {
        assert.equal(value.error, null); assert.equal(value.comparison.status, 'ready'); return value.comparison.result;
      }
      async function compareWithoutMutation() {
        sourceReads = 0; const files = await snapshotFiles(), before = requests;
        const state = await controller.compare();
        assert.equal(requests, before, 'Compare must not dispatch a request'); assert.equal(sourceReads, 2);
        assert.deepEqual(await snapshotFiles(), files, 'Compare must not write local source, cache, metadata or branch/base state');
        return comparison(state);
      }
      let firstIncomingId = config.firstIncomingId, secondIncomingId = config.secondIncomingId;
      let staleBeforeRefused = false, staleBetweenRefused = false, cachedIncomingPreserved = false;
      if (config.phase === 'initial') {
        assert.equal((await client.getAccount()).id, config.ownerId); assert.equal((await client.listProjects()).projects[0].id, config.projectId);
        await controller.bind({ remoteProjectId: config.projectId, remoteBranch: 'main' });
        const pushed = await controller.push(); assert.equal(pushed.error, null); assert.equal(pushed.base.localRevisionId, baseId);
        const beforeMissingFetch = requests, beforeFiles = await snapshotFiles();
        const missingFetch = await controller.compare();
        assert.equal(missingFetch.error, 'comparison-fetch-required'); assert.equal(missingFetch.comparison.result, null);
        assert.equal(requests, beforeMissingFetch); assert.deepEqual(await snapshotFiles(), beforeFiles);
        await fs.writeFile(sourcePath, xml('Saved local branch', '1/24s', '25/6s'), { mode: 0o600 });
        await projectSession.rescan(); const saved = await projectSession.saveRevision('Local divergent child'); localHead = saved.revisions[0].id;
        firstIncomingId = await appendIncoming('Film', 'comparison-incoming-first');
        await fs.writeFile(sourcePath, currentBytes, { mode: 0o600 }); await projectSession.rescan();
        const current = await projectSession.readComparisonSource();
        assert.notEqual(current.manifest.sourceHash, (await store.getRevision(localId, localHead)).contentHash);
        const fetched = await controller.fetch(); assert.equal(fetched.error, null); assert.equal(fetched.base.localRevisionId, baseId);
        assert.equal(fetched.sync.status, 'diverged'); assert.equal(fetched.fetched.total, 2);
        const plan = await compareWithoutMutation();
        assert.equal(plan.binding.incomingRevisionId, firstIncomingId); assert.equal(plan.binding.localHeadId, localHead);
        assert.equal(plan.binding.baseLocalRevisionId, baseId);
        assertFirstStatuses(plan);
      } else {
        assert.equal(config.phase, 'restarted');
        const before = requests, restored = await controller.getState(); assert.equal(requests, before);
        assert.equal(restored.comparison.status, 'none'); assert.equal(restored.base.localRevisionId, baseId); assert.equal(restored.fetched.total, 2);
        secondIncomingId = await appendIncoming('Incoming', 'comparison-incoming-second');
        const cached = await compareWithoutMutation(); assertFirstStatuses(cached);
        assert.equal(cached.binding.incomingRevisionId, firstIncomingId); cachedIncomingPreserved = true;
        const refreshed = await controller.fetch(); assert.equal(refreshed.error, null); assert.equal(refreshed.fetched.total, 3);
        assert.equal(refreshed.comparison.status, 'none'); assert.equal(refreshed.base.localRevisionId, baseId);
        const fresh = await compareWithoutMutation(); assertConflictStatuses(fresh);
        assert.equal(fresh.binding.incomingRevisionId, secondIncomingId); assert.equal(fresh.binding.localHeadId, localHead);
        await fs.writeFile(sourcePath, xml('Unscanned change', '2/48s', '5s'), { mode: 0o600 });
        const stale = await controller.compare(); assert.equal(stale.error, 'revision-source-changed'); assert.equal(stale.comparison.result, null); staleBeforeRefused = true;
        await fs.writeFile(sourcePath, currentBytes, { mode: 0o600 }); await projectSession.rescan();
        sourceReads = 0; mutateOnSecond = true;
        const raced = await controller.compare(); mutateOnSecond = false;
        assert.equal(sourceReads, 2); assert.equal(raced.error, 'revision-source-changed'); assert.equal(raced.comparison.result, null); staleBetweenRefused = true;
        await fs.writeFile(sourcePath, currentBytes, { mode: 0o600 }); await projectSession.rescan();
        assertConflictStatuses(await compareWithoutMutation());
        const bundle = await store.exportRevisions(localId); assert.equal(bundle.records.length, 2); assert.equal(bundle.branches.main, localHead);
        assert.equal((await client.getBranch(config.projectId, 'main')).revisionId, secondIncomingId);
      }
      assert.equal(await store.getSyncBase(localId, 'main'), baseId);
      const output = await controller.getState(), encoded = JSON.stringify(output.comparison);
      assert(!encoded.includes(config.localDirectory)); assert(!encoded.includes(config.controllerDirectory)); assert(!encoded.includes(session.accessToken));
      await controller.dispose();
      process.send({ type: 'result', data: { ownerSession: session, requests, localId, baseId, localHead, firstIncomingId, secondIncomingId,
        staleBeforeRefused, staleBetweenRefused, cachedIncomingPreserved } }, () => process.disconnect());
    } catch (error) {
      await controller?.dispose().catch(() => {});
      const line = /\[eval\]:(\d+):\d+/.exec(error.stack || '')?.[1];
      if (process.connected) process.send({ type: 'failure', data: { code: /^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'assertion-failed', line: line ? Number(line) : null } });
      process.stderr.write('service-three-way-client-proof-failed\n'); process.exitCode = 1; if (process.connected) process.disconnect();
    }
  });
  function assertFirstStatuses(plan) {
    assert.equal(plan.readOnly, true); assert.equal(plan.safeToApply, false);
    assert.deepEqual(plan.changes.map(row => [row.field, row.status]), [
      ['name', 'local-only'], ['frameDuration', 'incoming-only'], ['durationFrames', 'already-applied']]);
    const rate = plan.changes.find(row => row.field === 'frameDuration');
    assert.equal(rate.base, '1/24s'); assert.equal(rate.local, '1/24s'); assert.equal(rate.incoming, '1/30s');
    assert.equal(plan.changes[2].local, 120); assert.equal(plan.changes[2].incoming, 120);
    for (const context of Object.values(plan.context)) { assert.equal(context.clipCount, 1); assert.equal(context.mediaCount, 1); }
  }
  function assertConflictStatuses(plan) {
    assert.equal(plan.readOnly, true); assert.equal(plan.safeToApply, false);
    assert.deepEqual(plan.changes.map(row => [row.field, row.status]), [
      ['name', 'conflict'], ['frameDuration', 'incoming-only'], ['durationFrames', 'already-applied']]);
    assert.equal(plan.changes[0].base, 'Film'); assert.equal(plan.changes[0].local, 'Local'); assert.equal(plan.changes[0].incoming, 'Incoming');
  }
`;

async function runServiceThreeWayProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-service-three-way-proof-'));
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
    for (const session of [result.ownerSession]) {
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
    const projectId = 'comparison-proof-film';
    const project = await admin({ action: 'project-create', email: ownerEmail, password,
      projectId, name: 'Disposable comparison film', teamName: 'Disposable comparison team' });
    assert.equal(project.ownerId, owner.id);
    await assertStatePrivate();
    const localDirectory = path.join(directory, 'local-metadata'), controllerDirectory = path.join(directory, 'desktop-service');
    const input = { phase: 'initial', origin: `https://127.0.0.1:${port}`, ownerEmail,
      password, projectId, ownerId: owner.id, localDirectory, controllerDirectory };
    const firstHost = await launchHost(), first = await runClient(input); await stopHost(firstHost); await assertStatePrivate();
    const secondHost = await launchHost(), second = await runClient({ ...input, ...first, phase: 'restarted' });
    await stopHost(secondHost); await assertStatePrivate();
    assert(second.staleBeforeRefused); assert(second.staleBetweenRefused); assert(second.cachedIncomingPreserved);
    let privateFileCount = 0;
    async function inspectPrivateFiles(target) {
      for (const item of await fs.readdir(target, { withFileTypes: true })) {
        const filename = path.join(target, item.name), stat = await fs.lstat(filename); assert(!stat.isSymbolicLink());
        if (item.isDirectory()) { assert.equal(stat.mode & 0o777, 0o700); await inspectPrivateFiles(filename); }
        else { assert(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600); privateFileCount++;
          const bytes = await fs.readFile(filename);
          for (const secret of [...privateValues.filter(value => value !== directory && value !== configPath), ownerEmail]) assert(!bytes.includes(Buffer.from(secret)));
        }
      }
    }
    await inspectPrivateFiles(localDirectory); await inspectPrivateFiles(controllerDirectory);
    assert(children.every(record => record.terminal)); for (const record of children) assertPrivateLogs(record);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(),
      scope: 'Disposable source-bound service comparison through real HTTPS and fresh controller processes',
      transport: 'https-numeric-loopback-test-ca', authorizedAccounts: 1, hostProcesses: hostProcesses.length, clientControllerProcesses: 2,
      networkRequests: first.requests + second.requests, localRevisionCount: 2, remoteRevisionCount: 3, privateFileCount,
      statusesObserved: ['incoming-only', 'local-only', 'already-applied', 'conflict'],
      actualFcpxmlScans: true, unsavedCurrentLocalSourceCompared: true, verifiedCommonRootAndDivergedHistories: true,
      compareUsesExplicitFetchedIncoming: true, compareDispatchesNoNetworkRequests: true,
      comparisonWithoutExplicitFetchRefused: true,
      compareDoesNotWriteSourceMetadataCacheOrBases: true, rationalEquivalentFrameDurationsNormalized: true,
      cachedIncomingSurvivedRestart: true, comparisonNotAutomaticallyRestored: true,
      changedSourceWithoutRescanRefused: true, sourceChangeBetweenVerificationReadsRefused: true,
      explicitFetchReplacedIncomingAndClearedComparison: true, localAndServiceHeadsPreservedByCompare: true,
      legacyUnscopedBaseUnchanged: true, clipComparisonAvailable: false, mediaIdentityAvailable: false,
      safeToApply: false, revisionsImported: false, mediaFetched: false, privateFilesMode: '0600',
      gracefulSigtermExit: true, priorSubprocessesTerminalBeforeRelaunch: true, allOwnedSubprocessesTerminated: true,
      publicLogsOmitCredentialsAndPrivatePaths: true,
      limits: ['Sequence name, rational frame duration and frame count are the compared fields; clip/media edits are unavailable.',
        'The incoming observation is the last explicitly fetched service head, not a live-head guarantee.',
        'The disposable CA is trusted only in isolated test workers; no system trust or production deployment was configured.',
        'The fixture connection adapter uses real HTTPS; browser/native UI, OS credential storage, editor apply and power-loss behavior are separate checks.'] };
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
if (require.main === module) runServiceThreeWayProof().then(async receipt => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 });
  else process.stdout.write(output);
}).catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'service-three-way-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runServiceThreeWayProof };
