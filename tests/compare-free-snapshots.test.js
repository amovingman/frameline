const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareSnapshotFiles } = require('../phase-0/compare-free-snapshots');

const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const before = path.join(proof, 'live-mapping-before-schema3.json');
const after = path.join(proof, 'live-mapping-after-schema3.json');

test('compares named live Free captures by ID and leaves both sources untouched', () => {
  const result = compareSnapshotFiles(before, after);
  assert.match(result.beforeHash, /^[a-f0-9]{64}$/);
  assert.match(result.afterHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result.beforeHash, result.afterHash);
  assert.equal(result.diff.changes.length, 2);
  assert.deepEqual(result.summary.itemSummaries[0].classifications, ['position-change']);
  assert.equal(result.readOnly, true);
  assert.equal(result.safeToApply, false);
  assert.doesNotMatch(JSON.stringify(result), /file:\/\/|Users\/user|Downloads/);
});

test('CLI reports generic errors without leaking a selected path', () => {
  const script = path.join(__dirname, '../phase-0/compare-free-snapshots.js');
  const missing = '/private/tmp/frameline-secret-missing-snapshot.json';
  const run = spawnSync(process.execPath, [script, before, missing], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'invalid-or-incompatible-snapshots\n');
  assert.doesNotMatch(run.stderr, /frameline-secret|private\/tmp/);
});
