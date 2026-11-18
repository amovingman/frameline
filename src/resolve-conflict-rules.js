// Observed-field review guidance only. No property has a proven safe apply rule.
const { assessResolvePlan } = require('./resolve-plan-policy');
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const TIMELINE_FIELDS = new Set(['track', 'tracks', 'startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame']);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const order = (a, b) => cmp(a.timelineId, b.timelineId) || cmp(a.itemId || '', b.itemId || '')
  || cmp(a.field, b.field) || cmp(JSON.stringify(a), JSON.stringify(b));

function analyzeResolveConflictRules(classification) {
  // Reuse the existing classification boundary and its validation error contract.
  assessResolvePlan(classification);
  const decisions = classification.decisions.map(canonical).sort(order);
  const fieldReviews = [];
  const entityConflicts = [];
  const timelineReviews = [];
  const additions = new Map();
  for (const decision of decisions) {
    const { timelineId, itemId, field, status, base, local, incoming } = decision;
    if (field !== 'existence') {
      fieldReviews.push({ ...decision, rule: status === 'conflict' ? 'same-field-conflict'
        : status === 'already-applied' ? 'matching-observation' : 'independent-field-edit',
      requiresManualReview: true, safeToApply: false });
    } else {
      if (status === 'conflict') entityConflicts.push({ ...decision,
        rule: base !== null && (local === null || incoming === null) ? 'delete-edit-conflict'
          : base === null ? 'concurrent-addition-conflict' : 'entity-conflict',
        requiresManualReview: true, safeToApply: false });
      if (base === null) {
        const group = additions.get(timelineId) || [];
        group.push(decision);
        additions.set(timelineId, group);
      }
    }
    if (TIMELINE_FIELDS.has(field) || field.startsWith('trackState.')) timelineReviews.push({ timelineId, itemId, field,
      rule: 'timeline-interaction-review', reason: 'Intervals, track identity, links, and ripple effects may interact; the classification does not contain a complete timeline.',
      automaticTimelineOrdering: false, requiresManualReview: true, safeToApply: false });
  }
  for (const [timelineId, values] of additions) {
    // Include different-ID additions on opposite sides, as well as same-ID additions.
    if (!values.some(d => d.local !== null) || !values.some(d => d.incoming !== null)) continue;
    timelineReviews.push({ timelineId, itemId: null, field: 'existence',
      rule: 'concurrent-additions-review', additions: values,
      reason: 'Canonical review order is not timeline placement; intervals and ripple effects require manual review.',
      automaticTimelineOrdering: false, requiresManualReview: true, safeToApply: false });
  }
  timelineReviews.sort(order);
  return { schemaVersion: 1, readOnly: true, safeToApply: false,
    observedPropertiesOnly: true, provenSafeApplyProperties: [],
    reviewOrdering: 'timeline-id/item-id/field', automaticTimelineOrdering: false,
    fieldReviews, entityConflicts, timelineReviews,
    warnings: ['Independent observed field edits are review guidance only; no field is proven safe to apply.',
      'Unchanged or equal observations do not establish complete entity equivalence, effect settings, or absence of unknown values.'] };
}
module.exports = { analyzeResolveConflictRules };
