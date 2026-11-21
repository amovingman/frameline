'use strict';
const { createOwnedTransferStaging } = require('./owned-transfer-staging');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { acquireMetadataLock } = require('./metadata-lock');
const { createMediaAssetIdentity } = require('./media-asset-identity');
const { validateIdentity, validateUpload, validateMetadata, validateComplete, validateProgress, MAX_ASSET_BYTES } = require('./asset-http-transport');

const CHUNK = 1024 * 1024, MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/, ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SAFE = new Set(['asset-file-invalid', 'asset-source-changed', 'asset-identity-mismatch', 'asset-destination-exists',
  'asset-checkpoint-invalid', 'asset-cache-corrupt', 'asset-progress-failed', 'asset-rate-invalid', 'asset-cancelled',
  'asset-local-io-failed', 'asset-local-io-uncertain', 'asset-transfer-busy', 'asset-network-unavailable', 'access-token-invalid',
  'forbidden', 'asset-forbidden', 'project-not-found', 'asset-not-found', 'upload-not-found', 'asset-upload-not-found',
  'asset-ticket-invalid', 'asset-identity-collision', 'asset-chunk-conflict', 'upload-incomplete', 'asset-upload-incomplete',
  'asset-content-mismatch', 'asset-identity-invalid', 'asset-chunk-invalid', 'asset-chunk-corrupt', 'asset-state-invalid',
  'asset-storage-unavailable', 'asset-storage-uncertain', 'asset-response-invalid', 'asset-response-too-large',
  'asset-request-invalid', 'asset-request-too-large', 'asset-service-failed', 'request-too-large', 'body-invalid',
  'request-invalid', 'invalid-request-headers', 'asset-service-busy', 'rate-limit-exceeded',
  'service-sign-in-required', 'service-credential-storage-unavailable', 'asset-selection-changed',
  'asset-policy-invalid', 'asset-policy-forbidden', 'asset-policy-version-conflict', 'asset-policy-excluded',
  'asset-archive-invalid', 'asset-archive-conflict', 'asset-archived']);
