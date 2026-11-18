'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { startServiceHost } = require('../src/service-host');
const { createKeyring } = require('../src/security-controls');
const { acquireMetadataLock } = require('../src/metadata-lock');
const { API_VERSION } = require('../src/project-api-contracts');
const fixtures = path.join(__dirname, 'fixtures/network-tls');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, host: '127.0.0.1', port: 0, tls: { cert: await fs.readFile(path.join(fixtures, 'server.pem')),
    key: await fs.readFile(path.join(fixtures, 'server-key.pem')) }, keyring: createKeyring({ fixture: randomBytes(32) }, 'fixture') };
}
async function call(address, route = '/account') {
  const ca = await fs.readFile(path.join(fixtures, 'ca.pem'));
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: address.address, port: address.port, path: route, ca,
      headers: { 'x-api-version': API_VERSION, 'x-request-id': 'host-request' } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }); request.on('error', reject);
  });
}

test('host requires explicit initialization, serves actual verified TLS and closes network before reopening durable state', async t => {
  const config = await fixture(t);
  await assert.rejects(startServiceHost({ config, allowEphemeralPort: true }), { code: 'collaboration-state-invalid' });
  await assert.rejects(fs.stat(path.join(config.directory, 'collaboration.enc.json')), { code: 'ENOENT' });
  const host = await startServiceHost({ config, initialize: true, allowEphemeralPort: true }); t.after(() => host.close());
  assert.ok(host.address.port > 0); assert.equal((await call(host.address)).status, 401);
  assert.equal((await call(host.address, '/health')).status, 404);
  assert.equal((await call(host.address, '/admin')).status, 404);
  const before = await host.getStatus(); await Promise.all([host.close(), host.close()]);
  await assert.rejects(call(host.address)); await assert.rejects(host.getStatus(), { code: 'service-host-closed' });
  const reopened = await startServiceHost({ config: { ...config, port: host.address.port } }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.getStatus(), before); assert.equal((await call(reopened.address)).status, 401);
});

test('bad TLS and occupied ports fail without readiness or erasing an existing encrypted store', async t => {
  const config = await fixture(t);
  await assert.rejects(startServiceHost({ config: { ...config, tls: { cert: Buffer.from('bad'), key: Buffer.from('bad') } }, initialize: true, allowEphemeralPort: true }), { code: 'service-host-tls-unavailable' });
  await assert.rejects(fs.stat(path.join(config.directory, 'collaboration.enc.json')), { code: 'ENOENT' });
  const first = await startServiceHost({ config, initialize: true, allowEphemeralPort: true }); t.after(() => first.close());
  const before = await fs.readFile(path.join(config.directory, 'collaboration.enc.json'));
  await assert.rejects(startServiceHost({ config: { ...config, port: first.address.port } }), { code: 'service-host-listen-unavailable' });
  assert.deepEqual(await fs.readFile(path.join(config.directory, 'collaboration.enc.json')), before);
  assert.equal((await call(first.address)).status, 401);
});

test('shutdown bounds idle raw pre-handshake TCP connections without claiming a forced process exit', async t => {
  const config = await fixture(t); const host = await startServiceHost({ config, initialize: true, allowEphemeralPort: true, shutdownTimeoutMs: 1000 });
  t.after(() => host.close()); const socket = net.connect(host.address.port, host.address.address); socket.on('error', () => {});
  await once(socket, 'connect'); const disconnected = new Promise(resolve => socket.once('close', resolve));
  const started = Date.now(); await host.close(); await disconnected; assert.ok(Date.now() - started < 1000);
});

