'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { acquireMetadataLock } = require('./metadata-lock');
const { fingerprint } = require('./project-api-contracts');
const { validateIdentity, validatePolicy, validateUsage, validateAvailability, validClasses, MAX_ASSET_BYTES } = require('./asset-http-transport');
const defaultEngine = require('./asset-file-transfer');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/, ASSET = /^sha256:[a-f0-9]{64}$/;
const CLASSES = new Set(['original', 'proxy', 'audio', 'graphics', 'other']);
const PHASES = new Set(['hashing', 'uploading', 'verifying', 'downloading', 'writing']);
const STATUSES = new Set(['queued', 'running', 'paused', 'completed', 'cancelled', 'failed']);
const ERRORS = new Set(['asset-transfer-input-invalid', 'asset-transfer-unavailable', 'asset-transfer-busy', 'asset-transfer-capacity-exceeded',
  'asset-transfer-journal-invalid', 'asset-transfer-storage-unavailable', 'asset-transfer-storage-uncertain', 'asset-transfer-interrupted',
  'asset-selection-changed', 'asset-viewer-read-only', 'asset-file-invalid', 'asset-source-changed', 'asset-identity-mismatch',
  'asset-destination-exists', 'asset-checkpoint-invalid', 'asset-cache-corrupt', 'asset-progress-failed', 'asset-rate-invalid',
  'asset-cancelled', 'asset-local-io-failed', 'asset-local-io-uncertain', 'asset-network-unavailable', 'asset-service-failed',
  'asset-request-invalid', 'asset-request-too-large', 'asset-response-invalid', 'asset-response-too-large', 'asset-forbidden',
  'asset-not-found', 'upload-not-found', 'asset-upload-not-found', 'asset-ticket-invalid', 'asset-identity-collision',
  'asset-chunk-conflict', 'upload-incomplete', 'asset-upload-incomplete', 'asset-content-mismatch', 'asset-identity-invalid',
  'asset-chunk-invalid', 'asset-chunk-corrupt', 'asset-state-invalid', 'asset-state-newer-version', 'asset-key-rotation-required',
  'asset-capacity-exceeded', 'asset-storage-unavailable', 'asset-storage-uncertain', 'asset-verification-timeout',
  'service-sign-in-required', 'service-credential-storage-unavailable', 'service-offline', 'forbidden', 'access-token-invalid', 'project-not-found',
  'asset-policy-excluded', 'asset-policy-forbidden', 'asset-policy-invalid', 'asset-policy-version-conflict', 'asset-archived', 'asset-archive-invalid', 'asset-archive-conflict']);
function fail(code) { return Object.assign(new Error(code), { code }); }
function safeAssetTransferError(error) { return ERRORS.has(error?.code) ? error.code : 'asset-local-io-failed'; }
const clone = value => structuredClone(value);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const safeName = value => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
const filename = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const rate = value => value === null || Number.isSafeInteger(value) && value >= 1024 && value <= 1024 ** 3;
const SCOPE_FIELDS = ['originHash', 'accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch'];
function validScope(value) { return exact(value, SCOPE_FIELDS) && SHA.test(value.originHash || '') && SCOPE_FIELDS.slice(1).every(key => typeof value[key] === 'string' && ID.test(value[key])); }
const scopeKey = value => value ? fingerprint(value) : null;

