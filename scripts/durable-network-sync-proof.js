'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createAsyncRevisionSyncService } = require('../src/revision-sync-async');

function fail(code) { return Object.assign(new Error(code), { code }); }
const keyring = key => createKeyring({ fixture: Buffer.from(key, 'base64') }, 'fixture');
function fixtureBundle() {
  const projectId = randomUUID(), records = []; let parentRevisionId = null;
  for (let index = 1; index <= 2; index++) {
    const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
      sourceHash: createHash('sha256').update(`Durable synthetic revision ${index}`).digest('hex'),
      sequence: { name: 'Disposable durable sequence', frameDuration: '1/24s', durationFrames: 0 },
      clips: [], media: [], warnings: [] };
    const record = { id: randomUUID(), projectId, parentRevisionId, author: 'Disposable editor',
      createdAt: new Date(index).toISOString(), message: `Durable synthetic revision ${index}`,
      editorVersion: null, manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
    const bytes = `${JSON.stringify(record, null, 2)}\n`, { manifest: _manifest, ...summary } = record;
    summary.recordHash = createHash('sha256').update(bytes).digest('hex');
    records.push({ summary, bytes }); parentRevisionId = record.id;
  }
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: parentRevisionId }, records };
}

// Only this disposable subprocess opens a listener. Its encryption key and
// private directory arrive over stdin, never argv, logs or a proof receipt.
async function runServerChild() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw fail('durable-proof-child-invalid');
  }
  const config = JSON.parse(input);
  const runtime = await createDurableCollaborationService({ directory: config.directory, keyring: keyring(config.key) });
  const handler = createRevisionHttpHandler({ service: runtime.service, allowLoopbackHttp: true });
  const server = http.createServer((req, res) => {
    process.stdout.write(`${JSON.stringify({ request: true })}\n`);
    handler(req, res);
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await runtime.close(); process.exitCode = 0;
  }
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve, reject) => {
      const error = reason => { server.off('listening', ready); reject(reason); };
      const ready = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', ready); server.listen(0, '127.0.0.1');
    });
    if (!(config.previousPorts || []).includes(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
  }
  if (!server.listening) { await runtime.close(); throw fail('durable-proof-child-unavailable'); }
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port })}\n`);
}

async function runDurableNetworkSyncProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-durable-network-proof-'));
  const key = randomBytes(32).toString('base64');
  const children = [], ports = [];
  const projectId = 'durable-fixture-film';
  let privateRuntime = null, networkRequests = 0, firstInitialization = true;
  const secrets = [directory, key, Buffer.from(key, 'base64').toString('hex')];
  function rememberSession(session) { secrets.push(session.accessToken, session.refreshToken); return session; }
  async function openPrivateRuntime() {
    assert(children.every(child => child.terminal), 'Only one owned runtime process may operate at a time');
    privateRuntime = await createDurableCollaborationService({ directory, keyring: keyring(key), initialize: firstInitialization });
    firstInitialization = false; return privateRuntime;
  }
  async function closePrivateRuntime() { await privateRuntime?.close(); privateRuntime = null; }
  async function startChild() {
    assert.equal(privateRuntime, null);
    assert(children.every(child => child.terminal), 'Previous owned subprocess must be terminal before restart');
    const child = spawn(process.execPath, [__filename, '--server-child'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const owned = { child, terminal: false, exit: null }; children.push(owned);
    owned.closed = new Promise(resolve => {
      child.once('close', (code, signal) => { owned.terminal = true; owned.exit = { code, signal }; resolve(owned.exit); });
    });
    const ready = new Promise((resolve, reject) => {
      let buffer = '', totalBytes = 0;
      const timer = setTimeout(() => reject(fail('durable-proof-child-timeout')), 10000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > 1024 * 1024) { clearTimeout(timer); reject(fail('durable-proof-child-invalid')); return; }
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value;
          try { value = JSON.parse(line); } catch { clearTimeout(timer); reject(fail('durable-proof-child-invalid')); return; }
          if (value.request === true) networkRequests++;
          else if (value.ready === true && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
            clearTimeout(timer); resolve(value.port);
          }
        }
      });
      child.once('error', () => { clearTimeout(timer); reject(fail('durable-proof-child-unavailable')); });
      child.once('close', () => { clearTimeout(timer); reject(fail('durable-proof-child-unavailable')); });
    });
    // Discard stderr rather than allowing a child exception to expose private
    // paths or input. The public failure is a bounded code only.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ directory, key, previousPorts: ports }));
    owned.port = await ready; assert(!ports.includes(owned.port)); ports.push(owned.port);
    return owned;
  }
  async function stopChild(owned, signal = 'SIGTERM') {
    if (!owned || owned.terminal) return;
    owned.child.kill(signal);
    let timer;
    try {
      await Promise.race([owned.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('durable-proof-child-stop-timeout')), 10000);
      })]);
    } catch (error) {
      if (!owned.terminal) owned.child.kill('SIGKILL');
      await owned.closed; throw error;
    } finally { clearTimeout(timer); }
    assert.equal(owned.terminal, true);
    if (signal === 'SIGKILL') assert.equal(owned.exit.signal, 'SIGKILL');
    else assert.equal(owned.exit.code, 0);
  }
  function client(owned, token) {
    return createRevisionHttpClient({ origin: `http://127.0.0.1:${owned.port}`, getAccessToken: () => token,
      allowLoopbackHttp: true, timeoutMs: 5000 });
  }
  async function checkPrivateFile() {
    const filename = path.join(directory, 'collaboration.enc.json');
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    const stored = await fs.readFile(filename, 'utf8');
    for (const secret of secrets) assert(!stored.includes(secret), 'Encrypted fixture must not contain plaintext credentials');
    assert.equal(JSON.parse(stored).record.algorithm, 'aes-256-gcm');
  }
  try {
    let runtime = await openPrivateRuntime();
    const password = 'disposable durable fixture password'; secrets.push(password);
    const users = {}, sessions = {};
    for (const role of ['owner', 'editor']) {
      const email = `${role}@durable-disposable.example.test`; secrets.push(email);
      users[role] = await runtime.identity.createAccount(email, password);
      sessions[role] = rememberSession(await runtime.identity.signIn(email, password));
    }
    const context = { accessToken: sessions.owner.accessToken, requestId: 'durable-fixture-owner' };
    const team = await runtime.teams.create(context, 'Disposable durable team');
    await runtime.projects.create(context, { projectId, name: 'Disposable durable film', teamId: team.id });
    const invitation = await runtime.members.invite(context, projectId, 'editor@durable-disposable.example.test', 'editor');
    secrets.push(invitation.token);
    await runtime.members.accept({ accessToken: sessions.editor.accessToken, requestId: 'durable-fixture-editor' }, invitation.token);
    await closePrivateRuntime(); await checkPrivateFile();

    const local = fixtureBundle();
    const first = await startChild();
    const owner = client(first, sessions.owner.accessToken), editor = client(first, sessions.editor.accessToken);
    const ownerSync = createAsyncRevisionSyncService(owner), editorSync = createAsyncRevisionSyncService(editor);
    const pushed = await ownerSync.push({ remoteProjectId: projectId, bundle: local, authorId: users.owner.id });
    assert.equal(pushed.pushed, 2);
    const fetched = await editorSync.fetch({ remoteProjectId: projectId });
    assert.equal(fetched.revisions.length, 2); assert.equal(fetched.mediaFetched, false);
    assert(fetched.revisions.every(revision => revision.authorId === users.owner.id));
    // This acknowledged read follows the completed durable branch CAS. No
    // request is in flight when the disposable server is deliberately killed.
    assert.equal((await owner.getBranch(projectId, 'main')).revisionId, fetched.head);
    await stopChild(first, 'SIGKILL'); await checkPrivateFile();

    const second = await startChild();
    const secondOwner = client(second, sessions.owner.accessToken), secondEditor = client(second, sessions.editor.accessToken);
    const secondSync = createAsyncRevisionSyncService(secondOwner);
    assert.equal((await secondOwner.getBranch(projectId, 'main')).revisionId, fetched.head);
    assert.deepEqual(await createAsyncRevisionSyncService(secondEditor).fetch({ remoteProjectId: projectId }), fetched);
    const retry = await secondSync.push({ remoteProjectId: projectId, bundle: local, authorId: users.owner.id });
    assert.equal(retry.pushed, 0);
    await assert.rejects(client(second, 'forged-durable-token-value').getBranch(projectId, 'main'), { code: 'access-token-invalid' });
    await stopChild(second);

    runtime = await openPrivateRuntime();
    await runtime.members.remove(context, projectId, users.editor.id);
    const rotated = rememberSession(await runtime.identity.refresh(sessions.owner.refreshToken));
    await runtime.identity.signOut(rotated.refreshToken);
    const fresh = rememberSession(await runtime.identity.signIn('owner@durable-disposable.example.test', password));
    await closePrivateRuntime(); await checkPrivateFile();

    const third = await startChild();
    const freshOwner = client(third, fresh.accessToken);
    const finalFetch = await createAsyncRevisionSyncService(freshOwner).fetch({ remoteProjectId: projectId });
    assert.deepEqual(finalFetch, fetched);
    await assert.rejects(client(third, sessions.editor.accessToken).getBranch(projectId, 'main'), { code: 'forbidden' });
    await assert.rejects(client(third, sessions.editor.accessToken).findRevisionBySource(projectId, local.records[0].summary.id), { code: 'forbidden' });
    await assert.rejects(client(third, sessions.owner.accessToken).getBranch(projectId, 'main'), { code: 'access-token-invalid' });
    await assert.rejects(client(third, rotated.accessToken).getBranch(projectId, 'main'), { code: 'access-token-invalid' });
    await stopChild(third);

    runtime = await openPrivateRuntime();
    await assert.rejects(runtime.identity.refresh(sessions.owner.refreshToken), { code: 'refresh-token-invalid' });
    await assert.rejects(runtime.identity.refresh(rotated.refreshToken), { code: 'refresh-token-invalid' });
    assert.equal((await runtime.identity.authenticate(fresh.accessToken)).userId, users.owner.id);
    await closePrivateRuntime(); await checkPrivateFile();
    assert(children.every(owned => owned.terminal));
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(),
      transport: 'numeric-loopback-http-opt-in', scope: 'Disposable encrypted collaboration restart proof',
      authorizedAccounts: 2, serverProcesses: children.length, distinctServerPorts: ports.length,
      networkRequests, fetchedRevisionCount: finalFetch.revisions.length, mediaFetched: false,
      acknowledgedBranchSurvivedSigkill: true, sessionsAndRolesSurvivedRestart: true,
      metadataHistoryPreserved: true, retryCreatedNoDuplicateRevisions: true,
      authorBoundToSession: true, forgedAuthenticationDenied: true,
      removedMemberDeniedAfterRestart: true, rotatedAndSignedOutSessionsDeniedAfterRestart: true,
      revokedRefreshTokensDeniedAfterRestart: true, encryptedFileMode: '0600',
      plaintextCredentialsAbsent: true, ownedSubprocessesTerminalBeforeRestart: true,
      allOwnedSubprocessesTerminated: true,
      limits: ['Plain HTTP was explicitly allowed only for numeric loopback fixtures.',
        'The kill followed an acknowledged durable branch update; no mid-write crash is claimed.',
        'No external account, desktop connection, production key custody, hosting or cross-device deployment was configured.'] };
    const encoded = JSON.stringify(receipt);
    for (const secret of secrets) assert(!encoded.includes(secret), 'Public receipt must omit secrets and private paths');
    return receipt;
  } finally {
    await closePrivateRuntime();
    try { for (const owned of children) await stopChild(owned); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}

if (require.main === module) {
  const task = process.argv[2] === '--server-child' ? runServerChild() : runDurableNetworkSyncProof().then(async receipt => {
    const output = `${JSON.stringify(receipt, null, 2)}\n`;
    if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 });
    else process.stdout.write(output);
  });
  task.catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'durable-network-proof-failed'}\n`); process.exitCode = 1; });
}
module.exports = { runDurableNetworkSyncProof };
