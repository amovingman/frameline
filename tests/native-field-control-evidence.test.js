'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { auditNativeFieldControlEvidence } = require('../phase-0/native-field-control-evidence');

test('read-only native field control exposes unpaired records without claiming opaque equality', () => {
  const report = auditNativeFieldControlEvidence();
  assert.deepEqual(report.recordsPerExport, [430, 430]);
  assert.deepEqual(report.recordDifferenceCounts, { 'added-record': 150, 'removed-record': 150, 'observed-payload-difference': 1 });
  assert.equal(report.representedApiStateUnchangedDuringControl, true);
  assert.equal(report.rawMemberBytesMatch, false);
  assert.equal(report.originalNativeArchivesReconstructed, false);
  assert.equal(report.fullNativePreservationProven, false);
  assert.equal(report.safeToApply, false);
  assert(!JSON.stringify(report).includes('/Users/'));
});

test('changed field facts, source or receipt cannot be promoted to preservation proof', () => {
  for (const name of ['first-inventory.json.gz', 'resolve-native-field-inventory.py', 'receipt.json']) {
    assert.throws(() => auditNativeFieldControlEvidence(filename => {
      const raw = fs.readFileSync(filename);
      return filename.endsWith(name) ? Buffer.concat([raw, Buffer.from('changed')]) : raw;
    }));
  }
});
