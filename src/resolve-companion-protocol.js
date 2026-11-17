'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');

const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BYTES = 20 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail() { const error = new Error('resolve-companion-invalid'); error.code = 'resolve-companion-invalid'; throw error; }
function projectName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160
    && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
}
function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...names].sort().join('|');
}
async function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail();
  const selected = path.resolve(directory);
  try {
    const stat = await fs.lstat(selected);
    if (!stat.isDirectory() || stat.mode & 0o077) fail();
  } catch { fail(); }
  return fs.realpath(selected);
}
async function readPrivateFile(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > MAX_BYTES) fail();
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) fail();
    return bytes;
  } catch { fail(); }
  finally { await handle?.close(); }
}

// The main process prepares a private, time-limited request for Resolve's
// internal Console; no external API connection is required.
async function createCaptureRequest({ directory, expectedProjectName, now = () => Date.now() } = {}) {
  const root = await privateDirectory(directory);
  if (!projectName(expectedProjectName)) fail();
  const createdAt = now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail();
  const requestId = randomBytes(16).toString('hex');
  const request = { schemaVersion: 1, operation: 'capture', requestId,
    createdAt, expiresAt: createdAt + 5 * 60 * 1000, expectedProjectName };
  if (!Number.isSafeInteger(request.expiresAt)) fail();
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
  const filename = path.join(root, `${requestId}.request.json`);
  try { await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
  catch { fail(); }
  return { requestId, requestSha256: sha(bytes), requestFile: filename,
    expiresAt: request.expiresAt };
}

async function readCaptureResponse({ directory, requestId, requestSha256, now = () => Date.now(),
  includeSnapshot = false, responseText } = {}) {
  const root = await privateDirectory(directory);
  if (!ID.test(requestId || '') || !SHA.test(requestSha256 || '')) fail();
  const requestBytes = await readPrivateFile(path.join(root, `${requestId}.request.json`));
  if (sha(requestBytes) !== requestSha256) fail();
  let request, response;
  try {
    request = JSON.parse(requestBytes);
    if (responseText !== undefined && (typeof responseText !== 'string'
      || Buffer.byteLength(responseText) < 1 || Buffer.byteLength(responseText) > MAX_BYTES)) fail();
    response = JSON.parse(responseText === undefined
      ? await readPrivateFile(path.join(root, `${requestId}.response.json`)) : responseText);
  } catch { fail(); }
  const checkedAt = now();
  if (!exactKeys(request, ['schemaVersion', 'operation', 'requestId', 'createdAt', 'expiresAt', 'expectedProjectName'])
    || request.schemaVersion !== 1 || request.operation !== 'capture' || request.requestId !== requestId
    || !projectName(request.expectedProjectName) || !Number.isSafeInteger(request.createdAt)
    || request.createdAt < 0
    || request.expiresAt !== request.createdAt + 5 * 60 * 1000
    || !Number.isSafeInteger(checkedAt) || checkedAt > request.expiresAt
    || !exactKeys(response, ['schemaVersion', 'operation', 'requestId', 'requestSha256', 'snapshot'])
    || response.schemaVersion !== 1 || response.operation !== 'capture-result'
    || response.requestId !== requestId || response.requestSha256 !== requestSha256) fail();
  try { validateResolveSnapshot(response.snapshot); } catch { fail(); }
  if (response.snapshot.project_name !== request.expectedProjectName) fail();
  return { requestId, snapshotSha256: sha(Buffer.from(JSON.stringify(response.snapshot))),
    manifest: normalizeResolveSnapshot(response.snapshot), readOnly: true, safeToApply: false,
    ...(includeSnapshot ? { snapshot: response.snapshot } : {}) };
}

module.exports = { createCaptureRequest, readCaptureResponse };
