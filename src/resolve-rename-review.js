'use strict';

const { verifyResolvePreviewPlan } = require('./resolve-preview-plan');
const { verifyResolveDecisionAudit } = require('./resolve-review-decisions');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');

// Resolve the complete reviewed proposal before reducing it to the one operation
// proven by the disposable rename trial. Unsupported incoming work is rejected.
function resolveReviewedRename({ sources, plan, audit } = {}) {
  if (!verifyResolvePreviewPlan(plan, sources).valid || !verifyResolveDecisionAudit(audit, plan, sources).valid) {
    throw new Error('invalid-reviewed-rename');
  }
  if (plan.schemaVersion !== 1) throw new Error('rich-preview-review-only');
  const local = JSON.parse(sources.local.toString('utf8'));
  normalizeResolveSnapshot(local);
  const desired = structuredClone(local);
  const changes = [];
  for (const decision of plan.classification.decisions) {
    if (!['incoming-only', 'conflict'].includes(decision.status)) continue;
    let value = decision.incoming;
    if (decision.status === 'conflict') {
      const choice = audit.choices.find(choice => choice.timelineId === decision.timelineId
        && choice.itemId === decision.itemId && choice.field === decision.field);
      if (!choice) throw new Error('missing-reviewed-choice');
      if (choice.choice === 'keep-local') continue;
      value = choice.selectedValue;
    }
    if (decision.field !== 'name' || decision.itemId === null || typeof value !== 'string' || !value.trim()) {
      throw new Error('unsupported-reviewed-operation');
    }
    const item = desired.timelines.find(timeline => timeline.id === decision.timelineId)?.items
      .find(item => item.id === decision.itemId);
    if (!item) throw new Error('reviewed-target-missing');
    item.name = value;
    changes.push({ timelineId: decision.timelineId, itemId: decision.itemId, field: 'name', value });
  }
  if (changes.length !== 1) throw new Error('reviewed-trial-requires-one-rename');
  return { beforeBytes: sources.local, afterBytes: Buffer.from(JSON.stringify(desired)),
    sourceBindings: structuredClone(plan.binding), planHash: audit.planHash, auditHash: audit.auditHash,
    choices: structuredClone(audit.choices) };
}

module.exports = { resolveReviewedRename };
