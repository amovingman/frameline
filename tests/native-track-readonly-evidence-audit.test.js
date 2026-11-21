'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditNativeTrackReadOnlyEvidence } = require('../phase-0/native-track-readonly-evidence-audit');

test('live read-only proof recomputes three equal states, exact calibrated graph and all five current bindings', () => {
  const audit = auditNativeTrackReadOnlyEvidence();
  assert.equal(audit.challengeFreeReadOnlyRebindingVerified, true);
  assert.equal(audit.independentlyChallengedCalibrationAssociations, 21);
  assert.equal(audit.emptyDuplicateNameTracksBound, 4);
  assert.equal(audit.calibratedLocationRuleRecomputed, true);
  assert.equal(audit.nativeGraphsReconstructedFromArchives, false);
  assert.equal(audit.stableTrackIdentityProven, false);
  assert.equal(audit.ordinaryApplySupported, false);
  assert.equal(audit.installedTestScriptRemoved, true);
});

test('public read-only audit rejects changed native graph, raw payload and source', () => {
  for (const mode of ['graph', 'raw', 'source']) {
    const read = filename => {
      const bytes = fs.readFileSync(filename);
      if (mode === 'graph' && path.basename(filename) === 'native-track-readonly-live-observation.json') {
        const report = JSON.parse(bytes);
        report.graphs.first.timelines[0].tracks[0].nativeOrdinal = 9;
        return Buffer.from(JSON.stringify(report));
      }
      if (mode === 'raw' && path.basename(filename) === 'native-track-readonly-live-result.json.gz') return Buffer.from(bytes.subarray(0, 30));
      if (mode === 'source' && path.basename(filename) === 'resolve-native-track-readonly.lua') return Buffer.concat([bytes, Buffer.from('\n-- changed')]);
      return bytes;
    };
    assert.throws(() => auditNativeTrackReadOnlyEvidence(read));
  }
});
