const test = require('node:test');
const assert = require('node:assert/strict');
const { createResolvePlacementPolicy: policy } = require('../src/resolve-placement-policy');
function clip(id, startFrame = 0, endFrame = 10, trackIndex = 1) {
  return { id, type: 'video', name: id, trackType: 'video', trackIndex, startFrame, endFrame,
    sourceStartFrame: 0, sourceEndFrame: 10, mediaPoolId: 'media', linkedItemIds: [], effectCounts: { fusion: 0, ofx: 0, audio: 0 } };
}
function manifest(items = []) {
  return { schemaVersion: 1, readOnly: true, projectId: 'project', resolveVersion: '21.1.2.10', timelines: [{
    id: 'timeline', name: 'Edit', startFrame: 0,
    tracks: [{ type: 'video', index: 1, name: 'V1' }, { type: 'video', index: 2, name: 'V2' }], items }] };
}
const sources = (base = [], local = base, incoming = base) => ({ base: manifest(structuredClone(base)),
  local: manifest(structuredClone(local)), incoming: manifest(structuredClone(incoming)) });

test('concurrent additions preserve exact source positions and flag their shared start without inventing order', () => {
  const input = sources([], [clip('z-local', 24, 36)], [clip('a-incoming', 24, 48)]);
  const result = policy(input);
  assert.deepEqual(result.changes.map(row => row.itemId), ['a-incoming', 'z-local']);
  assert.equal(result.interactions[0].code, 'same-position-concurrent-additions');
  assert.deepEqual(result.interactions[0].itemIds, ['a-incoming', 'z-local']);
  assert.deepEqual(result.interactions[0].roles, ['incoming', 'local']);
  assert.deepEqual(result.interactions[0].interval, { startFrame: 24, endFrame: 36 });
  assert.deepEqual(result.changes[1].local, { track: { type: 'video', index: 1 }, startFrame: 24, endFrame: 36, known: true });
  assert.equal(result.changes[1].incoming, null);
  assert.equal(result.changes[1].status, 'local-only');
  assert.equal(result.safeToApply, false); assert.equal(result.readOnly, true); assert.equal(result.automaticTimelineOrdering, false);
  assert.equal(result.summary.independence, 'overlap-requires-review');
});

test('half-open adjacent additions and independent tracks never create an overlap', () => {
  for (const incoming of [clip('incoming', 10, 20), clip('incoming', 0, 10, 2)]) {
    const result = policy(sources([], [clip('local')], [incoming]));
    assert.deepEqual(result.interactions, []);
    assert.equal(result.summary.analysisComplete, true);
    assert.equal(result.summary.independence, 'no-cross-source-overlap-observed');
    assert.equal(result.rules.find(row => row.code === 'independent-is-review-only').description.includes('does not authorize'), true);
  }
});

test('overlapping additions on opposing branches produce a manual placement interaction', () => {
  const result = policy(sources([], [clip('local', 0, 20)], [clip('incoming', 15, 30)]));
  assert.equal(result.interactions.length, 1);
  assert.equal(result.interactions[0].code, 'cross-branch-placement-overlap');
  assert.deepEqual(result.interactions[0].interval, { startFrame: 15, endFrame: 20 });
  assert.equal(result.interactions[0].requiresManualReview, true);
});

test('an unchanged neighbor omitted from classification still blocks an incoming addition', () => {
  const neighbor = clip('unchanged', 10, 20);
  const result = policy(sources([neighbor], [neighbor], [neighbor, clip('added', 15, 25)]));
  assert.deepEqual(result.changes.map(row => row.itemId), ['added']);
  assert.equal(result.interactions.length, 1);
  assert.equal(result.interactions[0].code, 'existing-placement-overlap');
  assert.deepEqual(result.interactions[0].itemIds, ['added', 'unchanged']);
  assert.deepEqual(result.interactions[0].roles, ['incoming', 'local']);
});

