'use strict';
// Offline owner tools. Never hydrate an original service runtime: opening one
// can migrate metadata or execute pending physical garbage collection.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { acquireMetadataLock } = require('./metadata-lock');
const { fingerprint } = require('./project-api-contracts');
const { validateCollaborationState } = require('./durable-collaboration-service');
const { validateDurableAssetSnapshot } = require('./durable-asset-service');

const FORMAT = 'frameline-encrypted-service-backup';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_MANIFEST = 192 * 1024 * 1024, MAX_FILES = 1_000_010, MAX_TOTAL = 2 ** 51;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const fail = code => Object.assign(new Error(code), { code });
const SAFE = new Set(['backup-invalid', 'backup-key-unavailable', 'backup-source-invalid', 'backup-source-unclassified',
  'backup-source-changed', 'backup-source-busy', 'backup-destination-exists', 'backup-destination-invalid', 'backup-storage-unavailable',
  'backup-storage-uncertain', 'backup-cancelled', 'backup-progress-failed', 'backup-review-required', 'backup-options-invalid', 'incident-record-invalid']);
const safe = error => fail(SAFE.has(error?.code) ? error.code : 'backup-storage-unavailable');
function abort(signal) { if (signal?.aborted) throw fail('backup-cancelled'); }
function controls({ signal, onProgress = () => {} } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal) || typeof onProgress !== 'function') throw fail('backup-options-invalid');
  return { signal, async progress(value) { abort(signal); try { await onProgress(value); } catch { throw fail('backup-progress-failed'); } abort(signal); } };
}
function ringValid(keyring) { if (!keyring || typeof keyring.decrypt !== 'function') throw fail('backup-key-unavailable'); }
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(key => a[key] === b[key]);
function nested(parent, child) { const relative = path.relative(parent, child); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function noLinks(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw fail('backup-source-invalid');
  let current = path.parse(filename).root;
  for (const segment of path.resolve(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); if ((await fs.lstat(current)).isSymbolicLink()) throw fail('backup-source-invalid');
  }
  return path.resolve(filename);
}
async function privateRoot(directory) {
  await noLinks(directory); const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) throw fail('backup-source-invalid'); return path.resolve(directory);
}
async function regular(filename, limit) {
  await noLinks(filename); const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > limit) throw fail('backup-source-invalid');
  return stat;
}
async function readFile(filename, limit, ctl, save = true) {
  abort(ctl.signal); const before = await regular(filename, limit); const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash('sha256'), chunks = []; let size = 0;
  try {
    if (!unchanged(before, await handle.stat())) throw fail('backup-source-changed');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      abort(ctl.signal); size += chunk.length;
      if (size > before.size || size > limit) throw fail('backup-source-changed');
      hash.update(chunk); if (save) chunks.push(chunk);
    }
    if (size !== before.size || !unchanged(before, await handle.stat()) || !unchanged(before, await regular(filename, limit))) throw fail('backup-source-changed');
    return { stat: before, size, sha256: hash.digest('hex'), ...(save ? { bytes: Buffer.concat(chunks, size) } : {}) };
  } finally { await handle.close(); }
}
async function jsonFile(filename, limit, ctl) {
  const read = await readFile(filename, limit, ctl);
  try { return { ...read, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) }; }
  catch { throw fail('backup-source-invalid'); }
}
function envelope(record) {
  const base64 = (text, size = null) => typeof text === 'string' && Buffer.from(text, 'base64').toString('base64') === text && (size === null || Buffer.from(text, 'base64').length === size);
  if (!exact(record, ['version', 'keyId', 'algorithm', 'iv', 'tag', 'ciphertext']) || record.version !== 1 || record.algorithm !== 'aes-256-gcm'
    || typeof record.keyId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(record.keyId)
    || !base64(record.iv, 12) || !base64(record.tag, 16) || !base64(record.ciphertext) || !record.ciphertext) throw fail('backup-source-invalid');
}
function decrypt(record, keyring, keyIds) {
  envelope(record); let value;
  try { value = keyring.decrypt(record); } catch { throw fail('backup-key-unavailable'); }
  keyIds.add(record.keyId); return value;
}
async function stateFile(directory, name, limit, kind, keyring, ctl, keyIds) {
  const read = await jsonFile(path.join(directory, name), limit, ctl), file = read.value;
  if (!exact(file, ['schemaVersion', 'generation', 'record']) || file.schemaVersion !== 1 || !Number.isSafeInteger(file.generation) || file.generation < 0) throw fail('backup-source-invalid');
  const value = decrypt(file.record, keyring, keyIds);
  try { kind === 'collaboration' ? validateCollaborationState(value) : validateDurableAssetSnapshot(value); }
  catch { throw fail('backup-source-invalid'); }
  if (file.generation !== value.generation) throw fail('backup-source-invalid');
  return { ...read, state: value };
}
async function names(directory, expected, directories = new Set()) {
  const listed = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of listed) {
    if (!expected.has(entry.name) || entry.isSymbolicLink() || (directories.has(entry.name) ? !entry.isDirectory() : !entry.isFile())) throw fail('backup-source-unclassified');
  }
  return listed.map(entry => entry.name);
}
async function inventory({ directory, assetsDirectory, keyring }, ctl, allowLocks = true) {
  ringValid(keyring); directory = await privateRoot(directory);
  if (assetsDirectory) { assetsDirectory = await privateRoot(assetsDirectory); if (nested(directory, assetsDirectory) || nested(assetsDirectory, directory)) throw fail('backup-source-invalid'); }
  const keyIds = new Set(), files = [], directories = ['collaboration'];
  await names(directory, new Set(['collaboration.enc.json', ...(allowLocks ? ['metadata.lock'] : [])]));
  const history = await stateFile(directory, 'collaboration.enc.json', 96 * 1024 * 1024, 'collaboration', keyring, ctl, keyIds);
  files.push({ path: 'collaboration/collaboration.enc.json', byteLength: history.size, sha256: history.sha256, source: path.join(directory, 'collaboration.enc.json'), stat: history.stat });
  let assets = null;
  if (assetsDirectory) {
    await names(assetsDirectory, new Set(['assets.enc.json', 'uploads', ...(allowLocks ? ['metadata.lock'] : [])]), new Set(['uploads']));
    assets = await stateFile(assetsDirectory, 'assets.enc.json', 48 * 1024 * 1024, 'assets', keyring, ctl, keyIds);
    files.push({ path: 'assets/assets.enc.json', byteLength: assets.size, sha256: assets.sha256, source: path.join(assetsDirectory, 'assets.enc.json'), stat: assets.stat });
    directories.push('assets', 'assets/uploads'); const uploadsRoot = await privateRoot(path.join(assetsDirectory, 'uploads'));
    const state = assets.state, live = state.schemaVersion >= 5 ? state.blobs : state.uploads;
    const pending = state.schemaVersion >= 5 ? state.garbageCollection.pending.map(item => item.blob) : [];
    const blobs = new Map([...live.map(blob => [blob.id, { blob, pending: false }]), ...pending.map(blob => [blob.id, { blob, pending: true }])]);
    const physical = new Set(await names(uploadsRoot, new Set(blobs.keys()), new Set(blobs.keys())));
    const published = new Set(state.assets.map(asset => {
      const upload = state.uploads.find(item => item.id === asset.uploadId); return state.schemaVersion >= 5 ? upload.blobId : upload.id;
    }));
    for (const [id, item] of blobs) {
      abort(ctl.signal); const { blob } = item;
      if (!physical.has(id)) { if (!item.pending) throw fail('backup-source-invalid'); continue; }
      const folder = await privateRoot(path.join(uploadsRoot, id)); directories.push(`assets/uploads/${id}`);
      const expected = new Set(blob.hashes.map((_, index) => `${index}.enc.json`)); const entries = new Set(await names(folder, expected));
      const fullHash = createHash('sha256'); let fullSize = 0, allPresent = true;
      const chunkLimit = Math.ceil((state.chunkSize * 4 / 3 + 1024) * 4 / 3) + 4096;
      for (let index = 0; index < blob.hashes.length; index++) {
        const name = `${index}.enc.json`;
        if (!entries.has(name)) { allPresent = false; if (blob.hashes[index] !== null && !item.pending) throw fail('backup-source-invalid'); continue; }
        const filename = path.join(folder, name), read = await jsonFile(filename, chunkLimit, ctl), payload = decrypt(read.value, keyring, keyIds);
        const expectedSize = Math.min(state.chunkSize, Math.max(0, blob.identity.size - index * state.chunkSize));
        if (!exact(payload, ['schemaVersion', 'uploadId', 'projectId', 'index', 'checksum', 'data']) || payload.schemaVersion !== 1 || payload.uploadId !== id
          || payload.projectId !== blob.projectId || payload.index !== index || !SHA.test(payload.checksum || '') || typeof payload.data !== 'string') throw fail('backup-source-invalid');
        const bytes = Buffer.from(payload.data, 'base64');
        if (bytes.toString('base64') !== payload.data || bytes.length !== expectedSize || createHash('sha256').update(bytes).digest('hex') !== payload.checksum
          || blob.hashes[index] !== null && blob.hashes[index] !== payload.checksum) throw fail('backup-source-invalid');
        fullHash.update(bytes); fullSize += bytes.length;
        files.push({ path: `assets/uploads/${id}/${name}`, byteLength: read.size, sha256: read.sha256, source: filename, stat: read.stat });
        if (files.length > MAX_FILES) throw fail('backup-source-invalid');
        await ctl.progress({ phase: 'validating', completedFiles: files.length, totalFiles: null });
      }
      if (allPresent && (published.has(id) || item.pending) && (fullSize !== blob.identity.size || `sha256:${fullHash.digest('hex')}` !== blob.identity.contentId)) throw fail('backup-source-invalid');
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path)); directories.sort();
  return { files, directories, keyIds: [...keyIds].sort(), assetsIncluded: !!assetsDirectory,
    schemas: { collaboration: history.state.schemaVersion, assets: assets?.state.schemaVersion ?? null },
    generations: { collaboration: history.state.generation, assets: assets?.state.generation ?? null },
    containsSessions: true, containsNotificationState: history.state.schemaVersion >= 6 };
}
function descriptor(file) { return { path: file.path, byteLength: file.byteLength, sha256: file.sha256 }; }
function bodyFor(loaded) { const { sha256, ...body } = loaded; return body; }
function summary(manifest) { return { format: FORMAT, version: 1, backupId: manifest.backupId, sha256: manifest.sha256, createdAt: manifest.createdAt,
  fileCount: manifest.files.length, byteLength: manifest.files.reduce((sum, file) => sum + file.byteLength, 0), assetsIncluded: manifest.assetsIncluded,
  schemas: manifest.schemas, generations: manifest.generations, containsSessions: true, containsNotificationState: manifest.containsNotificationState,
  requiresSeparateKeys: true, verified: true }; }
