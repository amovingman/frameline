'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('bounded native timeline inventory resolves explicit structure and refuses ambiguous or unsupported sources', () => {
  const result = spawnSync('python3', [path.join(__dirname, '../phase-0/test_native_timeline_inventory.py')], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 6 tests/);
});
