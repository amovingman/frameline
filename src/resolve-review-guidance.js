'use strict';
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { verifyResolvePreviewPlan } = require('./resolve-preview-plan');
const { parseResolvePreviewSource } = require('./resolve-preview-source');
const { describeResolveDeletionPolicy } = require('./resolve-deletion-policy');
const { createResolvePlacementPolicy } = require('./resolve-placement-policy');
const { createResolveChangeContext } = require('./resolve-change-context');
const { createResolveReviewRiskPolicy } = require('./resolve-review-risk-policy');
const ROLES = ['base', 'local', 'incoming'];
const invalid = () => Object.assign(new Error('Invalid Resolve review guidance.'), { code: 'invalid-resolve-review-guidance' });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Derived from exactly the verified review sources. This presentation artifact
// has its own hash and does not change immutable historical plan/audit hashes.
function createResolveReviewGuidance(plan, sources) {
  try {
    if (!verifyResolvePreviewPlan(plan, sources).valid) throw invalid();
    const documents = Object.fromEntries(ROLES.map(role => [role, parseResolvePreviewSource(sources[role])]));
    const normalized = Object.fromEntries(ROLES.map(role => [role, documents[role].normalized]));
    const report = { schemaVersion: 1, readOnly: true, safeToApply: false,
      sourceHashes: { ...plan.binding.hashes },
      deletionPolicy: describeResolveDeletionPolicy(plan.classification),
      placementPolicy: createResolvePlacementPolicy(normalized),
      changeContext: createResolveChangeContext(documents, plan.classification),
      riskPolicy: createResolveReviewRiskPolicy(plan.classification, normalized) };
    return { ...report, guidanceHash: createHash('sha256').update(JSON.stringify(canonical(report))).digest('hex') };
  } catch { throw invalid(); }
}
function verifyResolveReviewGuidance(guidance, plan, sources) {
  if (!isDeepStrictEqual(guidance, createResolveReviewGuidance(plan, sources))) throw invalid();
  return { valid: true, readOnly: true, safeToApply: false };
}
module.exports = { createResolveReviewGuidance, verifyResolveReviewGuidance };
