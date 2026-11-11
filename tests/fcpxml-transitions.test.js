const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventoryTransitions } = require('../src/fcpxml-transitions');
const xml = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml'), 'utf8');

test('inventories the serialized Free Resolve transition in its containing XML scope', () => {
  const result = inventoryTransitions(xml);
  assert.equal(result.readOnly, true);
  assert.equal(result.transitions.length, 1);
  assert.deepEqual(result.transitions[0], {
    locator: 'sequence/spine[1]/gap[1]/spine[1]/transition[1]', name: 'Cross Dissolve',
    timing: { basis: 'xml-serialized-unresolved', offset: '17/12s', duration: '1/12s' },
    effectNames: ['Cross Dissolve']
  });
  assert.equal(result.effects, undefined);
  assert.doesNotMatch(JSON.stringify(result), /file:\/\/|Users\/user|FxPlug|"ease"|"value"/);
});

test('requires a named Frameline project and explicit selection when ambiguous', () => {
  assert.throws(() => inventoryTransitions(xml.replaceAll('Frameline Structure', 'Other Structure')), { code: 'frameline-project-required' });
  const duplicated = xml.replace('</event>', xml.match(/<project[\s\S]*<\/project>/)[0].replaceAll('Frameline Structure Coverage', 'Frameline Another Coverage') + '</event>');
  assert.throws(() => inventoryTransitions(duplicated), { code: 'ambiguous-project' });
  assert.equal(inventoryTransitions(duplicated, { projectName: 'Frameline Another Coverage 00 Copy (Resolve)' }).transitions.length, 1);
});

test('rejects malformed/versioned/entity input with path-free error codes', () => {
  assert.throws(() => inventoryTransitions('<fcpxml>'), { code: 'malformed-xml' });
  assert.throws(() => inventoryTransitions(xml.replace('version="1.10"', 'version="1.9"')), { code: 'unsupported-fcpxml-version' });
  assert.throws(() => inventoryTransitions(xml.replace('<!DOCTYPE fcpxml>', '<!DOCTYPE fcpxml [<!ENTITY secret SYSTEM "file:///secret">]>')), { code: 'malformed-xml' });
});
