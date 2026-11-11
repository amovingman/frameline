const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createResolvePreviewPlan, verifyResolvePreviewPlan } = require('../src/resolve-preview-plan');

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
