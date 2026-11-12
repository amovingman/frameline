const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { coverageFiles } = require('../phase-0/coverage-free-snapshot');

const phase = path.join(__dirname, '../phase-0');
const snapshot = path.join(phase, 'resolve-xml-proof/live-mapping-before-schema3.json');
const exportPath = path.join(phase, 'compatibility-corpus/resolve-structure-live.fcpxmld');
const script = path.join(phase, 'coverage-free-snapshot.js');

test('CLI reports bounded, path-free structure coverage without authorizing apply', () => {
  const direct = coverageFiles(snapshot, exportPath);
  assert.equal(direct.completeEnumeration, false);
  assert.equal(direct.safeToApply, false);
  assert.equal(direct.scopeBasis, 'single-selected-pair-identity-unverified');
  assert.match(direct.sources.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(direct.sources.exportSha256, /^[a-f0-9]{64}$/);
  const run = spawnSync(process.execPath, [script, snapshot, exportPath], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), direct);
  assert.doesNotMatch(run.stdout, /file:\/\/|Users\/user|moving-bars/);
});

test('CLI rejects missing inputs without leaking the path', () => {
  const run = spawnSync(process.execPath, [script, snapshot, path.join(phase, 'missing.fcpxml')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'invalid-coverage-input\n');
  assert.ok(fs.existsSync(snapshot));
});
