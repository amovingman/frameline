'use strict';

const { createHash } = require('node:crypto');

const ROLES = ['base', 'local', 'incoming'];
const HASH = /^[a-f0-9]{64}$/u;

function fail() {
  const error = new Error('Invalid snapshot source binding.');
  error.code = 'INVALID_SNAPSHOT_BINDING';
  throw error;
}

function digest(source) {
  if (typeof source === 'string') return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
  if (Buffer.isBuffer(source)) return createHash('sha256').update(source).digest('hex');
  fail();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
  }
}

function sourcesObject(sources) {
  exactObject(sources, ROLES);
  for (const role of ROLES) digest(sources[role]);
}

/** Bind each named source role to the SHA-256 of its exact UTF-8 or Buffer bytes. */
function bindSnapshotSources(sources) {
  try {
    sourcesObject(sources);
    const hashes = {};
    for (const role of ROLES) hashes[role] = digest(sources[role]);
    return { schemaVersion: 1, readOnly: true, safeToApply: false, hashes };
  } catch {
    fail();
  }
}

/** Check that a binding is well formed and still describes the supplied sources. */
function verifySnapshotSources(binding, sources) {
  try {
    exactObject(binding, ['schemaVersion', 'readOnly', 'safeToApply', 'hashes']);
    if (binding.schemaVersion !== 1 || binding.readOnly !== true || binding.safeToApply !== false) fail();
    exactObject(binding.hashes, ROLES);
    for (const role of ROLES) {
      if (typeof binding.hashes[role] !== 'string' || !HASH.test(binding.hashes[role])) fail();
    }
    sourcesObject(sources);
    const matches = {};
    const staleRoles = [];
    for (const role of ROLES) {
      matches[role] = digest(sources[role]) === binding.hashes[role];
      if (!matches[role]) staleRoles.push(role);
    }
    return {
      schemaVersion: 1,
      readOnly: true,
      safeToApply: false,
      valid: staleRoles.length === 0,
      matches,
      staleRoles
    };
  } catch {
    fail();
  }
}

module.exports = { bindSnapshotSources, verifySnapshotSources };
