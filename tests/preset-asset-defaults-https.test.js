'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { startServiceHost } = require('../src/service-host');

const clientSource = String.raw`
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRevisionHttpClient } = require(process.argv[1]);
const { createAssetHttpClient } = require(process.argv[2]);
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(text);
    const auth = createRevisionHttpClient({ origin: input.origin, getAccessToken: () => null });
    const session = await auth.signIn(input.email, input.password);
    const assets = createAssetHttpClient({ origin: input.origin, getAccessToken: () => session.accessToken });
    const bytes = Buffer.from('selected preset proxy bytes');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const identity = { version: 1, algorithm: 'sha256', contentId: 'sha256:' + checksum,
      size: bytes.length, assetClass: 'proxy', mediaType: null };
    if (input.phase === 1) {
      assert.deepEqual(await assets.getPolicy(input.projectId), { projectId: input.projectId, version: 1, syncClasses: ['proxy'] });
      await assert.rejects(assets.beginUpload(input.projectId, { ...identity, assetClass: 'original' }), { code: 'asset-policy-excluded' });
      const upload = await assets.beginUpload(input.projectId, identity);
      await assets.putChunk(input.projectId, upload.uploadId, 0, bytes, checksum);
      assert.equal((await assets.completeUpload(input.projectId, upload.uploadId)).verified, true);
      assert.deepEqual(Buffer.from((await assets.readChunk(input.projectId, identity.contentId, 0)).bytes), bytes);
      assert.equal((await assets.getAvailability(input.projectId, identity.contentId)).excluded, false);
      assert.equal((await assets.getUsage(input.projectId)).availableBytes, bytes.length);
      assert.deepEqual(await assets.setPolicy(input.projectId, { expectedVersion: 1, syncClasses: [] }),
        { projectId: input.projectId, version: 2, syncClasses: [] });
    } else {
      assert.deepEqual(await assets.getPolicy(input.projectId), { projectId: input.projectId, version: 2, syncClasses: [] });
      assert.equal((await assets.getAvailability(input.projectId, identity.contentId)).excluded, true);
      assert.equal((await assets.getUsage(input.projectId)).excludedBytes, bytes.length);
      assert.equal((await assets.getUsage(input.projectId)).availableBytes, 0);
      await assert.rejects(assets.readChunk(input.projectId, identity.contentId, 0), { code: 'asset-policy-excluded' });
      await assert.rejects(assets.beginUpload(input.projectId, identity), { code: 'asset-policy-excluded' });
    }
    await auth.signOut(session.refreshToken);
    process.send({ ok: true }, () => process.disconnect());
  } catch (error) {
    process.send({ ok: false, code: /^[a-z-]{1,80}$/.test(error.code || '') ? error.code : 'assertion-failed' }, () => process.disconnect());
    process.exitCode = 1;
  }
});
`;

test('actual HTTPS transfer honors atomic preset classes and a durable owner override after host restart', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'preset-asset-https-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const children = [];
  t.after(async () => {
    for (const record of children) if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
    await Promise.all(children.map(record => record.finished));
  });
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  const directory = path.join(root, 'collaboration');
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true, assetPolicyDefaultsEnabled: true });
  const email = 'owner@preset-assets.example.test';
  const password = 'Disposable preset assets password';
  await runtime.identity.createAccount(email, password);
  const context = { accessToken: (await runtime.identity.signIn(email, password)).accessToken };
  const team = await runtime.teams.create(context, 'Preset assets');
  const preset = await runtime.service.saveProjectPreset(context, { teamId: team.id, presetId: null, expectedVersion: 0,
    name: 'Proxy only', branches: ['review'], syncClasses: ['proxy'], idempotencyKey: 'proxy-preset' });
  const intent = { teamId: team.id, presetId: preset.id, expectedVersion: 1, projectName: 'Chosen proxy classes' };
  const plan = await runtime.service.previewProjectFromPreset(context, intent);
  const created = await runtime.service.createProjectFromPreset(context, { ...intent, planId: plan.planId, idempotencyKey: 'create-proxy-project' });
  await runtime.close();
  const fixtures = path.join(__dirname, 'fixtures/network-tls');
  const config = { directory, keyring, host: '127.0.0.1', port: 0,
    tls: { cert: await fs.readFile(path.join(fixtures, 'server.pem')), key: await fs.readFile(path.join(fixtures, 'server-key.pem')) },
    assets: { directory: path.join(root, 'assets'), signingKey: randomBytes(32) } };
  let host;
  t.after(() => host?.close());
  for (const phase of [1, 2]) {
    host = await startServiceHost({ config, initialize: phase === 1, allowEphemeralPort: true });
    const child = spawn(process.execPath, ['-e', clientSource,
      path.join(__dirname, '../src/revision-http-client'), path.join(__dirname, '../src/asset-http-client')], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(fixtures, 'ca.pem') },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {});
    const finished = new Promise(resolve => child.once('close', code => resolve(code)));
    children.push({ child, finished });
    let deadline;
    const reply = new Promise((resolve, reject) => {
      deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('preset-asset-client-timeout')); }, 15000);
      child.once('error', reject);
      child.once('message', resolve);
      finished.then(() => reject(new Error('asset-client-exited-before-receipt')));
    });
    child.stdin.end(JSON.stringify({ phase, email, password, projectId: created.projectId,
      origin: `https://127.0.0.1:${host.address.port}` }));
    try { assert.deepEqual(await reply, { ok: true }); }
    finally { clearTimeout(deadline); }
    assert.equal(await finished, 0);
    assert.equal(output, '');
    await host.close();
    host = null;
  }
});
