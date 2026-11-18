const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCredentialVault } = require('../src/credential-vault');

async function fixture(t, backend = 'gnome_libsecret') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-credential-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); let selected = backend; let available = true; let encryptions = 0; let decryptions = 0;
  const safeStorage = { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => selected,
    encryptString: value => { encryptions++; return Buffer.from(`fixture:${Buffer.from(value).toString('base64')}`); },
    decryptString: value => { decryptions++; return Buffer.from(value.toString().slice(8), 'base64').toString(); } };
  const filename = path.join(directory, 'credentials.enc.json');
  return { directory, filename, safeStorage, vault: createCredentialVault({ directory, safeStorage }),
    backend(value) { selected = value; }, available(value) { available = value; }, counts: () => ({ encryptions, decryptions }) };
}

test('basic_text cannot read, write or rotate credentials even when encryption reports available', async t => {
  const state = await fixture(t); await state.vault.set('service-session', 'private-session');
  const before = await fs.readFile(state.filename); const counts = state.counts(); state.backend('basic_text');
  for (const operation of [() => state.vault.get('service-session'), () => state.vault.set('service-session', 'replacement'), () => state.vault.rotate()]) {
    await assert.rejects(operation(), { code: 'credential-encryption-unavailable' });
    assert.deepEqual(await fs.readFile(state.filename), before);
  }
  assert.deepEqual(state.counts(), counts); state.backend('gnome_libsecret'); assert.equal(await state.vault.get('service-session'), 'private-session');
});

test('explicit removal remains available with a weak or unavailable backend without decrypting saved credentials', async t => {
  const state = await fixture(t); await state.vault.set('service-session', 'private-session'); await state.vault.set('other-session', 'other-private-session');
  const before = JSON.parse(await fs.readFile(state.filename, 'utf8')); const counts = state.counts();
  state.backend('basic_text'); assert.deepEqual(await state.vault.remove('service-session'), { removed: true });
  const after = JSON.parse(await fs.readFile(state.filename, 'utf8')); assert.equal(Object.hasOwn(after.entries, 'service-session'), false);
  assert.equal(after.entries['other-session'], before.entries['other-session']); assert.deepEqual(state.counts(), counts);
  for (const operation of [() => state.vault.get('other-session'), () => state.vault.set('other-session', 'replacement'), () => state.vault.rotate()])
    await assert.rejects(operation(), { code: 'credential-encryption-unavailable' });
  state.available(false); assert.deepEqual(await state.vault.remove('other-session'), { removed: true });
  assert.deepEqual(JSON.parse(await fs.readFile(state.filename, 'utf8')).entries, {}); assert.deepEqual(state.counts(), counts);
});

test('basic_text never creates a credential file and macOS-style absent backend accessor stays supported', async t => {
  const state = await fixture(t, 'basic_text');
  await assert.rejects(state.vault.set('service-session', 'private-session'), { code: 'credential-encryption-unavailable' });
  await assert.rejects(fs.stat(state.filename), { code: 'ENOENT' });
  delete state.safeStorage.getSelectedStorageBackend;
  await state.vault.set('service-session', 'private-session'); assert.equal(await state.vault.get('service-session'), 'private-session');
  assert.equal((await state.vault.rotate()).rotated, 1);
});

test('unavailable or failing encryption probes fail closed while preserving existing ciphertext', async t => {
  const state = await fixture(t); await state.vault.set('service-session', 'private-session'); const before = await fs.readFile(state.filename);
  state.available(false); await assert.rejects(state.vault.get('service-session'), { code: 'credential-encryption-unavailable' }); state.available(true);
  state.safeStorage.getSelectedStorageBackend = () => { throw new Error('/Users/private'); };
  await assert.rejects(state.vault.rotate(), error => error.code === 'credential-encryption-unavailable' && error.message === error.code);
  assert.deepEqual(await fs.readFile(state.filename), before);
});

test('credential reads refuse symlinks, non-files, oversized files and broad permissions without replacing them', async t => {
  const state = await fixture(t); const target = path.join(state.directory, 'private-target');
  await fs.writeFile(target, JSON.stringify({ version: 1, entries: {} }), { mode: 0o600 });
  await fs.symlink(target, state.filename);
  await assert.rejects(state.vault.get('service-session'), { code: 'credential-vault-corrupt' });
  assert.equal((await fs.lstat(state.filename)).isSymbolicLink(), true); await fs.unlink(state.filename);
  await fs.mkdir(state.filename, { mode: 0o700 });
  await assert.rejects(state.vault.set('service-session', 'private-session'), { code: 'credential-vault-corrupt' }); await fs.rmdir(state.filename);
  await fs.writeFile(state.filename, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(state.vault.get('service-session'), { code: 'credential-vault-corrupt' });
  assert.equal((await fs.stat(state.filename)).size, 1024 * 1024 + 1); await fs.unlink(state.filename);
  await fs.writeFile(state.filename, JSON.stringify({ version: 1, entries: {} }), { mode: 0o644 });
  await assert.rejects(state.vault.rotate(), { code: 'credential-vault-corrupt' }); assert.equal((await fs.stat(state.filename)).mode & 0o777, 0o644);
});

test('schema and entry validation reject hidden fields, invalid identifiers and malformed or excessive ciphertext', async t => {
  const state = await fixture(t);
  const cases = [{ version: 2, entries: {} }, { version: 1, entries: {}, refreshToken: 'private-token' },
    { version: 1, entries: { '/Users/private': 'YWJj' } }, { version: 1, entries: { session: '***' } },
    { version: 1, entries: { session: 'YWJj\n' } }, { version: 1, entries: { session: Buffer.alloc(128 * 1024 + 1).toString('base64') } }];
  for (const value of cases) {
    const bytes = JSON.stringify(value); await fs.writeFile(state.filename, bytes, { mode: 0o600 });
    await assert.rejects(state.vault.set('service-session', 'private-session'), { code: 'credential-vault-corrupt' });
    assert.equal(await fs.readFile(state.filename, 'utf8'), bytes);
  }
});

test('bounded secret input and prototype-like IDs remain safe through set, get and rotation', async t => {
  const state = await fixture(t);
  await assert.rejects(state.vault.set('session', 'x'.repeat(64 * 1024 + 1)), { code: 'credential-invalid' });
  await assert.rejects(state.vault.get(null), { code: 'credential-invalid' });
  assert.equal(await state.vault.get('constructor'), null);
  await assert.rejects(state.vault.set('__proto__', 'private-session'), { code: 'credential-invalid' });
  await state.vault.set('constructor', 'private-session'); assert.equal(await state.vault.get('constructor'), 'private-session');
  await state.vault.rotate(); assert.equal(await state.vault.get('constructor'), 'private-session');
  assert.equal((await state.vault.remove('constructor')).removed, true);
});
