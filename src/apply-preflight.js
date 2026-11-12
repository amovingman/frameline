'use strict';

// Diagnostic only: this is not an authorization or a transaction boundary.
// Callers must repeat all checks within any future exclusive apply transaction.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { verifyResolvePreviewPlan } = require('./resolve-preview-plan');
const { verifyResolveDecisionAudit } = require('./resolve-review-decisions');
const { requireProjectAdapter } = require('./project-adapter');

const HASH = /^[a-f0-9]{64}$/;

async function readVerifiedFile(filePath, expectedHash) {
  if (typeof filePath !== 'string' || !filePath || !HASH.test(expectedHash || '')) throw new Error('invalid-file');
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('not-file');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    const named = await fs.lstat(filePath);
    if (named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== named.size || before.mtimeMs !== named.mtimeMs || before.ctimeMs !== named.ctimeMs ||
        digest.digest('hex') !== expectedHash) throw new Error('file-changed');
    return { dev: before.dev, ino: before.ino, size: before.size };
  } finally { await handle.close(); }
}

/**
 * Read-only diagnostics for a future main-process apply transaction.
 * Inputs: { plan, sources, audit, sourcePath, expectedSourceHash, restorePoint, adapter }.
 * restorePoint is the { restorePointPath, sha256, size } record from createRestorePoint.
 * Existing media requirements have no trusted readiness verifier and therefore block.
 * The result is never permission to write, even when blockers is empty.
 */
async function checkApplyPreflight({ plan, sources, audit, sourcePath, expectedSourceHash, restorePoint, adapter } = {}) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  let planValid = false;
  try { planValid = verifyResolvePreviewPlan(plan, sources).valid; } catch { /* invalid plan */ }
  if (!planValid) block('plan-source-binding-invalid', 'The read-only plan or its source bindings are invalid or stale.');

  let auditValid = false;
  if (planValid) {
    try { auditValid = verifyResolveDecisionAudit(audit, plan, sources).valid === true; } catch { /* invalid audit */ }
  }
  if (!auditValid) block('conflict-audit-invalid', 'A complete, source-bound conflict audit is required.');
  if (!planValid || !Array.isArray(plan.assessment.mediaRequirements) || plan.assessment.mediaRequirements.length) {
    block('media-readiness-unverified', 'Media readiness cannot be verified for this plan.');
  }

  // Resolve snapshot bytes do not identify or authenticate the editor project file.
  // A caller-provided hash alone cannot establish that missing association.
  block('project-plan-binding-unverified', 'The project file is not bound to the reviewed snapshot plan.');

  let source;
  try { source = await readVerifiedFile(sourcePath, expectedSourceHash); }
  catch { block('source-hash-invalid', 'The current source file could not be verified against its expected hash.'); }

  try {
    requireProjectAdapter(adapter);
    if (adapter.capabilities.readOnly !== false || adapter.capabilities.stableIds !== true ||
        adapter.capabilities.apply !== true || adapter.capabilities.editorValidation !== true) throw new Error('unsupported');
  } catch { block('adapter-capabilities-unavailable', 'The adapter lacks proven stable IDs, apply, or editor validation capabilities.'); }

  try {
    if (!source || !restorePoint || restorePoint.sha256 !== expectedSourceHash ||
        !Number.isSafeInteger(restorePoint.size) || restorePoint.size !== source.size) throw new Error('invalid-restore');
    const copy = await readVerifiedFile(restorePoint.restorePointPath, expectedSourceHash);
    if (copy.size !== source.size || (copy.dev === source.dev && copy.ino === source.ino)) throw new Error('invalid-restore');
  } catch { block('restore-point-invalid', 'A distinct verified restore point of the current source is required.'); }

  return { schemaVersion: 1, readOnly: true, safeToApply: false, blockers };
}

module.exports = { checkApplyPreflight };
