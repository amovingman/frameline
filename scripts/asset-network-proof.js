'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createKeyring } = require('../src/security-controls');
const { identifyMediaFile } = require('../src/media-asset-identity');

const hostCli = path.resolve(__dirname, '../src/service-host-cli.js');
const adminCli = path.resolve(__dirname, '../src/service-admin-cli.js');
const fixtureTls = path.resolve(__dirname, '../tests/fixtures/network-tls');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { return Object.assign(new Error(code), { code }); }
function environment(trust = false) {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
  if (trust) env.NODE_EXTRA_CA_CERTS = path.join(fixtureTls, 'ca.pem');
  return env;
}

// Credentials and signed capabilities travel over stdin/private IPC, never
// argv/stdout. The actual client ticket flows use global fetch with certificate
// verification enabled and a TEST ONLY CA trusted in this child alone.
const workerScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const { createHash, randomUUID } = require('node:crypto');
  const { createRevisionHttpClient } = require(process.argv[1]);
  const { createAssetHttpClient } = require(process.argv[2]);
  const { API_VERSION } = require(process.argv[3]);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const config = JSON.parse(input); const bytes = Buffer.from(config.bytes, 'base64');
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined); assert.ok(process.env.NODE_EXTRA_CA_CERTS);
      let requests = 0;
      const send = (...args) => { requests++; return globalThis.fetch(...args); };
      let sessions = config.sessions;
      if (!sessions) {
        sessions = {};
        for (const role of ['owner', 'viewer', 'outsider']) sessions[role] = await createRevisionHttpClient({
          origin: config.origin, getAccessToken: () => null, fetch: send }).signIn(config.emails[role], config.password);
      }
      const clients = Object.fromEntries(Object.entries(sessions).map(([role, session]) => [role,
        createAssetHttpClient({ origin: config.origin, getAccessToken: () => session.accessToken, fetch: send })]));
      async function raw(method, relative, token, body, extra = {}) {
        const binary = Buffer.isBuffer(body), requestId = randomUUID();
        const response = await send(config.origin + relative, { method,
          headers: { authorization: 'Bearer ' + token, 'x-api-version': API_VERSION, 'x-request-id': requestId,
            ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }), ...extra },
          body: body === undefined ? undefined : binary ? body : JSON.stringify(body), redirect: 'error' });
        const responseBytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, bytes: responseBytes,
          json: (response.headers.get('content-type') || '').startsWith('application/json') ? JSON.parse(responseBytes) : null };
      }
      async function ticket(method, target, role = 'owner') {
        const response = await raw('POST', '/projects/' + config.projectId + '/assets/tickets', sessions[role].accessToken,
          { method, ...target });
        assert.equal(response.status, 200); return response.json.data;
      }
      const denied = async operation => assert.rejects(operation,
        error => ['forbidden', 'asset-forbidden', 'asset-not-found', 'asset-ticket-invalid', 'asset-url-invalid'].includes(error.code));
      let upload = config.upload, pendingTicket = config.pendingTicket, retainedTicket = config.retainedTicket;
      let completed = config.completed;
      let lifecycleHold = config.lifecycleHold;
      if (config.phase === 'partial') {
        assert.deepEqual(await clients.owner.getPolicy(config.projectId), { projectId: config.projectId, version: 0, syncClasses: [] });
        await assert.rejects(clients.owner.beginUpload(config.projectId, config.identity), { code: 'asset-policy-excluded' });
        await clients.owner.setPolicy(config.projectId, { expectedVersion: 0, syncClasses: ['original'] });
        await assert.rejects(clients.viewer.setPolicy(config.projectId, { expectedVersion: 1, syncClasses: [] }), { code: 'forbidden' });
        upload = await clients.owner.beginUpload(config.projectId, config.identity);
        assert.equal(upload.chunks, 3); assert.equal(upload.chunkSize, 1024 * 1024);
        assert.equal(upload.complete, false); assert.deepEqual(upload.received, [false, false, false]);
        const middle = bytes.subarray(upload.chunkSize, 2 * upload.chunkSize);
        const put = await clients.owner.putChunk(config.projectId, upload.uploadId, 1, middle, sha(middle));
        assert.equal(put.complete, false);
        const status = await clients.owner.uploadStatus(config.projectId, upload.uploadId);
        assert.deepEqual(status.received, [false, true, false]); assert.equal(status.complete, false);
        await denied(clients.owner.getAsset(config.projectId, config.identity.contentId));
        pendingTicket = await ticket('PUT', { uploadId: upload.uploadId, index: 0 });
        const badChecksum = await raw('PUT', pendingTicket.path, sessions.owner.accessToken,
          bytes.subarray(0, upload.chunkSize), { 'x-chunk-sha256': '0'.repeat(64) });
        assert.equal(badChecksum.status, 400); assert.equal(badChecksum.json.error.code, 'asset-chunk-invalid');
        const oversized = await raw('PUT', pendingTicket.path, sessions.owner.accessToken,
          bytes.subarray(0, upload.chunkSize + 1), { 'x-chunk-sha256': sha(bytes.subarray(0, upload.chunkSize + 1)) });
        assert.equal(oversized.status, 413); assert.equal(oversized.json.error.code, 'request-too-large');
        const tampered = pendingTicket.path.replace(/signature=([a-f0-9])/, (_, first) => 'signature=' + (first === '0' ? '1' : '0'));
        const rejected = await raw('PUT', tampered, sessions.owner.accessToken,
          bytes.subarray(0, upload.chunkSize), { 'x-chunk-sha256': sha(bytes.subarray(0, upload.chunkSize)) });
        assert.equal(rejected.status, 403); assert.equal(rejected.json.error.code, 'asset-ticket-invalid');
        const wrongMethod = await raw('GET', pendingTicket.path, sessions.owner.accessToken);
        assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.json.error.code, 'method-not-allowed');
        const expired = pendingTicket.path.replace(/expires=\d+/, 'expires=1');
        const expiredResponse = await raw('PUT', expired, sessions.owner.accessToken,
          bytes.subarray(0, upload.chunkSize), { 'x-chunk-sha256': sha(bytes.subarray(0, upload.chunkSize)) });
        assert.equal(expiredResponse.status, 403); assert.equal(expiredResponse.json.error.code, 'asset-ticket-invalid');
        assert.deepEqual((await clients.owner.uploadStatus(config.projectId, upload.uploadId)).received, [false, true, false]);
        const partialUsage = await clients.owner.getUsage(config.projectId);
        assert.equal(partialUsage.assetCount, 0); assert.equal(partialUsage.inProgressUploads, 1);
        assert.equal(partialUsage.inProgressReceivedBytes, 1024 * 1024);
        await denied(clients.viewer.beginUpload(config.projectId, config.identity));
        await denied(clients.outsider.beginUpload(config.projectId, config.identity));
      } else if (config.phase === 'finish') {
        assert.deepEqual(await clients.owner.getPolicy(config.projectId), { projectId: config.projectId, version: 1, syncClasses: ['original'] });
        const status = await clients.owner.uploadStatus(config.projectId, upload.uploadId);
        assert.deepEqual(status.received, [false, true, false]); assert.equal(status.complete, false);
        const resumed = await clients.owner.beginUpload(config.projectId, config.identity);
        assert.equal(resumed.uploadId, upload.uploadId);
        await assert.rejects(clients.owner.completeUpload(config.projectId, upload.uploadId), { code: 'upload-incomplete' });
        const first = bytes.subarray(0, upload.chunkSize);
        const continued = await raw('PUT', pendingTicket.path, sessions.owner.accessToken, first, { 'x-chunk-sha256': sha(first) });
        assert.equal(continued.status, 200);
        const last = bytes.subarray(2 * upload.chunkSize);
        await clients.owner.putChunk(config.projectId, upload.uploadId, 2, last, sha(last));
        const ready = await clients.owner.uploadStatus(config.projectId, upload.uploadId);
        assert.deepEqual(ready.received, [true, true, true]); assert.equal(ready.complete, false);
        await denied(clients.owner.getAsset(config.projectId, config.identity.contentId));
        completed = await clients.owner.completeUpload(config.projectId, upload.uploadId);
        assert.equal(completed.assetId, config.identity.contentId); assert.equal(completed.size, bytes.length);
        assert.equal(completed.verified, true);
        assert.deepEqual(await clients.owner.completeUpload(config.projectId, upload.uploadId), completed);
        const again = await clients.owner.beginUpload(config.projectId, config.identity);
        assert.equal(again.uploadId, upload.uploadId); assert.equal(again.complete, true);
        const downloaded = [];
        const asset = await clients.viewer.getAsset(config.projectId, completed.assetId);
        assert.equal(asset.size, bytes.length);
        for (let index = 0; index < upload.chunks; index++) {
          const chunk = await clients.viewer.readChunk(config.projectId, completed.assetId, index);
          assert.equal(sha(chunk.bytes), chunk.checksum); downloaded.push(chunk.bytes);
        }
        const result = Buffer.concat(downloaded); assert.deepEqual(result, bytes);
        assert.equal('sha256:' + sha(result), config.identity.contentId);
        const publishedUsage = await clients.viewer.getUsage(config.projectId);
        assert.equal(publishedUsage.logicalBytes, bytes.length); assert.equal(publishedUsage.availableBytes, bytes.length);
        assert.equal(publishedUsage.inProgressUploads, 0);
        const beforePolicyTicket = await ticket('GET', { assetId: completed.assetId, index: 0 }, 'viewer');
        await assert.rejects(clients.viewer.setArchived(config.projectId, completed.assetId, { expectedArchived: false, archived: true }), { code: 'forbidden' });
        const archived = await clients.owner.setArchived(config.projectId, completed.assetId, { expectedArchived: false, archived: true });
        assert.equal(archived.archived, true); assert.equal(archived.cloudPresent, true);
        assert.equal((await clients.owner.getUsage(config.projectId)).archivedBytes, bytes.length);
        const archivedRead = await raw('GET', beforePolicyTicket.path, sessions.viewer.accessToken);
        assert.equal(archivedRead.status, 403); assert.equal(archivedRead.json.error.code, 'asset-archived');
        await clients.owner.setPolicy(config.projectId, { expectedVersion: 1, syncClasses: [] });
        const excluded = await clients.viewer.getAvailability(config.projectId, completed.assetId);
        assert.equal(excluded.excluded, true); assert.equal(excluded.cloudPresent, true);
        const excludedUsage = await clients.owner.getUsage(config.projectId);
        assert.equal(excludedUsage.excludedBytes, bytes.length); assert.equal(excludedUsage.archivedBytes, 0);
        await assert.rejects(clients.owner.setPolicy(config.projectId, { expectedVersion: 1, syncClasses: ['original'] }), { code: 'asset-policy-version-conflict' });
        const excludedRead = await raw('GET', beforePolicyTicket.path, sessions.viewer.accessToken);
        assert.equal(excludedRead.status, 403); assert.equal(excludedRead.json.error.code, 'asset-policy-excluded');
        await clients.owner.setArchived(config.projectId, completed.assetId, { expectedArchived: true, archived: false });
        await clients.owner.setPolicy(config.projectId, { expectedVersion: 2, syncClasses: ['original'] });
        assert.equal((await clients.viewer.getAvailability(config.projectId, completed.assetId)).excluded, false);
        assert.equal((await clients.owner.getUsage(config.projectId)).availableBytes, bytes.length);
        lifecycleHold = await clients.owner.setHold(config.projectId, completed.assetId, {
          expectedVersion: 0, held: true, reason: 'contractual', until: null, idempotencyKey: 'proof-hold' });
        assert.equal(lifecycleHold.version, 1);
        await clients.owner.setRetentionPolicy(config.projectId, {
          expectedVersion: 0, minimumArchiveAgeMs: 1000, idempotencyKey: 'proof-retention' });
        await denied(clients.viewer.getLifecycleReport(config.projectId));
        await denied(clients.viewer.beginUpload(config.projectId, config.identity));
        await denied(clients.outsider.getAsset(config.projectId, completed.assetId));
        await assert.rejects(clients.outsider.getAsset(config.otherProjectId, completed.assetId), { code: 'asset-not-found' });
        assert.equal((await clients.outsider.getUsage(config.otherProjectId)).logicalBytes, 0);
        assert.equal((await clients.outsider.getAvailability(config.otherProjectId, completed.assetId)).cloudPresent, false);
        retainedTicket = await ticket('GET', { assetId: completed.assetId, index: 1 }, 'viewer');
        const outsiderRedemption = await raw('GET', retainedTicket.path, sessions.outsider.accessToken);
        assert.equal(outsiderRedemption.status, 403); assert.equal(outsiderRedemption.json.error.code, 'forbidden');
        const wrongProject = retainedTicket.path.replace('/projects/' + config.projectId + '/', '/projects/' + config.otherProjectId + '/');
        const otherProjectResponse = await raw('GET', wrongProject, sessions.outsider.accessToken);
        assert.equal(otherProjectResponse.status, 403); assert.equal(otherProjectResponse.json.error.code, 'asset-ticket-invalid');
      } else {
        assert.deepEqual(await clients.owner.getPolicy(config.projectId), { projectId: config.projectId, version: 3, syncClasses: ['original'] });
        assert.equal((await clients.owner.getUsage(config.projectId)).logicalBytes, bytes.length);
        assert(retainedTicket.expiresAt > Date.now(), 'Revocation is checked while the old capability is still unexpired');
        const revoked = await raw('GET', retainedTicket.path, sessions.viewer.accessToken);
        assert.equal(revoked.status, 403); assert.equal(revoked.json.error.code, 'forbidden');
        await denied(clients.viewer.getAsset(config.projectId, completed.assetId));
        const downloaded = [];
        for (let index = 0; index < upload.chunks; index++) downloaded.push((await clients.owner.readChunk(config.projectId, completed.assetId, index)).bytes);
        assert.deepEqual(Buffer.concat(downloaded), bytes);
        assert.equal((await clients.owner.beginUpload(config.projectId, config.identity)).uploadId, upload.uploadId);
        assert.deepEqual(await clients.owner.getHold(config.projectId, completed.assetId), lifecycleHold);
        const heldInput = { expectedVersion: 0, held: true, reason: 'contractual', until: null, idempotencyKey: 'proof-hold' };
        assert.deepEqual(await clients.owner.setHold(config.projectId, completed.assetId, heldInput), lifecycleHold);
        const released = await clients.owner.setHold(config.projectId, completed.assetId, {
          expectedVersion: 1, held: false, reason: null, until: null, idempotencyKey: 'proof-release' });
        assert.equal(released.version, 2); assert.equal(released.held, false);
        assert.deepEqual(await clients.owner.setHold(config.projectId, completed.assetId, heldInput), lifecycleHold);
        assert.deepEqual(await clients.owner.getHold(config.projectId, completed.assetId), released);
        assert.equal((await clients.owner.getRetentionPolicy(config.projectId)).minimumArchiveAgeMs, 1000);
        const oldReport = await clients.owner.getLifecycleReport(config.projectId);
        await clients.owner.setRetentionPolicy(config.projectId, {
          expectedVersion: 1, minimumArchiveAgeMs: 0, idempotencyKey: 'proof-retention-next' });
        await assert.rejects(clients.owner.planCleanup(config.projectId, {
          assetIds: [completed.assetId], expectedStateHash: oldReport.stateHash }), { code: 'asset-lifecycle-plan-stale' });
        await clients.owner.setArchived(config.projectId, completed.assetId, { expectedArchived: false, archived: true });
        const lifecycleReport = await clients.owner.getLifecycleReport(config.projectId);
        const plan = await clients.owner.planCleanup(config.projectId, { assetIds: [completed.assetId], expectedStateHash: lifecycleReport.stateHash });
        assert.equal(plan.ready, false); assert.equal(plan.deletionPerformed, false); assert.equal(plan.candidateBytes, bytes.length);
        assert.deepEqual(plan.items[0].blockers, ['revision-references-unverified']);
        await denied(clients.viewer.getHold(config.projectId, completed.assetId));
        await clients.owner.setArchived(config.projectId, completed.assetId, { expectedArchived: true, archived: false });
        assert.deepEqual((await clients.owner.readChunk(config.projectId, completed.assetId, 0)).bytes, bytes.subarray(0, upload.chunkSize));
      }
      process.send({ type: 'result', data: { sessions, upload, pendingTicket, retainedTicket, completed, lifecycleHold, requests } }, () => process.disconnect());
    } catch (error) {
      const line = /\[eval\]:(\d+):\d+/.exec(error.stack || '')?.[1];
      if (process.connected) process.send({ type: 'failure', data: {
        code: /^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'assertion-failed', line: line ? Number(line) : null } });
      process.stderr.write('asset-network-client-proof-failed\n'); process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  });