test('a local move detects an unchanged incoming neighbor using all source intervals', () => {
  const base = [clip('moved', 0, 10), clip('neighbor', 20, 30)];
  const result = policy(sources(base, [clip('moved', 15, 25), base[1]], base));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'move');
  assert.equal(result.changes[0].status, 'local-only');
  assert.equal(result.interactions[0].code, 'existing-placement-overlap');
  assert.deepEqual(result.interactions[0].interval, { startFrame: 20, endFrame: 25 });
});

test('concurrent moves of different items report their crossing while preserving every role', () => {
  const base = [clip('a', 0, 10), clip('b', 40, 50)];
  const result = policy(sources(base, [clip('a', 20, 30), base[1]], [base[0], clip('b', 25, 35)]));
  assert.equal(result.interactions.length, 1);
  assert.equal(result.interactions[0].code, 'cross-branch-placement-overlap');
  assert.deepEqual(result.changes.map(row => row.kind), ['move', 'move']);
  assert.deepEqual(result.summary.concurrentPlacements, { local: 1, incoming: 1 });
});

test('the same retained item with divergent placements requires a source choice even without overlap', () => {
  const result = policy(sources([clip('a')], [clip('a', 20, 30)], [clip('a', 40, 50)]));
  assert.equal(result.changes[0].status, 'conflict');
  assert.ok(result.changes[0].reasons.includes('same-item-divergent-placement'));
  assert.deepEqual(result.interactions, []); // One occurrence is not its own neighbor.
  assert.equal(result.safeToApply, false);
});

test('equal concurrent placement observations stay already-applied without proving whole entity equivalence', () => {
  const input = sources([clip('a')], [clip('a', 20, 30)], [clip('a', 20, 30)]);
  input.incoming.timelines[0].items[0].name = 'Different underlying edit';
  const result = policy(input);
  assert.equal(result.changes[0].status, 'already-applied');
  assert.equal(result.statusScope, 'observed-placement-only');
  assert.equal(result.safeToApply, false);
});

test('deletion against a placement edit retains the complete surviving interval in either direction', () => {
  for (const reverse of [false, true]) {
    const input = reverse ? sources([clip('a')], [], [clip('a', 0, 20)]) : sources([clip('a')], [clip('a', 0, 20)], []);
    const row = policy(input).changes[0];
    assert.equal(row.kind, 'deletion'); assert.equal(row.status, 'conflict');
    assert.equal(row[reverse ? 'local' : 'incoming'], null);
    assert.equal(row[reverse ? 'incoming' : 'local'].endFrame, 20);
  }
});

test('end-only trims remain distinct from moves and track moves preserve indexed destinations', () => {
  const trimmed = policy(sources([clip('a')], [clip('a', 0, 15)], [clip('a')]));
  assert.equal(trimmed.changes[0].kind, 'trim');
  const moved = policy(sources([clip('a')], [clip('a', 0, 10, 2)], [clip('a')]));
  assert.equal(moved.changes[0].kind, 'move');
  assert.equal(moved.changes[0].local.track.index, 2);
});

test('changed track layout and timeline origin require review even without changed clips', () => {
  const input = sources([clip('a')]);
  input.local.timelines[0].tracks.push({ type: 'video', index: 3, name: 'V3' });
  input.incoming.timelines[0].startFrame = 100;
  const result = policy(input);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.timelineReviews[0].reasons, ['track-layout-changed', 'timeline-origin-changed']);
  assert.equal(result.summary.independence, 'unverified-placement-context');
  assert.equal(result.summary.changedTimelineCount, 1);
});

test('unknown unchanged neighbors and invalid intervals cannot yield a complete independence claim', () => {
  for (const interval of [[null, null], [10, 10], [20, 10]]) {
    const unknown = clip('unknown', ...interval);
    const result = policy(sources([unknown], [unknown], [unknown, clip('new', 10, 20)]));
    assert.equal(result.summary.unknownPlacementCount, 1);
    assert.equal(result.summary.analysisComplete, false);
    assert.equal(result.summary.comparisonLimitReached, false);
    assert.equal(result.summary.independence, 'unverified-placement-context');
    assert.deepEqual(result.interactions, []);
    assert.ok(result.warnings.some(warning => warning.includes('excluded from overlap analysis')));
  }
});

