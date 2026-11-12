const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { inspectFreeExport } = require('../phase-0/inspect-free-export');

test('combines five read-only inventories for the named Free export without exposing paths', () => {
  const selected = path.join(__dirname, '../phase-0/compatibility-corpus/resolve-structure-live.fcpxmld');
  const report = inspectFreeExport(selected);
  assert.equal(report.readOnly, true);
  assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.sequences.length, 1);
  assert.deepEqual(report.tracks[0].counts, { serializedGaps: 1, pictureEntries: 3, audioEntries: 1, unknownEntries: 2 });
  assert.equal(report.audio[0].explicitAudioEntries.length, 1);
  assert.equal(report.transitions.length, 1);
  assert.equal(report.effects.length, 5);
  assert.doesNotMatch(JSON.stringify(report), /file:\/\/|Users\/user|FxPlug|ease/);
});
