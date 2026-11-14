const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

// Main-process only. Electron safeStorage uses the operating system's protected
// secret facility; this module is intentionally absent from preload.js.
function createCredentialVault({ directory, safeStorage }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !safeStorage
    || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') throw fail('credential-vault-invalid');
  const filename = path.join(directory, 'credentials.enc.json');
  let pending = Promise.resolve();
  function transact(action) { const next = pending.then(action); pending = next.catch(() => {}); return next; }
  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw fail('credential-vault-corrupt');
      return parsed;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error.code ? error : fail('credential-vault-corrupt'); }
  }
  async function write(value) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function requireEncryption() { if (!safeStorage.isEncryptionAvailable()) throw fail('credential-encryption-unavailable'); }
  function set(id, secret) {
    return transact(async () => {
      if (!ID.test(id) || typeof secret !== 'string' || !secret) throw fail('credential-invalid');
      requireEncryption(); const value = await read();
      value.entries[id] = safeStorage.encryptString(secret).toString('base64'); await write(value);
      return { stored: true, id };
    });
  }
  function get(id) {
    return transact(async () => {
      if (!ID.test(id)) throw fail('credential-invalid'); requireEncryption();
      const encoded = (await read()).entries[id]; if (!encoded) return null;
      try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
      catch { throw fail('credential-vault-corrupt'); }
    });
  }
  function remove(id) {
    return transact(async () => { if (!ID.test(id)) throw fail('credential-invalid'); const value = await read();
      const removed = Object.hasOwn(value.entries, id); delete value.entries[id]; await write(value); return { removed }; });
  }
  function rotate() {
    return transact(async () => {
      requireEncryption(); const value = await read(); const plaintext = {};
      try { for (const [id, encoded] of Object.entries(value.entries)) plaintext[id] = safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
      catch { throw fail('credential-vault-corrupt'); }
      value.entries = Object.fromEntries(Object.entries(plaintext).map(([id, secret]) => [id, safeStorage.encryptString(secret).toString('base64')]));
      await write(value); return { rotated: Object.keys(value.entries).length };
    });
  }
  return { set, get, remove, rotate };
}

module.exports = { createCredentialVault };
