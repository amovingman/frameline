'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFirstEditor } = require('../phase-0/audit-first-editor');

test('checked-in live evidence keeps ten first-editor gates honest', () => {
  const report = auditFirstEditor();
  assert.equal(report.gates.length, 10);
  assert.equal(report.safeToApply, false);
  assert.equal(report.releaseSupported, false);
  assert.equal(report.sources.beforeSnapshot, '37dcddbf9590aa423d99ebde5513e35f8ea49bb0169e9f5019e09f8c1ff85c51');
  assert.equal(report.sources.beforeExport, '0cd17372ffdfe85afa5bb0f8e8ccbbd83eff774ddaf223261fcef0fcb6d8e844');
  assert.equal(report.sources.afterSnapshot, '52baa9811fd1a0e4f3782890c639a4085337a0f2a0a78ae628fcb799a7dc2520');
  assert.equal(report.sources.afterExport, '61cf1c4088dc791e3973a38516516c3a5179b436a2e8eae0a113d0e75da8c307');
  assert.equal(report.sources.structureExport, '9f63b62306672623b042e40646fac3359262153b90ecae0118ef252a7f492ed9');
  assert.equal(report.observations.apiAudioItems, 2);
  assert.equal(report.observations.externalFreeConnection, false);
  assert.equal(report.gates.find(gate => gate.id === 'editor-choice-stop-or-revisit').status, 'blocked');
  assert.equal(report.observations.xmlExplicitAudioEntries, 1);
  assert.equal(report.observations.retainedApiItems, 5);
  assert.deepEqual(report.observations.observedDifferenceKinds, { 'item-changed': 2 });
  assert(report.gates.every(gate => ['open', 'blocked', 'partial'].includes(gate.status)));
  assert(!JSON.stringify(report).includes('/Users/'));
});
