'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native opaque field inventory localizes payload changes while rejecting unsupported equality claims', () => {
  const run = spawnSync('python3', [path.join(__dirname, '../phase-0/test_resolve_native_field_inventory.py')],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Ran 6 tests/);
});
