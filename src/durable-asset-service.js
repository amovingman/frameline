'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { createMediaAssetIdentity } = require('./media-asset-identity');
const { fingerprint } = require('./project-api-contracts');
const { emptyLifecycle, validateAssetLifecycleState, createAssetLifecycleOperations } = require('./service-asset-lifecycle');
const { emptyAssetJobs, validateAssetJobsState, createAssetJobOperations } = require('./service-asset-jobs');
const { emptyGc, validateGcState, validateReferences, createRetainedAssetOperations } = require('./service-retained-assets');

const MAX_INDEX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024 * 1024, MAX_CHUNKS = 65536;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ASSET = /^sha256:[a-f0-9]{64}$/;
const CLASSES = new Set(['original', 'proxy', 'audio', 'graphics', 'other']);
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
function validateState(value, chunkSize, maxAssetBytes, version = value?.schemaVersion) {
  const legacy = version === 1;
  if (value?.schemaVersion > 5) throw fail('asset-state-newer-version');
  if (![1, 2, 3, 4, 5].includes(version) || !exact(value, ['schemaVersion', 'generation', 'chunkSize', 'maxAssetBytes', 'uploads', 'assets', ...(legacy ? [] : ['policies']), ...(version >= 3 ? ['lifecycle'] : []), ...(version >= 4 ? ['jobs'] : []), ...(version >= 5 ? ['blobs', 'garbageCollection'] : [])])
    || value.schemaVersion !== version || !Number.isSafeInteger(value.generation) || value.generation < 0
    || value.chunkSize !== chunkSize || value.maxAssetBytes !== maxAssetBytes
    || !Array.isArray(value.uploads) || value.uploads.length > 10000 || !Array.isArray(value.assets) || value.assets.length > 10000
    || !legacy && (!Array.isArray(value.policies) || value.policies.length > 10000)) throw fail('asset-state-invalid');
  const uploads = new Map(), scoped = new Set(), completed = new Set(); let chunks = 0;
  for (const upload of value.uploads) {
    if (!exact(upload, ['id', 'projectId', 'identity', 'hashes', ...(version >= 5 ? ['blobId'] : [])]) || typeof upload.id !== 'string' || !UUID.test(upload.id)
      || uploads.has(upload.id) || !id(upload.projectId) || !Array.isArray(upload.hashes)) throw fail('asset-state-invalid');
    try { identity(upload.identity, maxAssetBytes, chunkSize); } catch { throw fail('asset-state-invalid'); }
    const scope = fingerprint({ projectId: upload.projectId, assetId: upload.identity.contentId });
    chunks += upload.hashes.length;
    if (scoped.has(scope) || chunks > 1_000_000 || upload.hashes.length !== Math.max(1, Math.ceil(upload.identity.size / chunkSize))
      || upload.hashes.some(value => value !== null && (typeof value !== 'string' || !SHA.test(value)))) throw fail('asset-state-invalid');
    uploads.set(upload.id, upload); scoped.add(scope);
  }
  for (const asset of value.assets) {
    if (!exact(asset, ['projectId', 'assetId', 'uploadId', ...(legacy ? [] : ['archived'])]) || !id(asset.projectId) || typeof asset.assetId !== 'string' || !ASSET.test(asset.assetId)
      || !uploads.has(asset.uploadId) || completed.has(asset.uploadId) || !legacy && typeof asset.archived !== 'boolean') throw fail('asset-state-invalid');
    const upload = uploads.get(asset.uploadId);
    if (upload.projectId !== asset.projectId || upload.identity.contentId !== asset.assetId || !upload.hashes.every(Boolean)) throw fail('asset-state-invalid');
    completed.add(asset.uploadId);
  }
  const policyProjects = new Set();
  for (const policy of legacy ? [] : value.policies) {
    if (!exact(policy, ['projectId', 'version', 'syncClasses']) || !id(policy.projectId) || policyProjects.has(policy.projectId)
      || !Number.isSafeInteger(policy.version) || policy.version < 1 || !Array.isArray(policy.syncClasses) || policy.syncClasses.length > CLASSES.size
      || policy.syncClasses.some(value => !CLASSES.has(value)) || new Set(policy.syncClasses).size !== policy.syncClasses.length
      || JSON.stringify(policy.syncClasses) !== JSON.stringify([...policy.syncClasses].sort())) throw fail('asset-state-invalid');
    policyProjects.add(policy.projectId);
  }
  let retired = [], retiredUploads = [];
  if (version >= 5) {
    if (!Array.isArray(value.blobs) || value.blobs.length > 10000) throw fail('asset-state-invalid');
    const blobs = new Map();
    const validateBlob = blob => {
      if (!exact(blob, ['id', 'projectId', 'identity', 'hashes']) || !UUID.test(blob.id) || !id(blob.projectId) || !Array.isArray(blob.hashes)) throw fail('asset-state-invalid');
      identity(blob.identity, maxAssetBytes, chunkSize);
      if (blob.hashes.length !== Math.max(1, Math.ceil(blob.identity.size / chunkSize)) || blob.hashes.some(digest => digest !== null && !SHA.test(digest))) throw fail('asset-state-invalid');
    };
    for (const blob of value.blobs) { validateBlob(blob); if (blobs.has(blob.id)) throw fail('asset-state-invalid'); blobs.set(blob.id, blob); }
    for (const upload of value.uploads) {
      const blob = blobs.get(upload.blobId);
      if (!blob || fingerprint(blob.identity) !== fingerprint(upload.identity) || fingerprint(blob.hashes) !== fingerprint(upload.hashes)) throw fail('asset-state-invalid');
    }
    if (value.blobs.some(blob => !value.uploads.some(upload => upload.blobId === blob.id))) throw fail('asset-state-invalid');
    validateGcState(value.garbageCollection, candidate => identity(candidate, maxAssetBytes, chunkSize), UUID);
    for (const row of value.garbageCollection.pending) { validateBlob(row.blob); if (blobs.has(row.blob.id)) throw fail('asset-state-invalid'); }
    const published = new Set(value.assets.map(item => JSON.stringify([item.projectId, item.assetId])));
    const deleted = value.garbageCollection.deleted.filter(item => !published.has(JSON.stringify([item.projectId, item.assetId])));
    retired = deleted.map(item => ({ projectId: item.projectId, assetId: item.assetId, uploadId: item.uploadId, archived: false }));
    retiredUploads = deleted.map(item => ({ id: item.uploadId, projectId: item.projectId, identity: item.identity }));
  }
  if (version >= 3) validateAssetLifecycleState(value.lifecycle, [...value.assets, ...retired]);
  if (version >= 4) validateAssetJobsState(value.jobs, [...value.assets, ...retired], [...value.uploads, ...retiredUploads]);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_INDEX_BYTES) throw fail('asset-state-invalid');
  return structuredClone(value);
}
function migrateState(value, chunkSize, maxAssetBytes, at, targetVersion = 4) {
  if (value?.schemaVersion >= 4) {
    const previous = validateState(value, chunkSize, maxAssetBytes);
    if (previous.schemaVersion === 5 || targetVersion === 4) return previous;
    return validateState({ ...previous, schemaVersion: 5, blobs: previous.uploads.map(item => structuredClone(item)),
      uploads: previous.uploads.map(item => ({ ...item, blobId: item.id })), garbageCollection: emptyGc() }, chunkSize, maxAssetBytes);
  }
  const previous = validateState(value, chunkSize, maxAssetBytes, value.schemaVersion);
  const assets = value.schemaVersion === 1 ? previous.assets.map(asset => ({ ...asset, archived: false })) : previous.assets;
  const lifecycle = previous.lifecycle || emptyLifecycle();
  // Legacy records have no trustworthy archive time. Start their waiting period
  // at migration instead of assuming they were archived long ago.
  if (value.schemaVersion < 3) lifecycle.archives = assets.filter(asset => asset.archived).map(({ projectId, assetId }) => ({ projectId, assetId, archivedAt: at }));
  return migrateState({ ...previous, schemaVersion: 4, policies: previous.policies || [], assets, lifecycle, jobs: emptyAssetJobs() }, chunkSize, maxAssetBytes, at, targetVersion);
}

