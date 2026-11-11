'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { bindSnapshotSources, verifySnapshotSources } = require('../src/resolve-snapshot-bindings');

const sources = () => ({ base: Buffer.from([0, 1, 255]), local: 'local ✓', incoming: '{"manifest":1}' });
const sha = value => createHash('sha256').update(value).digest('hex');

test('binds exact bytes for all three named roles and verifies identical inputs', () => {
  const input = sources();
  const binding = bindSnapshotSources(input);
  assert.deepEqual(binding, {
    schemaVersion: 1,
    readOnly: true,
    safeToApply: false,
    hashes: { base: sha(input.base), local: sha(Buffer.from(input.local, 'utf8')), incoming: sha(Buffer.from(input.incoming, 'utf8')) }
  });
  assert.deepEqual(verifySnapshotSources(binding, input), {
    schemaVersion: 1,
    readOnly: true,
    safeToApply: false,
    valid: true,
    matches: { base: true, local: true, incoming: true },
    staleRoles: []
  });
});

test('reports changed and stale source roles without allowing application', () => {
  const binding = bindSnapshotSources(sources());
  const current = sources();
  current.local = 'edited';
  const result = verifySnapshotSources(binding, current);
  assert.equal(result.valid, false);
  assert.deepEqual(result.matches, { base: true, local: false, incoming: true });
  assert.deepEqual(result.staleRoles, ['local']);
  assert.equal(result.readOnly, true);
  assert.equal(result.safeToApply, false);
});

test('rejects malformed role sets, source values, and binding hash shapes generically', () => {
  assert.throws(() => bindSnapshotSources({ base: 'a', local: 'b', incoming: 'c', extra: 'x' }), {
    code: 'INVALID_SNAPSHOT_BINDING', message: 'Invalid snapshot source binding.'
  });
  assert.throws(() => bindSnapshotSources({ base: 'a', local: new Uint8Array([1]), incoming: 'c' }), {
    code: 'INVALID_SNAPSHOT_BINDING', message: 'Invalid snapshot source binding.'
  });
  const binding = bindSnapshotSources(sources());
  binding.hashes.local = '../secret';
  assert.throws(() => verifySnapshotSources(binding, sources()), {
    code: 'INVALID_SNAPSHOT_BINDING', message: 'Invalid snapshot source binding.'
  });
  assert.throws(() => verifySnapshotSources({ ...binding, safeToApply: true }, sources()), {
    code: 'INVALID_SNAPSHOT_BINDING', message: 'Invalid snapshot source binding.'
  });
});
