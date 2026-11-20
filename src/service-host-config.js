'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { TextDecoder } = require('node:util');
const { createKeyring } = require('./security-controls');

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CERT_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { return Object.assign(new Error(code), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value);
const dnsName = value => typeof value === 'string' && value.length > 0 && value.length <= 253
  && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
function validateNotificationConfig(value) {
  const invalid = () => { throw fail('service-host-config-invalid'); };
  if (!exact(value, ['publicOrigin', 'from', 'smtp']) || typeof value.publicOrigin !== 'string'
    || value.publicOrigin.length > 2048 || !value.publicOrigin.startsWith('https://') || /[\x00-\x20\x7f]/.test(value.publicOrigin)
    || typeof value.from !== 'string' || value.from.length > 254
    || !/^[\x21-\x7e]+$/.test(value.from) || !exact(value.smtp, ['host', 'port', 'username', 'password'])) invalid();
  let origin;
  try { origin = new URL(value.publicOrigin); } catch { invalid(); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') invalid();
  const parts = value.from.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || parts[0].startsWith('.')
    || parts[0].endsWith('.') || parts[0].includes('..') || !dnsName(parts[1])) invalid();
  const smtp = value.smtp;
  if (typeof smtp.host !== 'string' || smtp.host !== smtp.host.trim() || smtp.host.length > 253
    || /[\x00-\x20\x7f\[\]%/@?#\\]/.test(smtp.host)
    || !(isIP(smtp.host) || dnsName(smtp.host) && !/^[0-9.]+$/.test(smtp.host))
    || !Number.isSafeInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535
    || (smtp.username === null) !== (smtp.password === null)
    || smtp.username !== null && (typeof smtp.username !== 'string' || smtp.username.length < 1 || smtp.username.length > 256
      || /[\x00-\x1f\x7f]/.test(smtp.username) || typeof smtp.password !== 'string' || smtp.password.length < 1
      || smtp.password.length > 1024 || /[\x00-\x1f\x7f]/.test(smtp.password))) invalid();
  return { publicOrigin: origin.origin, from: value.from, smtp: { host: smtp.host, port: smtp.port, username: smtp.username, password: smtp.password } };
}

async function readFile(filename, limit, privateFile, code) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit
      || (privateFile ? (stat.mode & 0o777) !== 0o600 : (stat.mode & 0o022) !== 0)) throw fail(code);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail(code); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail(code);
    return { bytes, stat };
  } catch { throw fail(code); }
  finally { await handle?.close(); }
}
async function canonicalFuture(filename) {
  let current = path.resolve(filename); const suffix = [];
  while (true) {
    try { return path.join(await fs.realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || current === path.dirname(current)) throw fail('service-host-config-invalid');
      suffix.push(path.basename(current)); current = path.dirname(current);
    }
  }
}
function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function load(configPath, includeTls) {
  if (!absolute(configPath)) throw fail('service-host-config-invalid');
  const configFile = await readFile(configPath, MAX_CONFIG_BYTES, true, 'service-host-config-unavailable');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configFile.bytes)); }
  catch { throw fail('service-host-config-invalid'); }
  if (!exact(value, ['schemaVersion', 'directory', 'port', 'tls', 'keyring'], ['host', 'assets', 'notifications']) || value.schemaVersion !== 1
    || !absolute(value.directory) || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
    || value.host !== undefined && (typeof value.host !== 'string' || !isIP(value.host) || value.host.includes('%'))
    || !exact(value.tls, ['certFile', 'keyFile']) || !absolute(value.tls.certFile) || !absolute(value.tls.keyFile)
    || !exact(value.keyring, ['activeKeyId', 'keys']) || typeof value.keyring.activeKeyId !== 'string'
    || !ID.test(value.keyring.activeKeyId) || !object(value.keyring.keys)
    || !Object.hasOwn(value.keyring.keys, value.keyring.activeKeyId)
    || Object.keys(value.keyring.keys).length < 1 || Object.keys(value.keyring.keys).length > 16) throw fail('service-host-config-invalid');
  if (value.assets !== undefined && (!exact(value.assets, ['directory', 'signingKey',
    ...(value.assets && Object.hasOwn(value.assets, 'ownerBoundaryDeduplication') ? ['ownerBoundaryDeduplication'] : [])]) || !absolute(value.assets.directory)
    || value.assets.ownerBoundaryDeduplication !== undefined && typeof value.assets.ownerBoundaryDeduplication !== 'boolean'
    || typeof value.assets.signingKey !== 'string' || value.assets.signingKey.length !== 44
    || Buffer.from(value.assets.signingKey, 'base64').length !== 32
    || Buffer.from(value.assets.signingKey, 'base64').toString('base64') !== value.assets.signingKey)) throw fail('service-host-config-invalid');
  const keys = Object.create(null);
  for (const [id, encoded] of Object.entries(value.keyring.keys)) {
    if (!ID.test(id) || typeof encoded !== 'string' || encoded.length !== 44) throw fail('service-host-config-invalid');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== encoded) throw fail('service-host-config-invalid');
    keys[id] = bytes;
  }
  const files = [configPath, value.tls.certFile, value.tls.keyFile];
  const canonical = await Promise.all([value.directory, ...files].map(canonicalFuture));
  if (new Set(files.map(filename => path.resolve(filename))).size !== files.length || new Set(canonical.slice(1)).size !== files.length
    || files.some(filename => inside(path.resolve(value.directory), path.resolve(filename)))
    || canonical.slice(1).some(filename => inside(canonical[0], filename))) throw fail('service-host-config-invalid');
  if (value.assets) {
    const assetDirectory = path.resolve(value.assets.directory), assetCanonical = await canonicalFuture(assetDirectory);
    if (inside(assetDirectory, path.resolve(value.directory)) || inside(path.resolve(value.directory), assetDirectory)
      || inside(assetCanonical, canonical[0]) || inside(canonical[0], assetCanonical)
      || files.some(filename => inside(assetDirectory, path.resolve(filename)))
      || canonical.slice(1).some(filename => inside(assetCanonical, filename))) throw fail('service-host-config-invalid');
  }
  const config = { directory: path.resolve(value.directory), host: value.host || '127.0.0.1', port: value.port,
    keyring: createKeyring(keys, value.keyring.activeKeyId) };
  if (value.assets) config.assets = { directory: path.resolve(value.assets.directory), signingKey: Buffer.from(value.assets.signingKey, 'base64'),
    ...(value.assets.ownerBoundaryDeduplication === undefined ? {} : { ownerBoundaryDeduplication: value.assets.ownerBoundaryDeduplication }) };
  if (value.notifications !== undefined) config.notifications = validateNotificationConfig(value.notifications);
  if (includeTls) {
    const [cert, key] = await Promise.all([readFile(value.tls.certFile, MAX_CERT_BYTES, false, 'service-host-tls-unavailable'),
      readFile(value.tls.keyFile, MAX_KEY_BYTES, true, 'service-host-tls-unavailable')]);
    const stats = [configFile.stat, cert.stat, key.stat];
    if (new Set(stats.map(stat => `${stat.dev}:${stat.ino}`)).size !== stats.length) throw fail('service-host-config-invalid');
    config.tls = { cert: cert.bytes, key: key.bytes };
  }
  return config;
}
const loadServiceHostConfig = configPath => load(configPath, true);
const loadServiceStorageConfig = configPath => load(configPath, false);
module.exports = { loadServiceHostConfig, loadServiceStorageConfig, MAX_CONFIG_BYTES, validateNotificationConfig };
