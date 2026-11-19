'use strict';
const { fingerprint } = require('./project-api-contracts');
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const classes = ['original', 'proxy', 'audio', 'graphics', 'other'];
const MAX_REQUEST_BYTES = 1024 * 1024, MAX_ASSETS = 1000;
function label(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 64
    || /[\x00-\x1f\x7f/\\:]/.test(value)) throw fail('shared-storage-label-invalid');
  return value;
}
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\x00-\x1f\x7f\\:]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.length <= 255);
}
function validateStorageRequest(value) {
  const bad = () => { throw fail('shared-storage-request-invalid'); };
  if (!exact(value, ['schemaVersion', 'projectId', 'sourceHash', 'assets']) || value.schemaVersion !== 1
    || !id(value.projectId) || !hash(value.sourceHash) || !Array.isArray(value.assets)
    || value.assets.length < 1 || value.assets.length > MAX_ASSETS) bad();
  const ids = new Set(), paths = new Set();
  for (const asset of value.assets) {
    if (!exact(asset, ['id', 'relativePath', 'assetClass', 'expected']) || !id(asset.id) || ids.has(asset.id)
      || !relative(asset.relativePath) || paths.has(asset.relativePath) || !classes.includes(asset.assetClass)
      || !exact(asset.expected, ['size', 'sha256']) || !Number.isSafeInteger(asset.expected.size)
      || asset.expected.size < 0 || !hash(asset.expected.sha256)) bad();
    ids.add(asset.id); paths.add(asset.relativePath);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST_BYTES) bad();
  return structuredClone({ ...value, assets: [...value.assets].sort((a, b) => a.id.localeCompare(b.id, 'en')) });
}
function storageRequestSummary(request) {
  request = validateStorageRequest(request);
  return { projectId: request.projectId, sourceHash: request.sourceHash, requestHash: fingerprint(request),
    assetCount: request.assets.length, assets: request.assets.map(({ id, assetClass, expected }) => ({ id, assetClass, expected })) };
}
const REASONS = ['size-and-hash-match', 'size-mismatch', 'hash-mismatch', 'candidate-missing',
  'candidate-unreadable', 'symlink-unsupported', 'not-regular-file', 'file-changed'];
function validateStorageReport(value) {
  const bad = () => { throw fail('shared-storage-state-invalid'); };
  if (!exact(value, ['schemaVersion', 'volumeId', 'volumeVersion', 'projectId', 'sourceHash', 'requestHash', 'checkedAt', 'items', 'reportHash'])
    || value.schemaVersion !== 1 || !id(value.volumeId) || !Number.isSafeInteger(value.volumeVersion) || value.volumeVersion < 1
    || !id(value.projectId) || !hash(value.sourceHash) || !hash(value.requestHash) || !hash(value.reportHash)
    || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_ASSETS) bad();
  const ids = new Set();
  for (const item of value.items) {
    if (!exact(item, ['id', 'assetClass', 'expected', 'verified', 'reason']) || !id(item.id) || ids.has(item.id)
      || !classes.includes(item.assetClass) || !exact(item.expected, ['size', 'sha256'])
      || !Number.isSafeInteger(item.expected.size) || item.expected.size < 0 || !hash(item.expected.sha256)
      || typeof item.verified !== 'boolean' || !REASONS.includes(item.reason)
      || item.verified !== (item.reason === 'size-and-hash-match')) bad();
    ids.add(item.id);
  }
  const { reportHash, ...body } = value;
  if (reportHash !== fingerprint(body)) bad();
  return structuredClone(value);
}
module.exports = { validateStorageRequest, storageRequestSummary, validateStorageReport, label,
  exact, id, hash, MAX_REQUEST_BYTES, MAX_ASSETS, fail };
