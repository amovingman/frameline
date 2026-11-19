'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { classifyResolveThreeWay } = require('../src/resolve-three-way-classifier');
const { describeResolveDeletionPolicy: describe, MAX_CHANGED_FIELDS, MAX_CHANGED_FIELD_BYTES, MAX_TOTAL_CHANGED_FIELD_BYTES } = require('../src/resolve-deletion-policy');
const { createResolvePreviewPlan, verifyResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveReviewSession } = require('../src/resolve-review-session');
const { saveResolvePreview, loadResolvePreview } = require('../src/resolve-preview-store');
const { saveResolveReview, loadResolveReview } = require('../src/resolve-review-store');

function manifest() {
  return { schemaVersion: 1, readOnly: true, projectId: 'project', resolveVersion: '21.1.2.10', timelines: [{
    id: 'timeline', name: 'Edit', startFrame: 0, tracks: [{ type: 'video', index: 1, name: 'V1' }, { type: 'video', index: 2, name: 'V2' }],
    items: ['a', 'b'].map((id, index) => ({ id, type: 'video', name: 'Repeated name', trackType: 'video', trackIndex: 1,
      startFrame: index * 10, endFrame: index * 10 + 10, sourceStartFrame: 0, sourceEndFrame: 10,
      mediaPoolId: 'media', linkedItemIds: [], effectCounts: { fusion: 0, ofx: 0, audio: 0 } })) }] };
}
function deletionFixture(level, reverse, change) {
  const base = manifest(), edited = manifest(), deleted = manifest();
  change(edited);
  if (level === 'timeline') deleted.timelines = [];
  else deleted.timelines[0].items.shift();
  return { base, local: reverse ? deleted : edited, incoming: reverse ? edited : deleted };
}
const classify = ({ base, local, incoming }) => classifyResolveThreeWay(base, local, incoming);
const rich = async () => JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json')));
const sources = (...values) => Object.fromEntries(['base', 'local', 'incoming'].map((role, index) => [role, Buffer.from(JSON.stringify(values[index]))]));
function removeFirst(value, wholeTimeline) {
  if (wholeTimeline) { value.snapshot.timelines = []; value.items = []; value.tracks = []; value.activeTimelineId = null; }
  else { value.snapshot.timelines[0].items.shift(); value.items.shift(); }
}

test('every represented clip edit remains a deletion conflict in both directions with explicit consequences', () => {
  const edits = [
    ['name', item => { item.name = 'Local title'; }],
    ['startFrame', item => { item.startFrame = 2; }],
    ['endFrame', item => { item.endFrame = 12; }],
    ['sourceStartFrame', item => { item.sourceStartFrame = 1; }],
    ['sourceEndFrame', item => { item.sourceEndFrame = 9; }],
    ['mediaPoolId', item => { item.mediaPoolId = 'replacement'; }],
    ['track.index', item => { item.trackIndex = 2; }],
    ['type', item => { item.type = 'audio'; }],
    ['linkedItemIds', item => { item.linkedItemIds = ['b']; }],
    ['effectCounts.ofx', item => { item.effectCounts.ofx = 1; }]
  ];
  for (const reverse of [false, true]) for (const [field, edit] of edits) {
    const input = deletionFixture('clip', reverse, value => edit(value.timelines[0].items[0]));
    const before = JSON.stringify(input), classification = classify(input), policy = describe(classification), conflict = policy.conflicts[0];
    assert.equal(classification.decisions[0].status, 'conflict');
    assert.equal(conflict.rule, 'delete-edit-conflict'); assert.equal(conflict.entityKind, 'clip');
    assert.equal(conflict.deletedBy, reverse ? 'local' : 'incoming');
    assert.equal(conflict.editedBy, reverse ? 'incoming' : 'local');
    assert(conflict.changedFields.some(path => path.startsWith(field)), field);
    assert.equal(conflict.consequences['keep-local'].action, reverse ? 'keep-deleted' : 'retain-edited');
    assert.equal(conflict.consequences['take-incoming'].action, reverse ? 'restore-edited' : 'delete-edited');
    assert.equal(conflict.requiresExplicitChoice, true); assert.equal(conflict.coverageComplete, false);
    assert.equal(policy.safeToApply, false); assert.equal(conflict.safeToApply, false); assert.equal(policy.readOnly, true);
    assert.equal(JSON.stringify(input), before);
  }
});

