'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('native comparison bounds archives, preserves unknown changes, and omits private names and values', () => {
  const result = spawnSync('python3', [path.join(__dirname, '../phase-0/test_native_resolve_comparison.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('successful live forward/reverse transactions retain the unresolved native-content gap', () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0', name)));
  const trial = read('successful-rename-live-observation.json');
  assert.equal(trial.forcedFailure, false);
  assert.equal(trial.forward.status, 'applied');
  assert.equal(trial.reverse.status, 'applied');
  assert.equal(trial.forward.sourceSha256, trial.reverse.resultingSnapshotSha256);
  assert.equal(trial.forward.resultingSnapshotSha256, trial.reverse.sourceSha256);
  assert.equal(trial.originalObservedStateRestored, true);
  assert.equal(trial.nativeContentValidated, false);
  assert.equal(trial.history.restoredParentRevisionId, trial.history.appliedRevisionId);
  const native = read('native-rename-difference-live-observation.json');
  assert.equal(native.before.sha256, trial.forward.backup.sha256);
  assert.equal(native.changedMembers, 3);
  assert.equal(native.losslessValidated, false);
  assert.equal(native.safeToApply, false);
  assert.equal(native.members.find(member => member.kind === 'gallery').status, 'unchanged');
  assert.ok(native.members.find(member => member.kind === 'sequence').changedLineTags.FieldsBlob);
  assert.ok(native.members.find(member => member.kind === 'sequence').changedLineTags.Name);
});

test('live no-edit control preserves the source observation while native opaque data still changes', () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0', name)));
  const control = read('native-no-edit-control-live-observation.json');
  const comparison = read('native-rename-control-comparison-live-observation.json');
  assert.equal(control.observedSnapshotSha256, '654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850');
  assert.equal(control.observedFieldsUnchanged, true);
  assert.equal(control.changedMembers, 3);
  assert.deepEqual(comparison.control.before, control.before);
  assert.deepEqual(comparison.control.after, control.after);
  const sequence = comparison.tagEvidence.find(member => member.kind === 'sequence');
  assert.deepEqual(sequence.commonTags, ['BtThumnail', 'FieldsBlob']);
  assert.deepEqual(sequence.editOnlyTags, ['Name']);
  assert.equal(comparison.losslessValidated, false);
  assert.equal(comparison.safeToApply, false);
});
