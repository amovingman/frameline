'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { validateTransferBundle } = require('./revision-transfer');

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const BACKUP_PREFIX = 'frameline-backups/v1/';
const SHA = /^[a-f0-9]{64}$/;
const validPageToken = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const RECORD_FIELDS = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && b.isDirectory() && !b.isSymbolicLink();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function cancelled(signal) { if (signal?.aborted) fail('cloud-backup-cancelled'); }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// Inspect JSON tokens before parsing: duplicate keys could otherwise hide fields
// in the exact bytes being approved for upload. Bound nesting and token count as
// well as byte length; the normal production validators check the full schema.
function parseJson(text) {
  const stack = []; let count = 0;
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    if (++count > 250000) fail('cloud-backup-too-large');
    const value = token[0];
    if (value === '{' || value === '[') {
      stack.push({ object: value === '{', keys: new Set(), nextKey: true });
      if (stack.length > 48) fail('cloud-backup-too-large');
    } else if (value === '}' || value === ']') stack.pop();
    else if (value === ',') { if (stack.at(-1)?.object) stack.at(-1).nextKey = true; }
    else if (value[0] === '"' && stack.at(-1)?.object && stack.at(-1).nextKey) {
      const key = JSON.parse(value), current = stack.at(-1);
      if (current.keys.has(key)) fail('cloud-backup-invalid-bundle');
      current.keys.add(key); current.nextKey = false;
    }
  }
  return JSON.parse(text);
}

function verifyBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) fail('cloud-backup-invalid-bundle');
  if (bytes.length > MAX_BACKUP_BYTES) fail('cloud-backup-too-large');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const bundle = parseJson(text);
    if (!exact(bundle, ['format', 'version', 'projectId', 'branches', 'records'])
      || !Array.isArray(bundle.records) || !bundle.records.length || bundle.records.length > 1000
      || !bundle.branches || typeof bundle.branches !== 'object' || Array.isArray(bundle.branches)
      || Object.keys(bundle.branches).length > 100) fail('cloud-backup-invalid-bundle');
    for (const entry of bundle.records) {
      if (!exact(entry, ['summary', 'bytes']) || typeof entry.bytes !== 'string'
        || !exact(entry.summary, [...RECORD_FIELDS, ...(Object.hasOwn(entry.summary || {}, 'recordHash') ? ['recordHash'] : [])])) fail('cloud-backup-invalid-bundle');
      const record = parseJson(entry.bytes);
      if (!exact(record, [...RECORD_FIELDS, 'manifest'])
        || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
        || record.createdAt.length > 40 || typeof record.message !== 'string' || record.message.length > 120
        || typeof record.author !== 'string' || record.author.length > 120
        || entry.summary.recordHash !== undefined && !SHA.test(entry.summary.recordHash)) fail('cloud-backup-invalid-bundle');
    }
    const records = [...validateTransferBundle(bundle).values()];
    const kinds = new Set(records.map(record => record.manifest.format === 'resolve-api-observation' ? 'resolve' : 'fcpxml'));
    if (kinds.size !== 1 || bundle.version === 2 && kinds.has('fcpxml')
      || kinds.has('resolve') && new Set(records.map(record => record.manifest.snapshot.project_id)).size !== 1) fail('cloud-backup-invalid-bundle');
    return { sha256: hash(bytes), byteCount: bytes.length, revisionCount: records.length,
      branchCount: Object.keys(bundle.branches).length, metadataOnly: true, safeToApply: false };
  } catch (error) {
    if (['cloud-backup-too-large', 'cloud-backup-invalid-bundle'].includes(error?.code)) throw error;
    fail('cloud-backup-invalid-bundle');
  }
}

async function parentIdentity(filename) {
  if (typeof filename !== 'string' || filename.length > 4096 || /[\x00-\x1f\x7f]/.test(filename)
    || !path.isAbsolute(filename) || path.resolve(filename) !== filename) fail('cloud-backup-invalid-file');
  let current = path.parse(filename).root;
  for (const component of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('cloud-backup-invalid-file');
  }
  return fs.lstat(path.dirname(filename));
}
async function checkParent(filename, before) {
  const after = await parentIdentity(filename);
  if (!sameDirectory(before, after)) fail('cloud-backup-invalid-file');
}
function normalizeFileError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('cloud-backup-')) throw error;
  if (error?.code === 'EEXIST') fail('cloud-backup-exists');
  fail('cloud-backup-invalid-file');
}
async function readBackup(filename, signal) {
  cancelled(signal); let handle;
  try {
    const parent = await parentIdentity(filename);
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2) fail('cloud-backup-invalid-file');
    if (before.size > MAX_BACKUP_BYTES) fail('cloud-backup-too-large');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      cancelled(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    const named = await fs.lstat(filename);
    if (offset !== before.size || named.isSymbolicLink() || !sameFile(before, await handle.stat()) || !sameFile(before, named)) fail('cloud-backup-source-changed');
    await checkParent(filename, parent); cancelled(signal);
    const result = bytes.subarray(0, offset);
    return { bytes: result, summary: verifyBytes(result) };
  } catch (error) { normalizeFileError(error); }
  finally { await handle?.close(); }
}