test('linked, effects and unsupported item risks are preserved for changed placement review', () => {
  const a = clip('a'), b = clip('b', 20, 30); a.linkedItemIds = ['b']; a.effectCounts.ofx = 1; a.type = 'nested';
  const input = sources([a, b]); input.incoming.timelines[0].items[0].startFrame = 1;
  const reasons = policy(input).changes[0].reasons;
  assert.ok(reasons.includes('linked-items-require-review'));
  assert.ok(reasons.includes('effects-or-unknown-effects-require-review'));
  assert.ok(reasons.includes('unsupported-item-type'));
});

test('collection permutations produce identical detached output and do not mutate sources', () => {
  const input = sources([], [clip('z', 0, 20), clip('a', 10, 25)], [clip('q', 5, 15), clip('b', 20, 30)]);
  for (const role of ['base', 'local', 'incoming']) input[role].timelines.push({ id: 'other', name: 'Other', startFrame: 0, tracks: [], items: [] });
  const before = structuredClone(input), result = policy(input), shuffled = structuredClone(input);
  for (const role of ['base', 'local', 'incoming']) {
    shuffled[role].timelines.reverse();
    for (const timeline of shuffled[role].timelines) { timeline.tracks.reverse(); timeline.items.reverse(); }
  }
  assert.deepEqual(policy(shuffled), result); assert.deepEqual(input, before);
  result.changes[0].local = { modified: true }; result.rules[0].description = 'changed';
  assert.deepEqual(policy(input), policy(before));
});

test('reversing branches preserves overlap evidence and exchanges source roles', () => {
  const input = sources([], [clip('a', 0, 20)], [clip('b', 10, 30)]), reversed = { base: input.base, local: input.incoming, incoming: input.local };
  const original = policy(input), result = policy(reversed);
  assert.equal(result.interactions[0].code, original.interactions[0].code);
  assert.deepEqual(result.interactions[0].itemIds, original.interactions[0].itemIds);
  assert.deepEqual(result.interactions[0].roles, ['incoming', 'local']);
  assert.deepEqual(result.changes[0].incoming, original.changes[0].local);
});

test('row caps disclose exact omitted observations without confusing display limits with analysis limits', () => {
  const input = sources([], [clip('a', 0, 20), clip('b', 0, 20)], [clip('c', 0, 20), clip('d', 0, 20)]);
  const result = policy(input, { maxChanges: 1, maxInteractions: 1 });
  assert.equal(result.changes.length, 1); assert.equal(result.interactions.length, 1);
  assert.equal(result.summary.totalChanges, 4); assert.equal(result.summary.truncatedChanges, 3);
  assert.equal(result.summary.observedInteractions, 4); assert.equal(result.summary.truncatedInteractions, 3);
  assert.equal(result.summary.analysisComplete, true); assert.equal(result.summary.comparisonLimitReached, false);
});

test('dense timelines cannot exceed the bounded pair-analysis budget and counts remain lower bounds', () => {
  const input = sources([], Array.from({ length: 1000 }, (_, index) => clip(`l-${index}`, 0, 100)),
    Array.from({ length: 1000 }, (_, index) => clip(`i-${index}`, 0, 100)));
  const result = policy(input, { maxChanges: 2, maxInteractions: 3, maxComparisons: 7 });
  assert.equal(result.summary.totalChanges, 2000);
  assert.equal(result.summary.comparisons, 7); assert.equal(result.summary.observedInteractions, 7);
  assert.equal(result.summary.analysisComplete, false); assert.equal(result.summary.comparisonLimitReached, true);
  assert.equal(result.summary.independence, 'unverified-analysis-limit');
  assert.ok(result.warnings.some(warning => warning.includes('lower bounds')));
});

