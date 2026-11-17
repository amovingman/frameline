'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateEffectObservation, parseEffectObservation, compareEffectObservations } = require('../src/resolve-effect-observation');
const { createEffectCaptureCommand, readEffectConsoleResult } = require('../src/resolve-effect-console');
const file = phase => fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof', `live-effects-${phase}.json`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('live effect supplement detects an enabled change invisible to schema-3 counts and verifies exact restoration', () => {
  const enabled = file('enabled'), disabled = file('disabled'), restored = file('restored');
  assert.equal(hash(enabled), '696ee1b32e09ff410f54ed4905c2423cc228437654511117f86d31ad4070f585');
  assert.equal(hash(disabled), '7b5cbe4ebe91f915e58b060f86a6f4eacf3daeb7750f3e9a78ce3a0e50b4728d');
  assert.deepEqual(enabled, restored);
  const before = parseEffectObservation(enabled);
  assert.equal(before.items.length, 53);
  assert.equal(before.items.flatMap(item => item.effects).length, 1);
  assert.equal(before.items.flatMap(item => item.effects)[0].typeId, 'Resolve FX/Resolve FX Blur/Gaussian Blur');
  const report = compareEffectObservations(enabled, disabled);
  assert.deepEqual(report.snapshotChanges, []);
  assert.deepEqual(report.effectChanges, [{ timelineId: 'ed6239f2-300b-4615-ba3e-55bbef44b11c',
    itemId: 'caead6fa-1b2c-49a5-9325-8aae89a0fe55', category: 'ofx', index: 1,
    kind: 'slot-field-changed', field: 'enabled', before: true, after: false }]);
  assert.equal(report.safeToApply, false);
  assert.equal(report.effectIdentity, 'category-index-only');
});

test('rejects omitted items, wrong counts, duplicate slots, paths, unknown fields, and getters', () => {
  for (const mutate of [value => value.items.pop(), value => value.items.push(value.items[0]),
    value => value.items[0].effects.push(value.items[0].effects[0]),
    value => { value.items[0].effects[0].index = 2; },
    value => { value.items[0].effects[0].enabled = 'true'; },
    value => { value.items[0].effects[0].typeId = '/Users/private/effect'; },
    value => { value.items[0].effects[0].typeId = 'https://example.invalid/effect'; },
    value => { value.items[0].effects[0].typeId = 'Resolve FX/../private/effect'; },
    value => { value.items[0].effects[0].name = '/Users/private'; },
    value => { value.items[0].effects[0].parameters = { value: 1 }; },
    value => { value.snapshot.timelines[0].items[0].effect_counts.ofx = 0; }]) {
    const observation = JSON.parse(file('enabled'));
    mutate(observation);
    assert.throws(() => validateEffectObservation(observation));
  }
  const observation = JSON.parse(file('enabled'));
  let accessed = false;
  Object.defineProperty(observation.items[0].effects[0], 'enabled', { enumerable: true, get() { accessed = true; return true; } });
  assert.throws(() => validateEffectObservation(observation));
  assert.equal(accessed, false);
});

test('effect comparisons ignore enumeration order and refuse different projects', () => {
  const original = file('enabled');
  const changed = JSON.parse(original);
  changed.items.reverse();
  assert.deepEqual(compareEffectObservations(original, JSON.stringify(changed)).effectChanges, []);
  changed.snapshot.project_id = 'another-project';
  assert.throws(() => compareEffectObservations(original, JSON.stringify(changed)));
});

test('Console capture parts bind a full supplement to their capture ID and reject incomplete or failed output', async () => {
  const request = await createEffectCaptureCommand('Frameline Restore Probe');
  const raw = file('enabled').toString('utf8').trimEnd(), lines = [];
  const total = Math.ceil(raw.length / 8192);
  for (let n = 0; n < raw.length; n += 8192) lines.push(`FRAMELINE_EFFECT_PART_V1:${request.captureId}:${lines.length + 1}:${total}:${raw.slice(n, n + 8192)}`);
  assert.equal(readEffectConsoleResult({ captureId: request.captureId, output: lines.join('\n') }), raw + '\n');
  for (const output of [lines.slice(1).join('\n'), [...lines, lines[0]].join('\n'), lines.toReversed().join('\n'),
    lines.join('\n') + `\nFRAMELINE_EFFECT_ERROR_V1:${request.captureId}:failed`]) {
    assert.throws(() => readEffectConsoleResult({ captureId: request.captureId, output }));
  }
  assert.throws(() => readEffectConsoleResult({ captureId: '0'.repeat(32), output: lines.join('\n') }));
  await assert.rejects(createEffectCaptureCommand('/Users/private/project'));
});
