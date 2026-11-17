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
