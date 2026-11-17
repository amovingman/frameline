const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { requireSecureTransport } = require('./security-controls');

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; return error; }
function checkAbort(signal) { if (signal?.aborted) throw fail('asset-cancelled'); }
function parseIdentity(identity) {
  if (!identity || identity.version !== 1 || identity.algorithm !== 'sha256'
    || typeof identity.contentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(identity.contentId)
    || !Number.isSafeInteger(identity.size) || identity.size < 0) throw fail('asset-identity-invalid');
  return identity.contentId.slice(7);
}
async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
}

// Local reference service. Each encrypted chunk and the small transfer index are
// durable on disk; only the caller-selected namespace can deduplicate content.
function createContentAssetService({ directory, namespaceId, keyring, urlSecret, origin,
  authorize, authorizeOwner = () => false, verifyRevision = () => false,
  chunkSize = 1024 * 1024, now = () => Date.now(),
  maxBytesPerSecond = null, onProgress = () => {} } = {}) {
  if (!path.isAbsolute(directory || '') || !ID.test(namespaceId || '') || !keyring
    || typeof keyring.encrypt !== 'function' || typeof keyring.decrypt !== 'function'
    || typeof urlSecret !== 'string' || urlSecret.length < 32 || typeof authorize !== 'function'
    || typeof authorizeOwner !== 'function' || typeof verifyRevision !== 'function'
    || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 8 * 1024 * 1024
    || maxBytesPerSecond !== null && (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond < 1024)) throw fail('asset-service-invalid');
  const { origin: secureOrigin } = requireSecureTransport(origin);
  const root = path.resolve(directory);
  const namespace = sha256(Buffer.from(namespaceId));
  const indexPath = path.join(root, 'index.json');
  let serial = Promise.resolve();
  const locked = action => { const next = serial.then(action); serial = next.catch(() => {}); return next; };
  async function state() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      if (value.version !== 1 || value.namespace !== namespace || !value.uploads || !value.assets) throw fail('asset-index-invalid');
      value.completed ||= {}; value.revisions ||= {};
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, namespace, uploads: {}, assets: {}, completed: {}, revisions: {} };
      throw fail(error.code === 'asset-index-invalid' ? error.code : 'asset-index-invalid');
    }
  }
  function checkProject(projectId, action) {
    if (!ID.test(projectId || '') || authorize(projectId, action) !== true) throw fail('asset-forbidden');
  }
  function checkOwner(projectId) {
    checkProject(projectId, 'read');
    if (authorizeOwner(projectId) !== true) throw fail('asset-owner-required');
  }
  function chunkCount(size) { return Math.max(1, Math.ceil(size / chunkSize)); }
  function expectedLength(size, index) { return Math.min(chunkSize, Math.max(0, size - index * chunkSize)); }
  async function pace(bytes, signal) {
    if (maxBytesPerSecond === null || bytes === 0) return;
    checkAbort(signal);
    const delay = Math.ceil(bytes / maxBytesPerSecond * 1000);
    await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(fail('asset-cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, delay);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  function uploadDir(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw fail('upload-not-found'); return path.join(root, 'uploads', id); }
  function assetDir(hash) { if (!SHA.test(hash)) throw fail('asset-identity-invalid'); return path.join(root, 'assets', namespace, hash); }
  async function beginUpload({ projectId, identity }) {
    return locked(async () => {
      checkProject(projectId, 'write'); const hash = parseIdentity(identity); const data = await state();
      const existing = data.assets[hash];
      if (existing) {
        if (existing.size !== identity.size) throw fail('asset-identity-collision');
        existing.projects = [...new Set([...existing.projects, projectId])];
        await writeJsonAtomic(indexPath, data);
        return { assetId: identity.contentId, alreadyPresent: true, complete: true, chunks: existing.chunks };
      }
      const id = randomUUID();
      data.uploads[id] = { projectId, hash, size: identity.size, hashes: Array(chunkCount(identity.size)).fill(null) };
      await fs.mkdir(uploadDir(id), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(indexPath, data);
      return { uploadId: id, assetId: identity.contentId, alreadyPresent: false, complete: false,
        chunks: data.uploads[id].hashes.length };
    });
  }
  async function putChunk({ projectId, uploadId, index, bytes, checksum, signal }) {
    return locked(async () => {
      checkProject(projectId, 'write'); checkAbort(signal); const data = await state();
      const upload = data.uploads[uploadId];
      if (!upload || upload.projectId !== projectId) throw fail('upload-not-found');
      if (!Number.isSafeInteger(index) || index < 0 || index >= upload.hashes.length
        || !Buffer.isBuffer(bytes) || bytes.length !== expectedLength(upload.size, index)
        || typeof checksum !== 'string' || !SHA.test(checksum) || sha256(bytes) !== checksum) throw fail('asset-chunk-invalid');
      if (upload.hashes[index] && upload.hashes[index] !== checksum) throw fail('asset-chunk-conflict');
      if (!upload.hashes[index]) {
        const encrypted = keyring.encrypt({ data: bytes.toString('base64') });
        await writeJsonAtomic(path.join(uploadDir(uploadId), `${index}.json`), encrypted);
        upload.hashes[index] = checksum;
        await writeJsonAtomic(indexPath, data);
      }
      await pace(bytes.length, signal); checkAbort(signal);
      const receivedBytes = upload.hashes.reduce((sum, hash, i) => sum + (hash ? expectedLength(upload.size, i) : 0), 0);
      onProgress({ direction: 'upload', projectId, assetId: `sha256:${upload.hash}`, receivedBytes, totalBytes: upload.size });
      return { receivedBytes, totalBytes: upload.size, complete: upload.hashes.every(Boolean) };
    });
  }
  async function uploadStatus(projectId, uploadId) {
    checkProject(projectId, 'write'); const upload = (await state()).uploads[uploadId];
    if (!upload || upload.projectId !== projectId) {
      const completed = (await state()).completed[uploadId];
      if (completed?.projectId === projectId) return { received: Array(completed.result.chunks).fill(true), totalBytes: completed.result.size, complete: true };
      throw fail('upload-not-found');
    }
    return { received: upload.hashes.map(Boolean), totalBytes: upload.size };
  }
  async function completeUpload(projectId, uploadId, signal) {
    return locked(async () => {
      checkProject(projectId, 'write'); checkAbort(signal); const data = await state();
      const upload = data.uploads[uploadId];
      if (!upload || upload.projectId !== projectId) {
        const completed = data.completed[uploadId];
        if (completed?.projectId === projectId) return structuredClone(completed.result);
        throw fail('upload-not-found');
      }
      if (!upload.hashes.every(Boolean)) throw fail('upload-incomplete');
      const digest = createHash('sha256'); let size = 0;
      for (let index = 0; index < upload.hashes.length; index++) {
        checkAbort(signal);
        const record = JSON.parse(await fs.readFile(path.join(uploadDir(uploadId), `${index}.json`), 'utf8'));
        const bytes = Buffer.from(keyring.decrypt(record).data, 'base64');
        if (bytes.length !== expectedLength(upload.size, index) || sha256(bytes) !== upload.hashes[index]) throw fail('asset-chunk-corrupt');
        digest.update(bytes); size += bytes.length;
      }
      if (size !== upload.size || digest.digest('hex') !== upload.hash) throw fail('asset-content-mismatch');
      const target = assetDir(upload.hash);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!data.assets[upload.hash]) {
        try { await fs.rename(uploadDir(uploadId), target); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        data.assets[upload.hash] = { size, hashes: upload.hashes, projects: [projectId], chunks: upload.hashes.length };
      } else {
        data.assets[upload.hash].projects = [...new Set([...data.assets[upload.hash].projects, projectId])];
        await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
      }
      const result = { assetId: `sha256:${upload.hash}`, size, chunks: upload.hashes.length, verified: true };
      data.completed[uploadId] = { projectId, result };
      delete data.uploads[uploadId]; await writeJsonAtomic(indexPath, data);
      return result;
    });
  }
  async function readChunk({ projectId, assetId, index, signal }) {
    checkProject(projectId, 'read'); checkAbort(signal); const hash = parseIdentity({ version: 1, algorithm: 'sha256', contentId: assetId, size: 0 });
    const asset = (await state()).assets[hash];
    if (!asset || !asset.projects.includes(projectId)) throw fail('asset-not-found');
    if (!Number.isSafeInteger(index) || index < 0 || index >= asset.chunks) throw fail('asset-chunk-invalid');
    const record = JSON.parse(await fs.readFile(path.join(assetDir(hash), `${index}.json`), 'utf8'));
    const bytes = Buffer.from(keyring.decrypt(record).data, 'base64');
    if (bytes.length !== expectedLength(asset.size, index) || sha256(bytes) !== asset.hashes[index]) throw fail('asset-chunk-corrupt');
    await pace(bytes.length, signal); checkAbort(signal);
    onProgress({ direction: 'download', projectId, assetId, receivedBytes: bytes.length, totalBytes: asset.size, index });
    return { bytes, checksum: asset.hashes[index], chunks: asset.chunks, totalBytes: asset.size };
  }
  async function storageUsage(projectId) {
    checkProject(projectId, 'read');
    const assets = Object.values((await state()).assets).filter(asset => asset.projects.includes(projectId));
    return { projectId, assetCount: assets.length, logicalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      exclusiveBytes: assets.filter(asset => asset.projects.length === 1).reduce((sum, asset) => sum + asset.size, 0) };
  }
  async function hasContent(projectId, assetId) {
    checkProject(projectId, 'write');
    const hash = parseIdentity({ version: 1, algorithm: 'sha256', contentId: assetId, size: 0 });
    return !!(await state()).assets[hash];
  }
  async function retainRevisionAssets(projectId, revisionId, assetIds) {
    return locked(async () => {
      checkProject(projectId, 'write');
      if (!ID.test(revisionId || '') || !Array.isArray(assetIds) || new Set(assetIds).size !== assetIds.length
        || assetIds.some(id => typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id))
        || verifyRevision(projectId, revisionId, assetIds) !== true) throw fail('asset-revision-invalid');
      const data = await state();
      for (const id of assetIds) if (!data.assets[id.slice(7)]?.projects.includes(projectId)) throw fail('asset-not-found');
      const revisions = data.revisions[projectId] ||= {};
      if (revisions[revisionId]) {
        if (JSON.stringify(revisions[revisionId]) !== JSON.stringify([...assetIds].sort())) throw fail('asset-revision-immutable');
        return { projectId, revisionId, retained: assetIds.length, created: false };
      }
      revisions[revisionId] = [...assetIds].sort();
      await writeJsonAtomic(indexPath, data);
      return { projectId, revisionId, retained: assetIds.length, created: true };
    });
  }
  function projectReport(data, projectId) {
    const revisions = data.revisions[projectId] || {};
    const assets = Object.entries(data.assets).filter(([, asset]) => asset.projects.includes(projectId))
      .map(([hash, asset]) => {
        const referencedBy = Object.entries(revisions).filter(([, ids]) => ids.includes(`sha256:${hash}`)).map(([id]) => id).sort();
        return { assetId: `sha256:${hash}`, size: asset.size, referencedBy,
          sharedProjects: asset.projects.length > 1, eligible: referencedBy.length === 0 };
      }).sort((a, b) => a.assetId.localeCompare(b.assetId));
    return { schemaVersion: 1, projectId, revisionCount: Object.keys(revisions).length, assets,
      logicalBytes: assets.reduce((sum, item) => sum + item.size, 0),
      deletableBytes: assets.filter(item => item.eligible && !item.sharedProjects).reduce((sum, item) => sum + item.size, 0),
      deletionPerformed: false };
  }
  async function exportProjectReport(projectId) {
    checkOwner(projectId); return projectReport(await state(), projectId);
  }
  async function garbageCollect(projectId, assetIds) {
    return locked(async () => {
      checkOwner(projectId);
      if (!Array.isArray(assetIds) || new Set(assetIds).size !== assetIds.length
        || assetIds.some(id => typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id))) throw fail('asset-delete-invalid');
      const data = await state(); const report = projectReport(data, projectId);
      const candidates = new Map(report.assets.map(item => [item.assetId, item]));
      for (const id of assetIds) {
        const candidate = candidates.get(id);
        if (!candidate) throw fail('asset-not-found');
        if (!candidate.eligible) throw fail('asset-retained-by-revision');
      }
      const physicallyDeleted = [];
      for (const id of assetIds) {
        const asset = data.assets[id.slice(7)];
        asset.projects = asset.projects.filter(id => id !== projectId);
        if (!asset.projects.length) { delete data.assets[id.slice(7)]; physicallyDeleted.push(id); }
      }
      for (const [uploadId, completed] of Object.entries(data.completed)) {
        if (completed.projectId === projectId && assetIds.includes(completed.result.assetId)) delete data.completed[uploadId];
      }
      // Drop references before removing bytes. A crash may leave orphaned encrypted
      // files, but cannot remove content still referenced by a retained revision.
      await writeJsonAtomic(indexPath, data);
      for (const id of physicallyDeleted) await fs.rm(assetDir(id.slice(7)), { recursive: true, force: true });
      return { projectId, released: assetIds, physicallyDeleted, retained: report.assets.filter(item => !item.eligible).length };
    });
  }
  function signedUrl({ projectId, assetId, method, expiresAt }) {
    checkProject(projectId, method === 'GET' ? 'read' : 'write');
    if (!['GET', 'PUT'].includes(method) || typeof assetId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(assetId)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 15 * 60_000) throw fail('asset-url-invalid');
    const payload = `${method}\n${namespace}\n${projectId}\n${assetId}\n${expiresAt}`;
    const signature = createHmac('sha256', urlSecret).update(payload).digest('hex');
    return `${secureOrigin}/assets/${encodeURIComponent(projectId)}/${assetId}?expires=${expiresAt}&method=${method}&signature=${signature}`;
  }
  function verifySignedUrl(url, method) {
    let parsed;
    try { parsed = new URL(url); } catch { throw fail('asset-url-invalid'); }
    const parts = parsed.pathname.split('/');
    if (parsed.origin !== secureOrigin || parts.length !== 4 || parts[1] !== 'assets'
      || !['GET', 'PUT'].includes(method) || parsed.searchParams.get('method') !== method
      || [...parsed.searchParams.keys()].length !== 3) throw fail('asset-url-invalid');
    const projectId = decodeURIComponent(parts[2]), assetId = parts[3], expiresAt = Number(parsed.searchParams.get('expires'));
    if (!ID.test(projectId) || !/^sha256:[a-f0-9]{64}$/.test(assetId) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= now()) throw fail('asset-url-invalid');
    const expected = createHmac('sha256', urlSecret).update(`${method}\n${namespace}\n${projectId}\n${assetId}\n${expiresAt}`).digest('hex');
    const supplied = parsed.searchParams.get('signature') || '';
    if (!SHA.test(supplied) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) throw fail('asset-url-invalid');
    checkProject(projectId, method === 'GET' ? 'read' : 'write');
    return { projectId, assetId, method, expiresAt };
  }
  return { beginUpload, putChunk, uploadStatus, completeUpload, readChunk,
    storageUsage, hasContent, retainRevisionAssets, exportProjectReport, garbageCollect,
    signedUrl, verifySignedUrl };
}

module.exports = { createContentAssetService };
