'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');

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
function bundle() {
  const projectId = randomUUID(), records = []; let parentRevisionId = null;
  for (let index = 1; index <= 2; index++) {
    const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
      sourceHash: createHash('sha256').update(`Hosted synthetic revision ${index}`).digest('hex'),
      sequence: { name: 'Hosted disposable sequence', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
    const record = { id: randomUUID(), projectId, parentRevisionId, author: 'Disposable operator',
      createdAt: new Date(index).toISOString(), message: `Hosted disposable revision ${index}`, editorVersion: null,
      manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
    const bytes = `${JSON.stringify(record, null, 2)}\n`, { manifest: _manifest, ...summary } = record;
    summary.recordHash = createHash('sha256').update(bytes).digest('hex'); records.push({ summary, bytes }); parentRevisionId = record.id;
  }
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: parentRevisionId }, records };
}

// Default global fetch verifies the server certificate against an explicitly
// trusted TEST ONLY CA in this isolated process. The wrapper counts dispatches;
// it does not override TLS, agents, redirects, authentication or response bytes.
// Session credentials return through private IPC, never stdout or argv.
const clientScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const { createRevisionHttpClient } = require(process.argv[1]);
  const { createAsyncRevisionSyncService } = require(process.argv[2]);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const config = JSON.parse(input);
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
      assert.ok(process.env.NODE_EXTRA_CA_CERTS);
      let requests = 0;
      const send = (...args) => { requests++; return globalThis.fetch(...args); };
      function connected(token) { return createRevisionHttpClient({ origin: config.origin, getAccessToken: () => token, fetch: send }); }
      let ownerSession = config.ownerSession, viewerSession = config.viewerSession;
      if (config.phase === 'initial') {
        ownerSession = await connected(null).signIn(config.ownerEmail, config.password);
        viewerSession = await connected(null).signIn(config.viewerEmail, config.password);
      }
      const owner = connected(ownerSession.accessToken), viewer = connected(viewerSession.accessToken);
      assert.equal((await owner.getAccount()).id, config.ownerId);
      assert.equal((await viewer.getAccount()).id, config.viewerId);
      assert.deepEqual((await owner.listProjects()).projects.map(item => [item.id, item.role]), [[config.projectId, 'owner']]);
      assert.deepEqual((await viewer.listProjects()).projects.map(item => [item.id, item.role]), [[config.projectId, 'viewer']]);
      const sync = createAsyncRevisionSyncService(owner);
      const pushed = await sync.push({ remoteProjectId: config.projectId, bundle: config.bundle, authorId: config.ownerId });
      assert.equal(pushed.pushed, config.phase === 'initial' ? 2 : 0);
      const fetched = await createAsyncRevisionSyncService(viewer).fetch({ remoteProjectId: config.projectId });
      assert.equal(fetched.revisions.length, 2); assert.equal(fetched.mediaFetched, false);
      assert(fetched.revisions.every(revision => revision.authorId === config.ownerId));
      if (config.previousFetch) assert.deepEqual(fetched, config.previousFetch);
      const manifestId = fetched.manifests[0].id;
      await assert.rejects(viewer.putManifest(config.projectId, fetched.manifests[0].document), { code: 'forbidden' });
      await assert.rejects(viewer.createRevision({ projectId: config.projectId, manifestId, parentRevisionId: fetched.head,
        sourceRevisionId: 'viewer-forbidden-source', message: 'Viewer must not write' }), { code: 'forbidden' });
      await assert.rejects(viewer.compareAndSwapBranch({ projectId: config.projectId, branch: 'main',
        expectedRevisionId: null, revisionId: fetched.head }), { code: 'forbidden' });
      assert.equal((await owner.getBranch(config.projectId, 'main')).revisionId, fetched.head);
      process.send({ type: 'result', data: { ownerSession, viewerSession, fetched, requests } }, () => process.disconnect());
    } catch {
      process.stderr.write('service-host-client-proof-failed\n');
      process.exitCode = 1; if (process.connected) process.disconnect();
    }
  });
`;

async function runServiceHostProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-service-host-proof-'));
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
    const child = spawn(process.execPath, args, { env: environment(trust), stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
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
    const record = start(['-e', clientScript, path.resolve(__dirname, '../src/revision-http-client.js'),
      path.resolve(__dirname, '../src/revision-sync-async.js')], { ipc: true, trust: true });
    let result = null;
    record.child.on('message', message => { if (message?.type === 'result') result = message.data; });
    record.child.stdin.end(JSON.stringify(input)); await waitForExit(record);
    assert.equal(record.exit.code, 0, 'Actual HTTPS client proof must finish successfully');
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
    const input = { phase: 'initial', origin: `https://127.0.0.1:${port}`, ownerEmail, viewerEmail,
      password, projectId, ownerId: owner.id, viewerId: viewer.id, bundle: bundle() };
    const firstHost = await launchHost(); const first = await runClient(input); await stopHost(firstHost);
    const committed = await assertStatePrivate();
    const reinitialized = await command([hostCli, 'initialize', '--config', configPath]);
    assert.equal(reinitialized.exit.code, 0); assert.deepEqual(hostEvents(reinitialized), [{ event: 'service-initialized' }]);
    assert.deepEqual(await assertStatePrivate(), committed, 'Explicit initialization must preserve an existing encrypted store');
    const secondHost = await launchHost();
    const restarted = await runClient({ ...input, phase: 'restarted', ownerSession: first.ownerSession,
      viewerSession: first.viewerSession, previousFetch: first.fetched });
    await stopHost(secondHost); await assertStatePrivate();
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
    assert(children.every(record => record.terminal));
    for (const record of children) assertPrivateLogs(record);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(),
      scope: 'Disposable operator CLI and HTTPS service process proof', transport: 'https-numeric-loopback-test-ca',
      authorizedAccounts: 2, hostProcesses: hostProcesses.length, networkRequests: first.requests + restarted.requests,
      fetchedRevisionCount: restarted.fetched.revisions.length, mediaFetched: false,
      missingStoreServeRejected: true, explicitInitializationRequired: true, existingInitializationPreserved: true,
      insecureConfigRejected: true, insecureTlsKeyRejected: true, privateConfigMode: '0600', privateTlsKeyMode: '0600',
      encryptedStateMode: '0600', stdinOnlyAdministration: true, viewerMetadataWritesDenied: true,
      sessionAndProjectAccessPreservedAfterRestart: true, revisionHistoryPreservedAfterRestart: true,
      idempotentRetryCreatedNoDuplicateRevisions: true, acknowledgedBranchPreserved: true,
      gracefulSigtermExit: true, priorSubprocessesTerminalBeforeRelaunch: true, allOwnedSubprocessesTerminated: true,
      publicLogsOmitCredentialsAndPrivatePaths: true, encryptedStateOmitsPlaintextCredentials: true,
      limits: ['The committed public TEST ONLY certificate and key were used solely on numeric loopback.',
        'The client trusted the test CA only in isolated child processes; global certificate verification stayed enabled.',
        'Restart followed an acknowledged operation and graceful shutdown; no mid-write crash is claimed.',
        'No public host, external account, desktop connection, production certificate or production key custody was configured.'] };
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
if (require.main === module) runServiceHostProof().then(async receipt => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 });
  else process.stdout.write(output);
}).catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'service-host-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runServiceHostProof };
