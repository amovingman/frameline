'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { loadServiceHostConfig, loadServiceStorageConfig, MAX_CONFIG_BYTES } = require('../src/service-host-config');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-host-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = { schemaVersion: 1, directory: path.join(root, 'data'), port: 8443,
    tls: { certFile: path.join(root, 'cert.pem'), keyFile: path.join(root, 'key.pem') },
    keyring: { activeKeyId: 'operator-key', keys: { 'operator-key': randomBytes(32).toString('base64') } } };
  await fs.writeFile(config.tls.certFile, await fs.readFile(path.join(__dirname, 'fixtures/network-tls/server.pem')), { mode: 0o644 });
  await fs.writeFile(config.tls.keyFile, await fs.readFile(path.join(__dirname, 'fixtures/network-tls/server-key.pem')), { mode: 0o600 });
  const write = value => fs.writeFile(configPath, JSON.stringify(value), { mode: 0o600 }); await write(config);
  return { root, configPath, config, write };
}

test('private host config loads explicit keys and buffers while storage-only loading does not require TLS files', async t => {
  const setup = await fixture(t); const loaded = await loadServiceHostConfig(setup.configPath);
  assert.equal(loaded.host, '127.0.0.1'); assert.equal(loaded.port, 8443); assert.equal(loaded.directory, setup.config.directory);
  assert.ok(Buffer.isBuffer(loaded.tls.cert)); assert.ok(Buffer.isBuffer(loaded.tls.key));
  assert.deepEqual(loaded.keyring.decrypt(loaded.keyring.encrypt({ probe: true })), { probe: true });
  await fs.unlink(setup.config.tls.certFile); await fs.unlink(setup.config.tls.keyFile);
  const storage = await loadServiceStorageConfig(setup.configPath); assert.equal(storage.tls, undefined); assert.equal(storage.keyring.activeKeyId, 'operator-key');
  await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-tls-unavailable' });
  await setup.write({ ...setup.config, host: '0.0.0.0' }); assert.equal((await loadServiceStorageConfig(setup.configPath)).host, '0.0.0.0');
});

test('host configuration rejects permissive schemas, nonnumeric binds, invalid ports and malformed encryption keys', async t => {
  const setup = await fixture(t);
  const edits = [value => { value.schemaVersion = 2; }, value => { value.extra = 'private-password'; }, value => { value.port = 0; },
    value => { value.port = 65536; }, value => { value.host = 'localhost'; }, value => { value.host = 'https://example.test'; },
    value => { value.directory = 'relative'; }, value => { value.tls.keyFile = 'relative'; }, value => { value.tls.passphrase = 'secret'; },
    value => { value.keyring.keys['operator-key'] = randomBytes(31).toString('base64'); },
    value => { value.keyring.keys['operator-key'] += '\n'; }, value => { value.keyring.activeKeyId = 'missing'; },
    value => { value.keyring.keys['bad/key'] = randomBytes(32).toString('base64'); }];
  for (const edit of edits) {
    const value = structuredClone(setup.config); edit(value); await setup.write(value);
    await assert.rejects(loadServiceStorageConfig(setup.configPath), error => error.code === 'service-host-config-invalid' && error.message === error.code);
  }
  await assert.rejects(loadServiceStorageConfig('relative-config.json'), { code: 'service-host-config-invalid' });
});

test('configuration reads refuse links, oversized files, invalid UTF8 and public permissions', async t => {
  const setup = await fixture(t); const linked = path.join(setup.root, 'linked.json'); await fs.symlink(setup.configPath, linked);
  await assert.rejects(loadServiceHostConfig(linked), { code: 'service-host-config-unavailable' });
  await fs.chmod(setup.configPath, 0o644); await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-unavailable' });
  await fs.chmod(setup.configPath, 0o600); await fs.writeFile(setup.configPath, 'x'.repeat(MAX_CONFIG_BYTES + 1));
  await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-unavailable' });
  await fs.writeFile(setup.configPath, Buffer.from([0xff])); await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
});

