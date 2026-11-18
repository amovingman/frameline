'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createAuthorizedProjectService } = require('../src/authorized-project-service');
const { createCloudHistoryStore } = require('../src/cloud-history-store');
const { createIdentityService } = require('../src/identity-service');
const { createAccessControl } = require('../src/access-control');

// PUBLIC TEST ONLY credentials, deliberately committed and never suitable for
// a deployed service. The CA signing key was discarded. Both certificates have
// explicit 2020–2120 validity; the leaf permits only the loopback IP127.0.0.1.
// Static PEM fixtures keep tests independent of an installed openssl executable.
const fixtureDirectory = path.join(__dirname, 'fixtures/network-tls');
const caPath = path.join(fixtureDirectory, 'ca.pem');
const serverCertificate = fs.readFileSync(path.join(fixtureDirectory, 'server.pem'));
const serverKey = fs.readFileSync(path.join(fixtureDirectory, 'server-key.pem'));

// NODE_EXTRA_CA_CERTS is read at Node startup, so trust is added only to the
// isolated child. Neither the test runner nor the user's trust store is changed.
// The client deliberately uses its default global fetch, with no injected agent
// and no TLS-verification override.
const childScript = String.raw`
  'use strict';
  const assert = require('node:assert/strict');
  const { createRevisionHttpClient } = require(process.argv[1]);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const { origin, ownerToken, outsiderToken, mode } = JSON.parse(input);
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
      const client = createRevisionHttpClient({ origin, getAccessToken: () => ownerToken });
      if (mode === 'untrusted') {
        assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined);
        await assert.rejects(client.getBranch('tls-film', 'main'), { code: 'sync-network-unavailable' });
        // The client intentionally sanitizes network errors. A separate actual
        // fetch verifies the rejection was certificate validation, not HTTP auth.
        await assert.rejects(fetch(origin + '/projects/tls-film/branches/main'), error =>
          ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
           'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.cause?.code));
        process.stdout.write(JSON.stringify({ untrustedCertificateRejected: true }));
        return;
      }
      assert.ok(process.env.NODE_EXTRA_CA_CERTS);
      const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true,
        identityStatus: 'unresolved', sourceHash: 'a'.repeat(64),
        sequence: { name: 'TLS fixture', frameDuration: '1/24s', durationFrames: 0 },
        clips: [], media: [], warnings: [] };
      assert.equal((await client.getBranch('tls-film', 'main')).revisionId, null);
      const stored = await client.putManifest('tls-film', manifest);
      const revision = await client.createRevision({ projectId: 'tls-film', manifestId: stored.id,
        parentRevisionId: null, sourceRevisionId: 'tls-local-revision', message: 'TLS fixture cut',
        idempotencyKey: 'tls-create' });
      await client.compareAndSwapBranch({ projectId: 'tls-film', branch: 'main',
        expectedRevisionId: null, revisionId: revision.id, idempotencyKey: 'tls-advance' });
      assert.equal((await client.getBranch('tls-film', 'main')).revisionId, revision.id);
      assert.equal((await client.getRevision('tls-film', revision.id)).sourceRevisionId, 'tls-local-revision');
      assert.deepEqual((await client.getManifest('tls-film', stored.id)).document, manifest);
      assert.equal((await client.findRevisionBySource('tls-film', 'tls-local-revision')).id, revision.id);
      const outsider = createRevisionHttpClient({ origin, getAccessToken: () => outsiderToken });
      await assert.rejects(outsider.findRevisionBySource('tls-film', 'tls-local-revision'), { code: 'forbidden' });
      await assert.rejects(outsider.putManifest('tls-film', manifest), { code: 'forbidden' });
      process.stdout.write(JSON.stringify({ trustedCertificateAccepted: true, revisionId: revision.id,
        authorId: revision.authorId, outsiderDenied: true }));
    } catch (error) {
      process.stderr.write(error.stack + '\n'); process.exitCode = 1;
    }
  });
`;

function runChild(input, trusted) {
  const env = { ...process.env };
  for (const name of ['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[name];
  if (trusted) env.NODE_EXTRA_CA_CERTS = caPath;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, path.resolve(__dirname, '../src/revision-http-client.js')],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('TLS fixture child timed out')); }, 10000);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`TLS fixture child failed (${code}): ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('TLS fixture child returned no receipt')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

async function serve(t) {
  const history = createCloudHistoryStore(); history.createProject({ projectId: 'tls-film', name: 'TLS fixture' });
  const identity = createIdentityService();
  const owner = identity.createAccount('tls-owner@example.test', 'a secure fixture password');
  identity.createAccount('tls-outsider@example.test', 'a second fixture password');
  const access = createAccessControl(); const team = access.createTeam(owner.id, 'TLS fixture editors');
  access.registerProject(owner.id, 'tls-film', team.id);
  const handler = createRevisionHttpHandler({ service: createAuthorizedProjectService({ history, identity, access }) });
  let requests = 0;
  const server = https.createServer({ key: serverKey, cert: serverCertificate, minVersion: 'TLSv1.2' }, (req, res) => {
    requests += 1; assert.equal(req.socket.encrypted, true); handler(req, res);
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000;
  // Expected when the untrusted client refuses the fixture CA during handshake.
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { history, owner, requests: () => requests, input: {
    origin: `https://127.0.0.1:${server.address().port}`,
    ownerToken: identity.signIn('tls-owner@example.test', 'a secure fixture password').accessToken,
    outsiderToken: identity.signIn('tls-outsider@example.test', 'a second fixture password').accessToken
  } };
}

test('default global fetch rejects an untrusted real HTTPS certificate before metadata reaches the handler', async t => {
  const setup = await serve(t);
  const receipt = await runChild({ ...setup.input, mode: 'untrusted' }, false);
  assert.equal(receipt.untrustedCertificateRejected, true);
  assert.equal(setup.requests(), 0);
  assert.equal(setup.history.listRevisions('tls-film').items.length, 0);
});

test('explicit child-only fixture CA enables default HTTPS metadata operations while preserving authorization', async t => {
  const ca = new X509Certificate(fs.readFileSync(caPath));
  const leaf = new X509Certificate(serverCertificate);
  assert.equal(ca.ca, true); assert.equal(leaf.ca, false);
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(leaf.checkIP('127.0.0.2'), undefined);
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(new Date(leaf.validFrom).getUTCFullYear(), 2020);
  assert.equal(new Date(leaf.validTo).getUTCFullYear(), 2120);
  const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;
  const originalVerification = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const setup = await serve(t);
  const receipt = await runChild({ ...setup.input, mode: 'trusted' }, true);
  assert.equal(receipt.trustedCertificateAccepted, true); assert.equal(receipt.outsiderDenied, true);
  assert.equal(receipt.authorId, setup.owner.id);
  assert.equal(setup.history.getBranch('tls-film', 'main').revisionId, receipt.revisionId);
  assert.equal(setup.history.listRevisions('tls-film').items.length, 1);
  assert.equal(setup.requests(), 10);
  assert.equal(process.env.NODE_EXTRA_CA_CERTS, originalExtraCa);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, originalVerification);
});