async function inspectBackup(filename) { return (await readBackup(filename)).summary; }
function keyFor(sha256) { if (typeof sha256 !== 'string' || !SHA.test(sha256)) fail('cloud-backup-invalid-id'); return `${BACKUP_PREFIX}${sha256}.json`; }
function requireTransport(transport, method) { if (!transport || typeof transport[method] !== 'function') fail('cloud-backup-unavailable'); }
function normalizeTransportError(error) {
  const allowed = ['auth', 'not-found', 'exists', 'conflict', 'cancelled', 'timeout', 'too-large', 'invalid-response', 'unavailable'];
  if (allowed.some(code => error?.code === `cloud-backup-${code}`)) fail(error.code);
  fail('cloud-backup-unavailable');
}
async function remoteGet(transport, key, signal) {
  requireTransport(transport, 'get'); cancelled(signal);
  let bytes;
  try { bytes = await transport.get({ key, maxBytes: MAX_BACKUP_BYTES, signal }); }
  catch (error) { normalizeTransportError(error); }
  cancelled(signal);
  if (!Buffer.isBuffer(bytes)) fail('cloud-backup-invalid-response');
  if (bytes.length > MAX_BACKUP_BYTES) fail('cloud-backup-too-large');
  return bytes;
}
async function uploadBackup({ filename, expectedSha256, transport, signal } = {}) {
  const key = keyFor(expectedSha256); requireTransport(transport, 'put');
  const { bytes, summary } = await readBackup(filename, signal);
  if (summary.sha256 !== expectedSha256) fail('cloud-backup-review-changed');
  cancelled(signal);
  try { await transport.put({ key, bytes, sha256: summary.sha256, signal }); }
  catch (error) {
    if (error?.code !== 'cloud-backup-exists') normalizeTransportError(error);
    const existing = await remoteGet(transport, key, signal);
    if (!existing.equals(bytes)) fail('cloud-backup-integrity');
    return { ...summary, uploaded: true, reused: true };
  }
  cancelled(signal);
  return { ...summary, uploaded: true, reused: false };
}
async function listBackups({ transport, continuationToken, signal } = {}) {
  requireTransport(transport, 'list'); cancelled(signal);
  if (continuationToken !== undefined && !validPageToken(continuationToken)) fail('cloud-backup-invalid-response');
  let page;
  try { page = await transport.list({ prefix: BACKUP_PREFIX, continuationToken, signal }); }
  catch (error) { normalizeTransportError(error); }
  cancelled(signal);
  if (!exact(page, ['items', 'continuationToken']) || !Array.isArray(page.items) || page.items.length > 100
    || page.continuationToken !== null && (!validPageToken(page.continuationToken) || page.continuationToken === continuationToken)) fail('cloud-backup-invalid-response');
  const seen = new Set();
  const backups = page.items.map(item => {
    if (!item || typeof item.key !== 'string' || !item.key.startsWith(BACKUP_PREFIX)) fail('cloud-backup-invalid-response');
    const sha256 = item.key.slice(BACKUP_PREFIX.length, -5);
    if (!SHA.test(sha256) || keyFor(sha256) !== item.key || seen.has(item.key) || !Number.isSafeInteger(item.size) || item.size < 2 || item.size > MAX_BACKUP_BYTES
      || item.lastModified !== undefined && (typeof item.lastModified !== 'string' || item.lastModified.length > 40 || !Number.isFinite(Date.parse(item.lastModified)))) fail('cloud-backup-invalid-response');
    seen.add(item.key);
    return { sha256, byteCount: item.size, lastModified: item.lastModified ?? null };
  });
  return { backups, continuationToken: page.continuationToken };
}
async function downloadBackup({ sha256, destination, transport, signal } = {}) {
  const key = keyFor(sha256); cancelled(signal);
  let parent;
  try {
    parent = await parentIdentity(destination);
    try { await fs.lstat(destination); fail('cloud-backup-exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) { normalizeFileError(error); }
  const bytes = await remoteGet(transport, key, signal);
  if (hash(bytes) !== sha256) fail('cloud-backup-integrity');
  const summary = verifyBytes(bytes);
  const temporary = path.join(path.dirname(destination), `.frameline-cloud-${randomUUID()}.tmp`);
  let published = false;
  try {
    cancelled(signal); await checkParent(destination, parent);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); cancelled(signal); await handle.sync(); } finally { await handle.close(); }
    await checkParent(destination, parent); cancelled(signal);
    await fs.link(temporary, destination); published = true;
    const directory = await fs.open(path.dirname(destination), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { ...summary, downloaded: true };
  } catch (error) {
    if (published) fail('cloud-backup-save-uncertain');
    normalizeFileError(error);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

module.exports = { MAX_BACKUP_BYTES, BACKUP_PREFIX, inspectBackup, uploadBackup, listBackups, downloadBackup };