test('TLS inputs are bounded regular files and private keys cannot be broadly readable or symbolic links', async t => {
  const setup = await fixture(t); await fs.chmod(setup.config.tls.keyFile, 0o644);
  await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-tls-unavailable' });
  await fs.chmod(setup.config.tls.keyFile, 0o600); const realKey = path.join(setup.root, 'real-key.pem'); await fs.rename(setup.config.tls.keyFile, realKey);
  await fs.symlink(realKey, setup.config.tls.keyFile); await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-tls-unavailable' });
  await fs.unlink(setup.config.tls.keyFile); await fs.rename(realKey, setup.config.tls.keyFile);
  await fs.writeFile(setup.config.tls.certFile, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-tls-unavailable' });
});

test('config, encryption data and TLS files cannot overlap through lexical paths, directory aliases or hard links', async t => {
  const setup = await fixture(t);
  await setup.write({ ...setup.config, directory: setup.root });
  await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
  await setup.write({ ...setup.config, tls: { ...setup.config.tls, keyFile: setup.configPath } });
  await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
  await fs.mkdir(setup.config.directory, { mode: 0o700 }); const alias = path.join(setup.root, 'data-alias'); await fs.symlink(setup.config.directory, alias);
  await setup.write({ ...setup.config, tls: { ...setup.config.tls, keyFile: path.join(alias, 'key.pem') } });
  await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
  await setup.write(setup.config); await fs.unlink(setup.config.tls.certFile); await fs.link(setup.config.tls.keyFile, setup.config.tls.certFile);
  await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-config-invalid' });
});

test('optional asset storage requires a separate directory and a private canonical signing key', async t => {
  const setup = await fixture(t), signingKey = randomBytes(32);
  const assets = { directory: path.join(setup.root, 'blobs'), signingKey: signingKey.toString('base64') };
  await setup.write({ ...setup.config, assets });
  const loaded = await loadServiceHostConfig(setup.configPath);
  assert.deepEqual(loaded.assets, { directory: assets.directory, signingKey });
  assert.deepEqual((await loadServiceStorageConfig(setup.configPath)).assets, loaded.assets);
  for (const invalid of [null, {}, { ...assets, extra: true }, { ...assets, directory: 'relative' },
    { ...assets, signingKey: randomBytes(31).toString('base64') }, { ...assets, signingKey: assets.signingKey + '\n' },
    { ...assets, directory: setup.config.directory }, { ...assets, directory: path.join(setup.config.directory, 'nested') },
    { ...assets, directory: setup.root }]) {
    await setup.write({ ...setup.config, assets: invalid });
    await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
  }
  await fs.mkdir(setup.config.directory, { mode: 0o700 });
  const alias = path.join(setup.root, 'asset-alias'); await fs.symlink(setup.config.directory, alias);
  await setup.write({ ...setup.config, assets: { ...assets, directory: alias } });
  await assert.rejects(loadServiceStorageConfig(setup.configPath), { code: 'service-host-config-invalid' });
});

test('optional mail configuration stays private and loads explicit implicit-TLS endpoints without network discovery', async t => {
  const setup = await fixture(t), notifications = { publicOrigin: 'https://notify.example.test/', from: 'updates@example.test',
    smtp: { host: 'no-resolve.invalid', port: 465, username: null, password: null } };
  await setup.write({ ...setup.config, notifications });
  const loaded = await loadServiceHostConfig(setup.configPath);
  assert.deepEqual(loaded.notifications, { ...notifications, publicOrigin: 'https://notify.example.test' });
  assert.deepEqual((await loadServiceStorageConfig(setup.configPath)).notifications, loaded.notifications);
  for (const host of ['127.0.0.1', '::1', 'mail.example.test']) {
    const value = { ...notifications, smtp: { host, port: 65535, username: 'fixture-user', password: 'private SMTP password' } };
    await setup.write({ ...setup.config, notifications: value });
    assert.deepEqual((await loadServiceStorageConfig(setup.configPath)).notifications.smtp, value.smtp);
  }
  await setup.write(setup.config); assert.equal((await loadServiceStorageConfig(setup.configPath)).notifications, undefined);
});

test('mail configuration rejects header injection, transport fallbacks, URLs, malformed ranges and incomplete credentials', async t => {
  const setup = await fixture(t), valid = { publicOrigin: 'https://notify.example.test', from: 'updates@example.test',
    smtp: { host: 'mail.example.test', port: 465, username: null, password: null } };
  const edits = [value => { value.publicOrigin = 'http://notify.example.test'; }, value => { value.publicOrigin += '/path'; },
    value => { value.publicOrigin += '?token=private'; }, value => { value.publicOrigin = 'https://user:password@notify.example.test'; },
    value => { value.publicOrigin += '\r\n'; }, value => { value.from = 'Display <updates@example.test>'; },
    value => { value.from = 'updates@example.test\r\nBcc: other@example.test'; }, value => { value.from = 'études@example.test'; },
    value => { value.from = `${'x'.repeat(65)}@example.test`; }, value => { value.from = 'bad..dots@example.test'; },
    value => { value.smtp.host = 'https://mail.example.test'; }, value => { value.smtp.host = 'mail.example.test:465'; },
    value => { value.smtp.host = '[::1]'; }, value => { value.smtp.host = 'fe80::1%en0'; }, value => { value.smtp.host = '999.1.1.1'; },
    value => { value.smtp.port = 0; }, value => { value.smtp.port = 65536; }, value => { value.smtp.port = '465'; },
    value => { value.smtp.username = 'name'; }, value => { value.smtp.password = 'password'; },
    value => { value.smtp.username = 'name'; value.smtp.password = 'bad\r\npassword'; },
    value => { value.smtp.rejectUnauthorized = false; }, value => { value.smtp.starttls = true; },
    value => { value.smtp.tls = false; }, value => { value.extra = true; }];
  for (const edit of edits) {
    const value = structuredClone(valid); edit(value); await setup.write({ ...setup.config, notifications: value });
    await assert.rejects(loadServiceStorageConfig(setup.configPath), error => error.code === 'service-host-config-invalid'
      && error.message === error.code && !JSON.stringify(error).includes('password'));
  }
  await setup.write({ ...setup.config, notifications: null }); await assert.rejects(loadServiceHostConfig(setup.configPath), { code: 'service-host-config-invalid' });
});