test('whole timeline deletion retains child edit identity and contextual meaning', () => {
  for (const reverse of [false, true]) {
    const classification = classify(deletionFixture('timeline', reverse, value => { value.timelines[0].items[1].name = 'Edited child'; }));
    const conflict = describe(classification).conflicts[0];
    assert.equal(conflict.itemId, null); assert.equal(conflict.entityKind, 'timeline');
    assert.deepEqual(conflict.changedFields, ['items["b"].name']);
    assert.match(conflict.consequences['take-incoming'].description, /timeline and its observed contents/);
    assert.equal(classification.decisions.length, 1);
  }
});

test('unchanged deletions, matching deletions, and concurrent additions are not relabeled delete/edit conflicts', () => {
  const base = manifest(), deleted = manifest(); deleted.timelines[0].items.shift();
  for (const values of [[base, base, deleted], [base, deleted, base], [base, deleted, deleted]]) {
    assert.deepEqual(describe(classifyResolveThreeWay(...values)).conflicts, []);
  }
  const empty = manifest(); empty.timelines = [];
  const other = manifest(); other.timelines[0].items[0].name = 'Different';
  assert.deepEqual(describe(classifyResolveThreeWay(empty, base, other)).conflicts, []);
});

test('richer inspector-only edits survive clip or timeline deletion and keep exact review audit values', async () => {
  for (const wholeTimeline of [false, true]) for (const reverse of [false, true]) {
    const base = await rich(), edited = structuredClone(base), deleted = structuredClone(base);
    edited.items[0].properties.Pan.decimal = '1.3250000000000000e+01'; removeFirst(deleted, wholeTimeline);
    const input = sources(base, reverse ? deleted : edited, reverse ? edited : deleted);
    const before = Object.fromEntries(Object.entries(input).map(([role, bytes]) => [role, Buffer.from(bytes)]));
    const plan = createResolvePreviewPlan(input), policy = describe(plan.classification), conflict = policy.conflicts[0];
    const path = wholeTimeline ? `items[${JSON.stringify(base.items[0].itemId)}].observations.properties.Pan` : 'observations.properties.Pan';
    assert(conflict.changedFields.includes(path));
    const review = createResolveConflictReview(plan, input);
    assert.equal(review.conflicts.length, 1);
    for (const choice of ['keep-local', 'take-incoming']) {
      const audit = createResolveDecisionAudit(plan, input, [{ conflictId: review.conflicts[0].id, choice }]);
      assert.deepEqual(audit.choices[0].selectedValue, plan.assessment.conflicts[0][choice === 'keep-local' ? 'local' : 'incoming']);
      assert.equal(audit.validationStatus, 'review-only'); assert.equal(audit.safeToApply, false);
    }
    assert.equal(verifyResolvePreviewPlan(plan, input).valid, true);
    for (const role of Object.keys(input)) assert.deepEqual(input[role], before[role]);
  }
});

test('timeline child and track supplement edits are described without copying entity values', async () => {
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.tracks[0].locked = true; local.items[0].effects[0].enabled = false;
  removeFirst(incoming, true);
  const policy = describe(createResolvePreviewPlan(sources(base, local, incoming)).classification);
  const conflict = policy.conflicts[0];
  assert(conflict.changedFields.some(value => value.endsWith('.observations.locked.value')));
  assert(conflict.changedFields.some(value => value.endsWith('.enabled')));
  assert.equal(Object.hasOwn(conflict, 'local'), false); assert.equal(Object.hasOwn(conflict, 'base'), false);
  assert.equal(Object.hasOwn(conflict, 'incoming'), false);
});

test('semantic decimal spellings and keyed collection order do not inflate changed fields', async () => {
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.snapshot.timelines[0].name = 'Real timeline edit';
  local.items[0].properties.Pan.decimal = '-0.0000000000000000e+00';
  local.items[0].properties.ZoomX.decimal = '0.1000000000000000e+01';
  local.items.reverse(); local.tracks.reverse(); local.snapshot.timelines[0].items.reverse(); local.snapshot.timelines[0].tracks.reverse();
  removeFirst(incoming, true);
  const classification = createResolvePreviewPlan(sources(base, local, incoming)).classification;
  const policy = describe(classification);
  assert.deepEqual(policy.conflicts[0].changedFields, ['name']);
  const reversed = structuredClone(classification); reversed.decisions.reverse();
  assert.deepEqual(describe(reversed), policy);
});

test('unknown and missing supplement coverage stays explicit and does not claim complete equivalence', async () => {
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.items[0].propertyReadStatus = 'unavailable'; local.items[0].properties = {};
  removeFirst(incoming, false);
  const policy = describe(createResolvePreviewPlan(sources(base, local, incoming)).classification), conflict = policy.conflicts[0];
  assert(conflict.changedFields.includes('observations.propertyReadStatus'));
  assert.equal(conflict.coverageComplete, false);
  assert(policy.warnings.some(value => value.includes('Unknown or missing coverage')));
});

