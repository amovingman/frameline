const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit, verifyResolveDecisionAudit } = require('../src/resolve-review-decisions');
function fixture() {
  const base = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8');
  const local = JSON.parse(base), incoming = JSON.parse(base);
  local.timelines[0].items[0].start_frame = 10;
  incoming.timelines[0].items[0].start_frame = 20;
  local.timelines[0].items[0].end_frame = 110;
  incoming.timelines[0].items[0].end_frame = 120;
  const sources = { base, local: JSON.stringify(local), incoming: JSON.stringify(incoming) };
  const plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources);
  const decisions = review.conflicts.map(({ id }) => ({ conflictId: id, choice: 'take-incoming' }));
  return { sources, plan, review, decisions };
}
const error = { code: 'invalid-resolve-review-decisions' };
test('lists observed context and offers no unproven manual fields', () => {
  const { plan, review } = fixture();
  assert.equal(review.conflicts.length, 2);
  assert.deepEqual(review.manualFields, []);
  for (const conflict of review.conflicts) {
    const original = plan.assessment.conflicts.find(value => value.field === conflict.field);
    for (const key of ['timelineId', 'itemId', 'field', 'base', 'local', 'incoming']) assert.deepEqual(conflict[key], original[key]);
    assert.deepEqual(conflict.options, ['keep-local', 'take-incoming']);
  }
  assert.ok(Object.isFrozen(review.conflicts[0].options));
});
test('audit is deterministic, detached, immutable and preserves unresolved safety constraints', () => {
  const { sources, plan, decisions } = fixture();
  const audit = createResolveDecisionAudit(plan, sources, decisions);
  assert.deepEqual(audit, createResolveDecisionAudit(plan, sources, [...decisions].reverse()));
  assert.equal(audit.safeToApply, false);
  assert.equal(audit.readOnly, true);
  assert.equal(audit.validationStatus, 'review-only');
  assert.deepEqual(audit.binding, plan.binding);
  assert.deepEqual(audit.mediaRequirements, plan.assessment.mediaRequirements);
  assert.ok(audit.warnings.some(value => value.code === 'timing-ripple-interaction'));
  assert.ok(Object.isFrozen(audit.choices[0]));
  decisions[0].choice = 'keep-local';
  assert.equal(audit.choices[0].choice, 'take-incoming');
  assert.equal(verifyResolveDecisionAudit(audit, plan, sources).valid, true);
});
test('rejects missing duplicate unknown manual and extraneous decisions', () => {
  const { sources, plan, decisions } = fixture();
  for (const input of [decisions.slice(1), [...decisions, decisions[0]], [decisions[0], decisions[0]],
    [{ ...decisions[0], conflictId: 'unknown' }, decisions[1]],
    [{ ...decisions[0], choice: 'manual', value: 42 }, decisions[1]],
    [{ ...decisions[0], value: 42 }, decisions[1]]]) {
    assert.throws(() => createResolveDecisionAudit(plan, sources, input), error);
  }
});
test('rejects tampered plans, stale bytes, changed audit values and hashes', () => {
  const { sources, plan, decisions } = fixture();
  const changed = structuredClone(plan);
  changed.assessment.conflicts[0].incoming = 999;
  assert.throws(() => createResolveConflictReview(changed, sources), error);
  assert.throws(() => createResolveDecisionAudit(plan, { ...sources, base: sources.base + '\n' }, decisions), error);
  const audit = createResolveDecisionAudit(plan, sources, decisions);
  for (const mutate of [value => { value.choices[0].selectedValue = 999; },
    value => { value.auditHash = '0'.repeat(64); }, value => { value.safeToApply = true; },
    value => { value.binding.hashes.local = '0'.repeat(64); }]) {
    const tampered = structuredClone(audit); mutate(tampered);
    assert.throws(() => verifyResolveDecisionAudit(tampered, plan, sources), error);
  }
});
test('empty conflict sets have a valid empty review audit', () => {
  const { sources } = fixture();
  sources.local = sources.base;
  const plan = createResolvePreviewPlan(sources);
  const audit = createResolveDecisionAudit(plan, sources, []);
  assert.deepEqual(audit.choices, []);
  assert.equal(audit.safeToApply, false);
});
