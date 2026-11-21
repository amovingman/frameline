'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');
const { bindDiagnosticSynchronizedTracks, bindSupportedSavedTracks } = require('../phase-0/supported-native-track-binding');
const pair = require('../phase-0/native-blind-identity-evidence/initial-pair.json');
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
  '../phase-0/native-blind-identity-evidence/initial-initial-result.json.gz'))));
const observations = [raw.before, raw.between, raw.after];
const graphs = Object.values(pair.capture.graphs);

test('diagnostic shape check accepts held-out capture but cannot promote it to a saved or current-live binding', () => {
  const result = bindDiagnosticSynchronizedTracks(observations, graphs, raw.apiLocationWitnesses);
  assert.equal(result.observedIdentityShapeValidated, true);
  assert.equal(result.supportedIdentityProfileValidated, false);
  assert.equal(result.savedCheckpointRequired, true);
  assert.equal(result.currentUnsavedStateBindingProven, false);
  assert.equal(result.trackCount, 8);
  assert.equal(result.emptyTrackCount, 5);
  assert.equal(result.itemCount, 52);
  assert.equal(result.apiLocationWitnesses.itemCount, 52);
  assert.equal(result.safeToApply, false);
  assert.equal(result.priorUuidLedgerRequired, false);
});

test('diagnostic shape check refuses drift, unknown native subtype and missing runtime witnesses', () => {
  const drift = structuredClone(observations);
  drift[1].snapshot.timelines[0].tracks[0].name += ' changed';
  assert.throws(() => bindDiagnosticSynchronizedTracks(drift, graphs, raw.apiLocationWitnesses), /state-drift/);
  const unsupported = structuredClone(graphs);
  for (const graph of unsupported) graph.timelines[0].tracks[0].nativeSubType = 99;
  assert.throws(() => bindDiagnosticSynchronizedTracks(observations, unsupported, raw.apiLocationWitnesses), /unsupported-finite-native-profile/);
  assert.throws(() => bindDiagnosticSynchronizedTracks(observations, graphs, null));
});

test('raw read/export data and caller-supplied saved flags cannot bypass source-bound save/reopen checkpoint verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-saved-binding-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preparation = path.join(directory, 'preparation.json');
  fs.writeFileSync(preparation, JSON.stringify({ operation: 'prepare-native-blind-capture', stage: 'capture',
    observations, graphs, apiLocationWitnesses: raw.apiLocationWitnesses, savedReopenProven: true }));
  await assert.rejects(bindSupportedSavedTracks(preparation), /saved-checkpoint-required/);
  fs.writeFileSync(preparation, JSON.stringify({ operation: 'prepare-native-blind-capture', stage: 'initialize',
    directory, savedReopenProven: true }));
  await assert.rejects(bindSupportedSavedTracks(preparation), /invalid-blind-record/);
});
