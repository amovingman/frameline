const test = require('node:test');
const assert = require('node:assert/strict');
const { inventorySequences } = require('../src/fcpxml-sequences');
test('sequence inventory preserves sequence names and raw durations', () => {
  const xml = '<fcpxml version="1.10"><resources/><library><event><project name="First"><sequence duration="3/2s"><spine/></sequence></project></event></library></fcpxml>';
  assert.equal(inventorySequences(xml)[0].duration, '3/2s');
});
