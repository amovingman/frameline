'use strict';

const { createResolvePreviewPlan, refreshResolvePreviewPlan } = require('./resolve-preview-plan');
const { saveResolvePreview, loadResolvePreview } = require('./resolve-preview-store');
const { saveResolveReview, loadResolveReview } = require('./resolve-review-store');
const { createResolveConflictReview, createResolveDecisionAudit } = require('./resolve-review-decisions');

// Source bytes and bindings stay in the main process. The public state is a
// detached JSON value and never grants permission to apply a change.
function createResolveReviewSession({ artifactDirectory }) {
  let plan = null, review = null, sources = null, decisions = [], audit = null, artifactId = null;
  let status = 'empty', error = null, reviewArtifactId = null, sourceVerification = null;
  const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));
  function publicValue(value) {
    if (!value) return null;
    const result = clone(value);
    delete result.binding;
    return result;
  }
  function getState() {
    return { status, plan: publicValue(plan), review: publicValue(review), decisions: clone(decisions),
      audit: publicValue(audit), artifactId, reviewArtifactId, sourceHashes: plan ? clone(plan.binding.hashes) : null,
      sourceVerification: clone(sourceVerification), error: clone(error) };
  }
  function failure(code, message, clear = false) {
    if (clear) { plan = review = sources = audit = artifactId = reviewArtifactId = sourceVerification = null; decisions = []; }
    status = clear || !plan ? 'error' : 'ready';
    error = { code, message };
    return getState();
  }
  function copySources(input) {
    // Preview validation enforces the exact source shape and permitted types.
    return Object.fromEntries(['base', 'local', 'incoming'].map(role => [role,
      Buffer.isBuffer(input[role]) ? Buffer.from(input[role]) : input[role]]));
  }
  function install(nextPlan, input, keep) {
    const nextSources = copySources(input);
    const nextReview = createResolveConflictReview(nextPlan, nextSources);
    const nextDecisions = keep ? decisions : [];
    const nextAudit = nextDecisions.length === nextReview.conflicts.length
      ? createResolveDecisionAudit(nextPlan, nextSources, nextDecisions) : null;
    plan = nextPlan; sources = nextSources; review = nextReview; decisions = nextDecisions; audit = nextAudit;
    if (!keep) artifactId = reviewArtifactId = null;
    sourceVerification = { changed: false, staleRoles: [] };
    status = 'ready'; error = null;
    return getState();
  }
  function load(input) {
    try { return install(createResolvePreviewPlan(input), input, false); }
    catch { return failure('invalid-resolve-preview', 'Unable to load Resolve review sources.', true); }
  }
  function refresh(input) {
    try {
      if (!plan) return load(input);
      const result = refreshResolvePreviewPlan(plan, input);
      install(result.plan, input, !result.refreshed);
      sourceVerification = { changed: result.refreshed, staleRoles: result.verification.staleRoles };
      return getState();
    } catch { return failure('invalid-resolve-preview', 'Unable to refresh Resolve review sources.', true); }
  }
  function save() {
    try {
      if (!plan || !sources) throw new Error();
      artifactId = saveResolvePreview(artifactDirectory, sources);
      error = null; status = 'ready';
      return getState();
    } catch { return failure('invalid-resolve-preview-artifact', 'Unable to save Resolve review preview.'); }
  }
  function recover(id, input) {
    try {
      const loaded = loadResolvePreview(artifactDirectory, id, input);
      install(loaded, input, false);
      artifactId = id;
      return getState();
    } catch { return failure('invalid-resolve-preview-artifact', 'Unable to recover Resolve review preview.', true); }
  }
  function saveReview() {
    try {
      if (!plan || !sources) throw new Error();
      reviewArtifactId = saveResolveReview(artifactDirectory, sources, decisions);
      error = null; status = 'ready'; return getState();
    } catch { return failure('invalid-resolve-review-artifact', 'Unable to save Resolve review choices.'); }
  }
  function recoverReview(id, input) {
    try {
      const loaded = loadResolveReview(artifactDirectory, id, input);
      install(loaded.plan, input, false);
      decisions = loaded.decisions; audit = loaded.audit; reviewArtifactId = id;
      return getState();
    } catch { return failure('invalid-resolve-review-artifact', 'Unable to recover Resolve review choices.', true); }
  }
  function setDecision(conflictId, choice) {
    try {
      if (!review || typeof conflictId !== 'string' || !review.conflicts.some(conflict => conflict.id === conflictId)
        || !['keep-local', 'take-incoming'].includes(choice)) throw new Error();
      const next = decisions.filter(decision => decision.conflictId !== conflictId);
      next.push({ conflictId, choice });
      next.sort((a, b) => a.conflictId.localeCompare(b.conflictId, 'en'));
      const nextAudit = next.length === review.conflicts.length ? createResolveDecisionAudit(plan, sources, next) : null;
      if (JSON.stringify(next) !== JSON.stringify(decisions)) reviewArtifactId = null;
      decisions = next; audit = nextAudit; status = 'ready'; error = null;
      return getState();
    } catch { return failure('invalid-resolve-review-decisions', 'Unable to record Resolve review decision.'); }
  }
  return { load, refresh, save, recover, saveReview, recoverReview, setDecision, getState };
}
module.exports = { createResolveReviewSession };