async function createDurableAssetService({ directory, keyring, authorize, authorizePolicy = null, getInitialPolicy = null, initialize = false, chunkSize = 1024 * 1024,
  maxAssetBytes = MAX_ASSET_BYTES, storage = fs, lockTimeoutMs = 5000, now = Date.now, workerActorContext = null,
  withRevisionReferences = null, ownerBoundaryDeduplication = false } = {}) {
  if (!path.isAbsolute(directory || '') || !keyring || typeof keyring.encrypt !== 'function' || typeof keyring.decrypt !== 'function'
    || typeof authorize !== 'function' || authorizePolicy !== null && typeof authorizePolicy !== 'function'
    || getInitialPolicy !== null && typeof getInitialPolicy !== 'function'
    || workerActorContext !== null && typeof workerActorContext !== 'function'
    || withRevisionReferences !== null && typeof withRevisionReferences !== 'function' || typeof ownerBoundaryDeduplication !== 'boolean'
    || typeof now !== 'function' || typeof initialize !== 'boolean' || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024 * 1024
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
  let pending = Promise.resolve(), closing = false, uncertain = false, initialized = false, observedKeyId = null, needsMigration = false;
  // Defaults belong to the immutable collaboration project, never the asset
  // journal. Keep them scoped to this fresh transaction's in-memory state.
  const initialPolicies = new WeakMap();
  const lifecycle = createAssetLifecycleOperations({ now });
  const retained = createRetainedAssetOperations({ lifecycle });
  const targetVersion = withRevisionReferences || ownerBoundaryDeduplication ? 5 : 4;
  const jobs = createAssetJobOperations({ now });
  const count = size => Math.max(1, Math.ceil(size / chunkSize));
  const length = (size, index) => Math.min(chunkSize, Math.max(0, size - index * chunkSize));
  async function permission(context, projectId, action, lease = null) {
    if (!id(projectId)) throw fail('asset-request-invalid');
    const result = lease ? await lease.authorize(action) : await authorize(context, projectId, action);
    if (result !== true && result?.allowed !== true) throw fail('asset-forbidden');
  }
  async function policyPermission(context, projectId, lease = null) {
    if (typeof authorizePolicy !== 'function') throw fail('asset-policy-forbidden');
    const result = lease ? await lease.authorizePolicy() : await authorizePolicy(context, projectId, 'write');
    if (!exact(result, ['allowed', 'actorId']) || result.allowed !== true || !id(result.actorId)) throw fail('asset-policy-forbidden');
    return result.actorId;
  }
  async function initialPolicy(context, projectId, lease = null) {
    if (getInitialPolicy === null && lease === null) return { projectId, version: 0, syncClasses: [] };
    const value = lease ? await lease.getInitialPolicy() : await getInitialPolicy(context, projectId);
    const fields = ['projectId', 'version', 'syncClasses'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length
      || !fields.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable; })
      || value.projectId !== projectId || ![0, 1].includes(value.version) || !Array.isArray(value.syncClasses)
      || value.syncClasses.length > CLASSES.size || value.version === 0 && value.syncClasses.length !== 0
      || value.syncClasses.some(item => !CLASSES.has(item)) || new Set(value.syncClasses).size !== value.syncClasses.length
      || JSON.stringify(value.syncClasses) !== JSON.stringify([...value.syncClasses].sort())) throw fail('asset-state-invalid');
    return structuredClone(value);
  }
  function validateInitialPolicy(value, baseline) {
    const local = value.policies.find(item => item.projectId === baseline.projectId);
    if (baseline.version === 1 && local && local.version < 2) throw fail('asset-state-invalid');
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
    observedKeyId = null; needsMigration = false;
    try {
      const file = await bounded(indexPath, MAX_FILE_BYTES, 'asset-state-invalid');
      if (file?.schemaVersion > 1) throw fail('asset-state-newer-version');
      if (!exact(file, ['schemaVersion', 'generation', 'record']) || file.schemaVersion !== 1) throw fail('asset-state-invalid');
      envelope(file.record); const original = keyring.decrypt(file.record), checked = migrateState(original, chunkSize, maxAssetBytes, lifecycle.clock(), targetVersion);
      needsMigration = original.schemaVersion !== checked.schemaVersion;
      if (checked.generation !== file.generation) throw fail('asset-state-invalid'); observedKeyId = file.record.keyId;
      return checked;
    } catch (error) {
      if (error.code === 'ENOENT' && !initialized && initialize) return null;
      throw fail(error.code === 'asset-state-newer-version' ? error.code : 'asset-state-invalid');
    }
  }
  function transact(context, projectId, action, operation, signal, startup = false, commitPermission = null, references = false) {
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
          value = { schemaVersion: targetVersion, generation: 0, chunkSize, maxAssetBytes, uploads: [], assets: [], policies: [], lifecycle: emptyLifecycle(), jobs: emptyAssetJobs(),
            ...(targetVersion >= 5 ? { blobs: [], garbageCollection: emptyGc() } : {}) };
          try { await privateDirectory(uploadsPath, true); await syncDir(directory); }
          catch (error) { if (error.code !== 'EEXIST') throw error; await privateDirectory(uploadsPath); }
        } else await privateDirectory(uploadsPath);
        let baseline = null;
        if (!startup) {
          baseline = await initialPolicy(context, projectId);
          validateInitialPolicy(value, baseline); initialPolicies.set(value, baseline);
        }
        const commit = async (snapshot = null, lease = null) => {
          if (lease) await permission(context, projectId, action, lease);
          const result = await operation(value, snapshot, lease);
          validateState(value, chunkSize, maxAssetBytes); abort(signal);
          if (!startup) {
            await permission(context, projectId, action, lease);
            const rechecked = await initialPolicy(context, projectId, lease);
            if (fingerprint(rechecked) !== fingerprint(baseline)) throw fail('asset-state-invalid');
            validateInitialPolicy(value, rechecked);
            await permission(context, projectId, action, lease);
          }
          if (commitPermission) await commitPermission(lease);
          abort(signal);
          if (needsMigration || previous !== fingerprint(value)) {
            if (value.generation === Number.MAX_SAFE_INTEGER) throw fail('asset-state-invalid'); value.generation++;
            await atomic(indexPath, { schemaVersion: 1, generation: value.generation, record: encrypt(value) }, MAX_FILE_BYTES);
          }
          initialized = true; return result;
        };
        if (!references) return await commit();
        if (!withRevisionReferences) throw fail('asset-reference-unavailable');
        // Always asset lock -> history lock. Hold both until index publication.
        return await withRevisionReferences(context, projectId, commit);
      } catch (error) {
        const safe = new Set(['asset-state-invalid', 'asset-state-newer-version', 'asset-storage-unavailable', 'asset-storage-uncertain',
          'asset-key-rotation-required', 'asset-service-busy', 'asset-request-invalid', 'asset-forbidden', 'asset-identity-invalid',
          'asset-identity-collision', 'asset-chunk-invalid', 'asset-chunk-conflict', 'asset-chunk-corrupt', 'asset-content-mismatch',
          'asset-capacity-exceeded', 'asset-not-found', 'asset-cancelled', 'upload-not-found', 'upload-incomplete',
          'asset-policy-invalid', 'asset-policy-forbidden', 'asset-policy-version-conflict', 'asset-policy-excluded',
          'asset-archive-invalid', 'asset-archive-conflict', 'asset-archived',
          'asset-reference-invalid', 'asset-reference-unavailable', 'asset-gc-blocked',
          'asset-revision-media-missing', 'asset-revision-identity-mismatch', 'asset-revision-unavailable',
          'asset-lifecycle-invalid', 'asset-lifecycle-version-conflict', 'asset-lifecycle-idempotency-conflict', 'asset-lifecycle-plan-stale',
          'asset-job-invalid', 'asset-job-not-found', 'asset-job-forbidden', 'asset-job-idempotency-conflict', 'asset-job-run-stale',
          'asset-job-state-conflict', 'asset-job-attempts-exhausted', 'asset-job-lease-stale', 'asset-job-lease-expired',
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
  function policy(value, projectId) {
    const baseline = initialPolicies.get(value);
    return structuredClone(value.policies.find(item => item.projectId === projectId)
      || (baseline?.projectId === projectId ? baseline : { projectId, version: 0, syncClasses: [] }));
  }
  function available(value, projectId, assetId) {
    const asset = value.assets.find(item => item.projectId === projectId && item.assetId === assetId);
    const upload = asset && getUpload(value, projectId, asset.uploadId);
    return { projectId, assetId, cloudPresent: !!asset, excluded: !!asset && !policy(value, projectId).syncClasses.includes(upload.identity.assetClass),
      archived: asset?.archived || false, assetClass: upload?.identity.assetClass || null, size: upload?.identity.size ?? null };
  }
  function transferable(value, upload) {
    if (!policy(value, upload.projectId).syncClasses.includes(upload.identity.assetClass)) throw fail('asset-policy-excluded');
    if (value.assets.some(asset => asset.uploadId === upload.id && asset.archived)) throw fail('asset-archived');
  }
  function ownerWrite(context, projectId, operation) {
    let actorId;
    const recheckOwner = async () => {
      const current = await policyPermission(context, projectId);
      if (current !== actorId) throw fail('asset-policy-forbidden');
    };
    return transact(context, projectId, 'write', async value => {
      actorId = await policyPermission(context, projectId); const result = await operation(value, actorId); await recheckOwner(); return result;
    }, undefined, false, recheckOwner);
  }
  async function jobActor(context, projectId, action) {
    const result = await authorize(context, projectId, action);
    if (result?.allowed !== true || !id(result.actorId)) throw fail('asset-job-forbidden'); return result.actorId;
  }
  function jobWrite(context, projectId, operation, jobId = null) {
    let actorId, crossAuthor = false;
    const check = async () => { if (await jobActor(context, projectId, 'write') !== actorId) throw fail('asset-job-forbidden'); };
    return transact(context, projectId, 'write', async value => {
      actorId = await jobActor(context, projectId, 'write');
      crossAuthor = jobId !== null && jobs.get(value, projectId, jobId).actorId !== actorId;
      if (crossAuthor) {
        if (await policyPermission(context, projectId) !== actorId) throw fail('asset-job-forbidden');
      }
      const result = await operation(value, actorId); await check(); return result;
    }, undefined, false, async () => {
      await check();
      if (crossAuthor && await policyPermission(context, projectId) !== actorId) throw fail('asset-job-forbidden');
    });
  }
  function verifyJobAsset(value, projectId, assetId) {
    const upload = getAssetUpload(value, projectId, assetId); transferable(value, upload); return upload;
  }
  function jobContext(claim) {
    if (!workerActorContext || !id(claim?.actorId)) throw fail('asset-job-forbidden');
    return workerActorContext(claim.actorId);
  }
  function leasedOperation(claim, operation) {
    let deadline;
    return transact(jobContext(claim), claim.projectId, 'read', value => {
      const job = jobs.assertLease(value, claim); deadline = job.lease.until; return operation(value, job);
    }, undefined, false, () => {
      // Authentication/policy reads can await another store. A lease that was
      // valid before those awaits must still be valid at commit/acknowledgment.
      if (jobs.clock() >= deadline) throw fail('asset-job-lease-expired');
    });
  }
  const worker = workerActorContext === null ? null : {
    claim: leaseMs => transact(null, null, null, value => jobs.claim(value, leaseMs, async (actorId, projectId) => {
      const context = workerActorContext(actorId); if (await jobActor(context, projectId, 'read') !== actorId) throw fail('asset-job-forbidden');
    }), null, true),
    metadata: claim => leasedOperation(claim, (value, job) => {
      const upload = verifyJobAsset(value, claim.projectId, job.assetId);
      return { assetId: job.assetId, size: job.size, chunks: upload.hashes.length, chunkSize };
    }),
    readChunk: (claim, index) => leasedOperation(claim, async (value, job) => {
      const upload = verifyJobAsset(value, claim.projectId, job.assetId);
      const bytes = await read(value, upload, index); jobs.assertLease(value, claim); transferable(value, upload); return bytes;
    }),
    progress: (claim, bytes) => leasedOperation(claim, value => jobs.progress(value, claim, bytes)),
    complete: (claim, result) => leasedOperation(claim, (value, job) => {
      verifyJobAsset(value, claim.projectId, job.assetId); return jobs.complete(value, claim, result);
    }),
    fail: (claim, code, interrupted = false) => {
      let deadline;
      return transact(null, null, null, value => { deadline = jobs.assertLease(value, claim).lease.until; return jobs.fail(value, claim, code, interrupted); }, null, true,
        () => { if (jobs.clock() >= deadline) throw fail('asset-job-lease-expired'); });
    }
  };
  const receipt = upload => ({ assetId: upload.identity.contentId, size: upload.identity.size, chunkSize, chunks: upload.hashes.length, verified: true });
  async function read(value, upload, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= upload.hashes.length) throw fail('asset-chunk-invalid');
    if (!upload.hashes[index]) throw fail('upload-incomplete');
    try {
      const physical = value.schemaVersion >= 5 ? value.blobs.find(blob => blob.id === upload.blobId) : upload;
      if (!physical) throw fail('asset-chunk-corrupt');
      const folder = path.join(uploadsPath, physical.id); await privateDirectory(folder);
      const encrypted = await bounded(path.join(folder, `${index}.enc.json`), maxChunkFile, 'asset-chunk-corrupt'); envelope(encrypted);
      const payload = keyring.decrypt(encrypted);
      if (!exact(payload, ['schemaVersion', 'uploadId', 'projectId', 'index', 'checksum', 'data']) || payload.schemaVersion !== 1
        || payload.uploadId !== physical.id || payload.projectId !== physical.projectId || payload.index !== index
        || payload.checksum !== upload.hashes[index] || !base64(payload.data, length(upload.identity.size, index))) throw fail('asset-chunk-corrupt');
      const bytes = Buffer.from(payload.data, 'base64'); if (hash(bytes) !== upload.hashes[index]) throw fail('asset-chunk-corrupt'); return bytes;
    } catch { throw fail('asset-chunk-corrupt'); }
  }
  function ownerReferences(context, projectId, operation) {
    return transact(context, projectId, 'write', async (value, references, lease) => {
      const actor = await policyPermission(context, projectId, lease);
      const result = await operation(value, references, actor);
      if (await policyPermission(context, projectId, lease) !== actor) throw fail('asset-policy-forbidden');
      return result;
    }, undefined, false, null, true);
  }
  function cleanupPendingGarbage() {
    return transact(null, null, null, async value => {
      if (value.schemaVersion < 5) return;
      for (const pendingBlob of [...value.garbageCollection.pending]) {
        const blob = pendingBlob.blob, folder = path.join(uploadsPath, blob.id);
        let clean = true;
        try {
          try { await privateDirectory(folder); }
          catch (error) { if (error.code === 'ENOENT') { value.garbageCollection.pending = value.garbageCollection.pending.filter(row => row.blob.id !== blob.id); continue; } throw error; }
          const directoryIdentity = await storage.lstat(folder);
          const expected = new Set(blob.hashes.map((_, index) => `${index}.enc.json`)); const identities = new Map();
          const names = await storage.readdir(folder);
          if (names.some(name => !expected.has(name))) continue; // Unknown files are never recursively removed.
          for (const name of names) {
            const index = Number(name.slice(0, -'.enc.json'.length)), filename = path.join(folder, name);
            const before = await storage.lstat(filename);
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) { clean = false; break; }
            const encrypted = await bounded(filename, maxChunkFile, 'asset-chunk-corrupt'); envelope(encrypted);
            const payload = keyring.decrypt(encrypted), checksum = blob.hashes[index];
            if (!exact(payload, ['schemaVersion', 'uploadId', 'projectId', 'index', 'checksum', 'data']) || payload.schemaVersion !== 1
              || payload.uploadId !== blob.id || payload.projectId !== blob.projectId || payload.index !== index || payload.checksum !== checksum
              || !base64(payload.data, length(blob.identity.size, index)) || hash(Buffer.from(payload.data, 'base64')) !== checksum) { clean = false; break; }
            const after = await storage.lstat(filename);
            if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) { clean = false; break; }
            identities.set(name, after);
          }
          if (!clean) continue;
          for (const name of names) {
            const currentDirectory = await storage.lstat(folder), expectedFile = identities.get(name), filename = path.join(folder, name);
            if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) { clean = false; break; }
            const current = await storage.lstat(filename);
            if (current.dev !== expectedFile.dev || current.ino !== expectedFile.ino || current.ctimeMs !== expectedFile.ctimeMs
              || current.mtimeMs !== expectedFile.mtimeMs || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1) { clean = false; break; }
            await storage.unlink(filename);
          }
          if (!clean) continue;
          await syncDir(folder); await storage.rmdir(folder); await syncDir(uploadsPath);
          value.garbageCollection.pending = value.garbageCollection.pending.filter(row => row.blob.id !== blob.id);
        } catch { /* A durable pending record retains exact ownership for explicit/restart retry. */ }
      }
    }, undefined, true);
  }
  await transact(null, null, null, () => null, null, true);
  await cleanupPendingGarbage();
  return {
    worker,
    getOwnerAssetReport: (context, projectId, input) => ownerReferences(context, projectId, (value, references) => retained.report(value, projectId, references, input)),
    planGarbageCollection: (context, projectId, input) => ownerReferences(context, projectId, (value, references) => retained.plan(value, projectId, references, input)),
    garbageCollect: async (context, projectId, input) => {
      const result = await ownerReferences(context, projectId, (value, references, actor) => retained.execute(value, actor, projectId, references, input));
      await cleanupPendingGarbage(); return result;
    },
    withPublicationGuard: (context, projectId, operation) => {
      if (typeof operation !== 'function') return Promise.reject(fail('asset-request-invalid'));
      return transact(context, projectId, 'write', value => operation((manifest, { requireMedia = false } = {}) => {
        if (!manifest?.mediaDependencies) { if (requireMedia) throw fail('asset-revision-media-missing'); return; }
        if (requireMedia && manifest.mediaDependencies.coverage !== 'complete') throw fail('asset-revision-media-missing');
        for (const dependency of manifest.mediaDependencies.assets || []) {
          const asset = value.assets.find(item => item.projectId === projectId && item.assetId === dependency.identity?.contentId);
          if (!asset) { if (requireMedia) throw fail('asset-revision-media-missing'); continue; }
          const upload = getUpload(value, projectId, asset.uploadId);
          if (fingerprint(upload.identity) !== fingerprint(dependency.identity)) throw fail('asset-revision-identity-mismatch');
          if (requireMedia) { try { transferable(value, upload); } catch { throw fail('asset-revision-media-missing'); } }
        }
      }));
    },
    submitVerificationJob: (context, projectId, input) => jobWrite(context, projectId, (value, actorId) =>
      jobs.submit(value, actorId, projectId, input, assetId => verifyJobAsset(value, projectId, assetId))),
    getVerificationJob: (context, projectId, jobId) => transact(context, projectId, 'read', value => jobs.publicJob(jobs.get(value, projectId, jobId))),
    listVerificationJobs: (context, projectId, input) => transact(context, projectId, 'read', value => jobs.list(value, projectId, input)),
    cancelVerificationJob: (context, projectId, jobId, input) => jobWrite(context, projectId, (value, actorId) =>
      jobs.action(value, actorId, projectId, jobId, 'cancel', input, assetId => verifyJobAsset(value, projectId, assetId)), jobId),
    retryVerificationJob: (context, projectId, jobId, input) => jobWrite(context, projectId, (value, actorId) =>
      jobs.action(value, actorId, projectId, jobId, 'retry', input, assetId => verifyJobAsset(value, projectId, assetId)), jobId),
    getVerificationMetrics: (context, projectId) => transact(context, projectId, 'read', value => jobs.metrics(value, projectId)),
    beginUpload: (context, projectId, candidate) => {
      let checked; try { checked = identity(candidate, maxAssetBytes, chunkSize); } catch (error) { return Promise.reject(error); }
      let dedupSource = null, dedupActor = null;
      return transact(context, projectId, 'write', async value => {
        if (withRevisionReferences) await withRevisionReferences(context, projectId, references => {
          const canonical = validateReferences(references, projectId);
          for (const revision of canonical.revisions) for (const retainedIdentity of revision.assets) {
            if (retainedIdentity.contentId === checked.contentId && fingerprint(retainedIdentity) !== fingerprint(checked)) throw fail('asset-identity-collision');
          }
        });
        const existing = value.uploads.find(item => item.projectId === projectId && item.identity.contentId === checked.contentId);
        if (existing) {
          if (fingerprint(existing.identity) !== fingerprint(checked)) throw fail('asset-identity-collision'); transferable(value, existing); return status(value, existing);
        }
        const retired = value.garbageCollection?.deleted.find(item => item.projectId === projectId && item.assetId === checked.contentId);
        if (retired && fingerprint(retired.identity) !== fingerprint(checked)) throw fail('asset-identity-collision');
        if (value.uploads.length >= 10000) throw fail('asset-capacity-exceeded');
        if (ownerBoundaryDeduplication && value.schemaVersion >= 5) {
          try { dedupActor = await policyPermission(context, projectId); } catch (error) { if (!['asset-policy-forbidden', 'forbidden'].includes(error.code)) throw error; }
          if (dedupActor) for (const asset of value.assets) {
            const source = getUpload(value, asset.projectId, asset.uploadId);
            if (asset.projectId === projectId || asset.archived || fingerprint(source.identity) !== fingerprint(checked)) continue;
            try { if (await policyPermission(context, asset.projectId) === dedupActor) { dedupSource = source; break; } }
            catch (error) { if (!['asset-policy-forbidden', 'forbidden'].includes(error.code)) throw error; }
          }
        }
        const uploadId = randomUUID();
        const upload = { id: uploadId, projectId, identity: checked,
          hashes: dedupSource ? [...dedupSource.hashes] : Array(count(checked.size)).fill(null),
          ...(value.schemaVersion >= 5 ? { blobId: dedupSource ? dedupSource.blobId : uploadId } : {}) };
        transferable(value, upload);
        if (!dedupSource) {
          const physicalId = upload.blobId || upload.id;
          if (value.schemaVersion >= 5) value.blobs.push({ id: physicalId, projectId, identity: structuredClone(checked), hashes: [...upload.hashes] });
          await privateDirectory(path.join(uploadsPath, physicalId), true); await syncDir(uploadsPath);
        }
        value.uploads.push(upload); transferable(value, upload); return status(value, upload);
      }, undefined, false, async () => {
        if (dedupSource && (await policyPermission(context, projectId) !== dedupActor || await policyPermission(context, dedupSource.projectId) !== dedupActor)) throw fail('asset-policy-forbidden');
      });
    },
    uploadStatus: (context, projectId, uploadId) => transact(context, projectId, 'write', value => status(value, getUpload(value, projectId, uploadId))),
    assertUploadAllowed: (context, projectId, uploadId) => transact(context, projectId, 'write', value => {
      transferable(value, getUpload(value, projectId, uploadId)); return { allowed: true };
    }),
    putChunk: (context, projectId, uploadId, index, input, checksum, { signal } = {}) => {
      if (!Buffer.isBuffer(input) || input.length > chunkSize || typeof checksum !== 'string' || !SHA.test(checksum)) return Promise.reject(fail('asset-chunk-invalid'));
      const bytes = Buffer.from(input);
      return transact(context, projectId, 'write', async value => {
        const upload = getUpload(value, projectId, uploadId);
        transferable(value, upload);
        if (!Number.isSafeInteger(index) || index < 0 || index >= upload.hashes.length || bytes.length !== length(upload.identity.size, index)
          || hash(bytes) !== checksum) throw fail('asset-chunk-invalid');
        if (upload.hashes[index] && upload.hashes[index] !== checksum) throw fail('asset-chunk-conflict');
        if (upload.hashes[index]) await read(value, upload, index);
        else {
          const physical = value.schemaVersion >= 5 ? value.blobs.find(blob => blob.id === upload.blobId) : upload;
          const folder = path.join(uploadsPath, physical.id); await privateDirectory(folder); abort(signal);
          const encrypted = encrypt({ schemaVersion: 1, uploadId: physical.id, projectId: physical.projectId, index, checksum, data: bytes.toString('base64') });
          await atomic(path.join(folder, `${index}.enc.json`), encrypted, maxChunkFile); upload.hashes[index] = checksum;
          if (value.schemaVersion >= 5) physical.hashes[index] = checksum;
        }
        transferable(value, upload);
        return { receivedBytes: upload.hashes.reduce((sum, digest, part) => sum + (digest ? length(upload.identity.size, part) : 0), 0),
          totalBytes: upload.identity.size, complete: false };
      }, signal);
    },
    completeUpload: (context, projectId, uploadId, { signal } = {}) => transact(context, projectId, 'write', async value => {
      const upload = getUpload(value, projectId, uploadId);
      if (value.assets.some(item => item.uploadId === uploadId)) return receipt(upload);
      transferable(value, upload);
      if (!upload.hashes.every(Boolean)) throw fail('upload-incomplete');
      const digest = createHash('sha256'); let size = 0;
      for (let index = 0; index < upload.hashes.length; index++) { abort(signal); const bytes = await read(value, upload, index); digest.update(bytes); size += bytes.length; }
      if (size !== upload.identity.size || `sha256:${digest.digest('hex')}` !== upload.identity.contentId) throw fail('asset-content-mismatch');
      transferable(value, upload); value.assets.push({ projectId, assetId: upload.identity.contentId, uploadId, archived: false }); return receipt(upload);
    }, signal),
    getAsset: (context, projectId, assetId) => transact(context, projectId, 'read', value => {
      const upload = getAssetUpload(value, projectId, assetId);
      return { assetId, size: upload.identity.size, chunkSize, chunks: upload.hashes.length, identity: structuredClone(upload.identity) };
    }),
    readChunk: (context, projectId, assetId, index, { signal } = {}) => transact(context, projectId, 'read', async value => {
      const upload = getAssetUpload(value, projectId, assetId); transferable(value, upload);
      const bytes = await read(value, upload, index); abort(signal); transferable(value, upload);
      return { bytes, checksum: upload.hashes[index], chunks: upload.hashes.length, totalBytes: upload.identity.size };
    }, signal),
    getPolicy: (context, projectId) => transact(context, projectId, 'read', value => policy(value, projectId)),
    setPolicy: (context, projectId, input) => ownerWrite(context, projectId, value => {
      if (!exact(input, ['expectedVersion', 'syncClasses']) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || !Array.isArray(input.syncClasses) || input.syncClasses.length > CLASSES.size || input.syncClasses.some(value => !CLASSES.has(value))
        || new Set(input.syncClasses).size !== input.syncClasses.length) throw fail('asset-policy-invalid');
      const previous = policy(value, projectId);
      if (previous.version !== input.expectedVersion) throw fail('asset-policy-version-conflict');
      if (previous.version === Number.MAX_SAFE_INTEGER) throw fail('asset-capacity-exceeded');
      if (!value.policies.some(item => item.projectId === projectId) && value.policies.length >= 10000) throw fail('asset-capacity-exceeded');
      const next = { projectId, version: previous.version + 1, syncClasses: [...input.syncClasses].sort() };
      const index = value.policies.findIndex(item => item.projectId === projectId); if (index < 0) value.policies.push(next); else value.policies[index] = next;
      return structuredClone(next);
    }),
    getAvailability: (context, projectId, assetId) => transact(context, projectId, 'read', value => {
      if (typeof assetId !== 'string' || !ASSET.test(assetId)) throw fail('asset-identity-invalid'); return available(value, projectId, assetId);
    }),
    setArchived: (context, projectId, assetId, input) => ownerWrite(context, projectId, value => {
      if (typeof assetId !== 'string' || !ASSET.test(assetId) || !exact(input, ['expectedArchived', 'archived'])
        || typeof input.expectedArchived !== 'boolean' || typeof input.archived !== 'boolean') throw fail('asset-archive-invalid');
      const asset = value.assets.find(item => item.projectId === projectId && item.assetId === assetId);
      if (!asset) throw fail('asset-not-found');
      if (asset.archived !== input.expectedArchived) throw fail('asset-archive-conflict');
      if (asset.archived !== input.archived) {
        value.lifecycle.archives = value.lifecycle.archives.filter(item => item.projectId !== projectId || item.assetId !== assetId);
        if (input.archived) value.lifecycle.archives.push({ projectId, assetId, archivedAt: lifecycle.clock() });
      }
      asset.archived = input.archived;
      return available(value, projectId, assetId);
    }),
    getHold: (context, projectId, assetId) => ownerWrite(context, projectId, value => lifecycle.hold(value, projectId, assetId)),
    setHold: (context, projectId, assetId, input) => ownerWrite(context, projectId, (value, actorId) => lifecycle.setHold(value, actorId, projectId, assetId, input)),
    getRetentionPolicy: (context, projectId) => ownerWrite(context, projectId, value => lifecycle.retention(value, projectId)),
    setRetentionPolicy: (context, projectId, input) => ownerWrite(context, projectId, (value, actorId) => lifecycle.setRetention(value, actorId, projectId, input)),
    getLifecycleReport: (context, projectId, input) => ownerWrite(context, projectId, value => lifecycle.report(value, projectId, input)),
    planCleanup: (context, projectId, input) => ownerWrite(context, projectId, value => lifecycle.plan(value, projectId, input)),
    getUsage: (context, projectId) => transact(context, projectId, 'read', value => {
      const result = { projectId, assetCount: 0, logicalBytes: 0, availableBytes: 0, archivedBytes: 0, excludedBytes: 0,
        inProgressUploads: 0, inProgressReceivedBytes: 0, inProgressDeclaredBytes: 0 };
      const completed = new Set(), uploads = new Map(value.uploads.map(upload => [upload.id, upload]));
      const enabled = new Set(policy(value, projectId).syncClasses);
      for (const asset of value.assets) if (asset.projectId === projectId) {
        const upload = uploads.get(asset.uploadId), size = upload.identity.size; completed.add(upload.id);
        result.assetCount++; result.logicalBytes += size;
        result[!enabled.has(upload.identity.assetClass) ? 'excludedBytes' : asset.archived ? 'archivedBytes' : 'availableBytes'] += size;
      }
      for (const upload of value.uploads) if (upload.projectId === projectId && !completed.has(upload.id)) {
        result.inProgressUploads++; result.inProgressDeclaredBytes += upload.identity.size;
        result.inProgressReceivedBytes += upload.hashes.reduce((sum, digest, index) => sum + (digest ? length(upload.identity.size, index) : 0), 0);
      }
      return result;
    }),
    close: async () => { closing = true; await pending; }
  };
}
module.exports = { createDurableAssetService, MAX_ASSET_BYTES, MAX_CHUNKS };