test('many represented changes have truthful bounded field summaries with exact counts', () => {
  const input = deletionFixture('timeline', false, value => {
    value.timelines[0].items = Array.from({ length: MAX_CHANGED_FIELDS + 20 }, (_, index) => ({
      ...structuredClone(value.timelines[0].items[0]), id: `new-${String(index).padStart(4, '0')}`
    }));
  });
  const policy = describe(classify(input)), conflict = policy.conflicts[0];
  assert.equal(conflict.changedFields.length, MAX_CHANGED_FIELDS);
  assert.equal(conflict.changedFieldCount, MAX_CHANGED_FIELDS + 22); // two base children removed and 120 added
  assert.equal(conflict.changedFieldsTruncated, true);
});

test('preview/review artifact recovery and session restart retain deletion choices and canonical identities', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deletion-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.items[0].properties.Pan.decimal = '1.3250000000000000e+01'; removeFirst(incoming, false);
  const input = sources(base, local, incoming), plan = createResolvePreviewPlan(input);
  const review = createResolveConflictReview(plan, input), decisions = [{ conflictId: review.conflicts[0].id, choice: 'keep-local' }];
  const previewId = saveResolvePreview(directory, input), reviewId = saveResolveReview(directory, input, decisions);
  const originalHash = createResolveDecisionAudit(plan, input, decisions).auditHash;
  const beforePlan = JSON.stringify(plan), beforeReview = JSON.stringify(review);
  describe(plan.classification);
  assert.equal(JSON.stringify(plan), beforePlan); assert.equal(JSON.stringify(review), beforeReview);
  assert.equal(saveResolvePreview(directory, input), previewId); assert.equal(saveResolveReview(directory, input, decisions), reviewId);
  assert.deepEqual(loadResolvePreview(directory, previewId, input), plan);
  const loaded = loadResolveReview(directory, reviewId, input);
  assert.equal(loaded.audit.auditHash, originalHash);
  const reopened = createResolveReviewSession({ artifactDirectory: directory });
  const state = reopened.recoverReview(reviewId, input);
  assert.equal(state.status, 'ready'); assert.equal(state.audit.auditHash, originalHash);
  assert.equal(describe(state.plan.classification).conflicts[0].consequences['keep-local'].action, 'retain-edited');
  const stale = { ...input, local: Buffer.concat([input.local, Buffer.from('\n')]) };
  assert.equal(reopened.recoverReview(reviewId, stale).status, 'error');
});

test('rejects malformed classification and excludes redundant unbounded context', () => {
  assert.throws(() => describe({ decisions: [] }), { code: 'invalid-resolve-classification' });
  const classification = classify(deletionFixture('clip', false, value => { value.timelines[0].items[0].name = 'Edited'; }));
  classification.decisions[0].context = { timelineName: 'Original', itemName: 'Edited', track: 'V1' };
  const policy = describe(classification); policy.conflicts[0].changedFields.push('malicious');
  assert.equal(Object.hasOwn(policy.conflicts[0], 'context'), false);
  assert.equal(classification.decisions[0].context.timelineName, 'Original');
  assert.deepEqual(describe(classification).conflicts[0].changedFields, ['name']);
});

test('global and per-conflict field byte budgets are deterministic and retain every compact conflict', () => {
  const classification = { schemaVersion: 1, readOnly: true, safeToApply: false, decisions: [] };
  for (let index = 0; index < 200; index++) {
    const properties = Object.fromEntries(Array.from({ length: 80 }, (_, field) => [`LongProperty${String(field).padStart(3, '0')}${'x'.repeat(40)}`, 0]));
    classification.decisions.push({ timelineId: 'timeline', itemId: `item-${String(index).padStart(4, '0')}`, field: 'existence', status: 'conflict',
      base: { observations: { properties } }, local: { observations: { properties: Object.fromEntries(Object.keys(properties).map(key => [key, 1])) } }, incoming: null });
  }
  const policy = describe(classification);
  assert.equal(policy.conflicts.length, classification.decisions.length);
  const bytes = policy.conflicts.reduce((sum, conflict) => {
    const rowBytes = conflict.changedFields.reduce((n, field) => n + Buffer.byteLength(field), 0);
    assert(rowBytes <= MAX_CHANGED_FIELD_BYTES); assert.equal(conflict.changedFieldCount, 80);
    assert.equal(conflict.changedFieldsTruncated, true);
    return sum + rowBytes;
  }, 0);
  assert(bytes <= MAX_TOTAL_CHANGED_FIELD_BYTES);
  assert(policy.conflicts.some(conflict => conflict.changedFields.length === 0));
  classification.decisions.reverse(); assert.deepEqual(describe(classification), policy);
});
