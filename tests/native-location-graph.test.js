'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native location reader preserves sources and refuses untested structural shapes', () => {
  const run = spawnSync('python3', [path.join(__dirname, '../phase-0/test_native_location_graph.py')],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
});
