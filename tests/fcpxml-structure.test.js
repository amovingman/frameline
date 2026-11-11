const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventoryStructure } = require('../src/fcpxml-structure');

const fixture = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml'), 'utf8');
test('inventories the live Resolve export without leaking media paths', () => {
  const result = inventoryStructure(fixture);
  assert.equal(result.readOnly, true);
  assert.equal(result.sequences.length, 1);
  const sequence = result.sequences[0];
  assert.equal(sequence.name, 'Frameline Structure Coverage 00 Copy (Resolve)');
  assert.ok(sequence.tracks.some(t => t.type === 'video' && t.lane === 1));
  assert.ok(sequence.tracks.some(t => t.type === 'audio' && t.lane === 4));
  assert.equal(sequence.linkedAudio.length, 0);
  assert.equal(sequence.tracks.filter(t => t.type === 'audio').flatMap(t => t.entries).length, 1);
  assert.ok(!sequence.tracks.some(t => t.type === 'audio' && t.lane === 0));
  assert.ok(sequence.unsupported.includes('nested-sequences-not-inventoried'));
  assert.ok(sequence.unsupported.includes('transition-details-not-inventoried'));
  assert.ok(!JSON.stringify(result).includes('file://'));
  assert.ok(!JSON.stringify(result).includes('/Users/'));
});
test('inventories multiple sequences and rejects malformed or unsupported XML', () => {
  const xml = '<fcpxml version="1.10"><resources/><library><event><project name="A"><sequence><spine/></sequence></project><project name="B"><sequence><spine/></sequence></project></event></library></fcpxml>';
  assert.deepEqual(inventoryStructure(xml).sequences.map(s => s.name), ['A', 'B']);
  assert.throws(() => inventoryStructure('<fcpxml>'), { code: 'malformed-xml' });
  assert.throws(() => inventoryStructure(xml.replace('1.10', '1.9')), { code: 'unsupported-fcpxml-version' });
});
