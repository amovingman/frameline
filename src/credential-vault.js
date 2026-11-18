const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MAX_VAULT_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024;
const validId = value => typeof value === 'string' && ID.test(value);
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'entries|version' || value.version !== 1
    || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)
    || Object.keys(value.entries).length > 4096) throw fail('credential-vault-corrupt');
  for (const [id, encoded] of Object.entries(value.entries)) {
    if (!validId(id) || typeof encoded !== 'string' || encoded.length < 4
      || encoded.length > Math.ceil(MAX_ENTRY_BYTES / 3) * 4) throw fail('credential-vault-corrupt');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_ENTRY_BYTES || bytes.toString('base64') !== encoded) throw fail('credential-vault-corrupt');
  }
  return value;
}

// Main-process only. Electron safeStorage uses the operating system's protected
// secret facility; this module is intentionally absent from preload.js.
function createCredentialVault({ directory, safeStorage }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !safeStorage
    || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function'
    || safeStorage.getSelectedStorageBackend !== undefined && typeof safeStorage.getSelectedStorageBackend !== 'function') throw fail('credential-vault-invalid');
  const filename = path.join(directory, 'credentials.enc.json');
  let pending = Promise.resolve();
  function transact(action) { const next = pending.then(action); pending = next.catch(() => {}); return next; }
  async function read() {
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > MAX_VAULT_BYTES) throw fail('credential-vault-corrupt');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw fail('credential-vault-corrupt'); offset += bytesRead;
      }
      if ((await handle.stat()).size !== stat.size) throw fail('credential-vault-corrupt');
      return validate(JSON.parse(bytes.toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw fail('credential-vault-corrupt'); }
    finally { await handle?.close(); }
  }
  async function write(value, { encrypting = true } = {}) {
    if (encrypting) requireEncryption();
    validate(value); const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_VAULT_BYTES) throw fail('credential-vault-corrupt');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function requireEncryption() {
    try {
      if (safeStorage.isEncryptionAvailable() !== true
        || typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw fail('credential-encryption-unavailable');
    } catch { throw fail('credential-encryption-unavailable'); }
  }
  function set(id, secret) {
    return transact(async () => {
      if (!validId(id) || typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > MAX_SECRET_BYTES) throw fail('credential-invalid');
      requireEncryption(); const value = await read(); requireEncryption();
      Object.defineProperty(value.entries, id, { value: safeStorage.encryptString(secret).toString('base64'), enumerable: true, writable: true, configurable: true }); await write(value);
      return { stored: true, id };
    });
  }
  function get(id) {
    return transact(async () => {
      if (!validId(id)) throw fail('credential-invalid'); requireEncryption();
      const entries = (await read()).entries; requireEncryption(); if (!Object.hasOwn(entries, id)) return null; const encoded = entries[id];
      try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
      catch { throw fail('credential-vault-corrupt'); }
    });
  }
  function remove(id) {
    return transact(async () => { if (!validId(id)) throw fail('credential-invalid'); const value = await read();
      const removed = Object.hasOwn(value.entries, id); delete value.entries[id]; await write(value, { encrypting: false }); return { removed }; });
  }
  function rotate() {
    return transact(async () => {
      requireEncryption(); const value = await read(); requireEncryption(); const plaintext = Object.create(null);
      try { for (const [id, encoded] of Object.entries(value.entries)) plaintext[id] = safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
      catch { throw fail('credential-vault-corrupt'); }
      value.entries = Object.fromEntries(Object.entries(plaintext).map(([id, secret]) => [id, safeStorage.encryptString(secret).toString('base64')]));
      await write(value); return { rotated: Object.keys(value.entries).length };
    });
  }
  return { set, get, remove, rotate };
}

module.exports = { createCredentialVault };
