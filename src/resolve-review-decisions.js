'use strict';

// Review choices record intent only. They never authorize or perform editor writes.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { verifyResolvePreviewPlan } = require('./resolve-preview-plan');
const MANUAL_FIELDS = Object.freeze([]);

function invalid() {
  const error = new Error('Invalid or stale Resolve conflict review decisions.');
  error.code = 'invalid-resolve-review-decisions';
  throw error;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function createResolveConflictReview(plan, sources) {
  try {
    if (!verifyResolvePreviewPlan(plan, sources).valid) invalid();
    const planHash = hash(plan);
    const conflicts = plan.assessment.conflicts.map(conflict => ({
      id: hash({ planHash, conflict }),
      timelineId: conflict.timelineId, itemId: conflict.itemId, field: conflict.field,
      base: canonical(conflict.base), local: canonical(conflict.local), incoming: canonical(conflict.incoming),
      options: ['keep-local', 'take-incoming']
    })).sort((a, b) => a.timelineId.localeCompare(b.timelineId, 'en')
      || (a.itemId || '').localeCompare(b.itemId || '', 'en')
      || a.field.localeCompare(b.field, 'en') || a.id.localeCompare(b.id, 'en'));
    return freeze({ schemaVersion: 1, readOnly: true, safeToApply: false,
      binding: canonical(plan.binding), planHash, manualFields: [...MANUAL_FIELDS], conflicts });
  } catch { invalid(); }
}

function createResolveDecisionAudit(plan, sources, decisions) {
  try {
    const review = createResolveConflictReview(plan, sources);
    if (!Array.isArray(decisions) || decisions.length !== review.conflicts.length) invalid();
    const byId = new Map();
    for (const decision of decisions) {
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || Reflect.ownKeys(decision).length !== 2
        || !Object.hasOwn(decision, 'conflictId') || !Object.hasOwn(decision, 'choice')
        || typeof decision.conflictId !== 'string' || byId.has(decision.conflictId)
        || !['keep-local', 'take-incoming'].includes(decision.choice)) invalid();
      byId.set(decision.conflictId, decision.choice);
    }
    const choices = review.conflicts.map(conflict => {
      if (!byId.has(conflict.id)) invalid();
      const choice = byId.get(conflict.id);
      return { conflictId: conflict.id, timelineId: conflict.timelineId, itemId: conflict.itemId,
        field: conflict.field, choice, selectedValue: canonical(choice === 'keep-local' ? conflict.local : conflict.incoming) };
    });
    const record = { schemaVersion: 1, readOnly: true, safeToApply: false,
      binding: canonical(review.binding), planHash: review.planHash, choices,
      warnings: canonical(plan.assessment.warnings), mediaRequirements: canonical(plan.assessment.mediaRequirements),
      validationStatus: 'review-only' };
    return freeze({ ...record, auditHash: hash(record) });
  } catch { invalid(); }
}

function verifyResolveDecisionAudit(audit, plan, sources) {
  try {
    if (!audit || !Array.isArray(audit.choices)) invalid();
    const expected = createResolveDecisionAudit(plan, sources,
      audit.choices.map(({ conflictId, choice }) => ({ conflictId, choice })));
    if (!isDeepStrictEqual(audit, expected)) invalid();
    return freeze({ valid: true, readOnly: true, safeToApply: false });
  } catch { invalid(); }
}
module.exports = { createResolveConflictReview, createResolveDecisionAudit, verifyResolveDecisionAudit, MANUAL_FIELDS };
