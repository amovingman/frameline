const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { verifyCandidate, fingerprintFile } = require('./local-media-readiness');

const CLASSES = Object.freeze(['original', 'proxy', 'audio', 'graphics', 'other']);
const SHA_ID = /^sha256:[a-f0-9]{64}$/;
const ITEM_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }
function validateAsset(asset) {
  if (!asset || !ITEM_ID.test(asset.id || '') || !SHA_ID.test(asset.contentId || '')
    || !Number.isSafeInteger(asset.size) || asset.size < 0 || !CLASSES.includes(asset.assetClass)
    || asset.required !== undefined && typeof asset.required !== 'boolean') throw fail('media-policy-asset-invalid');
  return asset;
}
function validateAssets(assets) {
  if (!Array.isArray(assets) || new Set(assets.map(item => item?.id)).size !== assets.length) throw fail('media-policy-assets-invalid');
  return assets.map(validateAsset);
}

// Inputs are evidence, not guesses from filenames. A verified local original
// cannot be replaced by a same-named proxy or an unverified relink candidate.
function classifyMediaAvailability({ localVerified = false, cloudPresent = false,
  collaboratorPresent = false, excluded = false, archived = false } = {}) {
  if (![localVerified, cloudPresent, collaboratorPresent, excluded, archived].every(value => typeof value === 'boolean')) throw fail('media-evidence-invalid');
  const state = excluded ? 'excluded' : archived ? 'archived' : cloudPresent ? 'cloud-present'
    : localVerified ? 'local-only' : collaboratorPresent ? 'collaborator-only' : 'missing';
  return { state, localVerified, cloudPresent, collaboratorPresent, excluded, archived };
}

// No class syncs by default. Policy updates require project write authority.
function createProjectMediaPolicy({ authorize, initialState = null } = {}) {
  if (typeof authorize !== 'function') throw fail('media-policy-invalid');
  const state = initialState ? structuredClone(initialState) : { version: 1, projects: {} };
  if (state.version !== 1 || !state.projects || typeof state.projects !== 'object') throw fail('media-policy-invalid');
  for (const [projectId, classes] of Object.entries(state.projects)) {
    if (!ITEM_ID.test(projectId) || !Array.isArray(classes) || classes.some(value => !CLASSES.includes(value))
      || new Set(classes).size !== classes.length) throw fail('media-policy-invalid');
  }
  function allowed(projectId, action) {
    if (!ITEM_ID.test(projectId || '') || authorize(projectId, action) !== true) throw fail('media-policy-forbidden');
  }
  function get(projectId) {
    allowed(projectId, 'read');
    return { projectId, syncClasses: [...(state.projects[projectId] || [])] };
  }
  function set(projectId, syncClasses) {
    allowed(projectId, 'write');
    if (!Array.isArray(syncClasses) || syncClasses.some(value => !CLASSES.includes(value))
      || new Set(syncClasses).size !== syncClasses.length) throw fail('media-policy-invalid');
    state.projects[projectId] = [...syncClasses].sort();
    return get(projectId);
  }
  function snapshot() { return structuredClone(state); }
  return { get, set, snapshot };
}

function planRevisionDownloads({ projectId, revisionId, assets, availability }) {
  if (!ITEM_ID.test(projectId || '') || !ITEM_ID.test(revisionId || '') || !availability || typeof availability !== 'object') throw fail('media-download-plan-invalid');
  const items = validateAssets(assets).filter(asset => asset.required !== false).map(asset => {
    const evidence = availability[asset.id];
    if (!evidence || !['cloud-present', 'local-only', 'collaborator-only', 'missing', 'excluded', 'archived'].includes(evidence.state)) throw fail('media-download-plan-invalid');
    const action = evidence.localVerified ? 'skip-local' : evidence.state === 'cloud-present' ? 'download' : 'blocked';
    return { id: asset.id, contentId: asset.contentId, size: asset.size, assetClass: asset.assetClass,
      action, reason: action === 'blocked' ? evidence.state : null };
  });
  return { version: 1, projectId, revisionId, items, requiredCount: items.length,
    downloadBytes: items.filter(item => item.action === 'download').reduce((sum, item) => sum + item.size, 0),
    ready: items.every(item => item.action !== 'blocked') };
}

