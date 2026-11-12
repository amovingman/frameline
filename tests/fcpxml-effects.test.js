const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventoryEffects } = require('../src/fcpxml-effects');
const xml = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml'), 'utf8');

test('reports only serialized filters and adjustments without traversing resource sequences', () => {
  const result = inventoryEffects(xml);
  assert.equal(result.readOnly, true);
  assert.equal(result.effects.length, 5);
  assert.equal(result.effects.filter(effect => effect.kind === 'adjust-transform').length, 4);
  const transition = result.effects.find(effect => effect.kind === 'filter-video');
  assert.equal(transition.name, 'Cross Dissolve');
  assert.equal(transition.usage, 'transition');
  assert.equal(transition.resourceResolved, true);
  assert.ok(result.effects.every(effect => effect.parametersIncluded === false));
  assert.equal(result.transitions, undefined);
  assert.doesNotMatch(JSON.stringify(result), /file:\/\/|Users\/user|FxPlug|ease|position|scale|anchor/);
});

test('unresolved filters remain visible and private names and unsupported parameters stay excluded', () => {
  const result = inventoryEffects(xml.replace('ref="r4"', 'ref="missing"').replace('name="Transition"', 'name="file:///private/secret"'));
  const filter = result.effects.find(effect => effect.kind === 'filter-video');
  assert.equal(filter.name, 'filter-video');
  assert.equal(filter.resourceResolved, false);
  assert.deepEqual(result.warnings, ['Some effect references could not be resolved']);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|ease|"value"/);
});