`;

async function runAssetNetworkProof() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-asset-network-proof-')));
  const configPath = path.join(directory, 'config.json'), dataDirectory = path.join(directory, 'collaboration');
  const assetDirectory = path.join(directory, 'assets'), certFile = path.join(directory, 'test-only-server.pem');
  const keyFile = path.join(directory, 'test-only-server-key.pem'), sourceFile = path.join(directory, 'disposable-source.bin');
  const key = randomBytes(32).toString('base64'), signingKey = randomBytes(32).toString('base64');
  const password = 'disposable asset fixture password', payload = randomBytes(2 * 1024 * 1024 + 17);
  const emails = { owner: 'asset-owner@disposable.example.test', viewer: 'asset-viewer@disposable.example.test',
    outsider: 'asset-outsider@disposable.example.test' };
  const secrets = [directory, key, signingKey, password, sourceFile];
  const receiptSecrets = [...secrets, ...Object.values(emails)];
  const children = [], hosts = []; let privateRuntime = null, port;
  function safeLogs(record) {
    for (const secret of secrets) assert(!(record.stdout + record.stderr).includes(secret), 'Owned process logs must omit credentials, capabilities and private paths');
  }
  function start(args, { ipc = false, trust = false } = {}) {
    for (const secret of secrets.filter(value => value !== directory && value !== sourceFile)) {
      assert(!args.some(arg => String(arg).includes(secret)), 'Private credentials must not appear in process arguments');
    }
    const child = spawn(process.execPath, args, { env: environment(trust), stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    const record = { child, terminal: false, stdout: '', stderr: '', exit: null }; children.push(record);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdin.on('error', () => {});
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      record[name] += chunk; if (Buffer.byteLength(record[name]) > 128 * 1024) child.kill('SIGKILL');
    });
    record.closed = new Promise(resolve => {
      child.once('error', () => {}); child.once('close', (code, signal) => {
        record.terminal = true; record.exit = { code, signal }; resolve();
      });
    }); return record;
  }
  async function terminal(record, timeoutMs = 15000) {
    let timer;
    try { await Promise.race([record.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('asset-proof-process-timeout')), timeoutMs);
    })]); }
    catch (error) { if (!record.terminal) record.child.kill('SIGKILL'); await record.closed; throw error; }
    finally { clearTimeout(timer); }
    safeLogs(record); return record;
  }
  async function command(args, input) {
    assert(hosts.every(record => record.terminal)); assert.equal(privateRuntime, null);
    const record = start(args); record.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    await terminal(record); assert.equal(record.exit.code, 0, 'Private fixture administration must succeed');
    return JSON.parse(record.stdout);
  }
  async function launch() {
    assert(children.every(record => record.terminal)); assert.equal(privateRuntime, null);
    const record = start([hostCli, 'serve', '--config', configPath]); hosts.push(record); record.child.stdin.end();
    let timer;
    try {
      const ready = await new Promise((resolve, reject) => {
        const inspect = () => {
          for (const line of record.stdout.split('\n').slice(0, -1)) {
            let value; try { value = JSON.parse(line); } catch { reject(fail('asset-proof-host-ready-invalid')); return; }
            if (value.event === 'service-ready') { resolve(value); return; }
          }
        };
        record.child.stdout.on('data', inspect); record.child.once('close', () => reject(fail('asset-proof-host-start-failed')));
        timer = setTimeout(() => reject(fail('asset-proof-host-start-timeout')), 10000); inspect();
      });
      assert.equal(ready.address.address, '127.0.0.1'); assert.equal(ready.address.port, port); return record;
    } finally { clearTimeout(timer); }
  }
  async function stop(record) {
    if (record.terminal) return;
    record.child.kill('SIGTERM'); await terminal(record); assert.equal(record.exit.code, 0); assert.equal(record.exit.signal, null);
    assert.deepEqual(record.stdout.trim().split('\n').map(line => JSON.parse(line).event), ['service-ready', 'service-stopped']);
  }
  async function worker(config) {
    const record = start(['-e', workerScript, path.resolve(__dirname, '../src/revision-http-client.js'),
      path.resolve(__dirname, '../src/asset-http-client.js'), path.resolve(__dirname, '../src/project-api-contracts.js')], { ipc: true, trust: true });
    let result, failure;
    record.child.on('message', message => { if (message?.type === 'result') result = message.data;
      if (message?.type === 'failure') failure = message.data; });
    record.child.stdin.end(JSON.stringify(config)); await terminal(record, 30000);
    assert.equal(record.exit.code, 0, `Real HTTPS asset client must finish ${config.phase}: ${failure?.code || 'unknown'} at worker line ${failure?.line || 'unknown'}`); assert(result);
    assert.equal(record.stdout, '');
    for (const session of Object.values(result.sessions)) {
      secrets.push(session.accessToken, session.refreshToken); receiptSecrets.push(session.accessToken, session.refreshToken);
    }
    for (const capability of [result.pendingTicket?.path, result.retainedTicket?.path]) if (capability) {
      secrets.push(capability); receiptSecrets.push(capability);
    }
    return result;
  }
  async function encryptedFiles() {
    const files = [];
    async function walk(root) {
      assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const filename = path.join(root, entry.name);
        if (entry.isDirectory()) await walk(filename);
        else { assert(entry.isFile()); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600); files.push(filename); }
      }
    }
    await walk(assetDirectory);
    const markers = [payload.subarray(0, 64), payload.subarray(1024 * 1024, 1024 * 1024 + 64), payload.subarray(2 * 1024 * 1024)];
    for (const filename of files) {
      const bytes = await fs.readFile(filename);
      for (const marker of markers) {
        assert(!bytes.includes(marker), 'Asset files must omit plaintext media bytes');
        assert(!bytes.includes(Buffer.from(marker.toString('base64'))), 'Asset files must omit base64 plaintext media');
      }
      for (const secret of [...secrets, ...Object.values(emails)]) assert(!bytes.includes(Buffer.from(secret)), 'Asset files must omit credentials and private paths');
    }
    return files.length;
  }
  try {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    await fs.copyFile(path.join(fixtureTls, 'server.pem'), certFile); await fs.chmod(certFile, 0o644);
    await fs.copyFile(path.join(fixtureTls, 'server-key.pem'), keyFile); await fs.chmod(keyFile, 0o600);
    await fs.writeFile(sourceFile, payload, { mode: 0o600 });
    const identity = await identifyMediaFile(sourceFile, { assetClass: 'original', mediaType: 'application/octet-stream' });
    assert.equal(identity.contentId, `sha256:${sha256(payload)}`);
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory: dataDirectory, host: '127.0.0.1', port,
      tls: { certFile, keyFile }, keyring: { activeKeyId: 'proof', keys: { proof: key } },
      assets: { directory: assetDirectory, signingKey } }), { mode: 0o600 });
    assert.deepEqual(await command([hostCli, 'initialize', '--config', configPath]), { event: 'service-initialized' });
    const admin = input => command([adminCli, '--config', configPath], input);
    const users = {};
    for (const role of ['owner', 'viewer', 'outsider']) users[role] = await admin({ action: 'account-create', email: emails[role], password });
    const projectId = 'asset-proof-film', otherProjectId = 'asset-proof-other';
    await admin({ action: 'project-create', email: emails.owner, password, projectId, name: 'Disposable asset film', teamName: 'Asset fixture owners' });
    await admin({ action: 'project-create', email: emails.outsider, password, projectId: otherProjectId, name: 'Other disposable film', teamName: 'Other fixture owners' });
    await admin({ action: 'member-add', ownerEmail: emails.owner, ownerPassword: password,
      memberEmail: emails.viewer, memberPassword: password, projectId, role: 'viewer' });
    const input = { origin: `https://127.0.0.1:${port}`, emails, password, projectId, otherProjectId,
      identity, bytes: payload.toString('base64') };
    const firstHost = await launch(); const partial = await worker({ ...input, phase: 'partial' }); await stop(firstHost);
    await encryptedFiles();
    const secondHost = await launch(); const completed = await worker({ ...input, ...partial, phase: 'finish' }); await stop(secondHost);
    const fileCount = await encryptedFiles();
    assert(children.every(record => record.terminal));
    privateRuntime = await createDurableCollaborationService({ directory: dataDirectory,
      keyring: createKeyring({ proof: Buffer.from(key, 'base64') }, 'proof') });
    await privateRuntime.members.remove({ accessToken: partial.sessions.owner.accessToken, requestId: 'asset-proof-membership-revoke' }, projectId, users.viewer.id);
    await privateRuntime.close(); privateRuntime = null;
    const thirdHost = await launch(); const revoked = await worker({ ...input, ...completed, phase: 'revoked' }); await stop(thirdHost);
    assert.equal(await encryptedFiles(), fileCount); assert(children.every(record => record.terminal));
    for (const record of children) safeLogs(record);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: 'Disposable signed HTTPS asset transfer and restart proof',
      transport: 'https-numeric-loopback-test-ca', authenticatedAccounts: 3, projects: 2, hostProcesses: hosts.length,
      networkRequests: partial.requests + completed.requests + revoked.requests, assetBytes: payload.length, chunks: 3,
      encryptedPrivateFiles: fileCount, outOfOrderChunkAccepted: true, partialUploadSurvivedRestart: true,
      capabilitySurvivedGracefulRestart: true, resumeReusedUpload: true, wholeContentHashVerified: true,
      viewerDownloadedExactBytes: true, completedRetryReusedAsset: true, viewerWriteDenied: true,
      outsiderAccessDenied: true, crossProjectContentIsolation: true, malformedChecksumRejected: true, oversizedChunkRejected: true,
      capabilityTamperingRejected: true, wrongMethodRejected: true, alteredExpiredCapabilityRejected: true,
      removedViewerOldTicketDeniedAfterRestart: true, retainedOwnerContentAvailable: true,
      policyDefaultsDisabled: true, ownerPolicyPersistsAcrossRestart: true, viewerPolicyAndArchiveWritesDenied: true,
      partialAndPublishedUsageVerified: true, archivedBytesRetainedAndBlocked: true, excludedBytesRetainedAndBlocked: true,
      outstandingTicketsRecheckArchiveAndPolicy: true, stalePolicyUpdateRejected: true, restoredPolicyAllowsRead: true,
      lifecycleHoldPersistedAcrossHostRestart: true, lifecycleExactRetryDoesNotReinstateReleasedHold: true,
      lifecycleRetentionPersistedAcrossHostRestart: true, lifecycleOwnerReportsAndStalePlansVerified: true,
      lifecyclePlanRemainsBlockedAndMediaRetained: true,
      encryptedChunksOmitPlaintext: true, privateFileMode: '0600', gracefulSigtermExit: true,
      priorOwnedProcessesTerminalBeforeRestart: true, allOwnedProcessesTerminated: true,
      publicLogsAndReceiptOmitCredentialsCapabilitiesAndPrivatePaths: true,
      limits: ['Only disposable files and the public TEST ONLY TLS certificate were used on numeric loopback.',
        'This process proof altered the signed expiry field; separate transport tests advance the verifier clock past a genuine ticket expiry.',
        'Project access authorizes bytes; this proof does not bind assets to canonical revision identities or enable editor apply.',
        'No public deployment, production credential custody, cross-device integration or mid-write crash is claimed.'] };
    for (const secret of receiptSecrets) assert(!JSON.stringify(receipt).includes(secret));
    return receipt;
  } finally {
    try {
      await privateRuntime?.close(); privateRuntime = null;
      for (const record of children) if (!record.terminal) {
        record.child.kill('SIGTERM'); try { await terminal(record); } catch { /* terminal force-kills and reaps on timeout. */ }
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}
if (require.main === module) runAssetNetworkProof().then(async receipt => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), output, { mode: 0o600 }); else process.stdout.write(output);
}).catch(error => { process.stderr.write(`${/^[a-z0-9-]{1,80}$/.test(error.code || '') ? error.code : 'asset-network-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runAssetNetworkProof };
