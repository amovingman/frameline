'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { createMediaAssetIdentity } = require('./media-asset-identity');
const { fingerprint } = require('./project-api-contracts');

const MAX_INDEX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024 * 1024, MAX_CHUNKS = 65536;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ASSET = /^sha256:[a-f0-9]{64}$/;
const id = value => typeof value === 'string' && ID.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base64 = (value, size = null) => typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value
  && (size === null || Buffer.from(value, 'base64').length === size);
function fail(code) { return Object.assign(new Error(code), { code }); }
function abort(signal) {
  if (signal !== undefined && signal !== null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) throw fail('asset-request-invalid');
  if (signal?.aborted) throw fail('asset-cancelled');
}
function identity(value, maxBytes, chunkSize) {
  if (!exact(value, ['version', 'algorithm', 'contentId', 'size', 'assetClass', 'mediaType'])
    || value.version !== 1 || value.algorithm !== 'sha256' || typeof value.contentId !== 'string' || !ASSET.test(value.contentId)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maxBytes
    || Math.max(1, Math.ceil(value.size / chunkSize)) > MAX_CHUNKS
    || value.mediaType !== null && (typeof value.mediaType !== 'string' || value.mediaType.length > 127)) throw fail('asset-identity-invalid');
  let checked;
  try { checked = createMediaAssetIdentity({ size: value.size, sha256: value.contentId.slice(7) }, value); }
  catch { throw fail('asset-identity-invalid'); }
  if (fingerprint(checked) !== fingerprint(value)) throw fail('asset-identity-invalid');
  return structuredClone(checked);
}
function envelope(value) {
  if (!exact(value, ['version', 'keyId', 'algorithm', 'iv', 'tag', 'ciphertext']) || value.version !== 1
    || !id(value.keyId) || value.algorithm !== 'aes-256-gcm' || !base64(value.iv, 12) || !base64(value.tag, 16)
    || !base64(value.ciphertext) || !value.ciphertext) throw fail('asset-state-invalid');
}
function validateState(value, chunkSize, maxAssetBytes) {
  if (value?.schemaVersion > 1) throw fail('asset-state-newer-version');
  if (!exact(value, ['schemaVersion', 'generation', 'chunkSize', 'maxAssetBytes', 'uploads', 'assets'])
    || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0
    || value.chunkSize !== chunkSize || value.maxAssetBytes !== maxAssetBytes
    || !Array.isArray(value.uploads) || value.uploads.length > 10000 || !Array.isArray(value.assets) || value.assets.length > 10000) throw fail('asset-state-invalid');
  const uploads = new Map(), scoped = new Set(), completed = new Set(); let chunks = 0;
  for (const upload of value.uploads) {
    if (!exact(upload, ['id', 'projectId', 'identity', 'hashes']) || typeof upload.id !== 'string' || !UUID.test(upload.id)
      || uploads.has(upload.id) || !id(upload.projectId) || !Array.isArray(upload.hashes)) throw fail('asset-state-invalid');
    try { identity(upload.identity, maxAssetBytes, chunkSize); } catch { throw fail('asset-state-invalid'); }
    const scope = fingerprint({ projectId: upload.projectId, assetId: upload.identity.contentId });
    chunks += upload.hashes.length;
    if (scoped.has(scope) || chunks > 1_000_000 || upload.hashes.length !== Math.max(1, Math.ceil(upload.identity.size / chunkSize))
      || upload.hashes.some(value => value !== null && (typeof value !== 'string' || !SHA.test(value)))) throw fail('asset-state-invalid');
    uploads.set(upload.id, upload); scoped.add(scope);
  }
  for (const asset of value.assets) {
    if (!exact(asset, ['projectId', 'assetId', 'uploadId']) || !id(asset.projectId) || typeof asset.assetId !== 'string' || !ASSET.test(asset.assetId)
      || !uploads.has(asset.uploadId) || completed.has(asset.uploadId)) throw fail('asset-state-invalid');
    const upload = uploads.get(asset.uploadId);
    if (upload.projectId !== asset.projectId || upload.identity.contentId !== asset.assetId || !upload.hashes.every(Boolean)) throw fail('asset-state-invalid');
    completed.add(asset.uploadId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_INDEX_BYTES) throw fail('asset-state-invalid');
  return structuredClone(value);
}

async function createDurableAssetService({ directory, keyring, authorize, initialize = false, chunkSize = 1024 * 1024,
  maxAssetBytes = MAX_ASSET_BYTES, storage = fs, lockTimeoutMs = 5000 } = {}) {
  if (!path.isAbsolute(directory || '') || !keyring || typeof keyring.encrypt !== 'function' || typeof keyring.decrypt !== 'function'
    || typeof authorize !== 'function' || typeof initialize !== 'boolean' || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024 * 1024
    || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 0 || maxAssetBytes > MAX_ASSET_BYTES
    || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30000) throw fail('asset-service-invalid');
  try {
    if (initialize) await storage.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await storage.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw fail('asset-storage-unavailable');
    directory = await storage.realpath(directory);
  } catch { throw fail('asset-storage-unavailable'); }
  const indexPath = path.join(directory, 'assets.enc.json'), uploadsPath = path.join(directory, 'uploads');
  const maxChunkFile = Math.ceil((chunkSize * 4 / 3 + 1024) * 4 / 3) + 4096;
  let pending = Promise.resolve(), closing = false, uncertain = false, initialized = false, observedKeyId = null;
  const count = size => Math.max(1, Math.ceil(size / chunkSize));
  const length = (size, index) => Math.min(chunkSize, Math.max(0, size - index * chunkSize));
  async function permission(context, projectId, action) {
    if (!id(projectId)) throw fail('asset-request-invalid');
    const result = await authorize(context, projectId, action);
    if (result !== true && result?.allowed !== true) throw fail('asset-forbidden');
  }
  async function syncDir(filename) {
    const handle = await storage.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function privateDirectory(filename, create = false) {
    if (create) await storage.mkdir(filename, { mode: 0o700 });
    const stat = await storage.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || await storage.realpath(filename) !== filename) throw fail('asset-state-invalid');
  }
  async function bounded(filename, limit, code) {
    let handle;
    try {
      handle = await storage.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > limit) throw fail(code);
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw fail(code); offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail(code);
      return JSON.parse(bytes.toString('utf8'));
    } finally { await handle?.close(); }
  }
  function encrypt(value) {
    const encrypted = structuredClone(keyring.encrypt(structuredClone(value))); envelope(encrypted);
    if (fingerprint(keyring.decrypt(structuredClone(encrypted))) !== fingerprint(value)) throw fail('asset-state-invalid');
    if (observedKeyId !== null && encrypted.keyId !== observedKeyId) throw fail('asset-key-rotation-required');
    return encrypted;
  }
  async function atomic(filename, value, limit) {
    const temporary = path.join(path.dirname(filename), `.asset-${randomUUID()}.tmp`); let replacing = false;
    try {
      const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > limit) throw fail('asset-storage-unavailable');
      const handle = await storage.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      replacing = true; await storage.rename(temporary, filename); await syncDir(path.dirname(filename));
    } catch (error) {
      if (replacing) { uncertain = true; throw fail('asset-storage-uncertain'); }
      if (error?.code === 'asset-key-rotation-required') throw fail(error.code);
      throw fail('asset-storage-unavailable');
    } finally { await storage.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function state() {
    observedKeyId = null;
    try {
      const file = await bounded(indexPath, MAX_FILE_BYTES, 'asset-state-invalid');
      if (file?.schemaVersion > 1) throw fail('asset-state-newer-version');
      if (!exact(file, ['schemaVersion', 'generation', 'record']) || file.schemaVersion !== 1) throw fail('asset-state-invalid');
      envelope(file.record); const checked = validateState(keyring.decrypt(file.record), chunkSize, maxAssetBytes);
      if (checked.generation !== file.generation) throw fail('asset-state-invalid'); observedKeyId = file.record.keyId;
      return checked;
    } catch (error) {
      if (error.code === 'ENOENT' && !initialized && initialize) return null;
      throw fail(error.code === 'asset-state-newer-version' ? error.code : 'asset-state-invalid');
    }
  }
  function transact(context, projectId, action, operation, signal, startup = false) {
    if (closing) return Promise.reject(fail('asset-service-closed'));
    const next = pending.then(async () => {
      if (uncertain) throw fail('asset-storage-uncertain'); abort(signal);
      if (!startup) await permission(context, projectId, action);
      let release;
      try { release = await acquireMetadataLock(directory, lockTimeoutMs); } catch { throw fail('asset-service-busy'); }
      try {
        abort(signal); if (!startup) await permission(context, projectId, action);
        let value = await state(); const previous = value && fingerprint(value);
        if (value === null) {
          value = { schemaVersion: 1, generation: 0, chunkSize, maxAssetBytes, uploads: [], assets: [] };
          try { await privateDirectory(uploadsPath, true); await syncDir(directory); }
          catch (error) { if (error.code !== 'EEXIST') throw error; await privateDirectory(uploadsPath); }
        } else await privateDirectory(uploadsPath);
        const result = await operation(value);
        validateState(value, chunkSize, maxAssetBytes); abort(signal);
        if (!startup) await permission(context, projectId, action); abort(signal);
        if (previous !== fingerprint(value)) {
          if (value.generation === Number.MAX_SAFE_INTEGER) throw fail('asset-state-invalid'); value.generation++;
          await atomic(indexPath, { schemaVersion: 1, generation: value.generation, record: encrypt(value) }, MAX_FILE_BYTES);
        }
        initialized = true; return result;
      } catch (error) {
        const safe = new Set(['asset-state-invalid', 'asset-state-newer-version', 'asset-storage-unavailable', 'asset-storage-uncertain',
          'asset-key-rotation-required', 'asset-service-busy', 'asset-request-invalid', 'asset-forbidden', 'asset-identity-invalid',
          'asset-identity-collision', 'asset-chunk-invalid', 'asset-chunk-conflict', 'asset-chunk-corrupt', 'asset-content-mismatch',
          'asset-capacity-exceeded', 'asset-not-found', 'asset-cancelled', 'upload-not-found', 'upload-incomplete',
          'forbidden', 'access-token-invalid', 'rate-limit-exceeded']);
        throw fail(safe.has(error?.code) ? error.code : 'asset-storage-unavailable');
      } finally { try { await release(); } catch { uncertain = true; throw fail('asset-storage-uncertain'); } }
    }); pending = next.catch(() => {}); return next;
  }
  function getUpload(value, projectId, uploadId) {
    if (typeof uploadId !== 'string' || !UUID.test(uploadId)) throw fail('upload-not-found');
    const upload = value.uploads.find(item => item.id === uploadId && item.projectId === projectId);
    if (!upload) throw fail('upload-not-found'); return upload;
  }
  function getAssetUpload(value, projectId, assetId) {
    if (typeof assetId !== 'string' || !ASSET.test(assetId)) throw fail('asset-identity-invalid');
    const asset = value.assets.find(item => item.projectId === projectId && item.assetId === assetId);
    if (!asset) throw fail('asset-not-found'); return getUpload(value, projectId, asset.uploadId);
  }
  function status(value, upload) {
    return { uploadId: upload.id, assetId: upload.identity.contentId, size: upload.identity.size, chunkSize,
      chunks: upload.hashes.length, received: upload.hashes.map(Boolean), complete: value.assets.some(item => item.uploadId === upload.id) };
  }
  const receipt = upload => ({ assetId: upload.identity.contentId, size: upload.identity.size, chunkSize, chunks: upload.hashes.length, verified: true });
  async function read(upload, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= upload.hashes.length) throw fail('asset-chunk-invalid');
    if (!upload.hashes[index]) throw fail('upload-incomplete');
    try {
      const folder = path.join(uploadsPath, upload.id); await privateDirectory(folder);
      const encrypted = await bounded(path.join(folder, `${index}.enc.json`), maxChunkFile, 'asset-chunk-corrupt'); envelope(encrypted);
      const value = keyring.decrypt(encrypted);
      if (!exact(value, ['schemaVersion', 'uploadId', 'projectId', 'index', 'checksum', 'data']) || value.schemaVersion !== 1
        || value.uploadId !== upload.id || value.projectId !== upload.projectId || value.index !== index
        || value.checksum !== upload.hashes[index] || !base64(value.data, length(upload.identity.size, index))) throw fail('asset-chunk-corrupt');
      const bytes = Buffer.from(value.data, 'base64'); if (hash(bytes) !== upload.hashes[index]) throw fail('asset-chunk-corrupt'); return bytes;
    } catch { throw fail('asset-chunk-corrupt'); }
  }
  await transact(null, null, null, () => null, null, true);
  return {
    beginUpload: (context, projectId, candidate) => {
      let checked; try { checked = identity(candidate, maxAssetBytes, chunkSize); } catch (error) { return Promise.reject(error); }
      return transact(context, projectId, 'write', async value => {
        const existing = value.uploads.find(item => item.projectId === projectId && item.identity.contentId === checked.contentId);
        if (existing) {
          if (fingerprint(existing.identity) !== fingerprint(checked)) throw fail('asset-identity-collision'); return status(value, existing);
        }
        if (value.uploads.length >= 10000) throw fail('asset-capacity-exceeded');
        const upload = { id: randomUUID(), projectId, identity: checked, hashes: Array(count(checked.size)).fill(null) };
        await privateDirectory(path.join(uploadsPath, upload.id), true); await syncDir(uploadsPath);
        value.uploads.push(upload); return status(value, upload);
      });
    },
    uploadStatus: (context, projectId, uploadId) => transact(context, projectId, 'write', value => status(value, getUpload(value, projectId, uploadId))),
    putChunk: (context, projectId, uploadId, index, input, checksum, { signal } = {}) => {
      if (!Buffer.isBuffer(input) || input.length > chunkSize || typeof checksum !== 'string' || !SHA.test(checksum)) return Promise.reject(fail('asset-chunk-invalid'));
      const bytes = Buffer.from(input);
      return transact(context, projectId, 'write', async value => {
        const upload = getUpload(value, projectId, uploadId);
        if (!Number.isSafeInteger(index) || index < 0 || index >= upload.hashes.length || bytes.length !== length(upload.identity.size, index)
          || hash(bytes) !== checksum) throw fail('asset-chunk-invalid');
        if (upload.hashes[index] && upload.hashes[index] !== checksum) throw fail('asset-chunk-conflict');
        if (upload.hashes[index]) await read(upload, index);
        else {
          const folder = path.join(uploadsPath, upload.id); await privateDirectory(folder); abort(signal);
          const encrypted = encrypt({ schemaVersion: 1, uploadId, projectId, index, checksum, data: bytes.toString('base64') });
          await atomic(path.join(folder, `${index}.enc.json`), encrypted, maxChunkFile); upload.hashes[index] = checksum;
        }
        return { receivedBytes: upload.hashes.reduce((sum, digest, part) => sum + (digest ? length(upload.identity.size, part) : 0), 0),
          totalBytes: upload.identity.size, complete: false };
      }, signal);
    },
    completeUpload: (context, projectId, uploadId, { signal } = {}) => transact(context, projectId, 'write', async value => {
      const upload = getUpload(value, projectId, uploadId);
      if (value.assets.some(item => item.uploadId === uploadId)) return receipt(upload);
      if (!upload.hashes.every(Boolean)) throw fail('upload-incomplete');
      const digest = createHash('sha256'); let size = 0;
      for (let index = 0; index < upload.hashes.length; index++) { abort(signal); const bytes = await read(upload, index); digest.update(bytes); size += bytes.length; }
      if (size !== upload.identity.size || `sha256:${digest.digest('hex')}` !== upload.identity.contentId) throw fail('asset-content-mismatch');
      value.assets.push({ projectId, assetId: upload.identity.contentId, uploadId }); return receipt(upload);
    }, signal),
    getAsset: (context, projectId, assetId) => transact(context, projectId, 'read', value => {
      const upload = getAssetUpload(value, projectId, assetId);
      return { assetId, size: upload.identity.size, chunkSize, chunks: upload.hashes.length, identity: structuredClone(upload.identity) };
    }),
    readChunk: (context, projectId, assetId, index, { signal } = {}) => transact(context, projectId, 'read', async value => {
      const upload = getAssetUpload(value, projectId, assetId), bytes = await read(upload, index); abort(signal);
      return { bytes, checksum: upload.hashes[index], chunks: upload.hashes.length, totalBytes: upload.identity.size };
    }, signal),
    close: async () => { closing = true; await pending; }
  };
}
module.exports = { createDurableAssetService, MAX_ASSET_BYTES, MAX_CHUNKS };
