'use strict';

// Content-addressed review choices; sources and their paths are never stored.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createResolvePreviewPlan } = require('./resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('./resolve-review-decisions');

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/u;
function invalid() { const error = new Error('Invalid, stale, or corrupted Resolve review artifact.'); error.code = 'invalid-resolve-review-artifact'; throw error; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function filename(directory, id) {
  if (typeof directory !== 'string' || !directory || typeof id !== 'string' || !ID.test(id)) invalid();
  return path.join(directory, `review-${id}.json`);
}
function read(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) invalid();
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) break; offset += n; }
    if (offset !== stat.size) invalid();
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function build(sources, decisions) {
  const plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources);
  if (!Array.isArray(decisions)) invalid();
  const seen = new Set();
  const normalized = decisions.map(decision => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)
      || Reflect.ownKeys(decision).length !== 2 || !Object.hasOwn(decision, 'conflictId') || !Object.hasOwn(decision, 'choice')
      || typeof decision.conflictId !== 'string' || seen.has(decision.conflictId)
      || !review.conflicts.some(conflict => conflict.id === decision.conflictId)
      || !['keep-local', 'take-incoming'].includes(decision.choice)) invalid();
    seen.add(decision.conflictId);
    return { conflictId: decision.conflictId, choice: decision.choice };
  }).sort((a, b) => a.conflictId.localeCompare(b.conflictId, 'en'));
  const audit = normalized.length === review.conflicts.length ? createResolveDecisionAudit(plan, sources, normalized) : null;
  return { plan, review, decisions: normalized, audit };
}
function saveResolveReview(directory, sources, decisions) {
  try {
    const { plan, decisions: choices, audit } = build(sources, decisions);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, readOnly: true, safeToApply: false,
      binding: plan.binding, decisions: choices, auditHash: audit ? audit.auditHash : null }));
    if (bytes.length > MAX_ARTIFACT_BYTES) invalid();
    const id = hash(bytes), destination = filename(directory, id);
    const temporary = path.join(directory, `.resolve-review-${randomBytes(16).toString('hex')}.tmp`);
    let created = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temporary, destination); } catch (error) { if (error.code !== 'EEXIST' || !read(destination).equals(bytes)) throw error; }
      return id;
    } finally { if (created) fs.unlinkSync(temporary); }
  } catch { invalid(); }
}
function loadResolveReview(directory, id, sources) {
  try {
    const bytes = read(filename(directory, id));
    if (hash(bytes) !== id) invalid();
    const artifact = JSON.parse(bytes.toString('utf8'));
    if (!artifact || Array.isArray(artifact) || Object.keys(artifact).sort().join(',') !== 'auditHash,binding,decisions,readOnly,safeToApply,schemaVersion'
      || artifact.schemaVersion !== 1 || artifact.readOnly !== true || artifact.safeToApply !== false) invalid();
    const result = build(sources, artifact.decisions);
    if (!isDeepStrictEqual(artifact.binding, result.plan.binding) || !isDeepStrictEqual(artifact.decisions, result.decisions)
      || artifact.auditHash !== (result.audit ? result.audit.auditHash : null)) invalid();
    return result;
  } catch { invalid(); }
}
module.exports = { saveResolveReview, loadResolveReview, MAX_ARTIFACT_BYTES };
