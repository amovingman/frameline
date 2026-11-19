'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { noLinks } = require('./shared-storage-volume');
const { fingerprint } = require('./project-api-contracts');
const { exact, id, hash, label, validateStorageReport, fail } = require('./shared-storage-protocol');
const MAX_BYTES = 8 * 1024 * 1024;
function validateStorageState(value) {
  const bad = () => { throw fail('shared-storage-state-invalid'); };
  if (!exact(value, ['schemaVersion', 'generation', 'volumes', 'reports', 'pending']) || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !Array.isArray(value.volumes) || value.volumes.length > 32 || !Array.isArray(value.reports) || value.reports.length > 32) bad();
  const ids = new Set(), roots = new Set();
  for (const volume of value.volumes) {
    if (!exact(volume, ['id', 'label', 'root', 'identity', 'version']) || !id(volume.id) || ids.has(volume.id)
      || typeof volume.root !== 'string' || !path.isAbsolute(volume.root) || path.resolve(volume.root) !== volume.root
      || roots.has(volume.root) || !exact(volume.identity, ['dev', 'ino'])
      || ![volume.identity.dev, volume.identity.ino].every(v => typeof v === 'string' && /^\d{1,30}$/.test(v))
      || !Number.isSafeInteger(volume.version) || volume.version < 1) bad();
    try { label(volume.label); } catch { bad(); }
    ids.add(volume.id); roots.add(volume.root);
  }
  const reports = new Set();
  for (const report of value.reports) {
    validateStorageReport(report);
    const volume = value.volumes.find(item => item.id === report.volumeId);
    if (!volume || report.volumeVersion > volume.version || reports.has(report.volumeId)) bad();
    reports.add(report.volumeId);
  }
  if (value.pending !== null && (!exact(value.pending, ['volumeId', 'requestHash', 'startedAt'])
    || !ids.has(value.pending.volumeId) || !hash(value.pending.requestHash)
    || !Number.isSafeInteger(value.pending.startedAt) || value.pending.startedAt < 0)) bad();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) bad();
  return structuredClone(value);
}
function createSharedStorageStore({ directory, storage = fs } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) throw fail('shared-storage-invalid');
  const filename = path.join(directory, 'storage.json'), marker = path.join(directory, 'initialized.json');
  let pending = Promise.resolve(), uncertain = false, observed = false;
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  async function syncDirectory() { const h = await storage.open(directory, flags); try { await h.sync(); } finally { await h.close(); } }
  async function bounded(target, max) {
    const h = await storage.open(target, flags);
    try {
      const stat = await h.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > max) throw fail('shared-storage-state-invalid');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await h.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw fail('shared-storage-state-invalid'); offset += bytesRead;
      }
      const after = await h.stat(), current = await storage.lstat(target);
      if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) throw fail('shared-storage-state-invalid');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { await h.close(); }
  }
  async function publish(target, value) {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`); let replacing = false;
    try {
      const h = await storage.open(temporary, 'wx', 0o600);
      try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); }
      replacing = true; await storage.rename(temporary, target); await syncDirectory();
    } catch {
      if (replacing) { uncertain = true; throw fail('shared-storage-storage-uncertain'); }
      throw fail('shared-storage-storage-unavailable');
    } finally { await storage.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function read() {
    try {
      const value = await bounded(filename, MAX_BYTES);
      if (value?.schemaVersion > 1) throw fail('shared-storage-newer-version');
      const checked = validateStorageState(value);
      const initialized = await bounded(marker, 128);
      if (!exact(initialized, ['schemaVersion']) || initialized.schemaVersion !== 1) throw fail('shared-storage-state-invalid');
      observed = true; return checked;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const names = await storage.readdir(directory);
      if (observed || names.some(name => name !== 'metadata.lock')) throw fail('shared-storage-state-invalid');
      const fresh = { schemaVersion: 1, generation: 0, volumes: [], reports: [], pending: null };
      // Marker first: an interrupted first initialization fails closed.
      await publish(marker, { schemaVersion: 1 }); await publish(filename, fresh); observed = true; return fresh;
    }
  }
  function transact(action = value => value) {
    const next = pending.then(async () => {
      if (uncertain) throw fail('shared-storage-storage-uncertain');
      let release;
      try {
        await storage.mkdir(directory, { recursive: true, mode: 0o700 }); await noLinks(directory);
        if (((await storage.lstat(directory)).mode & 0o777) !== 0o700) throw fail('shared-storage-state-invalid');
        release = await acquireMetadataLock(directory); await noLinks(directory);
        const state = await read(), before = fingerprint(state);
        const result = await action(state);
        validateStorageState(state);
        if (before !== fingerprint(state)) {
          if (state.generation === Number.MAX_SAFE_INTEGER) throw fail('shared-storage-state-invalid');
          state.generation++; await publish(filename, state);
        }
        return structuredClone(result);
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('shared-storage-')) throw fail(error.code);
        throw fail('shared-storage-storage-unavailable');
      } finally { await release?.(); }
    });
    pending = next.catch(() => {}); return next;
  }
  return { transact, load: () => transact(), dispose: () => pending };
}
module.exports = { createSharedStorageStore, validateStorageState };
