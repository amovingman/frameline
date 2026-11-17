const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createResolvePreviewPlan, verifyResolvePreviewPlan, refreshResolvePreviewPlan } = require('../src/resolve-preview-plan');

const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const read = name => fs.readFileSync(path.join(proof, name));
const sources = () => ({
  base: read('live-mapping-before-schema3.json'),
  local: read('live-mapping-before-schema3.json'),
  incoming: read('live-mapping-after-schema3.json')
});

test('builds a deterministic, hash-bound read-only preview from paired live captures', () => {
  const input = sources();
  const plan = createResolvePreviewPlan(input);
  assert.deepEqual(plan, createResolvePreviewPlan(input));
  assert.equal(plan.safeToApply, false);
  assert.deepEqual(plan.classification.decisions.map(decision => [decision.field, decision.status]), [
    ['endFrame', 'incoming-only'], ['startFrame', 'incoming-only']
  ]);
  assert.ok(plan.assessment.warnings.some(warning => warning.code === 'timing-ripple-interaction'));
  assert.equal(verifyResolvePreviewPlan(plan, input).valid, true);
  const changed = { ...input, local: Buffer.from(input.local.toString('utf8') + '\n') };
  assert.deepEqual(verifyResolvePreviewPlan(plan, changed).staleRoles, ['local']);
  assert.equal(verifyResolvePreviewPlan(plan, changed).safeToApply, false);
});

test('classifies a same-field disagreement as conflict and rejects unsafe source shapes', () => {
  const input = sources();
  const local = JSON.parse(input.base.toString('utf8'));
  const incoming = JSON.parse(input.base.toString('utf8'));
  local.timelines[0].items[0].start_frame = 10;
  incoming.timelines[0].items[0].start_frame = 20;
  input.local = Buffer.from(JSON.stringify(local));
  input.incoming = Buffer.from(JSON.stringify(incoming));
  const plan = createResolvePreviewPlan(input);
  assert.equal(plan.classification.decisions[0].status, 'conflict');
  assert.equal(plan.assessment.counts.conflicts, 1);
  assert.throws(() => createResolvePreviewPlan({ ...input, extra: 'x' }), { code: 'invalid-resolve-preview' });
  assert.throws(() => createResolvePreviewPlan({ ...input, local: Buffer.from('{') }), { code: 'invalid-resolve-preview' });
});

test('verification rejects a modified preview even when source hashes still match', () => {
  const input = sources();
  const plan = createResolvePreviewPlan(input);
  const changed = structuredClone(plan);
  changed.classification.decisions[0].status = 'already-applied';
  assert.throws(() => verifyResolvePreviewPlan(changed, input), { code: 'invalid-resolve-preview' });
  const changedAssessment = structuredClone(plan);
  changedAssessment.assessment.counts.conflicts = 10;
  assert.throws(() => verifyResolvePreviewPlan(changedAssessment, input), { code: 'invalid-resolve-preview' });
});

test('refresh verifies an unchanged preview and returns a detached read-only plan', () => {
  const input = sources();
  const prior = createResolvePreviewPlan(input);
  const result = refreshResolvePreviewPlan(prior, input);
  assert.equal(result.refreshed, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.safeToApply, false);
  assert.deepEqual(result.verification.staleRoles, []);
  assert.equal(result.verification.valid, true);
  assert.deepEqual(result.plan, prior);
  assert.notEqual(result.plan, prior);
  const tampered = structuredClone(prior);
  tampered.assessment.counts.conflicts = 10;
  assert.throws(() => refreshResolvePreviewPlan(tampered, input), { code: 'invalid-resolve-preview' });
});

test('refresh reports stale roles and recomputes classification from current snapshots', () => {
  const input = sources();
  const prior = createResolvePreviewPlan(input);
  const original = structuredClone(prior);
  const local = JSON.parse(input.base.toString('utf8'));
  const incoming = JSON.parse(input.base.toString('utf8'));
  local.timelines[0].items[0].start_frame = 10;
  incoming.timelines[0].items[0].start_frame = 20;
  const current = { ...input, local: JSON.stringify(local), incoming: JSON.stringify(incoming) };
  const result = refreshResolvePreviewPlan(prior, current);
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.verification.staleRoles, ['local', 'incoming']);
  assert.deepEqual(result.verification.matches, { base: true, local: false, incoming: false });
  assert.equal(result.verification.valid, false);
  assert.deepEqual(result.plan, createResolvePreviewPlan(current));
  assert.equal(result.plan.assessment.counts.conflicts, 1);
  assert.equal(result.plan.readOnly, true);
  assert.equal(result.plan.safeToApply, false);
  assert.equal(verifyResolvePreviewPlan(result.plan, current).valid, true);
  assert.deepEqual(prior, original);
  assert.throws(() => refreshResolvePreviewPlan(prior, { ...current, base: '{' }), { code: 'invalid-resolve-preview' });
});

test('refresh replaces the binding even when only snapshot formatting changes', () => {
  const input = sources();
  const prior = createResolvePreviewPlan(input);
  const current = { ...input, base: input.base.toString('utf8') + '\n' };
  const result = refreshResolvePreviewPlan(prior, current);
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.verification.staleRoles, ['base']);
  assert.deepEqual(result.plan.classification, prior.classification);
  assert.notEqual(result.plan.binding.hashes.base, prior.binding.hashes.base);
});

test('source-bound preview handles no-op, shared edit, independent edits, rename, and ordering', () => {
  const base = JSON.parse(read('live-mapping-before-schema3.json'));
  const make = (local, incoming) => createResolvePreviewPlan({
    base: JSON.stringify(base), local: JSON.stringify(local), incoming: JSON.stringify(incoming)
  });
  const plain = structuredClone(base);
  assert.deepEqual(make(plain, plain).classification.decisions, []);

  const sharedLocal = structuredClone(base);
  const sharedIncoming = structuredClone(base);
  sharedLocal.timelines[0].items[0].name = 'Shared rename';
  sharedIncoming.timelines[0].items[0].name = 'Shared rename';
  const shared = make(sharedLocal, sharedIncoming);
  assert.deepEqual(shared.classification.decisions.map(({ field, status }) => [field, status]),
    [['name', 'already-applied']]);

  const local = structuredClone(base);
  const incoming = structuredClone(base);
  local.timelines[0].items[0].name = 'Local rename';
  incoming.timelines[0].items[1].name = 'Incoming rename';
  const independent = make(local, incoming);
  assert.deepEqual(independent.classification.decisions.map(({ itemId, field, status }) =>
    [itemId, field, status]), [
    [local.timelines[0].items[0].id, 'name', 'local-only'],
    [incoming.timelines[0].items[1].id, 'name', 'incoming-only']
  ].sort((a, b) => a[0].localeCompare(b[0])));
  assert.equal(independent.safeToApply, false);

  const reordered = structuredClone(base);
  reordered.timelines[0].items.reverse();
  reordered.timelines[0].tracks.reverse();
  const orderPlan = make(base, reordered);
  assert.deepEqual(orderPlan.classification.decisions, []);
  assert.notEqual(orderPlan.binding.hashes.base, orderPlan.binding.hashes.incoming);
  assert.equal(verifyResolvePreviewPlan(orderPlan,
    { base: JSON.stringify(base), local: JSON.stringify(base), incoming: JSON.stringify(reordered) }).valid, true);
});