test('shutdown drains an admitted durable request after its client disconnects before closing the runtime', async t => {
  const config = await fixture(t); const host = await startServiceHost({ config, initialize: true, allowEphemeralPort: true, shutdownTimeoutMs: 3000 });
  t.after(() => host.close()); const release = await acquireMetadataLock(config.directory);
  const ca = await fs.readFile(path.join(fixtures, 'ca.pem'));
  const socket = tls.connect({ host: host.address.address, port: host.address.port, ca }); socket.on('error', () => {}); await once(socket, 'secureConnect');
  socket.write(`GET /account HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer invalid-but-bounded-token\r\nx-api-version: ${API_VERSION}\r\nx-request-id: drain-request\r\n\r\n`);
  await new Promise(resolve => setTimeout(resolve, 50)); let finished = false;
  const closing = host.close().then(() => { finished = true; }); socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(finished, false);
  await release(); await closing;
  assert.equal(finished, true);
});

test('host options reject implicit ephemeral binds, hostnames and unbounded shutdown deadlines', async t => {
  const config = await fixture(t);
  for (const options of [{ config }, { config: { ...config, host: 'localhost' }, allowEphemeralPort: true },
    { config, allowEphemeralPort: true, shutdownTimeoutMs: 0 }, { config, allowEphemeralPort: true, shutdownTimeoutMs: 30001 }])
    await assert.rejects(startServiceHost(options), { code: 'service-host-invalid' });
});

test('optional assets require explicit initialization and remain authenticated through the shared HTTPS listener', async t => {
  const config = await fixture(t);
  const metadata = await startServiceHost({ config, initialize: true, allowEphemeralPort: true }); await metadata.close();
  const directory = `${config.directory}-assets`; t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const withAssets = { ...config, assets: { directory, signingKey: randomBytes(32) } };
  const before = await fs.readFile(path.join(config.directory, 'collaboration.enc.json'));
  await assert.rejects(startServiceHost({ config: withAssets, allowEphemeralPort: true }), { code: 'asset-storage-unavailable' });
  assert.deepEqual(await fs.readFile(path.join(config.directory, 'collaboration.enc.json')), before);
  const host = await startServiceHost({ config: withAssets, initialize: true, allowEphemeralPort: true }); t.after(() => host.close());
  assert.equal((await fs.stat(path.join(directory, 'assets.enc.json'))).mode & 0o777, 0o600);
  assert.equal((await call(host.address, `/projects/film/assets/${encodeURIComponent('sha256:' + 'a'.repeat(64))}`)).status, 401);
  await host.close();
  const restarted = await startServiceHost({ config: withAssets, allowEphemeralPort: true }); t.after(() => restarted.close());
  assert.equal((await call(restarted.address)).status, 401);
});

test('direct host construction rejects overlapping media and identity stores before creating either', async t => {
  const config = await fixture(t);
  for (const directory of [config.directory, path.join(config.directory, 'nested'), path.dirname(config.directory)]) {
    await assert.rejects(startServiceHost({ config: { ...config, assets: { directory, signingKey: randomBytes(32) } },
      initialize: true, allowEphemeralPort: true }), { code: 'service-host-invalid' });
  }
  await assert.rejects(fs.stat(path.join(config.directory, 'collaboration.enc.json')), { code: 'ENOENT' });
});

test('optional notification configuration is validated before storage initialization and absent mail starts no worker', async t => {
  const config = await fixture(t);
  await assert.rejects(startServiceHost({ config: { ...config, notifications: {
    publicOrigin: 'http://mail.example.test', from: 'updates@example.test',
    smtp: { host: 'mail.example.test', port: 465, username: null, password: null }
  } }, initialize: true, allowEphemeralPort: true }), { code: 'service-host-config-invalid' });
  await assert.rejects(fs.stat(path.join(config.directory, 'collaboration.enc.json')), { code: 'ENOENT' });
  const host = await startServiceHost({ config, initialize: true, allowEphemeralPort: true }); t.after(() => host.close());
  assert.equal(host.getNotificationStatus(), null); assert.equal(await host.runNotificationDelivery(), null);
  await host.close(); await assert.rejects(host.runNotificationDelivery(), { code: 'service-host-closed' });
});