function manifestValid(value) {
  if (!exact(value, ['format', 'version', 'backupId', 'createdAt', 'assetsIncluded', 'schemas', 'generations', 'keyIds', 'files', 'directories', 'containsSessions', 'containsNotificationState', 'sha256'])
    || value.format !== FORMAT || value.version !== 1 || !UUID.test(value.backupId || '') || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.assetsIncluded !== 'boolean' || value.containsSessions !== true || typeof value.containsNotificationState !== 'boolean'
    || !exact(value.schemas, ['collaboration', 'assets']) || !exact(value.generations, ['collaboration', 'assets'])
    || ![1, 2, 3, 4, 5, 6, 7].includes(value.schemas.collaboration) || !Number.isSafeInteger(value.generations.collaboration) || value.generations.collaboration < 0
    || (value.assetsIncluded ? ![1, 2, 3, 4, 5].includes(value.schemas.assets) || !Number.isSafeInteger(value.generations.assets) || value.generations.assets < 0 : value.schemas.assets !== null || value.generations.assets !== null)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES || !Array.isArray(value.directories) || value.directories.length > 20003
    || !Array.isArray(value.keyIds) || value.keyIds.length < 1 || value.keyIds.length > 16 || value.keyIds.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key))
    || !SHA.test(value.sha256 || '') || fingerprint(bodyFor(value)) !== value.sha256) throw fail('backup-invalid');
  const files = new Set(), dirs = new Set(); let total = 0;
  for (const file of value.files) {
    if (!exact(file, ['path', 'byteLength', 'sha256']) || typeof file.path !== 'string' || !/^(?:collaboration\/collaboration\.enc\.json|assets\/assets\.enc\.json|assets\/uploads\/[a-f0-9-]{36}\/(?:0|[1-9][0-9]{0,4})\.enc\.json)$/.test(file.path)
      || files.has(file.path) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 1 || file.byteLength > 96 * 1024 * 1024 || !SHA.test(file.sha256 || '')) throw fail('backup-invalid');
    files.add(file.path); total += file.byteLength;
  }
  for (const dir of value.directories) {
    if (typeof dir !== 'string' || !/^(?:collaboration|assets|assets\/uploads|assets\/uploads\/[a-f0-9-]{36})$/.test(dir) || dirs.has(dir)) throw fail('backup-invalid'); dirs.add(dir);
  }
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL || !files.has('collaboration/collaboration.enc.json') || !dirs.has('collaboration')
    || value.assetsIncluded !== files.has('assets/assets.enc.json') || value.files.some(file => file.path.startsWith('assets/') && !value.assetsIncluded)) throw fail('backup-invalid');
  return value;
}
async function verifyInternal(options, ctl) {
  ringValid(options.keyring); const root = await privateRoot(options.backupDirectory);
  const manifest = manifestValid((await jsonFile(path.join(root, 'backup.json'), MAX_MANIFEST, ctl)).value);
  await names(root, new Set(['backup.json', 'collaboration', ...(manifest.assetsIncluded ? ['assets'] : [])]), new Set(['collaboration', ...(manifest.assetsIncluded ? ['assets'] : [])]));
  const actual = await inventory({ directory: path.join(root, 'collaboration'), assetsDirectory: manifest.assetsIncluded ? path.join(root, 'assets') : undefined, keyring: options.keyring }, ctl, false);
  if (fingerprint(actual.files.map(descriptor)) !== fingerprint(manifest.files) || fingerprint(actual.directories) !== fingerprint(manifest.directories)
    || fingerprint(actual.schemas) !== fingerprint(manifest.schemas) || fingerprint(actual.generations) !== fingerprint(manifest.generations)
    || fingerprint(actual.keyIds) !== fingerprint(manifest.keyIds) || actual.containsNotificationState !== manifest.containsNotificationState) throw fail('backup-invalid');
  return { manifest, actual, root };
}
async function newTarget(destination, sources) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0') || path.resolve(destination) === path.parse(destination).root) throw fail('backup-destination-invalid');
  destination = path.resolve(destination); const parent = path.dirname(destination); await noLinks(parent);
  const parentStat = await fs.lstat(parent); if (!parentStat.isDirectory() || parentStat.mode & 0o022) throw fail('backup-destination-invalid');
  if (sources.some(source => nested(source, destination) || nested(destination, source))) throw fail('backup-destination-invalid');
  try { await fs.mkdir(destination, { mode: 0o700 }); } catch (error) { throw fail(error.code === 'EEXIST' ? 'backup-destination-exists' : 'backup-storage-unavailable'); }
  const identity = await fs.lstat(destination), token = randomUUID(); const ownedFiles = new Map(), ownedDirs = new Map([[destination, identity]]);
  async function assertDirectory(directory) {
    for (let folder = directory; folder !== path.dirname(destination); folder = path.dirname(folder)) {
      const owned = ownedDirs.get(folder), stat = await fs.lstat(folder);
      if (!owned || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.mode & 0o077) throw fail('backup-destination-invalid');
    }
  }
  async function write(filename, bytes) {
    await assertDirectory(path.dirname(filename));
    const handle = await fs.open(filename, 'wx', 0o600); ownedFiles.set(filename, await handle.stat());
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  await write(path.join(destination, 'owner.json'), JSON.stringify({ owner: FORMAT, token }));
  return { destination, token, ownedFiles, ownedDirs, write, assertDirectory, async cleanup() {
    try {
      const root = await fs.lstat(destination); if (root.dev !== identity.dev || root.ino !== identity.ino || root.isSymbolicLink()) return;
      const marker = (await jsonFile(path.join(destination, 'owner.json'), 512, {})).value; if (marker.owner !== FORMAT || marker.token !== token) return;
      for (const [filename, expected] of [...ownedFiles].sort((a, b) => Number(path.basename(a[0]) === 'owner.json') - Number(path.basename(b[0]) === 'owner.json'))) {
        await noLinks(path.dirname(filename));
        for (let folder = path.dirname(filename); folder !== path.dirname(destination); folder = path.dirname(folder)) {
          const owned = ownedDirs.get(folder), stat = await fs.lstat(folder);
          if (!owned || !stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino) return;
        }
        const current = await fs.lstat(filename); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== expected.dev || current.ino !== expected.ino) return;
        await fs.unlink(filename);
      }
      for (const [dir, expected] of [...ownedDirs].sort((a, b) => b[0].length - a[0].length)) {
        const current = await fs.lstat(dir); if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) return;
        await fs.rmdir(dir);
      }
    } catch { /* Preserve unknown or modified destination evidence. */ }
  } };
}
async function syncDirectory(directory) { const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function acquireBackupLock(directory, ctl) {
  const deadline = Date.now() + 5000;
  while (true) {
    abort(ctl.signal);
    try {
      const lock = await fs.lstat(path.join(directory, 'metadata.lock'));
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || lock.size > 512 || (lock.mode & 0o777) !== 0o600) throw fail('backup-source-invalid');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { return await acquireMetadataLock(directory, 0); }
    catch (error) {
      if (error.code !== 'metadata-locked' || Date.now() >= deadline) throw fail('backup-source-busy');
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); ctl.signal?.removeEventListener('abort', cancel); reject(fail('backup-cancelled')); };
        const timer = setTimeout(() => { ctl.signal?.removeEventListener('abort', cancel); resolve(); }, 25);
        ctl.signal?.addEventListener('abort', cancel, { once: true }); if (ctl.signal?.aborted) cancel();
      });
    }
  }
}
async function copyInventory(target, actual, ctl) {
  for (const relative of [...actual.directories].sort((a, b) => a.length - b.length)) {
    const folder = path.join(target.destination, relative); await target.assertDirectory(path.dirname(folder));
    await fs.mkdir(folder, { mode: 0o700 }); target.ownedDirs.set(folder, await fs.lstat(folder));
  }
  const totalBytes = actual.files.reduce((sum, file) => sum + file.byteLength, 0); let copiedBytes = 0, completedFiles = 0;
  // Publish both state indexes after their chunk payloads; no server is started.
  const ordered = [...actual.files].sort((a, b) => Number(!a.path.includes('/uploads/')) - Number(!b.path.includes('/uploads/')));
  for (const file of ordered) {
    abort(ctl.signal); await ctl.progress({ phase: 'copying', completedFiles, totalFiles: actual.files.length, bytesRead: copiedBytes, totalBytes });
    let before;
    try { before = await regular(file.source, file.byteLength); } catch { throw fail('backup-source-changed'); }
    if (!unchanged(before, file.stat)) throw fail('backup-source-changed');
    const source = await fs.open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), destination = path.join(target.destination, file.path);
    let output;
    const hash = createHash('sha256'); let size = 0;
    try {
      await target.assertDirectory(path.dirname(destination));
      output = await fs.open(destination, 'wx', 0o600); target.ownedFiles.set(destination, await output.stat());
      if (!unchanged(before, await source.stat())) throw fail('backup-source-changed');
      for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
        abort(ctl.signal); size += chunk.length; if (size > file.byteLength) throw fail('backup-source-changed');
        hash.update(chunk); await output.writeFile(chunk); copiedBytes += chunk.length;
        await ctl.progress({ phase: 'copying', completedFiles, totalFiles: actual.files.length, bytesRead: copiedBytes, totalBytes });
      }
      if (size !== file.byteLength || hash.digest('hex') !== file.sha256 || !unchanged(before, await source.stat()) || !unchanged(before, await regular(file.source, file.byteLength))) throw fail('backup-source-changed');
      await output.sync();
    } finally { await source.close(); await output?.close(); }
    completedFiles++;
  }
  for (const relative of [...actual.directories].sort((a, b) => b.length - a.length)) await syncDirectory(path.join(target.destination, relative));
}
async function assertInventoryUnchanged(actual, roots, allowLocks) {
  const expected = new Map(actual.directories.map(dir => [dir, { names: new Set(), dirs: new Set() }]));
  for (const relative of actual.directories) {
    const parent = path.posix.dirname(relative); if (expected.has(parent)) { expected.get(parent).names.add(path.posix.basename(relative)); expected.get(parent).dirs.add(path.posix.basename(relative)); }
  }
  for (const file of actual.files) expected.get(path.posix.dirname(file.path)).names.add(path.posix.basename(file.path));
  for (const [relative, children] of expected) {
    const [kind, ...suffix] = relative.split('/'); const directory = path.join(roots[kind], ...suffix); await privateRoot(directory);
    if (allowLocks && !suffix.length) children.names.add('metadata.lock');
    await names(directory, children.names, children.dirs);
  }
  for (const file of actual.files) {
    let current; try { current = await regular(file.source, file.byteLength); } catch { throw fail('backup-source-changed'); }
    if (!unchanged(file.stat, current)) throw fail('backup-source-changed');
  }
}
async function seal(target, name, value) {
  await target.assertDirectory(target.destination);
  const markerPath = path.join(target.destination, 'owner.json'), marker = await jsonFile(markerPath, 512, {});
  const expected = target.ownedFiles.get(markerPath);
  if (marker.stat.dev !== expected.dev || marker.stat.ino !== expected.ino || marker.value.owner !== FORMAT || marker.value.token !== target.token) throw fail('backup-destination-invalid');
  const children = [...target.ownedDirs.keys()].filter(directory => directory !== target.destination && path.dirname(directory) === target.destination).map(directory => path.basename(directory));
  await names(target.destination, new Set(['owner.json', ...children]), new Set(children));
  await target.write(path.join(target.destination, name), `${JSON.stringify(value)}\n`);
  try {
    await fs.unlink(path.join(target.destination, 'owner.json')); target.ownedFiles.delete(path.join(target.destination, 'owner.json'));
    await syncDirectory(target.destination); await syncDirectory(path.dirname(target.destination));
  } catch { target.ambiguous = true; throw fail('backup-storage-uncertain'); }
}
async function createServiceBackup(options = {}) {
  let target, releaseAssets, releaseHistory, committed = false;
  try {
    const ctl = controls(options); ringValid(options.keyring);
    const directory = await privateRoot(options.directory), assetsDirectory = options.assetsDirectory ? await privateRoot(options.assetsDirectory) : undefined;
    if (assetsDirectory && (nested(directory, assetsDirectory) || nested(assetsDirectory, directory))) throw fail('backup-source-invalid');
    await ctl.progress({ phase: 'locking', completedFiles: 0, totalFiles: null });
    if (assetsDirectory) releaseAssets = await acquireBackupLock(assetsDirectory, ctl);
    releaseHistory = await acquireBackupLock(directory, ctl);
    abort(ctl.signal); const actual = await inventory({ directory, assetsDirectory, keyring: options.keyring }, ctl);
    const body = { format: FORMAT, version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), assetsIncluded: actual.assetsIncluded,
      schemas: actual.schemas, generations: actual.generations, keyIds: actual.keyIds, files: actual.files.map(descriptor), directories: actual.directories,
      containsSessions: true, containsNotificationState: actual.containsNotificationState };
    const manifest = { ...body, sha256: fingerprint(body) };
    manifestValid(manifest);
    target = await newTarget(options.destination, [directory, ...(assetsDirectory ? [assetsDirectory] : [])]);
    await copyInventory(target, actual, ctl);
    const copied = await inventory({ directory: path.join(target.destination, 'collaboration'), assetsDirectory: assetsDirectory ? path.join(target.destination, 'assets') : undefined, keyring: options.keyring }, ctl, false);
    if (fingerprint(copied.files.map(descriptor)) !== fingerprint(manifest.files)) throw fail('backup-source-changed');
    await assertInventoryUnchanged(actual, { collaboration: directory, assets: assetsDirectory }, true);
    await assertInventoryUnchanged(copied, { collaboration: path.join(target.destination, 'collaboration'), assets: path.join(target.destination, 'assets') }, false);
    await seal(target, 'backup.json', manifest); committed = true;
    try { await ctl.progress({ phase: 'complete', completedFiles: manifest.files.length, totalFiles: manifest.files.length }); } catch {}
    return summary(manifest);
  } catch (error) { throw safe(error); }
  finally {
    if (target && !committed && !target.ambiguous) await target.cleanup();
    let releaseFailed = false;
    try { await releaseHistory?.(); } catch { releaseFailed = true; }
    try { await releaseAssets?.(); } catch { releaseFailed = true; }
    if (releaseFailed) throw fail('backup-storage-uncertain');
  }
}
async function verifyServiceBackup(options = {}) {
  try { const ctl = controls(options); const { manifest } = await verifyInternal(options, ctl); return summary(manifest); }
  catch (error) { throw safe(error); }
}
async function restoreServiceBackup(options = {}) {
  let target, committed = false;
  try {
    if (options.confirmed !== true || !SHA.test(options.expectedSha256 || '')) throw fail('backup-review-required');
    const ctl = controls(options), checked = await verifyInternal(options, ctl);
    if (checked.manifest.sha256 !== options.expectedSha256) throw fail('backup-review-required');
    target = await newTarget(options.destination, [checked.root]); await copyInventory(target, checked.actual, ctl);
    const copied = await inventory({ directory: path.join(target.destination, 'collaboration'), assetsDirectory: checked.manifest.assetsIncluded ? path.join(target.destination, 'assets') : undefined, keyring: options.keyring }, ctl, false);
    if (fingerprint(copied.files.map(descriptor)) !== fingerprint(checked.manifest.files)) throw fail('backup-source-changed');
    await assertInventoryUnchanged(checked.actual, { collaboration: path.join(checked.root, 'collaboration'), assets: path.join(checked.root, 'assets') }, false);
    await assertInventoryUnchanged(copied, { collaboration: path.join(target.destination, 'collaboration'), assets: path.join(target.destination, 'assets') }, false);
    await seal(target, 'restore.json', { ...summary(checked.manifest), accessState: 'historical-sessions-permissions-and-consent', automaticStartup: false }); committed = true;
    return summary(checked.manifest);
  } catch (error) { throw safe(error); }
  finally { if (target && !committed && !target.ambiguous) await target.cleanup(); }
}
const INCIDENT_CODES = new Set(['none', 'file-unavailable', 'file-access-denied', 'file-busy', 'file-too-large', 'scan-failed',
  'scan-cancelled', 'revision-source-changed', 'invalid-manifest', 'metadata-unavailable', 'metadata-corrupt',
  'collaboration-state-invalid', 'collaboration-state-newer-version', 'collaboration-storage-unavailable', 'collaboration-storage-uncertain',
  'asset-state-invalid', 'asset-state-newer-version', 'asset-storage-unavailable', 'asset-storage-uncertain', 'asset-chunk-corrupt',
  'asset-content-mismatch', 'asset-forbidden', 'asset-policy-forbidden', 'asset-lifecycle-plan-stale', 'asset-gc-blocked',
  'access-token-invalid', 'forbidden', 'service-offline', 'service-host-failed', 'service-host-shutdown-failed',
  'backup-invalid', 'backup-key-unavailable', 'backup-source-invalid', 'backup-source-unclassified', 'backup-source-changed',
  'backup-source-busy', 'backup-destination-exists', 'backup-storage-unavailable', 'backup-storage-uncertain', 'backup-cancelled']);
