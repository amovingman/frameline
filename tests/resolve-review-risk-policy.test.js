'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyResolveThreeWay } = require('../src/resolve-three-way-classifier');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveReviewRiskPolicy: risk, MAX_DECISIONS, MAX_CONTEXT_COMPARISONS } = require('../src/resolve-review-risk-policy');
function manifest() {
  return { schemaVersion: 1, readOnly: true, projectId: 'film', resolveVersion: '21.1.2.10', timelines: [{
    id: 'edit', name: 'Editorial', startFrame: 0, tracks: [{ type: 'video', index: 1, name: 'V1' }],
    items: [['target', 0, 10], ['overlap', 5, 15], ['adjacent', 10, 20]].map(([id, startFrame, endFrame]) => ({
      id, type: 'video', name: id, trackType: 'video', trackIndex: 1, startFrame, endFrame,
      sourceStartFrame: 0, sourceEndFrame: 10, mediaPoolId: `media-${id}`, linkedItemIds: [], effectCounts: { fusion: 0, ofx: 0, audio: 0 }
    })) }] };
}
function fixture() {
  const sources = Object.fromEntries(['base', 'local', 'incoming'].map(role => [role, manifest()]));
  sources.local.timelines[0].items[0].name = 'Local name'; sources.incoming.timelines[0].items[0].name = 'Incoming name';
  return { sources, classification: classifyResolveThreeWay(sources.base, sources.local, sources.incoming) };
}
const error = { code: 'invalid-resolve-review-risk-policy' };
const category = (row, name) => row.riskCategories.find(value => value.category === name).status;

test('name conflicts include unchanged overlap and adjacent blockers from all source inventories', () => {
  const { sources, classification } = fixture();
  assert.equal(classification.decisions.length, 1);
  const report = risk(classification, sources), row = report.decisions[0];
  assert.equal(row.context.overlappingNeighborCount, 1); assert.equal(row.context.adjacentNeighborCount, 1);
  assert.ok(row.warningCodes.includes('neighbor-interval-overlap')); assert.ok(row.warningCodes.includes('neighbor-boundary-adjacent'));
  assert.equal(category(row, 'timing-ripple'), 'blocked'); assert.equal(report.gate, 'blocked');
  assert.equal(report.safeToApply, false); assert.equal(row.context.contextComplete, true);
});

test('reciprocal links from an otherwise unchanged neighbor require linked review', () => {
  const { sources } = fixture();
  for (const source of Object.values(sources)) source.timelines[0].items[1].linkedItemIds = ['target'];
  const classification = classifyResolveThreeWay(sources.base, sources.local, sources.incoming);
  const row = risk(classification, sources).decisions[0];
  assert.equal(row.context.linkedItemCount, 1); assert.equal(category(row, 'linked-clips'), 'blocked');
});

test('transition and compound neighbors remain blocked while unobserved coverage remains unknown', () => {
  const { sources } = fixture();
  for (const source of Object.values(sources)) {
    source.timelines[0].items[1].type = 'CrossDissolveTransition'; source.timelines[0].items[2].type = 'Compound';
  }
  const classification = classifyResolveThreeWay(sources.base, sources.local, sources.incoming);
  const report = risk(classification, sources), row = report.decisions[0];
  assert.equal(row.context.transitionOrNestedNeighborCount, 2);
  assert.equal(category(row, 'transitions'), 'blocked'); assert.equal(category(row, 'nested-unknown'), 'blocked');
  assert.ok(report.warnings.some(value => value.code === 'transition-coverage-unknown'));
  assert.ok(report.warnings.some(value => value.code === 'nested-coverage-unknown'));
});

test('unknown target or unchanged-neighbor timing makes contextual analysis explicitly incomplete', () => {
  for (const index of [0, 1]) {
    const { sources } = fixture();
    for (const source of Object.values(sources)) source.timelines[0].items[index].endFrame = null;
    const classification = classifyResolveThreeWay(sources.base, sources.local, sources.incoming);
    const report = risk(classification, sources);
    assert.equal(report.summary.contextComplete, false); assert.equal(report.summary.comparisonLimitReached, false);
    assert.ok(report.decisions[0].warningCodes.includes('context-analysis-incomplete'));
  }
});

test('whole timeline conflicts retain child and link risks in either deletion direction', () => {
  for (const deleted of ['local', 'incoming']) {
    const { sources } = fixture();
    for (const source of Object.values(sources)) { source.timelines[0].items[0].linkedItemIds = ['overlap']; source.timelines[0].items[1].type = 'Transition'; }
    sources[deleted].timelines = [];
    const classification = classifyResolveThreeWay(sources.base, sources.local, sources.incoming);
    const row = risk(classification, sources).decisions[0];
    assert.equal(row.itemId, null); assert.equal(row.gate, 'blocked');
    for (const name of ['timing-ripple', 'linked-clips', 'transitions', 'nested-unknown']) assert.equal(category(row, name), 'blocked');
  }
});

