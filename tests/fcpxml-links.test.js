const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventoryLinkedAudio } = require('../src/fcpxml-links');
test('same-clip audio association is explicitly a candidate', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld/Info.fcpxml'), 'utf8');
  const live = inventoryLinkedAudio(xml)[0];
  assert.deepEqual(live.linkedAudio, []);
  assert.equal(live.explicitAudioEntries.length, 1);
  assert.equal(live.explicitAudioEntries[0].lane, 4);
  assert.equal(live.linkageStatus, 'unresolved-without-api-ids');
  const explicit = '<fcpxml version="1.10"><resources/><library><event><project name="P"><sequence><spine><clip><video ref="v"/><audio ref="a"/></clip></spine></sequence></project></event></library></fcpxml>';
  const sameClip = inventoryLinkedAudio(explicit)[0];
  assert.equal(sameClip.linkedAudio[0].status, 'candidate');
  assert.equal(sameClip.explicitAudioEntries.length, 1);
});