function createDesktopAssetTransfers({ directory, connection, getSelection, onChange = () => {}, engine = defaultEngine } = {}) {
  if (!filename(directory) || !connection || typeof connection.getState !== 'function' || typeof connection.getAssetClient !== 'function'
    || typeof getSelection !== 'function' || typeof onChange !== 'function'
    || !['inspectAssetFile', 'uploadAssetFile', 'downloadAssetFile'].every(key => typeof engine[key] === 'function')) throw fail('asset-transfer-input-invalid');
  const journal = path.join(directory, 'transfers.json'), marker = path.join(directory, 'initialized.json');
  let version = 0, active = null, preparation = null, review = null, error = null, starting = false, closed = false, uncertain = false, journalObserved = false;
  const tasks = new Set(), notifications = new Set(), metadata = new Set();
  let storage = { key: null, status: 'idle', policy: null, usage: null, error: null }, availability = null, storageRequest = 0, availabilityRequest = 0;
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  async function privateDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('asset-transfer-storage-unavailable');
  }
  function validateJournal(value) {
    if (!exact(value, ['schemaVersion', 'jobs']) || value.schemaVersion !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 100) throw fail('asset-transfer-journal-invalid');
    const seen = new Set();
    for (const job of value.jobs) {
      if (!exact(job, ['id', 'scope', 'direction', 'name', 'filename', 'destination', 'identity', 'assetId', 'size', 'maxBytesPerSecond',
        'status', 'stage', 'bytes', 'totalBytes', 'error', 'createdAt', 'updatedAt', 'completedAt']) || !ID.test(job.id || '') || seen.has(job.id)
        || !validScope(job.scope) || !['upload', 'download'].includes(job.direction) || !safeName(job.name)
        || typeof job.assetId !== 'string' || !ASSET.test(job.assetId) || job.size !== null && !integer(job.size, MAX_ASSET_BYTES)
        || !rate(job.maxBytesPerSecond) || !STATUSES.has(job.status) || ![...PHASES, 'queued', 'paused', 'complete', 'cancelled', 'failed'].includes(job.stage)
        || !integer(job.bytes, MAX_ASSET_BYTES) || job.totalBytes !== null && (!integer(job.totalBytes, MAX_ASSET_BYTES) || job.bytes > job.totalBytes)
        || job.error !== null && !ERRORS.has(job.error) || !integer(job.createdAt) || !integer(job.updatedAt)
        || job.completedAt !== null && !integer(job.completedAt)) throw fail('asset-transfer-journal-invalid');
      if (job.direction === 'upload') {
        let identity; try { identity = validateIdentity(job.identity); } catch { throw fail('asset-transfer-journal-invalid'); }
        if (!filename(job.filename) || job.destination !== null || identity.contentId !== job.assetId || identity.size !== job.size) throw fail('asset-transfer-journal-invalid');
      } else if (!filename(job.destination) || job.filename !== null || job.identity !== null) throw fail('asset-transfer-journal-invalid');
      if (job.status === 'completed' && (job.completedAt === null || job.size === null || job.bytes !== job.size || job.totalBytes !== job.size)) throw fail('asset-transfer-journal-invalid');
      seen.add(job.id);
    }
    return value;
  }
  async function readMarker() {
    let handle;
    try {
      handle = await fs.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > 128) throw fail('asset-transfer-journal-invalid');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()));
      if (!exact(value, ['schemaVersion']) || value.schemaVersion !== 1) throw fail('asset-transfer-journal-invalid');
      return true;
    } catch (problem) { if (problem.code === 'ENOENT') return false; throw fail('asset-transfer-journal-invalid'); }
    finally { await handle?.close(); }
  }
  async function read() {
    let handle;
    try {
      const parent = await fs.lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw fail('asset-transfer-journal-invalid');
      handle = await fs.open(journal, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > 4 * 1024 * 1024) throw fail('asset-transfer-journal-invalid');
      const bytes = await handle.readFile(); const after = await handle.stat();
      if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail('asset-transfer-journal-invalid');
      const value = validateJournal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      await readMarker(); journalObserved = true; return value;
    } catch (failure) {
      if (failure.code === 'ENOENT' && !journalObserved) {
        const entries = await fs.readdir(directory).catch(problem => { if (problem.code === 'ENOENT') return []; throw fail('asset-transfer-journal-invalid'); });
        if (entries.every(name => name === 'metadata.lock')) return { schemaVersion: 1, jobs: [] };
      }
      throw fail('asset-transfer-journal-invalid');
    }
    finally { await handle?.close(); }
  }
  async function edit(action) {
    if (uncertain) throw fail('asset-transfer-storage-uncertain');
    let release, temporary, replacing = false;
    try {
      await privateDirectory(); release = await acquireMetadataLock(directory); const value = await read();
      async function publish(target, document) {
        const bytes = Buffer.from(JSON.stringify(document)); if (bytes.length > 4 * 1024 * 1024) throw fail('asset-transfer-capacity-exceeded');
        temporary = path.join(directory, `.transfers-${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        replacing = true; await fs.rename(temporary, target);
        const parent = await fs.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); try { await parent.sync(); } finally { await parent.close(); }
        replacing = false; temporary = null;
      }
      // Publish an empty journal and marker before the first job. Missing state
      // can then never silently reset observed work on this or a later launch.
      if (!journalObserved) { await publish(journal, value); journalObserved = true; }
      if (!await readMarker()) await publish(marker, { schemaVersion: 1 });
      action(value); validateJournal(value); await publish(journal, value);
    } catch (failure) {
      if (replacing) { uncertain = true; throw fail('asset-transfer-storage-uncertain'); }
      throw fail(['asset-transfer-journal-invalid', 'asset-transfer-capacity-exceeded'].includes(failure.code) ? failure.code : 'asset-transfer-storage-unavailable');
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      if (release) try { await release(); } catch { uncertain = true; throw fail('asset-transfer-storage-uncertain'); }
    }
  }
  async function context() {
    let selected, state;
    try { selected = await getSelection(); state = connection.getState(); } catch { throw fail('asset-transfer-unavailable'); }
    if (!selected || !state.origin || !state.account?.id || !['connected', 'offline'].includes(state.status)) return null;
    const scope = Object.fromEntries(SCOPE_FIELDS.map(key => [key, selected[key]]));
    if (!validScope(scope) || scope.originHash !== fingerprint(state.origin) || scope.accountId !== state.account.id) return null;
    const project = state.projects?.find(item => item.id === scope.remoteProjectId && item.branches.includes(scope.remoteBranch));
    const available = state.connected === true && state.status === 'connected' && !!project;
    return { scope, key: scopeKey(scope), available, canUpload: available && ['owner', 'editor'].includes(project.role), canManage: available && project.role === 'owner',
      name: project && safeName(project.name) ? project.name : 'Service project' };
  }
  async function assertCurrent(expected, { upload = false, manage = false, allowOffline = false } = {}) {
    const current = await context();
    if (closed || !current || current.key !== expected.key) throw fail('asset-selection-changed');
    if (!allowOffline && !current.available) throw fail('asset-transfer-unavailable');
    if (upload && !current.canUpload) throw fail('asset-viewer-read-only');
    if (manage && !current.canManage) throw fail('asset-policy-forbidden');
    return current;
  }
  async function getState() {
    let ctx = null, value = { jobs: [] }, failure = null;
    try { ctx = await context(); } catch (problem) { failure = safeAssetTransferError(problem); }
    try { value = await read(); } catch (problem) { failure = safeAssetTransferError(problem); }
    try { const latest = await context(); if (latest?.key !== ctx?.key || latest?.available !== ctx?.available || latest?.canUpload !== ctx?.canUpload || latest?.canManage !== ctx?.canManage) ctx = latest; }
    catch (problem) { ctx = null; failure = safeAssetTransferError(problem); }
    const jobs = ctx ? value.jobs.filter(job => scopeKey(job.scope) === ctx.key).slice().reverse().map(job => {
      const own = active?.id === job.id ? active.latest : null, interrupted = job.status === 'running' && active?.id !== job.id;
      const status = interrupted ? 'paused' : job.status;
      const checkedAvailability = availability?.key === ctx.key && availability.value.assetId === job.assetId ? availability.value : null;
      const blocked = checkedAvailability && (checkedAvailability.excluded || checkedAvailability.archived || job.direction === 'download' && !checkedAvailability.cloudPresent);
      return { id: job.id, direction: job.direction, name: job.name, assetId: job.assetId, size: own?.totalBytes ?? job.size,
        status, stage: own?.phase || (interrupted ? 'paused' : job.stage), bytes: own?.bytes ?? job.bytes, totalBytes: own ? own.totalBytes : job.totalBytes,
        error: interrupted ? 'asset-transfer-interrupted' : job.error, completedAt: job.completedAt,
        canResume: !!(!closed && !uncertain && !blocked && ctx.available && (job.direction !== 'upload' || ctx.canUpload && storage.key === ctx.key && storage.policy?.syncClasses.includes(job.identity.assetClass)) && ['queued', 'paused', 'failed', 'cancelled'].includes(status)),
        canCancel: !closed && ['queued', 'running', 'paused'].includes(status) };
    }) : [];
    const shownReview = ctx && review?.key === ctx.key ? { id: review.id, name: review.name, identity: clone(review.identity),
      estimatedUploadBytes: review.reused === true ? 0 : review.identity.size, reused: review.reused } : null;
    return { version: ++version, available: !!ctx?.available, canUpload: !!ctx?.canUpload,
      scope: ctx ? { remoteProjectId: ctx.scope.remoteProjectId, remoteProjectName: ctx.name } : null,
      busy: starting || !!active || !!preparation, preparing: preparation && ctx?.key === preparation.key ? clone(preparation.progress) : null,
      review: shownReview, jobs, error: error || failure,
      storage: { status: storage.key === ctx?.key ? storage.status : 'idle', policy: storage.key === ctx?.key ? clone(storage.policy) : null,
        usage: storage.key === ctx?.key ? clone(storage.usage) : null, canManage: !!ctx?.canManage, error: storage.key === ctx?.key ? storage.error : null },
      availability: availability && ctx && availability.key === ctx.key ? clone(availability.value) : null };
  }
  function notify() {
    if (closed) return;
    const task = getState().then(state => { if (!closed) onChange(state); }).catch(() => {}).finally(() => notifications.delete(task)); notifications.add(task);
  }
  async function reconcile() {
    const current = await context(), key = current?.key || null;
    if (active && (active.key !== key || !current?.available || active.direction === 'upload' && !current.canUpload)) {
      active.reason = active.key !== key ? 'asset-selection-changed' : 'asset-transfer-unavailable'; active.controller.abort();
    }
    if (preparation?.key && (preparation.key !== key || !current?.canUpload)) preparation.controller.abort();
    if (review && (review.key !== key || !current?.canUpload)) review = null;
    for (const request of metadata) if (request.key !== key || !current?.available || request.manage && !current.canManage) {
      request.controller.abort();
      if (request.key === key && request.kind === 'storage' && request.serial === storageRequest && storage.status === 'loading') {
        storageRequest++; storage.status = 'error'; storage.error = !current?.available ? 'asset-transfer-unavailable' : 'asset-policy-forbidden';
      }
    }
    if (storage.key !== key) { storageRequest++; availabilityRequest++; storage = { key, status: 'idle', policy: null, usage: null, error: null }; availability = null; }
    notify();
  }
  function lifecycle() { return closed ? Promise.resolve() : track(reconcile().catch(problem => { error = safeAssetTransferError(problem); notify(); })); }
  function acceptPolicy(ctx, value) {
    const policy = validatePolicy(value); if (policy.projectId !== ctx.scope.remoteProjectId) throw fail('asset-response-invalid');
    if (storage.key !== ctx.key) storage = { key: ctx.key, status: 'idle', policy: null, usage: null, error: null };
    if (storage.policy && (policy.version < storage.policy.version || policy.version === storage.policy.version
      && JSON.stringify(policy.syncClasses) !== JSON.stringify(storage.policy.syncClasses))) throw fail('asset-response-invalid');
    if (storage.policy && policy.version !== storage.policy.version) storage.usage = null;
    storage.policy = policy; storage.error = null;
    if (review?.key === ctx.key && !policy.syncClasses.includes(review.identity.assetClass)) { review = null; error = 'asset-policy-excluded'; }
    if (preparation?.key === ctx.key && !policy.syncClasses.includes(preparation.assetClass)) { error = 'asset-policy-excluded'; preparation.controller.abort(); }
    if (active?.key === ctx.key && active.assetClass && !policy.syncClasses.includes(active.assetClass)) {
      active.reason = 'asset-policy-excluded'; active.controller.abort();
    }
    return policy;
  }
  async function freshPolicy(ctx, signal) {
    const policy = validatePolicy(await connection.getAssetClient().getPolicy(ctx.scope.remoteProjectId, { signal }));
    await assertCurrent(ctx); if (signal?.aborted) throw fail('asset-cancelled');
    const accepted = acceptPolicy(ctx, policy); if (storage.status !== 'loading') storage.status = 'ready'; return accepted;
  }
  async function requireClass(ctx, assetClass, signal) {
    const policy = await freshPolicy(ctx, signal);
    if (!policy.syncClasses.includes(assetClass)) throw fail('asset-policy-excluded');
    return policy;
  }
  async function inspectAvailability(ctx, assetId, signal) {
    const value = validateAvailability(await connection.getAssetClient().getAvailability(ctx.scope.remoteProjectId, assetId, { signal }));
    await assertCurrent(ctx); if (signal?.aborted) throw fail('asset-cancelled');
    if (value.projectId !== ctx.scope.remoteProjectId || value.assetId !== assetId) throw fail('asset-response-invalid');
    return value;
  }
  async function uploadGate(ctx, identity, suppliedSignal = null) {
    const request = suppliedSignal ? null : { key: ctx.key, manage: false, controller: new AbortController() };
    if (request) metadata.add(request);
    const signal = suppliedSignal || request.controller.signal;
    try {
      await requireClass(ctx, identity.assetClass, signal);
      const value = await inspectAvailability(ctx, identity.contentId, signal);
      if (value.excluded) throw fail('asset-policy-excluded'); if (value.archived) throw fail('asset-archived');
      return value;
    } finally { if (request) metadata.delete(request); }
  }
  async function downloadGate(ctx, assetId, suppliedSignal = null) {
    const request = suppliedSignal ? null : { key: ctx.key, manage: false, controller: new AbortController() };
    if (request) metadata.add(request);
    try {
      const value = await inspectAvailability(ctx, assetId, suppliedSignal || request.controller.signal);
      if (!value.cloudPresent) throw fail('asset-not-found'); if (value.excluded) throw fail('asset-policy-excluded'); if (value.archived) throw fail('asset-archived');
      return value;
    } finally { if (request) metadata.delete(request); }
  }
  function publicAvailability(value) {
    return { assetId: value.assetId, state: !value.cloudPresent ? 'not-on-service' : value.excluded ? 'excluded' : value.archived ? 'archived' : 'cloud-present',
      cloudPresent: value.cloudPresent, excluded: value.excluded, archived: value.archived, assetClass: value.assetClass, size: value.size };
  }
  function metadataAction(action, { manage = false, kind = 'storage' } = {}) { return control(async () => {
    const ctx = await context(); if (!ctx?.available) throw fail('asset-transfer-unavailable'); if (manage && !ctx.canManage) throw fail('asset-policy-forbidden');
    const request = { key: ctx.key, manage, kind, controller: new AbortController() }; metadata.add(request);
    const serial = kind === 'storage' ? ++storageRequest : ++availabilityRequest;
    request.serial = serial;
    if (kind === 'storage') { if (storage.key !== ctx.key) storage = { key: ctx.key, status: 'idle', policy: null, usage: null, error: null }; storage.status = 'loading'; storage.error = null; }
    notify();
    try { await action(ctx, connection.getAssetClient(), request.controller.signal, serial, request); }
    catch (problem) {
      const current = await context().catch(() => null);
      if (!closed && current?.key === ctx.key && !request.controller.signal.aborted) {
        const code = safeAssetTransferError(problem);
        if (kind === 'storage' && request.serial === storageRequest) { storage.status = 'error'; storage.error = code; }
        else if (kind === 'availability' && request.serial === availabilityRequest) { availability = null; error = code; }
      }
    } finally { metadata.delete(request); notify(); }
    return getState();
  }); }
  async function storageSnapshot(ctx, client, signal, initialPolicy = null) {
    let before = initialPolicy || validatePolicy(await client.getPolicy(ctx.scope.remoteProjectId, { signal }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const usage = validateUsage(await client.getUsage(ctx.scope.remoteProjectId, { signal }));
      const after = validatePolicy(await client.getPolicy(ctx.scope.remoteProjectId, { signal }));
      if ([before.projectId, usage.projectId, after.projectId].some(id => id !== ctx.scope.remoteProjectId)) throw fail('asset-response-invalid');
      if (before.version === after.version && JSON.stringify(before.syncClasses) === JSON.stringify(after.syncClasses)) return { policy: after, usage };
      before = after;
    }
    throw fail('asset-policy-version-conflict');
  }
  function refreshStorage() { return metadataAction(async (ctx, client, signal, serial) => {
    const { policy, usage } = await storageSnapshot(ctx, client, signal); await assertCurrent(ctx);
    if (serial === storageRequest && !signal.aborted) { const accepted = acceptPolicy(ctx, policy); storage.usage = accepted.version === policy.version ? usage : null; storage.status = 'ready'; }
  }); }
  function savePolicy(input) { return metadataAction(async (ctx, client, signal, serial, request) => {
    if (!exact(input, ['expectedVersion', 'syncClasses']) || !integer(input.expectedVersion) || !validClasses(input.syncClasses)) throw fail('asset-policy-invalid');
    availabilityRequest++; availability = null;
    const policy = validatePolicy(await client.setPolicy(ctx.scope.remoteProjectId, clone(input), { signal })); await assertCurrent(ctx, { manage: true });
    if (policy.projectId !== ctx.scope.remoteProjectId || policy.version !== input.expectedVersion + 1
      || JSON.stringify(policy.syncClasses) !== JSON.stringify([...input.syncClasses].sort())) throw fail('asset-response-invalid');
    availabilityRequest++; availability = null;
    if (signal.aborted) throw fail('asset-cancelled');
    serial = ++storageRequest; request.serial = serial;
    if (storage.key !== ctx.key || !storage.policy || policy.version >= storage.policy.version) acceptPolicy(ctx, policy);
    storage.usage = null; storage.status = 'loading'; storage.error = null;
    const snapshot = await storageSnapshot(ctx, client, signal, policy); await assertCurrent(ctx, { manage: true });
    if (serial === storageRequest && !signal.aborted) { acceptPolicy(ctx, snapshot.policy); storage.usage = snapshot.usage; storage.status = 'ready'; }
  }, { manage: true }); }
  function checkAvailability(assetId) { return metadataAction(async (ctx, client, signal, serial) => {
    if (typeof assetId !== 'string' || !ASSET.test(assetId)) throw fail('asset-transfer-input-invalid');
    const value = validateAvailability(await client.getAvailability(ctx.scope.remoteProjectId, assetId, { signal })); await assertCurrent(ctx);
    if (value.projectId !== ctx.scope.remoteProjectId || value.assetId !== assetId) throw fail('asset-response-invalid');
    if (serial === availabilityRequest && !signal.aborted) { availability = { key: ctx.key, value: publicAvailability(value) }; error = null; }
  }, { kind: 'availability' }); }
  function setArchived(input) { return metadataAction(async (ctx, client, signal, serial, request) => {
    if (!exact(input, ['assetId', 'expectedArchived', 'archived']) || !ASSET.test(input.assetId || '') || typeof input.expectedArchived !== 'boolean' || typeof input.archived !== 'boolean') throw fail('asset-archive-invalid');
    availabilityRequest++; availability = null;
    const value = validateAvailability(await client.setArchived(ctx.scope.remoteProjectId, input.assetId,
      { expectedArchived: input.expectedArchived, archived: input.archived }, { signal })); await assertCurrent(ctx, { manage: true });
    if (value.projectId !== ctx.scope.remoteProjectId || value.assetId !== input.assetId || !value.cloudPresent || value.archived !== input.archived) throw fail('asset-response-invalid');
    availabilityRequest++;
    if (signal.aborted) throw fail('asset-cancelled');
    serial = ++storageRequest; request.serial = serial;
    availability = { key: ctx.key, value: publicAvailability(value) }; storage.usage = null; storage.status = 'loading'; storage.error = null;
    if (value.archived && review?.key === ctx.key && review.identity.contentId === value.assetId) { review = null; error = 'asset-archived'; }
    if (value.archived && preparation?.key === ctx.key && preparation.assetId === value.assetId) { error = 'asset-archived'; preparation.controller.abort(); }
    if (value.archived && active?.key === ctx.key && active.assetId === value.assetId) { active.reason = 'asset-archived'; active.controller.abort(); }
    const snapshot = await storageSnapshot(ctx, client, signal); await assertCurrent(ctx, { manage: true });
    if (serial === storageRequest && !signal.aborted) { acceptPolicy(ctx, snapshot.policy); storage.usage = snapshot.usage; storage.status = 'ready'; }
  }, { manage: true }); }
  async function update(id, patch) { await edit(value => { const job = value.jobs.find(item => item.id === id); if (!job) throw fail('asset-transfer-journal-invalid'); Object.assign(job, patch, { updatedAt: Date.now() }); }); }
  function validateProgress(progress) {
    if (!exact(progress, ['phase', 'bytes', 'totalBytes']) || !PHASES.has(progress.phase)
      || !(progress.totalBytes === null && progress.phase === 'verifying' && progress.bytes === 0)
        && (!integer(progress.totalBytes, MAX_ASSET_BYTES) || !integer(progress.bytes, progress.totalBytes))) throw fail('asset-progress-failed');
  }
  async function execute(job, ctx, run) {
    let lastWrite = 0, lastPhase = null, lastNotify = 0;
    try {
      await assertCurrent(ctx, { upload: job.direction === 'upload' });
      if (job.direction === 'upload') await uploadGate(ctx, job.identity, run.controller.signal);
      else run.assetClass = (await downloadGate(ctx, job.assetId, run.controller.signal)).assetClass;
      await update(job.id, { status: 'running', stage: 'queued', error: null });
      const client = connection.getAssetClient();
      if (job.direction === 'download') {
        const work = path.join(directory, 'work'); await fs.mkdir(work, { mode: 0o700 }).catch(problem => { if (problem.code !== 'EEXIST') throw problem; });
        const stat = await fs.lstat(work); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('asset-transfer-storage-unavailable');
      }
      const onProgress = async progress => {
        validateProgress(progress); await assertCurrent(ctx, { upload: job.direction === 'upload' });
        if (run.controller.signal.aborted) throw fail('asset-cancelled');
        if (job.direction === 'upload' && progress.totalBytes !== null && progress.totalBytes !== job.size) throw fail('asset-progress-failed');
        run.latest = clone(progress); const now = Date.now(), changed = progress.phase !== lastPhase;
        if (changed || now - lastWrite >= 250) {
          await update(job.id, { stage: progress.phase, bytes: progress.bytes, totalBytes: progress.totalBytes,
            ...(job.direction === 'download' && progress.totalBytes !== null ? { size: progress.totalBytes } : {}) }); lastWrite = now; lastPhase = progress.phase;
        }
        if (changed || now - lastNotify >= 100) { notify(); lastNotify = now; }
      };
      const receipt = job.direction === 'upload'
        ? await engine.uploadAssetFile({ client, projectId: job.scope.remoteProjectId, filename: job.filename, identity: clone(job.identity),
          signal: run.controller.signal, onProgress, maxBytesPerSecond: job.maxBytesPerSecond })
        : await engine.downloadAssetFile({ client, projectId: job.scope.remoteProjectId, assetId: job.assetId, destination: job.destination,
          workDirectory: path.join(directory, 'work', job.id), signal: run.controller.signal, onProgress, maxBytesPerSecond: job.maxBytesPerSecond });
      await assertCurrent(ctx, { upload: job.direction === 'upload' });
      if (run.controller.signal.aborted) throw fail('asset-cancelled');
      if (!receipt || receipt.assetId !== job.assetId || !integer(receipt.size, MAX_ASSET_BYTES) || receipt.verified !== true
        || job.direction === 'upload' && receipt.size !== job.size) throw fail('asset-response-invalid');
      await update(job.id, { status: 'completed', stage: 'complete', size: receipt.size, bytes: receipt.size, totalBytes: receipt.size, error: null, completedAt: Date.now() });
    } catch (problem) {
      const code = run.controller.signal.aborted ? run.reason || 'asset-cancelled' : safeAssetTransferError(problem);
      const status = run.cancelled ? 'cancelled' : run.controller.signal.aborted || ['asset-network-unavailable', 'service-offline'].includes(code) ? 'paused' : 'failed';
      try { await update(job.id, { status, stage: status, error: code }); } catch (storage) { error = safeAssetTransferError(storage); }
    } finally { if (active === run) active = null; notify(); }
  }
  function launch(job, ctx) {
    if (closed) throw fail('asset-transfer-unavailable');
    const run = { id: job.id, key: ctx.key, direction: job.direction, assetId: job.assetId, assetClass: job.identity?.assetClass || null,
      controller: new AbortController(), latest: null, reason: null, cancelled: false, promise: null };
    active = run; run.promise = track(execute(job, ctx, run)); notify();
  }
  function control(action) {
    if (closed) return Promise.resolve().then(getState);
    return track(Promise.resolve().then(action).catch(problem => { error = safeAssetTransferError(problem); return getState(); }));
  }
  function prepareUpload({ filename: source, name, assetClass, maxBytesPerSecond = null } = {}) { return control(async () => {
    if (active || preparation || starting) throw fail('asset-transfer-busy');
    if (!filename(source) || !safeName(name) || !CLASSES.has(assetClass) || !rate(maxBytesPerSecond)) throw fail('asset-transfer-input-invalid');
    review = null; error = null;
    const run = { key: null, assetClass, assetId: null, controller: new AbortController(), progress: { phase: 'hashing', bytes: 0, totalBytes: null }, promise: null }; preparation = run; notify();
    run.promise = (async () => { try {
      const ctx = await context(); if (run.controller.signal.aborted || closed) throw fail('asset-cancelled');
      if (!ctx?.available) throw fail('asset-transfer-unavailable'); if (!ctx.canUpload) throw fail('asset-viewer-read-only');
      run.key = ctx.key; notify();
      await requireClass(ctx, assetClass, run.controller.signal);
      const inspected = await engine.inspectAssetFile(source, { assetClass, signal: run.controller.signal, onProgress: async progress => {
        validateProgress(progress); await assertCurrent(ctx, { upload: true }); if (run.controller.signal.aborted) throw fail('asset-cancelled');
        run.progress = clone(progress); notify();
      } });
      const identity = validateIdentity(inspected.identity); await assertCurrent(ctx, { upload: true });
      if (run.controller.signal.aborted) throw fail('asset-cancelled');
      run.assetId = identity.contentId; await requireClass(ctx, assetClass, run.controller.signal);
      const currentAvailability = await inspectAvailability(ctx, identity.contentId, run.controller.signal);
      if (currentAvailability.excluded) throw fail('asset-policy-excluded'); if (currentAvailability.archived) throw fail('asset-archived');
      let reused = currentAvailability.cloudPresent;
      if (reused) { const found = await connection.getAssetClient().getAsset(ctx.scope.remoteProjectId, identity.contentId, { signal: run.controller.signal });
        if (!found || fingerprint(found.identity) !== fingerprint(identity)) throw fail('asset-identity-collision'); reused = true;
      }
      await assertCurrent(ctx, { upload: true }); if (run.controller.signal.aborted) throw fail('asset-cancelled');
      review = { id: randomUUID(), key: ctx.key, scope: ctx.scope, name, filename: source, identity, maxBytesPerSecond, reused };
    } catch (problem) { if (!run.controller.signal.aborted) error = safeAssetTransferError(problem); }
    finally { if (preparation === run) preparation = null; notify(); } })();
    await run.promise;
    return getState();
  }); }
  function addJob(direction, fields, ctx) {
    const now = Date.now(); return { id: randomUUID(), scope: clone(ctx.scope), direction, name: fields.name,
      filename: direction === 'upload' ? fields.filename : null, destination: direction === 'download' ? fields.destination : null,
      identity: direction === 'upload' ? clone(fields.identity) : null, assetId: fields.assetId, size: fields.size,
      maxBytesPerSecond: fields.maxBytesPerSecond, status: 'queued', stage: 'queued', bytes: 0, totalBytes: fields.size,
      error: null, createdAt: now, updatedAt: now, completedAt: null };
  }
  async function persistAndLaunch(job, ctx) {
    await edit(value => { if (value.jobs.length >= 100) throw fail('asset-transfer-capacity-exceeded'); value.jobs.push(job); });
    await assertCurrent(ctx, { upload: job.direction === 'upload' }); launch(job, ctx);
  }
  function confirmUpload(id) { return control(async () => {
    if (active || preparation || starting) throw fail('asset-transfer-busy');
    const selected = review; if (!selected || selected.id !== id) throw fail('asset-transfer-unavailable');
    starting = true;
    try {
      const ctx = await context(); if (!ctx || ctx.key !== selected.key) throw fail('asset-selection-changed');
      await assertCurrent(ctx, { upload: true }); await uploadGate(ctx, selected.identity); review = null; error = null;
      await persistAndLaunch(addJob('upload', { ...selected, assetId: selected.identity.contentId, size: selected.identity.size }, ctx), ctx);
    }
    finally { starting = false; }
    return getState();
  }); }
  function startDownload({ assetId, destination, name, maxBytesPerSecond = null } = {}) { return control(async () => {
    if (active || preparation || starting) throw fail('asset-transfer-busy');
    if (typeof assetId !== 'string' || !ASSET.test(assetId) || !filename(destination) || !safeName(name) || !rate(maxBytesPerSecond)) throw fail('asset-transfer-input-invalid');
    starting = true; error = null;
    try { const ctx = await context(); if (!ctx?.available) throw fail('asset-transfer-unavailable');
      await downloadGate(ctx, assetId);
      await persistAndLaunch(addJob('download', { assetId, destination, name, maxBytesPerSecond, size: null }, ctx), ctx); }
    finally { starting = false; }
    return getState();
  }); }
  function resume(id) { return control(async () => {
    if (active || preparation || starting) throw fail('asset-transfer-busy');
    starting = true; error = null;
    try {
      const ctx = await context(); if (!ctx?.available) throw fail('asset-transfer-unavailable');
      const job = (await read()).jobs.find(item => item.id === id && scopeKey(item.scope) === ctx.key);
      if (!job || job.status === 'completed') throw fail('asset-transfer-unavailable'); await assertCurrent(ctx, { upload: job.direction === 'upload' });
      if (job.direction === 'upload') await uploadGate(ctx, job.identity);
      else await downloadGate(ctx, job.assetId);
      await update(id, { status: 'queued', stage: 'queued', error: null }); await assertCurrent(ctx, { upload: job.direction === 'upload' }); launch(job, ctx);
    }
    finally { starting = false; }
    return getState();
  }); }
  function cancel(id) { return control(async () => {
    const ctx = await context(), job = (await read()).jobs.find(item => item.id === id && scopeKey(item.scope) === ctx?.key);
    if (!job || job.status === 'completed') throw fail('asset-transfer-unavailable');
    if (active?.id === id) { const run = active; run.cancelled = true; run.reason = 'asset-cancelled'; run.controller.abort(); await run.promise; }
    else await update(id, { status: 'cancelled', stage: 'cancelled', error: 'asset-cancelled' });
    error = null; notify(); return getState();
  }); }
  function clearReview() { return control(async () => { review = null; const run = preparation; if (run) run.controller.abort();
    if (run?.promise) await run.promise; notify(); return getState(); }); }
  async function dispose() { closed = true; preparation?.controller.abort(); if (active) { active.reason = 'asset-transfer-interrupted'; active.controller.abort(); }
    for (const request of metadata) request.controller.abort();
    while (tasks.size || notifications.size) { await Promise.allSettled([...tasks, ...notifications]); } }
  return { getState, prepareUpload, confirmUpload, startDownload, resume, cancel, clearReview, refreshStorage, savePolicy, checkAvailability, setArchived,
    selectionChanged: lifecycle, connectionChanged: lifecycle, dispose };
}
module.exports = { createDesktopAssetTransfers, safeAssetTransferError };