// Downloads only the plan's required cloud items into content-hash-named files.
// Existing files are checked by size and hash; no file is overwritten.
async function downloadRequiredMedia(plan, { destination, service, resolveRevisionAssets,
  verifyLocalAsset, signal, onProgress = () => {} } = {}) {
  if (!plan || plan.version !== 1 || !ITEM_ID.test(plan.projectId || '') || !ITEM_ID.test(plan.revisionId || '')
    || !Array.isArray(plan.items) || !service || typeof service.readChunk !== 'function'
    || typeof resolveRevisionAssets !== 'function' || typeof destination !== 'string' || !path.isAbsolute(destination)) throw fail('media-download-invalid');
  const revision = await resolveRevisionAssets(plan.projectId, plan.revisionId);
  if (!revision || revision.projectId !== plan.projectId || revision.id !== plan.revisionId) throw fail('media-revision-stale');
  const required = validateAssets(revision.assets).filter(item => item.required !== false);
  if (required.length !== plan.items.length || new Set(plan.items.map(item => item.id)).size !== plan.items.length
    || !plan.items.every(item => {
    const source = required.find(asset => asset.id === item.id);
    return source && source.contentId === item.contentId && source.size === item.size
      && source.assetClass === item.assetClass && ['skip-local', 'download', 'blocked'].includes(item.action);
  }) || plan.items.some(item => item.action === 'blocked')) throw fail('media-download-plan-stale');
  for (const item of plan.items.filter(item => item.action === 'skip-local')) {
    if (typeof verifyLocalAsset !== 'function' || await verifyLocalAsset(item) !== true) throw fail('media-local-unverified');
  }
  const root = await fs.realpath(destination);
  if (root !== path.resolve(destination) || !(await fs.stat(root)).isDirectory()) throw fail('media-destination-invalid');
  const results = [];
  for (const item of plan.items) {
    validateAsset(item);
    if (signal?.aborted) throw fail('media-download-cancelled');
    if (item.action !== 'download') continue;
    const target = path.join(root, item.contentId.slice(7));
    try {
      const existing = await fingerprintFile(target);
      if (existing.size === item.size && existing.sha256 === item.contentId.slice(7)) {
        results.push({ id: item.id, status: 'already-present' }); continue;
      }
      throw fail('media-destination-collision');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(root, `.frameline-${randomUUID()}.part`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      const digest = createHash('sha256'); let bytesWritten = 0, chunks = null;
      for (let index = 0; chunks === null || index < chunks; index++) {
        if (signal?.aborted) throw fail('media-download-cancelled');
        const chunk = await service.readChunk({ projectId: plan.projectId, assetId: item.contentId, index, signal });
        if (!Buffer.isBuffer(chunk.bytes) || chunk.checksum !== createHash('sha256').update(chunk.bytes).digest('hex')
          || !Number.isSafeInteger(chunk.chunks) || chunk.chunks < 1 || chunks !== null && chunks !== chunk.chunks) throw fail('media-download-corrupt');
        chunks = chunk.chunks;
        let written = 0;
        while (written < chunk.bytes.length) {
          const result = await handle.write(chunk.bytes, written, chunk.bytes.length - written, bytesWritten + written);
          if (result.bytesWritten < 1) throw fail('media-download-write-failed');
          written += result.bytesWritten;
        }
        digest.update(chunk.bytes); bytesWritten += chunk.bytes.length;
        onProgress({ id: item.id, bytesWritten, totalBytes: item.size });
      }
      if (bytesWritten !== item.size || digest.digest('hex') !== item.contentId.slice(7)) throw fail('media-download-corrupt');
      await handle.sync(); await handle.close(); handle = null;
      await fs.link(temporary, target); // EEXIST fails safely, unlike rename.
      results.push({ id: item.id, status: 'downloaded' });
    } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
  }
  return { projectId: plan.projectId, revisionId: plan.revisionId, results };
}

async function evaluateRelinkCandidate({ required, candidatePath, candidateClass }) {
  validateAsset(required);
  if (candidateClass !== required.assetClass) return { id: required.id, verified: false, reason: 'asset-class-mismatch' };
  const result = await verifyCandidate(candidatePath, { size: required.size, sha256: required.contentId.slice(7) });
  return { id: required.id, verified: result.verified, reason: result.reason };
}

async function estimateUpload({ projectId, assets, policy, service }) {
  if (!policy || !service || typeof service.hasContent !== 'function' || typeof service.storageUsage !== 'function') throw fail('media-upload-estimate-invalid');
  const allowed = new Set(policy.get(projectId).syncClasses);
  const seen = new Set(); const items = []; let uploadBytes = 0, excludedBytes = 0, reusedBytes = 0;
  for (const asset of validateAssets(assets)) {
    if (!allowed.has(asset.assetClass)) { excludedBytes += asset.size; items.push({ id: asset.id, assetClass: asset.assetClass, action: 'excluded-by-policy', bytes: asset.size }); continue; }
    if (seen.has(asset.contentId) || await service.hasContent(projectId, asset.contentId)) {
      reusedBytes += asset.size; items.push({ id: asset.id, assetClass: asset.assetClass, action: 'reuse', bytes: asset.size });
    } else { seen.add(asset.contentId); uploadBytes += asset.size; items.push({ id: asset.id, assetClass: asset.assetClass, action: 'upload', bytes: asset.size }); }
  }
  return { projectId, uploadBytes, excludedBytes, reusedBytes, currentUsage: await service.storageUsage(projectId), items };
}

module.exports = { CLASSES, classifyMediaAvailability, createProjectMediaPolicy,
  planRevisionDownloads, downloadRequiredMedia, evaluateRelinkCandidate, estimateUpload };