test('many overlapping unchanged observations do not consume a pair budget or produce false changes', () => {
  const base = Array.from({ length: 3000 }, (_, index) => clip(`item-${index}`, 0, 100));
  const result = policy(sources(base), { maxComparisons: 0 });
  assert.equal(result.summary.totalChanges, 0); assert.equal(result.summary.comparisons, 0);
  assert.equal(result.summary.analysisComplete, true); assert.deepEqual(result.interactions, []);
});

test('zero comparison budget is complete only when there are no actual overlap candidates', () => {
  const adjacent = policy(sources([], [clip('a')], [clip('b', 10, 20)]), { maxComparisons: 0 });
  assert.equal(adjacent.summary.analysisComplete, true);
  const overlapping = policy(sources([], [clip('a')], [clip('b')]), { maxComparisons: 0 });
  assert.equal(overlapping.summary.analysisComplete, false); assert.equal(overlapping.summary.observedInteractions, 0);
});

test('bounded sweep matches direct interval enumeration across reproducible mixed timelines', () => {
  let seed = 421;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const represented = item => item ? [item.trackType, item.trackIndex, item.startFrame, item.endFrame] : null;
  const equal = (a, b) => JSON.stringify(represented(a)) === JSON.stringify(represented(b));
  const key = (left, right) => [left, right].sort((a, b) => a[0].localeCompare(b[0], 'en')).map(value => value.join(':')).join('|');
  for (let iteration = 0; iteration < 100; iteration++) {
    const base = ['a', 'b', 'c'].map(id => { const start = random(30); return clip(id, start, start + 1 + random(15), 1 + random(2)); });
    const variants = () => ['a', 'b', 'c', 'd', 'e', 'f'].filter(() => random(4) > 0).map(id => {
      if (random(3) === 0 && base.some(item => item.id === id)) return structuredClone(base.find(item => item.id === id));
      const start = random(30); return clip(id, start, start + 1 + random(15), 1 + random(2));
    });
    const local = variants(), incoming = variants(), expected = [];
    for (const l of local) for (const i of incoming) {
      if (l.id === i.id || l.trackIndex !== i.trackIndex || l.endFrame <= i.startFrame || i.endFrame <= l.startFrame) continue;
      if (equal(base.find(item => item.id === l.id), l) && equal(base.find(item => item.id === i.id), i)) continue;
      expected.push(key([l.id, 'local'], [i.id, 'incoming']));
    }
    const actual = policy(sources(base, local, incoming));
    assert.deepEqual(actual.interactions.map(row => key([row.itemIds[0], row.roles[0]], [row.itemIds[1], row.roles[1]])).sort(), expected.sort());
    assert.equal(actual.summary.analysisComplete, true);
    assert.equal(actual.summary.observedInteractions, expected.length);
  }
});

test('serialized output remains bounded even when validated normalized identifiers are unusually long', () => {
  const id = 'long-'.repeat(500000);
  const result = policy(sources([], [clip(id)], [clip('incoming')]));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024);
  assert.equal(result.summary.outputByteLimitReached, true);
  assert.equal(result.summary.totalChanges, 2);
  assert.ok(result.summary.truncatedChanges > 0);
});

test('incompatible identities, malformed manifests and unbounded options fail closed', () => {
  const input = sources();
  const incompatible = structuredClone(input); incompatible.local.projectId = 'other';
  assert.throws(() => policy(incompatible), { code: 'invalid-resolve-placement-policy' });
  assert.throws(() => policy({ ...input, unexpected: true }), { code: 'invalid-resolve-placement-policy' });
  for (const options of [null, [], { extra: 1 }, { maxChanges: -1 }, { maxInteractions: 5001 }, { maxComparisons: 1000001 }, { maxChanges: NaN }])
    assert.throws(() => policy(input, options), { code: 'invalid-resolve-placement-policy' });
  const invalid = sources([clip('a')]); invalid.local.timelines[0].items[0].trackIndex = 99;
  assert.throws(() => policy(invalid), { code: 'invalid-resolve-manifest' });
});
