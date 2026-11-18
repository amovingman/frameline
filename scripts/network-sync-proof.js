'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createIdentityService } = require('../src/identity-service');
const { createAccessControl } = require('../src/access-control');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createRevisionHttpClient } = require('../src/revision-http-client');
const { createAsyncRevisionSyncService } = require('../src/revision-sync-async');
const { createSyncQueue } = require('../src/sync-queue');
const { createRevisionCache } = require('../src/revision-cache');

function fixtureBundle(count) {
  const projectId = randomUUID(), records = []; let parentRevisionId = null;
  for (let index = 1; index <= count; index++) {
    const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
      sourceHash: createHash('sha256').update(`disposable network fixture ${index}`).digest('hex'),
      sequence: { name: 'Disposable sequence', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
    const record = { id: randomUUID(), projectId, parentRevisionId, author: 'Disposable editor',
      createdAt: new Date(index).toISOString(), message: `Disposable revision ${index}`, editorVersion: null,
      manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
    const bytes = `${JSON.stringify(record, null, 2)}\n`, { manifest: _manifest, ...summary } = record;
    summary.recordHash = createHash('sha256').update(bytes).digest('hex'); records.push({ summary, bytes }); parentRevisionId = record.id;
  }
  return { format: 'frameline-revisions', version: 1, projectId, branches: { main: parentRevisionId }, records };
}

// This proof creates disposable accounts in memory and listens only on numeric
// loopback. It never configures the desktop or contacts an external service.
async function runNetworkSyncProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-network-proof-'));
  let server, port, dropAcknowledgment = false, race = false, competingHead = null;
  const identity = createIdentityService(), access = createAccessControl();
  const users = {}, sessions = {};
  for (const role of ['owner', 'editor', 'outsider']) {
    users[role] = identity.createAccount(`${role}@disposable.example.test`, 'disposable fixture password');
    sessions[role] = identity.signIn(`${role}@disposable.example.test`, 'disposable fixture password');
  }
  const team = access.createTeam(users.owner.id, 'Disposable team');
  const invite = access.invite(users.owner.id, team.id, 'editor@disposable.example.test', 'editor');
  access.acceptInvitation(invite.token, users.editor.id, 'editor@disposable.example.test');
  const projectId = 'disposable-network-project'; access.registerProject(users.owner.id, projectId, team.id);
  access.setProjectRole(users.owner.id, projectId, users.editor.id, 'editor');
  const history = createCloudHistoryStore(); history.createProject({ projectId, name: 'Disposable network project' });
  const service = createAuthorizedProjectService({ history, access, identity });
  const transportService = { ...service, updateBranch: (...args) => {
    const result = service.updateBranch(...args);
    if (dropAcknowledgment) { dropAcknowledgment = false; throw new Error('disposable lost acknowledgment'); }
    return result;
  } };
  const handler = createRevisionHttpHandler({ service: transportService, allowLoopbackHttp: true });
  let clients, requests = 0;
  async function start() {
    server = http.createServer(async (req, res) => {
      requests++;
      if (race && req.method === 'PUT' && req.url === `/projects/${projectId}/branches/main`) {
        race = false;
        try {
          const current = await clients.editor.getBranch(projectId, 'main');
          const record = JSON.parse(fixtureBundle(1).records[0].bytes);
          record.manifest.sourceHash = 'f'.repeat(64);
          const manifest = await clients.editor.putManifest(projectId, record.manifest);
          const revision = await clients.editor.createRevision({ projectId, manifestId: manifest.id,
            parentRevisionId: current.revisionId, sourceRevisionId: randomUUID(), message: 'Competing editor work', idempotencyKey: randomUUID() });
          await clients.editor.compareAndSwapBranch({ projectId, branch: 'main', expectedRevisionId: current.revisionId,
            revisionId: revision.id, idempotencyKey: randomUUID() }); competingHead = revision.id;
        } catch (error) { res.destroy(error); return; }
      }
      await handler(req, res);
    });
    server.requestTimeout = 10000; server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port || 0, '127.0.0.1', resolve); });
    port = server.address().port;
  }
  async function stop() {
    if (!server?.listening) return;
    const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closing;
  }
  try {
    await start();
    clients = Object.fromEntries(Object.keys(users).map(role => [role, createRevisionHttpClient({
      origin: `http://127.0.0.1:${port}`, getAccessToken: () => sessions[role].accessToken, allowLoopbackHttp: true, timeoutMs: 3000 })]));
    const cache = createRevisionCache({ directory: path.join(directory, 'cache') });
    const ownerSync = createAsyncRevisionSyncService(clients.owner);
    const editorSync = createAsyncRevisionSyncService(clients.editor, { cache });
    const local = fixtureBundle(3), initial = structuredClone(local);
    initial.records = initial.records.slice(0, 2); initial.branches.main = initial.records[1].summary.id;
    const queueDirectory = path.join(directory, 'queue');
    let queue = createSyncQueue({ directory: queueDirectory });
    const queued = queue.enqueuePush({ remoteProjectId: projectId, bundle: initial, authorId: users.owner.id });
    const offline = await queue.processAsync({ online: false, sync: ownerSync }); assert.equal(offline.pending, 1); assert.equal(requests, 0);
    await stop();
    const unavailable = await queue.processAsync({ online: true, sync: ownerSync }); assert.equal(unavailable.retrying, 1);
    assert.equal(queue.inspect()[0].lastError, 'sync-network-unavailable');
    await start(); queue.retry(queued.id); dropAcknowledgment = true;
    const lost = await queue.processAsync({ online: true, sync: ownerSync }); assert.equal(lost.retrying, 1);
    assert.equal(history.listRevisions(projectId).items.length, 1); assert.equal(queue.inspect().length, 1);
    queue = createSyncQueue({ directory: queueDirectory }); queue.retry(queued.id);
    const recovered = await queue.processAsync({ online: true, sync: ownerSync }); assert.equal(recovered.completed, 1); assert.equal(queue.inspect().length, 0);
    assert.equal(history.listRevisions(projectId).items.length, 2);
    const fetched = await editorSync.fetch({ remoteProjectId: projectId });
    assert.equal(fetched.revisions.length, 2); assert.equal(fetched.mediaFetched, false);
    assert(fetched.revisions.every(value => value.authorId === users.owner.id));
    assert.deepEqual(await editorSync.fetchCached({ remoteProjectId: projectId }), fetched);
    await assert.rejects(clients.outsider.getBranch(projectId, 'main'), { code: 'forbidden' });
    await assert.rejects(clients.outsider.findRevisionBySource(projectId, initial.records[0].summary.id), { code: 'forbidden' });
    race = true;
    await assert.rejects(ownerSync.push({ remoteProjectId: projectId, bundle: local, authorId: users.owner.id }), { code: 'sync-branch-conflict' });
    assert.equal(history.getBranch(projectId, 'main').revisionId, competingHead);
    assert.equal(history.getRevision(projectId, competingHead).authorId, users.editor.id);
    access.removeProjectMember(users.owner.id, projectId, users.editor.id);
    await assert.rejects(clients.editor.getBranch(projectId, 'main'), { code: 'forbidden' });
    await stop();
    const afterOffline = await editorSync.fetchCached({ remoteProjectId: projectId }); assert.deepEqual(afterOffline, fetched);
    const receipt = { schemaVersion: 1, observedAt: new Date().toISOString(), transport: 'numeric-loopback-http-opt-in',
      scope: 'Disposable authenticated revision metadata exchange; no desktop connection or hosted deployment',
      authorizedAccounts: 2, outsiderAccounts: 1, networkRequests: requests, offlineQueuePreserved: true,
      unavailableServerRetried: true, committedBranchAcknowledgmentLost: true, queueRecoveredFromDisk: true,
      retryCreatedNoDuplicateRevisions: true, fetchedRevisionCount: fetched.revisions.length,
      mediaFetched: false, authorBoundToSession: true, outsiderBranchAndSourceLookupDenied: true,
      concurrentBranchWriterPreserved: true, removedMemberDenied: true, verifiedCacheAvailableOffline: true,
      limits: ['HTTP was explicitly allowed for this loopback fixture only.', 'Identity and server history were in memory.',
        'No production hosting, TLS termination, desktop authentication or cross-device deployment is claimed.'] };
    const encoded = JSON.stringify(receipt);
    for (const session of Object.values(sessions)) assert(!encoded.includes(session.accessToken) && !encoded.includes(session.refreshToken));
    assert(!encoded.includes(directory)); return receipt;
  } finally { await stop(); await fs.rm(directory, { recursive: true, force: true }); }
}
if (require.main === module) runNetworkSyncProof().then(async receipt => {
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), `${JSON.stringify(receipt, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}).catch(error => { process.stderr.write(`${error.code || 'network-proof-failed'}\n`); process.exitCode = 1; });
module.exports = { runNetworkSyncProof };
