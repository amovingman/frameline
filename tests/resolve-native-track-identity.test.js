'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('read-only native identity graph and controlled empty-track bindings fail closed on unsupported input', () => {
  const run = spawnSync('python3', [path.join(__dirname, '../phase-0/test_resolve_native_track_identity.py')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
});

test('historical native track observation binds original archive hashes without closing unsupported proofs', () => {
  const root = path.join(__dirname, '..');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'phase-0/native-track-identity-historical-observation.json')));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, report.sourceProfile))).digest('hex'), report.sourceProfileSha256);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, report.apiSnapshot))).digest('hex'), report.apiSnapshotSha256);
  assert.equal(report.baselineGraphAndApiWitness.apiBindings.reduce((sum, row) => sum + row.itemCount, 0), 53);
  assert.equal(report.baselineGraphAndApiWitness.apiBindings.length, 2);
  const noEdit = JSON.parse(fs.readFileSync(path.join(root, 'phase-0/native-no-edit-control-live-observation.json')));
  const renamed = JSON.parse(fs.readFileSync(path.join(root, 'phase-0/native-rename-difference-live-observation.json')));
  assert.deepEqual(report.noEditSaveReopen.before, noEdit.before); assert.deepEqual(report.noEditSaveReopen.after, noEdit.after);
  assert.deepEqual(report.clipRenameSaveReopen.before, renamed.before); assert.deepEqual(report.clipRenameSaveReopen.after, renamed.after);
  assert.equal(report.noEditSaveReopen.retainedTracks.length, 2);
  assert.equal(report.clipRenameSaveReopen.retainedTracks.length, 2);
  assert.equal(report.newLiveEditorRun, false); assert.equal(report.stableTrackIdentityProven, false);
  assert.equal(report.emptyTrackApiBindingProven, false); assert.equal(report.safeToApply, false);
});
