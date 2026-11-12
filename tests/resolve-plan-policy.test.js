const test = require('node:test');
const assert = require('node:assert/strict');
const { assessResolvePlan, WARNING_CODES } = require('../src/resolve-plan-policy');

const classification = decisions => ({ schemaVersion: 1, readOnly: true, safeToApply: false, decisions });
const decision = (field, overrides = {}) => ({ timelineId: 'timeline-1', itemId: 'item-1', field,
  status: 'incoming-only', base: null, local: null, incoming: null, ...overrides });
const warnings = result => Object.fromEntries(result.warnings.map(warning => [warning.code, warning.count]));

test('empty and harmless previews never authorize writes', () => {
  for (const input of [classification([]), classification([decision('name', { base: 'A', local: 'A', incoming: 'B' })])]) {
    const result = assessResolvePlan(input);
    assert.equal(result.readOnly, true);
    assert.equal(result.safeToApply, false);
    assert.deepEqual(warnings(result), { 'read-only-preview': 1, 'track-index-identity': 1 });
    assert.equal(result.counts.conflicts, 0);
  }
});

test('fixed warning codes cover conflict and all conservative policy categories', () => {
  const result = assessResolvePlan(classification([
    decision('startFrame', { status: 'conflict', base: 0, local: 10, incoming: 20 }),
    decision('endFrame'), decision('sourceStartFrame'), decision('sourceEndFrame'),
    decision('track'), decision('tracks', { itemId: null }),
    decision('linkedItemIds'), decision('effectCounts.fusion'), decision('effectCounts.ofx'),
    decision('effectCounts.audio'), decision('type', { incoming: 'Transition' }),
    decision('type', { incoming: 'Compound' }), decision('existence')
  ]));
  assert.deepEqual(warnings(result), {
    'addition-deletion': 1, conflict: 1, 'effect-change': 3, 'linked-item-change': 1,
    'read-only-preview': 1, 'timing-ripple-interaction': 4, 'track-index-identity': 1,
    'unsupported-item-type': 2
  });
  assert.deepEqual(result.counts, { decisions: 13, conflicts: 1, warningCategories: 8, warningOccurrences: 14 });
  assert.deepEqual(result.warnings.map(warning => warning.code), WARNING_CODES);
});

test('whole added/deleted entities expose nested risks without duplicate warnings per decision', () => {
  const item = { id: 'item-1', track: { type: 'video', index: 1 }, type: 'transition', startFrame: 0, endFrame: 10,
    linkedItemIds: ['item-2'], 'effectCounts.fusion': 2, 'effectCounts.ofx': null, 'effectCounts.audio': 0 };
  const result = assessResolvePlan(classification([decision('existence', {
    itemId: null, base: { items: [item, item] }, local: null, incoming: null
  })]));
  assert.deepEqual(warnings(result), {
    'addition-deletion': 1, 'effect-change': 1, 'linked-item-change': 1,
    'read-only-preview': 1, 'timing-ripple-interaction': 1,
    'track-index-identity': 1, 'unsupported-item-type': 1
  });
});

test('local-only and already-applied decisions retain risk warnings and input stays unchanged', () => {
  const input = classification([decision('startFrame', { status: 'local-only' }),
    decision('linkedItemIds', { status: 'already-applied', incoming: ['item-2'] })]);
  const before = JSON.stringify(input);
  const result = assessResolvePlan(input);
  assert.equal(warnings(result)['timing-ripple-interaction'], 1);
  assert.equal(warnings(result)['linked-item-change'], 1);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(assessResolvePlan(classification([...input.decisions].reverse())), result);
});

test('normal video/audio type decisions do not claim unsupported types', () => {
  const result = assessResolvePlan(classification([decision('type', { base: 'video', local: 'video', incoming: 'audio' })]));
  assert.equal(warnings(result)['unsupported-item-type'], undefined);
});

test('malformed or writable inputs fail closed', () => {
  for (const input of [null, {}, classification(null), { ...classification([]), safeToApply: true },
    { ...classification([]), readOnly: false }, classification([decision('name', { status: 'safe' })]),
    classification([decision('name', { itemId: undefined })]), classification([{ timelineId: 't' }])]) {
    assert.throws(() => assessResolvePlan(input), { code: 'invalid-resolve-classification' });
  }
});
