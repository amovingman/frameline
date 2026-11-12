'use strict';

// Local, read-only artifacts. Sources remain with the caller and must be supplied
// again on recovery; this store neither applies changes nor performs remote sync.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createResolvePreviewPlan, verifyResolvePreviewPlan } = require('./resolve-preview-plan');

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/u;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function invalid() {
  const error = new Error('Invalid, stale, or corrupted Resolve preview artifact.');
  error.code = 'invalid-resolve-preview-artifact';
  throw error;
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function filePath(directory, id) {
  if (typeof directory !== 'string' || !directory || typeof id !== 'string' || !ID.test(id)) invalid();
  return path.join(directory, `${id}.json`);
}
function readBounded(filename) {
  const fd = fs.openSync(filename, FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (offset !== stat.size) invalid();
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

/**
 * Save a freshly computed preview in an existing caller-owned directory.
 * Returns its immutable SHA-256 identifier. Repeated saves are idempotent.
 * Only the preview is stored; exact source bytes are required again to load.
 */
function saveResolvePreview(directory, sources) {
  const plan = createResolvePreviewPlan(sources);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, readOnly: true, safeToApply: false, plan }), 'utf8');
  if (bytes.length > MAX_ARTIFACT_BYTES) invalid();
  const id = hash(bytes);
  const destination = filePath(directory, id);
  const temporary = path.join(directory, `.resolve-preview-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, destination); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never replace an existing artifact, even if it is damaged.
      if (!readBounded(destination).equals(bytes)) invalid();
    }
    return id;
  } finally { if (created) fs.unlinkSync(temporary); }
}

/** Load only after checking the content address, format, exact sources, and regenerated plan. */
function loadResolvePreview(directory, id, sources) {
  try {
    const bytes = readBounded(filePath(directory, id));
    if (hash(bytes) !== id) invalid();
    const artifact = JSON.parse(bytes.toString('utf8'));
    if (!artifact || Array.isArray(artifact) || Object.keys(artifact).sort().join(',') !== 'plan,readOnly,safeToApply,schemaVersion'
      || artifact.schemaVersion !== 1 || artifact.readOnly !== true || artifact.safeToApply !== false) invalid();
    if (!verifyResolvePreviewPlan(artifact.plan, sources).valid) invalid();
    return artifact.plan;
  } catch { invalid(); }
}

module.exports = { saveResolvePreview, loadResolvePreview, MAX_ARTIFACT_BYTES };