test('all decided conflicts still have blocked risk policy and retain exact original plan/review hashes', () => {
  const base = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'));
  const local = JSON.parse(base), incoming = JSON.parse(base);
  local.timelines[0].items[0].name = 'Retained local edit'; incoming.timelines[0].items.shift();
  const sources = { base, local: Buffer.from(JSON.stringify(local)), incoming: Buffer.from(JSON.stringify(incoming)) };
  const plan = createResolvePreviewPlan(sources), review = createResolveConflictReview(plan, sources);
  const audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(row => ({ conflictId: row.id, choice: 'keep-local' })));
  assert.equal(review.planHash, '30379afcdecf3a7360394b4a819ba90477f9b2fb1bb17a8fe77f69035d7e0f06');
  assert.equal(audit.auditHash, 'ea002b63ed8dd18e5856a3d4a30528ba02671a8410cb08d50a8504d4cddae8d7');
  const normalized = Object.fromEntries(Object.entries(sources).map(([role, bytes]) => [role, normalizeResolveSnapshot(JSON.parse(bytes))]));
  const before = JSON.stringify({ sources, plan, review, audit });
  const report = risk(plan.classification, normalized);
  assert.equal(report.gate, 'blocked'); assert.ok(report.decisions.every(row => row.gate === 'blocked'));
  assert.equal(JSON.stringify({ sources, plan, review, audit }), before);
});

test('equivalent source and decision enumeration yields deterministic detached metadata', () => {
  const { sources, classification } = fixture();
  const expected = risk(classification, sources), before = JSON.stringify({ sources, classification });
  for (const source of Object.values(sources)) { source.timelines.reverse(); source.timelines[0].items.reverse(); source.timelines[0].tracks.reverse(); }
  classification.decisions.reverse(); assert.deepEqual(risk(classification, sources), expected);
  expected.decisions[0].warningCodes.push('mutated');
  assert.notEqual(JSON.stringify(risk(classification, sources)), JSON.stringify(expected));
  assert.doesNotMatch(before, /mutated/);
});

test('malformed source roles, scope, anchors, fields and private traversal fail closed', () => {
  const { sources, classification } = fixture();
  for (const mutate of [
    value => { delete value.sources.incoming; }, value => { value.sources.extra = value.sources.base; },
    value => { value.sources.local.projectId = 'other'; }, value => { value.sources.local.resolveVersion = 'other'; },
    value => { value.classification.projectId = 'other'; }, value => { value.classification.decisions[0].timelineId = 'missing'; },
    value => { value.classification.decisions[0].itemId = 'missing'; }, value => { value.classification.decisions[0].field = '/Users/private/token'; },
    value => { value.sources.base.timelines[0].items[0].id = '../secret'; }, value => { value.classification.decisions[0].field = 'properties.Unknown'; }
  ]) { const value = structuredClone({ sources, classification }); mutate(value); assert.throws(() => risk(value.classification, value.sources), error); }
  const report = risk(classification, sources);
  assert.doesNotMatch(JSON.stringify(report), /Local name|Incoming name|Editorial|media-target|password|token|\/Users\//);
});

test('empty observations never imply proof of transition, nested, ripple or link safety', () => {
  const source = manifest(), sources = { base: source, local: source, incoming: source };
  const report = risk(classifyResolveThreeWay(source, source, source), sources);
  assert.deepEqual(report.decisions, []); assert.equal(report.gate, 'blocked');
  for (const code of ['transition-coverage-unknown', 'nested-coverage-unknown', 'ripple-semantics-unknown', 'linked-coverage-unknown']) assert.ok(report.warnings.some(row => row.code === code));
});

test('large full-source contextual work is bounded without dropping selected-change risk rows', () => {
  const { sources } = fixture();
  for (const source of Object.values(sources)) {
    const prototype = source.timelines[0].items[0];
    source.timelines[0].items = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(prototype), id: `item-${String(index).padStart(4, '0')}`, startFrame: index * 10, endFrame: index * 10 + 5 }));
  }
  for (const item of sources.local.timelines[0].items) item.name = 'Changed';
  const classification = classifyResolveThreeWay(sources.base, sources.local, sources.incoming), report = risk(classification, sources);
  assert.equal(report.decisions.length, 500); assert.equal(report.summary.comparisonLimitReached, true);
  assert.equal(report.summary.comparisons, MAX_CONTEXT_COMPARISONS); assert.equal(report.summary.contextComplete, false);
  assert.ok(report.decisions.some(row => row.warningCodes.includes('context-analysis-incomplete')));
  const tooMany = structuredClone(classification); tooMany.decisions = Array(MAX_DECISIONS + 1).fill(tooMany.decisions[0]);
  assert.throws(() => risk(tooMany, sources), error);
});
