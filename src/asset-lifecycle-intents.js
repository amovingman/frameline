'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { acquireMetadataLock } = require('./metadata-lock');
const { fingerprint } = require('./project-api-contracts');
const { validateHoldInput, validateRetentionInput, asset, id } = require('./asset-lifecycle-protocol');

const MAX_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREFIX = 'asset-lifecycle-';
const INVALID = `${PREFIX}intent-invalid`;
const UNAVAILABLE = `${PREFIX}intent-storage-unavailable`;
const UNCERTAIN = `${PREFIX}intent-storage-uncertain`;
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const binding = value => typeof value === 'string' && HASH.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

function validateIntent(value, withKey) {
  if (!exact(value, ['kind', 'projectId', 'assetId', 'input']) || !['hold', 'retention'].includes(value.kind)
    || !id(value.projectId) || (value.kind === 'hold' ? !asset(value.assetId) : value.assetId !== null)) throw fail(INVALID);
  const supplied = value.input;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || !withKey && Object.hasOwn(supplied, 'idempotencyKey')) throw fail(INVALID);
  try { (value.kind === 'hold' ? validateHoldInput : validateRetentionInput)(withKey ? supplied : { ...supplied, idempotencyKey: 'validation-only' }); }
  catch { throw fail(INVALID); }
  return structuredClone(value);
}
function validateState(value) {
  if (!exact(value, ['schemaVersion', 'entries']) || value.schemaVersion !== 1
    || !Array.isArray(value.entries) || value.entries.length > 100) throw fail(INVALID);
  const seen = new Set();
  for (const entry of value.entries) {
    if (!exact(entry, ['bindingHash', 'record']) || !binding(entry.bindingHash) || seen.has(entry.bindingHash)
      || !exact(entry.record, ['id', 'kind', 'projectId', 'assetId', 'input', 'createdAt'])
      || typeof entry.record.id !== 'string' || !UUID.test(entry.record.id) || !time(entry.record.createdAt)) throw fail(INVALID);
    const { kind, projectId, assetId, input } = entry.record;
    validateIntent({ kind, projectId, assetId, input }, true);
    if (typeof input.idempotencyKey !== 'string' || !UUID.test(input.idempotencyKey)
      || input.idempotencyKey === entry.record.id) throw fail(INVALID);
    seen.add(entry.bindingHash);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw fail(INVALID);
  return structuredClone(value);
}
function intentHash(record) {
  const { idempotencyKey: _key, ...input } = record.input;
  return fingerprint({ kind: record.kind, projectId: record.projectId, assetId: record.assetId, input });
}

// Private desktop state only. Every operation rereads under the cooperative lock;
// an acknowledgment follows both file and directory flushes, never network I/O.
function createAssetLifecycleIntents({ directory, storage = fs, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof now !== 'function'
    || !storage || !['lstat', 'realpath', 'mkdir', 'open', 'rename', 'unlink', 'readdir'].every(key => typeof storage[key] === 'function')) throw fail(INVALID);
  directory = path.resolve(directory);
  const filename = path.join(directory, 'lifecycle-intents.json');
  const marker = path.join(directory, 'initialized.json');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  let pending = Promise.resolve(), uncertain = false, observed = false;

  async function syncDirectory(target) {
    const handle = await storage.open(target, flags);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function ensureDirectory(target = directory) {
    let stat;
    try { stat = await storage.lstat(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw fail(UNAVAILABLE);
      await ensureDirectory(parent);
      try { await storage.mkdir(target, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      await syncDirectory(target); await syncDirectory(parent);
      stat = await storage.lstat(target);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || target === directory && (stat.mode & 0o777) !== 0o700
      || await storage.realpath(target) !== target) throw fail(INVALID);
  }
  async function bounded(target, limit) {
    const handle = await storage.open(target, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 2 || stat.size > limit) throw fail(INVALID);
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw fail(INVALID); offset += bytesRead;
      }
      const after = await handle.stat();
      const current = await storage.lstat(target);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino
        || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1) throw fail(INVALID);
      return bytes;
    } finally { await handle.close(); }
  }
  async function publish(target, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_BYTES) throw fail(INVALID);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    let replacing = false;
    try {
      const handle = await storage.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      replacing = true;
      await storage.rename(temporary, target);
      await syncDirectory(directory);
    } catch (error) {
      if (replacing) { uncertain = true; throw fail(UNCERTAIN); }
      if (error.code === INVALID) throw error;
      throw fail(UNAVAILABLE);
    } finally { try { await storage.unlink(temporary); } catch { /* Cleanup does not replace the publication error. */ } }
  }
  async function read() {
    let bytes;
    try { bytes = await bounded(filename, MAX_BYTES); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const names = await storage.readdir(directory);
      if (observed || names.some(name => name !== 'metadata.lock')) throw fail(INVALID);
      const fresh = { schemaVersion: 1, entries: [] };
      await publish(filename, fresh);
      bytes = Buffer.from(JSON.stringify(fresh));
    }
    let state;
    try { state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw fail(INVALID); }
    observed = true;
    let markerBytes;
    try { markerBytes = await bounded(marker, 128); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await publish(marker, { schemaVersion: 1 });
      markerBytes = Buffer.from('{"schemaVersion":1}');
    }
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes));
      if (!exact(value, ['schemaVersion']) || value.schemaVersion !== 1) throw fail(INVALID);
    } catch { throw fail(INVALID); }
    return state;
  }
  function run(action) {
    const operation = pending.then(async () => {
      if (uncertain) throw fail(UNCERTAIN);
      let release;
      try {
        await ensureDirectory();
        release = await acquireMetadataLock(directory);
        // A second local process may have replaced the state while we waited.
        await ensureDirectory();
        return await action(await read());
      } catch (error) {
        if ([INVALID, UNAVAILABLE, UNCERTAIN, `${PREFIX}retry-required`, `${PREFIX}selection-changed`].includes(error.code)) throw error;
        throw fail(UNAVAILABLE);
      } finally {
        if (release) try { await release(); } catch { uncertain = true; throw fail(UNCERTAIN); }
      }
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    load(bindingHash) {
      if (!binding(bindingHash)) return Promise.reject(fail(INVALID));
      return run(state => structuredClone(state.entries.find(entry => entry.bindingHash === bindingHash)?.record ?? null));
    },
    begin(bindingHash, value) {
      let checked;
      try { if (!binding(bindingHash)) throw fail(INVALID); checked = validateIntent(value, false); }
      catch { return Promise.reject(fail(INVALID)); }
      return run(async state => {
        const prior = state.entries.find(entry => entry.bindingHash === bindingHash)?.record;
        const id = randomUUID(), input = { ...checked.input, idempotencyKey: randomUUID() };
        if (prior) {
          if (intentHash(prior) !== intentHash({ ...checked, input })) throw fail(`${PREFIX}retry-required`);
          return { record: structuredClone(prior), created: false };
        }
        const createdAt = now(); if (!time(createdAt) || state.entries.length >= 100) throw fail(INVALID);
        const record = { id, kind: checked.kind, projectId: checked.projectId, assetId: checked.assetId, input, createdAt };
        const next = validateState({ schemaVersion: 1, entries: [...state.entries, { bindingHash, record }] });
        await publish(filename, next);
        return { record: structuredClone(record), created: true };
      });
    },
    complete(bindingHash, id) {
      if (!binding(bindingHash) || typeof id !== 'string' || !UUID.test(id)) return Promise.reject(fail(INVALID));
      return run(async state => {
        const prior = state.entries.find(entry => entry.bindingHash === bindingHash)?.record;
        if (!prior) return { removed: false };
        if (prior.id !== id) throw fail(`${PREFIX}selection-changed`);
        await publish(filename, { schemaVersion: 1, entries: state.entries.filter(entry => entry.bindingHash !== bindingHash) });
        return { removed: true };
      });
    }
  };
}
module.exports = { createAssetLifecycleIntents };