async function recordOwnerIncident({ directory, record, now = Date.now } = {}) {
  try {
    if (!exact(record, ['category', 'severity', 'stage', 'buildVersion', 'errorCodes', 'backupSha256'])
      || !['corruption', 'access', 'compatibility', 'transfer', 'update', 'security', 'recovery'].includes(record.category)
      || !['low', 'medium', 'high'].includes(record.severity) || !['opened', 'contained', 'verified', 'closed'].includes(record.stage)
      || typeof record.buildVersion !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(record.buildVersion)
      || !Array.isArray(record.errorCodes) || record.errorCodes.length < 1 || record.errorCodes.length > 16 || record.errorCodes.some(code => !INCIDENT_CODES.has(code))
      || new Set(record.errorCodes).size !== record.errorCodes.length || !(record.backupSha256 === null || SHA.test(record.backupSha256))
      || typeof now !== 'function' || typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('incident-record-invalid');
    const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('incident-record-invalid');
    await noLinks(path.dirname(directory));
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateRoot(directory); const incidentId = randomUUID();
    const body = { schemaVersion: 1, incidentId, recordedAt: new Date(at).toISOString(), responsibility: 'project-owner', ...structuredClone(record) };
    const receipt = { ...body, sha256: fingerprint(body) }, filename = path.join(directory, `incident-${incidentId}.json`);
    const handle = await fs.open(filename, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory); return { saved: true, incidentId, sha256: receipt.sha256, record: body };
  } catch (error) { throw safe(error); }
}
module.exports = { createServiceBackup, verifyServiceBackup, restoreServiceBackup, recordOwnerIncident };
