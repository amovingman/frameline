'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { createSharedStorageStore } = require('./shared-storage-store');
const { inspectStorageRoot, assertStorageRoot, verifyStorageAsset, noLinks, cancelled } = require('./shared-storage-volume');
const { validateStorageRequest, storageRequestSummary, validateStorageReport, label, id, hash,
  MAX_REQUEST_BYTES, fail } = require('./shared-storage-protocol');

async function readStorageRequest(filename) {
  let handle;
  try {
    await noLinks(filename);
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_REQUEST_BYTES) throw fail('shared-storage-request-invalid');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail('shared-storage-request-invalid'); offset += bytesRead;
    }
    const after = await handle.stat();
    await noLinks(filename); const current = await fs.lstat(filename);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev) throw fail('shared-storage-request-invalid');
    return validateStorageRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw fail('shared-storage-request-invalid'); }
  finally { await handle?.close(); }
}

function createDesktopSharedStorage({ directory, store = createSharedStorageStore({ directory }),
  onChange = () => {}, now = Date.now, verifyAsset = verifyStorageAsset } = {}) {
  let durable = { volumes: [], reports: [], pending: null }, initialized = false, busy = false, closed = false;
  let selectedId = null, request = null, requestSummary = null, report = null, proposal = null, progress = null, error = null, outcome = null;
  let controller = null, running = Promise.resolve();
  const statuses = new Map();
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('shared-storage-invalid'); return value; };
  const volume = () => durable.volumes.find(item => item.id === selectedId);
  function getState() {
    return structuredClone({ available: initialized && !closed, busy, selectedId, error, outcome,
      volumes: durable.volumes.map(({ id, label, version }) => ({ id, label, version, status: statuses.get(id) || 'unchecked' })),
      request: requestSummary, report, proposal, progress,
      interrupted: durable.pending, historicalReport: !busy && !report && selectedId
        ? durable.reports.find(item => item.volumeId === selectedId) || null : null });
  }
  function emit() { try { onChange(getState()); } catch { /* Display observers cannot alter results. */ } }
  function safeError(value) {
    return typeof value?.code === 'string' && /^shared-storage-[a-z-]+$/.test(value.code) ? value.code : 'shared-storage-unavailable';
  }
  function invalidate() { report = null; proposal = null; progress = null; }
  async function reload() { durable = await store.load(); }
  function action(operation) {
    if (closed || busy) return Promise.resolve({ ...getState(), error: closed ? 'shared-storage-closed' : 'shared-storage-busy' });
    busy = true; error = null; outcome = null; emit();
    running = (async () => {
      try { await reload(); initialized = true; await operation(); }
      catch (value) { error = safeError(value); proposal = null; }
      finally { busy = false; controller = null; emit(); }
      return getState();
    })();
    return running;
  }
  function selected(input, withRequest = false) {
    if (!input || !id(input.volumeId) || input.volumeId !== selectedId || !volume()
      || input.volumeVersion !== volume().version || withRequest && (!request || input.requestHash !== fingerprint(request))) throw fail('shared-storage-selection-changed');
    return structuredClone(volume());
  }
  async function check(value) {
    try { await assertStorageRoot(value); statuses.set(value.id, 'online'); }
    catch (error) {
      statuses.set(value.id, error.code === 'shared-storage-offline' ? 'offline'
        : error.code === 'shared-storage-volume-changed' ? 'changed' : 'unreadable');
      throw error;
    }
  }
  async function runVerification(value) {
    const signal = controller.signal, source = structuredClone(request), requestHash = fingerprint(source);
    invalidate();
    const startedAt = clock();
    await store.transact(state => { state.pending = { volumeId: value.id, requestHash, startedAt }; }); await reload();
    progress = { completed: 0, total: source.assets.length, bytesRead: 0 }; emit();
    const items = []; let bytesRead = 0, lastProgressAt = 0;
    try {
      await check(value);
      for (const asset of source.assets) {
        cancelled(signal);
        const item = await verifyAsset(value, asset, { signal, onProgress: size => {
          progress = { completed: items.length, total: source.assets.length, bytesRead: bytesRead + size };
          const at = Date.now(); if (at - lastProgressAt >= 100) { lastProgressAt = at; emit(); }
        } });
        if (item.verified || item.reason === 'hash-mismatch') bytesRead += asset.expected.size;
        items.push(item); progress = { completed: items.length, total: source.assets.length, bytesRead }; emit();
      }
      cancelled(signal); await check(value);
      const body = { schemaVersion: 1, volumeId: value.id, volumeVersion: value.version,
        projectId: source.projectId, sourceHash: source.sourceHash, requestHash, checkedAt: clock(), items };
      const completed = validateStorageReport({ ...body, reportHash: fingerprint(body) });
      await store.transact(state => {
        const current = state.volumes.find(item => item.id === value.id);
        if (fingerprint(current) !== fingerprint(value)) throw fail('shared-storage-selection-changed');
        state.reports = [...state.reports.filter(item => item.volumeId !== value.id), completed]; state.pending = null;
      });
      await reload(); report = completed; outcome = 'verification-complete';
    } catch (error) {
      // Keep the last completed report as historical evidence. A crash before
      // this clear retains pending and requires an explicit fresh check.
      await store.transact(state => {
        if (state.pending?.volumeId === value.id && state.pending.requestHash === requestHash) state.pending = null;
      });
      await reload(); throw error;
    }
  }
  const api = {
    getState,
    initialize: () => action(async () => { await reload(); initialized = true; }),
    register: (root, displayLabel) => action(async () => {
      label(displayLabel); const identity = await inspectStorageRoot(root); invalidate();
      const value = { id: randomUUID(), label: displayLabel, root, identity, version: 1 };
      await store.transact(state => {
        if (state.volumes.some(item => item.root === root || fingerprint(item.identity) === fingerprint(identity))) throw fail('shared-storage-already-registered');
        if (state.volumes.length >= 32) throw fail('shared-storage-capacity');
        state.volumes.push(value);
      });
      await reload(); selectedId = value.id; statuses.set(value.id, 'online'); outcome = 'volume-registered';
    }),
    select: volumeId => action(async () => {
      if (volumeId !== null && (!id(volumeId) || !durable.volumes.some(item => item.id === volumeId))) throw fail('shared-storage-selection-changed');
      selectedId = volumeId; invalidate();
    }),
    rename: input => action(async () => {
      const value = selected(input); label(input.label);
      await store.transact(state => {
        const item = state.volumes.find(item => item.id === value.id);
        if (fingerprint(item) !== fingerprint(value)) throw fail('shared-storage-selection-changed');
        item.label = input.label;
      }); await reload(); outcome = 'volume-renamed';
    }),
    forget: input => action(async () => {
      const value = selected(input);
      await store.transact(state => {
        const current = state.volumes.find(item => item.id === value.id);
        if (fingerprint(current) !== fingerprint(value)) throw fail('shared-storage-selection-changed');
        state.volumes = state.volumes.filter(item => item.id !== value.id);
        state.reports = state.reports.filter(item => item.volumeId !== value.id);
        if (state.pending?.volumeId === value.id) state.pending = null;
      });
      await reload(); statuses.delete(value.id); selectedId = null; invalidate(); outcome = 'volume-forgotten';
    }),
    reconnect: (input, root) => action(async () => {
      const value = selected(input), identity = await inspectStorageRoot(root);
      if (fingerprint(identity) !== fingerprint(value.identity)) throw fail('shared-storage-volume-changed');
      await store.transact(state => {
        const item = state.volumes.find(item => item.id === value.id);
        if (fingerprint(item) !== fingerprint(value)) throw fail('shared-storage-selection-changed');
        if (state.volumes.some(item => item.id !== value.id && item.root === root)) throw fail('shared-storage-already-registered');
        if (item.version === Number.MAX_SAFE_INTEGER) throw fail('shared-storage-capacity');
        item.root = root; item.version++;
      });
      await reload(); invalidate(); statuses.set(value.id, 'online'); outcome = 'volume-reconnected';
    }),
    check: input => action(async () => { const value = selected(input); invalidate(); await check(value); outcome = 'volume-online'; }),
    importRequest: filename => action(async () => {
      // Clear the previous request even when the new selection is malformed.
      request = null; requestSummary = null; invalidate(); request = await readStorageRequest(filename);
      requestSummary = storageRequestSummary(request); outcome = 'request-loaded';
    }),
    verify: input => action(async () => { const value = selected(input, true); controller = new AbortController(); await runVerification(value); }),
    cancel() { if (controller) { controller.abort(); proposal = null; } return getState(); },
    prepareProposal: input => action(async () => {
      const value = selected(input, true);
      if (!report || report.reportHash !== input.reportHash || report.volumeId !== value.id
        || report.volumeVersion !== value.version || report.requestHash !== fingerprint(request)
        || report.items.some(item => !item.verified)) throw fail('shared-storage-report-required');
      const reviewed = report.reportHash;
      controller = new AbortController(); await runVerification(value);
      // Verification may refresh checkedAt; the proposal binds the new report
      // and the report the user reviewed, without claiming an executable edit.
      if (report.items.some(item => !item.verified)) throw fail('shared-storage-report-required');
      const body = { schemaVersion: 1, kind: 'shared-storage-relink-proposal', readOnly: true, executable: false,
        volumeId: value.id, volumeVersion: value.version, projectId: request.projectId, sourceHash: request.sourceHash,
        requestHash: fingerprint(request), reviewedReportHash: reviewed, reportHash: report.reportHash,
        assets: report.items.map(({ id, assetClass, expected }) => ({ id, assetClass, contentId: `sha256:${expected.sha256}`, size: expected.size })) };
      proposal = { ...body, proposalHash: fingerprint(body) }; outcome = 'proposal-ready';
    }),
    // Called after the native save dialog returns. Recheck bytes and exact
    // proposal again; the exported artifact never includes local locations.
    exportProposal: (input, destination) => action(async () => {
      const value = selected(input, true), reviewed = proposal;
      if (!reviewed || !hash(input.proposalHash) || input.proposalHash !== reviewed.proposalHash
        || reviewed.volumeId !== value.id || reviewed.volumeVersion !== value.version
        || reviewed.requestHash !== fingerprint(request)) throw fail('shared-storage-proposal-stale');
      controller = new AbortController();
      for (const asset of request.assets) {
        const result = await verifyAsset(value, asset, { signal: controller.signal });
        if (!result.verified) throw fail('shared-storage-proposal-stale');
      }
      await check(value); cancelled(controller.signal);
      await noLinks(require('node:path').dirname(destination));
      let handle;
      try { handle = await fs.open(destination, 'wx', 0o600); }
      catch (error) { throw fail(error.code === 'EEXIST' ? 'shared-storage-destination-exists' : 'shared-storage-export-failed'); }
      try { await handle.writeFile(`${JSON.stringify(reviewed, null, 2)}\n`); await handle.sync(); }
      catch { await handle.close(); await fs.rm(destination, { force: true }).catch(() => {}); throw fail('shared-storage-export-failed'); }
      await handle.close(); outcome = 'proposal-exported';
    }),
    async dispose() { closed = true; controller?.abort(); await running; await store.dispose(); }
  };
  return api;
}
module.exports = { createDesktopSharedStorage, readStorageRequest };