function fail(code) { return Object.assign(new Error(code), { code }); }
const safe = error => fail(SAFE.has(error?.code) ? error.code : 'asset-local-io-failed');
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
function check(signal) {
  if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw fail('asset-request-invalid');
  if (signal?.aborted) throw fail('asset-cancelled');
}
function settings(signal, onProgress, rate = null) {
  check(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('asset-progress-failed');
  if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1024)) throw fail('asset-rate-invalid');
}
async function progress(onProgress, phase, bytes, totalBytes, signal) {
  check(signal);
  try { await onProgress?.({ phase, bytes, totalBytes }); } catch { throw fail('asset-progress-failed'); }
  check(signal);
}
async function wait(ms, signal) {
  check(signal); if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(fail('asset-cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  });
}
const pace = (bytes, rate, signal) => rate === null ? Promise.resolve() : wait(Math.ceil(bytes * 1000 / rate), signal);
async function noLinks(filename, allowMissingLeaf = false) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]/.test(filename)) throw fail('asset-file-invalid');
  const absolute = path.resolve(filename); let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw fail('asset-file-invalid'); }
    catch (error) { if (allowMissingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return absolute; throw error; }
  }
  return absolute;
}
async function openSource(filename) {
  let handle;
  try {
    const absolute = await noLinks(filename);
    handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(MAX_ASSET_BYTES)) throw fail('asset-file-invalid');
    return { handle, stat, filename: absolute, size: Number(stat.size) };
  } catch (error) { await handle?.close().catch(() => {}); throw SAFE.has(error.code) ? error : fail('asset-file-invalid'); }
}
async function stable(source) {
  const after = await source.handle.stat({ bigint: true });
  let named;
  try { await noLinks(source.filename); named = await fs.lstat(source.filename, { bigint: true }); }
  catch { throw fail('asset-source-changed'); }
  if (!sameStat(source.stat, after) || !sameStat(source.stat, named) || !named.isFile()) throw fail('asset-source-changed');
}
async function readAt(handle, size, offset) {
  const bytes = Buffer.alloc(size); let done = 0;
  while (done < size) { const { bytesRead } = await handle.read(bytes, done, size - done, offset + done); if (!bytesRead) throw fail('asset-source-changed'); done += bytesRead; }
  return bytes;
}
async function hashSource(source, phase, signal, onProgress) {
  const digest = createHash('sha256'); let bytes = 0; await progress(onProgress, phase, 0, source.size, signal);
  while (bytes < source.size) {
    check(signal); const part = await readAt(source.handle, Math.min(CHUNK, source.size - bytes), bytes); digest.update(part); bytes += part.length;
    await progress(onProgress, phase, bytes, source.size, signal);
  }
  await stable(source); return digest.digest('hex');
}
async function inspectAssetFile(filename, { assetClass = 'other', mediaType = null, signal, onProgress } = {}) {
  let source;
  try {
    settings(signal, onProgress); source = await openSource(filename);
    const hash = await hashSource(source, 'hashing', signal, onProgress);
    return { identity: validateIdentity(createMediaAssetIdentity({ size: source.size, sha256: hash }, { assetClass, mediaType })) };
  } catch (error) { throw safe(error); } finally { await source?.handle.close().catch(() => {}); }
}
async function cancelVerification(client, projectId, uploadId) {
  if (typeof client.cancelVerification !== 'function') return;
  const controller = new AbortController(); let timer;
  try {
    await Promise.race([Promise.resolve().then(() => client.cancelVerification(projectId, uploadId, { signal: controller.signal })).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 3000); })]);
  } finally { clearTimeout(timer); }
}
async function uploadAssetFile({ client, projectId, filename, identity, signal, onProgress, maxBytesPerSecond = null } = {}) {
  let source, uploadId = null, verifying = false;
  try {
    settings(signal, onProgress, maxBytesPerSecond);
    if (!client || !['beginUpload', 'putChunk', 'completeUpload'].every(name => typeof client[name] === 'function')
      || typeof projectId !== 'string' || !ID.test(projectId)) throw fail('asset-request-invalid');
    const expected = validateIdentity(identity); source = await openSource(filename);
    if (source.size !== expected.size || `sha256:${await hashSource(source, 'hashing', signal, onProgress)}` !== expected.contentId) throw fail('asset-identity-mismatch');
    const state = validateUpload(await client.beginUpload(projectId, expected, { signal })); uploadId = state.uploadId;
    if (state.assetId !== expected.contentId || state.size !== expected.size) throw fail('asset-response-invalid');
    let uploaded = state.received.reduce((sum, received, index) => sum + (received ? Math.min(state.chunkSize, Math.max(0, state.size - index * state.chunkSize)) : 0), 0);
    await progress(onProgress, 'uploading', uploaded, expected.size, signal);
    for (let index = 0; index < state.chunks; index++) {
      check(signal); if (state.received[index]) continue; await stable(source);
      const bytes = await readAt(source.handle, Math.min(state.chunkSize, Math.max(0, source.size - index * state.chunkSize)), index * state.chunkSize);
      await pace(bytes.length, maxBytesPerSecond, signal); check(signal);
      const result = validateProgress(await client.putChunk(projectId, uploadId, index, bytes, sha(bytes), { signal }));
      if (result.totalBytes !== expected.size || result.receivedBytes < uploaded + bytes.length) throw fail('asset-response-invalid');
      uploaded = result.receivedBytes; await progress(onProgress, 'uploading', uploaded, expected.size, signal);
    }
    if (`sha256:${await hashSource(source, 'hashing', signal, onProgress)}` !== expected.contentId) throw fail('asset-source-changed');
    verifying = true;
    await progress(onProgress, 'verifying', 0, null, signal);
    const receipt = validateComplete(await client.completeUpload(projectId, uploadId, { signal }));
    if (['assetId', 'size', 'chunkSize', 'chunks'].some(field => receipt[field] !== state[field])) throw fail('asset-response-invalid');
    await stable(source); check(signal); await progress(onProgress, 'verifying', source.size, source.size, signal); return receipt;
  } catch (error) {
    if (verifying && uploadId && signal?.aborted) await cancelVerification(client, projectId, uploadId);
    throw safe(signal?.aborted ? fail('asset-cancelled') : error);
  } finally { await source?.handle.close().catch(() => {}); }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateBytes(filename, limit, expectedSize = null) {
  let handle;
  try {
    await noLinks(filename); handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || (Number(stat.mode) & 0o777) !== 0o600 || stat.size < 0n || stat.size > BigInt(limit)
      || expectedSize !== null && stat.size !== BigInt(expectedSize)) throw fail('asset-cache-corrupt');
    const bytes = await readAt(handle, Number(stat.size), 0); const after = await handle.stat({ bigint: true });
    if (!sameStat(stat, after)) throw fail('asset-cache-corrupt'); return bytes;
  } catch (error) { if (error.code === 'ENOENT') throw error; throw fail('asset-cache-corrupt'); }
  finally { await handle?.close().catch(() => {}); }
}
async function atomicPrivate(filename, bytes, staging) {
  try { await staging.replacePrivate(filename, bytes); }
  catch (error) { throw fail(error.publicationMayHaveOccurred?'asset-local-io-uncertain':'asset-local-io-failed'); }
}
function validateCheckpoint(value, binding) {
  if (!exact(value, ['schemaVersion', 'projectId', 'assetId', 'size', 'chunkSize', 'chunks', 'hashes']) || value.schemaVersion !== 1
    || ['projectId', 'assetId', 'size', 'chunkSize', 'chunks'].some(key => value[key] !== binding[key])
    || !Array.isArray(value.hashes) || value.hashes.length !== binding.chunks
    || value.hashes.some(hash => hash !== null && (typeof hash !== 'string' || !SHA.test(hash)))) throw fail('asset-checkpoint-invalid');
  return value;
}
async function existingDestination(destination, metadata, signal, onProgress) {
  try { await fs.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let source;
  try {
    source = await openSource(destination);
    if (source.size !== metadata.size || `sha256:${await hashSource(source, 'hashing', signal, onProgress)}` !== metadata.assetId) throw fail('asset-destination-exists');
    return true;
  } catch (error) { if (error.code === 'asset-cancelled' || error.code === 'asset-progress-failed') throw error; throw fail('asset-destination-exists'); }
  finally { await source?.handle.close().catch(() => {}); }
}
async function downloadAssetFile({ client, projectId, assetId, destination, workDirectory, signal, onProgress, maxBytesPerSecond = null, onStagingCheckpoint = async () => {} } = {}) {
  let release, temporary, output, assembly, published = false;
  try {
    settings(signal, onProgress, maxBytesPerSecond);
    if (!client || !['getAsset', 'readChunk'].every(name => typeof client[name] === 'function') || typeof projectId !== 'string' || !ID.test(projectId) || !asset(assetId)) throw fail('asset-request-invalid');
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw fail('asset-file-invalid');
    const parent = await noLinks(path.dirname(destination)); destination = path.join(parent, path.basename(destination));
    const metadata = validateMetadata(await client.getAsset(projectId, assetId, { signal }));
    if (metadata.assetId !== assetId) throw fail('asset-response-invalid');
    if (await existingDestination(destination, metadata, signal, onProgress)) return { assetId, size: metadata.size, verified: true, alreadyPresent: true };
    const work = await noLinks(workDirectory, true);
    if (destination === work || destination.startsWith(`${work}${path.sep}`) || work.startsWith(`${destination}${path.sep}`)) throw fail('asset-file-invalid');
    try { await fs.mkdir(work, { mode: 0o700 }); await syncDirectory(path.dirname(work)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(work);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || destination === work
      || destination.startsWith(`${work}${path.sep}`) || work.startsWith(`${destination}${path.sep}`)) throw fail('asset-file-invalid');
    try { release = await acquireMetadataLock(work, 100); } catch { throw fail('asset-transfer-busy'); }
    const staging = createOwnedTransferStaging({ directory: path.join(work, '.transfer-staging'), onCheckpoint: onStagingCheckpoint });
    const binding = { projectId, assetId, size: metadata.size, chunkSize: metadata.chunkSize, chunks: metadata.chunks };
    const checkpointFile = path.join(work, 'checkpoint.json'); let checkpoint;
    try {
      const bytes = await privateBytes(checkpointFile, MAX_CHECKPOINT_BYTES);
      checkpoint = validateCheckpoint(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), binding);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('asset-checkpoint-invalid');
      for(const name of await fs.readdir(work))if(!['metadata.lock', '.transfer-staging'].includes(name)&&!await staging.reservedTemporary(path.join(work,name),[checkpointFile]))throw fail('asset-checkpoint-invalid');
      checkpoint = { schemaVersion: 1, ...binding, hashes: Array(metadata.chunks).fill(null) };
      await atomicPrivate(checkpointFile, Buffer.from(JSON.stringify(checkpoint)), staging);
    }
    let received = 0;
    for (let index = 0; index < metadata.chunks; index++) {
      check(signal); const size = Math.min(metadata.chunkSize, Math.max(0, metadata.size - index * metadata.chunkSize));
      const filename = path.join(work, `chunk-${index}.bin`);
      if (checkpoint.hashes[index]) {
        const bytes = await privateBytes(filename, CHUNK, size); if (sha(bytes) !== checkpoint.hashes[index]) throw fail('asset-cache-corrupt');
      } else {
        await progress(onProgress, 'downloading', received, metadata.size, signal); await pace(size, maxBytesPerSecond, signal);
        const result = await client.readChunk(projectId, assetId, index, { signal });
        if (!result || !Buffer.isBuffer(result.bytes) || result.bytes.length !== size || result.chunks !== metadata.chunks || result.totalBytes !== metadata.size
          || typeof result.checksum !== 'string' || !SHA.test(result.checksum) || sha(result.bytes) !== result.checksum) throw fail('asset-response-invalid');
        await atomicPrivate(filename, result.bytes, staging); checkpoint.hashes[index] = result.checksum;
        await atomicPrivate(checkpointFile, Buffer.from(JSON.stringify(checkpoint)), staging);
      }
      received += size; await progress(onProgress, 'downloading', received, metadata.size, signal);
    }
    check(signal); assembly = await staging.begin({ targetPath: destination, kind: 'download-assembly', expectedSha256: assetId.slice(7), expectedBytes: metadata.size }); temporary = assembly.temporaryPath; output = assembly.handle;
    const digest = createHash('sha256'); let written = 0; await progress(onProgress, 'writing', 0, metadata.size, signal);
    for (let index = 0; index < metadata.chunks; index++) {
      const size = Math.min(metadata.chunkSize, Math.max(0, metadata.size - index * metadata.chunkSize));
      const bytes = await privateBytes(path.join(work, `chunk-${index}.bin`), CHUNK, size);
      if (sha(bytes) !== checkpoint.hashes[index]) throw fail('asset-cache-corrupt');
      digest.update(bytes); let offset = 0;
      while (offset < bytes.length) { check(signal); const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw fail('asset-local-io-failed'); offset += bytesWritten; }
      written += size; await progress(onProgress, 'writing', written, metadata.size, signal);
    }
    if (written !== metadata.size || `sha256:${digest.digest('hex')}` !== assetId) throw fail('asset-identity-mismatch');
    await assembly.ready(); output = null; await progress(onProgress, 'verifying', written, metadata.size, signal);
    let alreadyPresent = false;
    try { await assembly.publish('link'); published = true; }
    catch (error) {
      if(error.publicationMayHaveOccurred){published=true;throw fail('asset-local-io-uncertain');}
      if (error.code !== 'EEXIST') throw error;
      if (!await existingDestination(destination, metadata, signal, onProgress)) throw fail('asset-destination-exists'); alreadyPresent = true;
    }
    if (published) { try { await syncDirectory(parent); } catch { throw fail('asset-local-io-uncertain'); } }
    return { assetId, size: metadata.size, verified: true, alreadyPresent };
  } catch (error) { throw safe(signal?.aborted && !published ? fail('asset-cancelled') : error); }
  finally {
    await output?.close().catch(() => {});
    if (assembly) await assembly.cleanup().catch(() => {});
    if (release) { try { await release(); } catch { /* No caller data or checkpoint is removed on a lock release failure. */ } }
  }
}
module.exports = { inspectAssetFile, uploadAssetFile, downloadAssetFile };
