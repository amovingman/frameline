// Local optional media work. This module never writes an editor export, project,
// revision, sync base, canonical asset reference, or network request.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID, createHash } = require('node:crypto');
const { acquireMetadataLock } = require('./metadata-lock');
const { createMediaArtifactStore, privateDirectory } = require('./media-artifact-store');
const { regularIdentity, sameIdentity, readVerifiedExport, loadTimelinePreview } = require('./media-render-input');

const KINDS = new Set(['hash', 'asset-check', 'thumbnail', 'proxy', 'timeline-preview']);
const RENDER = new Set(['thumbnail', 'proxy', 'timeline-preview']);
const STATUSES = new Set(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']);
const fail = code => Object.assign(new Error(code), { code });
const defaultPolicy = () => ({ enabled: false, rightsConfirmed: false, costPerGiBMonthUSD: null, epoch: 0 });
const selectionKey = value => value ? JSON.stringify([value.projectId, value.sourceHash, value.exportPath]) : null;
const sourceName = filename => path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const identityValid = value => exactKeys(value, ['size', 'dev', 'ino', 'mtimeMs', 'ctimeMs', 'birthtimeMs'])
  && ['size', 'dev', 'ino', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(key => Number.isFinite(value[key]) && value[key] >= 0)
  && Number.isSafeInteger(value.size);
function selectionValid(key, projectId) {
  try { const value = JSON.parse(key); return Array.isArray(value) && value.length === 3 && value[0] === projectId
    && HASH.test(value[1]) && typeof value[2] === 'string' && path.isAbsolute(value[2]); } catch { return false; }
}
const optionsValid = value => exactKeys(value, ['frame', 'width', 'height', 'rightsConfirmed'])
  && ['frame', 'width', 'height'].every(key => value[key] === undefined || (Number.isSafeInteger(value[key]) && value[key] >= (key === 'frame' ? 0 : 1) && value[key] <= 4096))
  && (value.rightsConfirmed === undefined || typeof value.rightsConfirmed === 'boolean');
const sourceValid = (value, projectId) => exactKeys(value, ['id', 'path', 'name', 'identity', 'sha256', 'selectionKey']) && UUID.test(value.id)
  && typeof value.path === 'string' && path.isAbsolute(value.path) && identityValid(value.identity) && HASH.test(value.sha256) && selectionValid(value.selectionKey, projectId);
function artifactValid(value, projectId) {
  return exactKeys(value, ['id', 'filename', 'projectBucket', 'mimeType', 'width', 'height', 'byteLength', 'sha256', 'canonical', 'durationSeconds'])
    && UUID.test(value.id) && value.projectBucket === createHash('sha256').update(projectId).digest('hex')
    && ['image/png', 'video/mp4'].includes(value.mimeType) && value.filename === `${value.id}.${value.mimeType === 'image/png' ? 'png' : 'mp4'}`
    && ['width', 'height'].every(key => Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 4096)
    && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 50 * 1024 * 1024 && HASH.test(value.sha256)
    && value.canonical === false && (value.durationSeconds === undefined || (Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0));
}
function resultValid(job) {
  const value = job.result;
  if (value === null) return job.status !== 'completed';
  if (job.status !== 'completed' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (job.kind === 'hash') return exactKeys(value, ['sha256', 'byteLength', 'verified']) && HASH.test(value.sha256)
    && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && value.verified === true;
  if (job.kind === 'asset-check') return exactKeys(value, ['available', 'verified', 'byteLength', 'inspection', 'kind', 'width', 'height', 'durationSeconds', 'frameRate'])
    && value.available === true && value.verified === true && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0
    && ['unavailable', 'unsupported', 'decoded'].includes(value.inspection)
    && (value.kind === undefined || ['image', 'video'].includes(value.kind))
    && ['width', 'height'].every(key => value[key] === undefined || (Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 32768))
    && ['durationSeconds', 'frameRate'].every(key => value[key] === undefined || value[key] === null || (Number.isFinite(value[key]) && value[key] >= 0));
  return artifactValid(job.artifact, job.projectId) && exactKeys(value, ['artifactId', 'mimeType', 'width', 'height', 'byteLength', 'sha256', 'canonical', 'durationSeconds', 'clipCount', 'previewType'])
    && value.artifactId === job.artifact.id && ['mimeType', 'width', 'height', 'byteLength', 'sha256', 'canonical', 'durationSeconds'].every(key => value[key] === job.artifact[key])
    && (job.kind !== 'timeline-preview' || (value.previewType === 'storyboard' && Number.isInteger(value.clipCount) && value.clipCount > 0 && value.clipCount <= 24));
}
function journalValid(value) {
  if (!exactKeys(value, ['version', 'projects', 'jobs']) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 1000 || !Array.isArray(value.jobs) || value.jobs.length > 1000) return false;
  const projects = new Set(); const ids = new Set(); const keys = new Set();
  for (const item of value.projects) {
    if (!exactKeys(item, ['id', 'policy', 'source']) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/.test(item.id) || projects.has(item.id)
      || !exactKeys(item.policy, ['enabled', 'rightsConfirmed', 'costPerGiBMonthUSD', 'epoch']) || typeof item.policy.enabled !== 'boolean' || typeof item.policy.rightsConfirmed !== 'boolean'
      || !Number.isSafeInteger(item.policy.epoch) || item.policy.epoch < 0 || !(item.policy.costPerGiBMonthUSD === null || (Number.isFinite(item.policy.costPerGiBMonthUSD) && item.policy.costPerGiBMonthUSD >= 0 && item.policy.costPerGiBMonthUSD <= 100000))
      || (item.source !== null && !sourceValid(item.source, item.id))) return false;
    projects.add(item.id);
  }
  for (const job of value.jobs) {
    if (!exactKeys(job, ['id', 'key', 'kind', 'projectId', 'selectionKey', 'exportPath', 'sourceHash', 'source', 'policyEpoch', 'options', 'status', 'progress', 'attempts', 'processingMs', 'createdAt', 'error', 'result', 'artifact', 'runToken', 'timelineSources'])
      || !UUID.test(job.id) || ids.has(job.id) || !HASH.test(job.key) || keys.has(job.key) || !projects.has(job.projectId) || !KINDS.has(job.kind) || !STATUSES.has(job.status)
      || !selectionValid(job.selectionKey, job.projectId) || JSON.stringify([job.projectId, job.sourceHash, job.exportPath]) !== job.selectionKey
      || (job.kind === 'timeline-preview' ? job.source !== null : !sourceValid(job.source, job.projectId))
      || !Number.isSafeInteger(job.policyEpoch) || job.policyEpoch < 0 || !optionsValid(job.options)
      || !Number.isInteger(job.progress) || job.progress < 0 || job.progress > 100 || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 3
      || !Number.isFinite(job.processingMs) || job.processingMs < 0 || typeof job.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(job.createdAt) || !Number.isFinite(Date.parse(job.createdAt))
      || !(job.runToken === null || UUID.test(job.runToken)) || !(job.error === null || job.error === 'media-job-cancelled' || job.error === errorCode({ code: job.error }))
      || (job.artifact !== null && !artifactValid(job.artifact, job.projectId)) || !resultValid(job)
      || (job.timelineSources !== undefined && (!Array.isArray(job.timelineSources) || job.timelineSources.length > 24 || job.timelineSources.some(source => !exactKeys(source, ['path', 'identity', 'sha256']) || typeof source.path !== 'string' || !path.isAbsolute(source.path) || !identityValid(source.identity) || !HASH.test(source.sha256))))) return false;
    ids.add(job.id); keys.add(job.key);
  }
  return true;
}
const errorCode = error => {
  const allowed = new Set(['source-changed', 'selection-changed', 'policy-disabled', 'preview-rights-required',
    'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'symlink-unsupported', 'not-regular-file', 'file-changed',
    'native-renderer-unavailable', 'media-renderer-unavailable', 'unsupported-media', 'render-failed', 'render-timeout',
    'native-media-provider-unavailable', 'native-media-output-invalid', 'native-media-input-invalid', 'native-media-limit-exceeded',
    'native-media-timeout', 'native-media-unavailable', 'native-media-source-changed', 'native-media-output-exists',
    'render-output-changed', 'invalid-render-output', 'unsupported-preview-timing', 'unsupported-preview-structure',
    'ambiguous-preview-sequence', 'ambiguous-preview-resource', 'nonlocal-preview-source', 'invalid-preview-source',
    'unsupported-preview-version', 'missing-preview-format', 'unsupported-preview-lane', 'unsupported-preview-disabled-clip',
    'missing-preview-picture', 'missing-preview-original', 'ambiguous-preview-source', 'preview-source-out-of-range', 'ambiguous-preview-overlap',
    'no-preview-picture', 'preview-clip-limit', 'export-too-large', 'unsafe-preview-xml', 'malformed-preview-xml',
    'unsupported-frame-rate', 'proxy-duration-limit', 'media-duration-limit', 'worker-failed']);
  return allowed.has(error?.code) ? error.code : 'media-job-failed';
};
function fingerprint(filename, { signal, progress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('media-job-cancelled'));
    const worker = new Worker(path.join(__dirname, 'media-jobs-fingerprint-worker.js'), { workerData: { filename } });
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; signal?.removeEventListener('abort', abort);
      void worker.terminate(); error ? reject(error) : resolve(result);
    };
    const abort = () => finish(fail('media-job-cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (message.progress) { try { progress(message.progress); } catch { finish(fail('worker-failed')); } }
      else if (message.result) finish(null, message.result);
      else if (message.error) finish(fail(message.error));
    });
    worker.on('error', () => finish(fail('worker-failed')));
    worker.on('exit', () => { if (!done) finish(fail('worker-failed')); });
  });
}
function createDesktopMediaJobs({ directory, getSelection, renderer, onChange = () => {} }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof getSelection !== 'function' || typeof onChange !== 'function') throw fail('invalid-media-jobs-options');
  const filename = path.join(directory, 'desktop-media-jobs.json');
  const artifacts = createMediaArtifactStore({ directory });
  let state = { version: 1, projects: [], jobs: [] };
  let serial = Promise.resolve(); let initialized = false; let disposed = false; let release; let storageError = null;
  let active = null; let starting = false; let generation = 0; let lastSelection = null; let availability = false; let cacheBytesByProject = new Map();
  const serialize = action => { const result = serial.then(action); serial = result.catch(() => {}); return result; };
  async function selection() {
    const value = await getSelection();
    if (!value || typeof value.projectId !== 'string' || !value.projectId || value.projectId.length > 240
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/.test(value.projectId) || !/^[a-f0-9]{64}$/.test(value.sourceHash || '') || typeof value.exportPath !== 'string' || !path.isAbsolute(value.exportPath)) return null;
    return { projectId: value.projectId, sourceHash: value.sourceHash, exportPath: value.exportPath };
  }
  function project(id, create = false) {
    let value = state.projects.find(item => item.id === id);
    if (!value && create) { value = { id, policy: defaultPolicy(), source: null }; state.projects.push(value); }
    return value;
  }
  function requireInitialized(writable = true) {
    if (!initialized || disposed) throw fail('media-jobs-unavailable');
    if (writable && storageError) throw fail(storageError);
  }
  function blockStorage() {
    storageError = 'media-storage-unavailable'; generation++;
    active?.controller.abort();
    for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) { job.status = 'paused'; job.runToken = null; }
    notify();
  }
  async function persist() {
    const temporary = path.join(directory, `media-state-${randomUUID()}.tmp`);
    try {
      if (storageError) throw fail(storageError);
      const bytes = JSON.stringify(state); if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw fail('media-storage-unavailable');
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename); const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {}); blockStorage(); throw fail('media-storage-unavailable');
    }
  }
  function sourceFor(selected) {
    const source = selected && project(selected.projectId)?.source;
    return source && source.selectionKey === selectionKey(selected) ? source : null;
  }
  function dto(selected) {
    const selectedProject = selected && project(selected.projectId); const policy = selectedProject?.policy || defaultPolicy();
    const source = sourceFor(selected);
    const jobs = state.jobs.filter(job => selected && job.projectId === selected.projectId);
    const counts = Object.fromEntries([...STATUSES].map(status => [status, jobs.filter(job => job.status === status).length]));
    const cacheBytes = selected ? cacheBytesByProject.get(selected.projectId) || 0 : 0;
    const processingMs = jobs.reduce((sum, job) => sum + job.processingMs, 0);
    return { available: !!selected, error: storageError, projectId: selected?.projectId || null, sourceHash: selected?.sourceHash || null, source: source ? { id: source.id, name: sourceName(source.path) } : null,
      policy: { enabled: policy.enabled, rightsConfirmed: policy.rightsConfirmed, costPerGiBMonthUSD: policy.costPerGiBMonthUSD },
      renderingAvailable: availability,
      jobs: jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, progress: job.progress,
        sourceName: sourceName(job.source?.path || job.exportPath),
        requiresNewJob: job.selectionKey !== selectionKey(selected)
          || (job.kind !== 'timeline-preview' && source?.id !== job.source?.id)
          || (RENDER.has(job.kind) && policy.epoch !== job.policyEpoch),
        attempts: job.attempts, error: job.error, createdAt: job.createdAt, processingMs: job.processingMs,
        result: !storageError && job.status === 'completed' && (!RENDER.has(job.kind) || (policy.enabled && policy.rightsConfirmed && policy.epoch === job.policyEpoch
          && job.selectionKey === selectionKey(selected) && (job.kind === 'timeline-preview' || source?.id === job.source?.id))) ? job.result : null })),
      metrics: { counts, backlog: counts.queued + counts.running + counts.paused, failures: counts.failed,
        processingMs, cacheBytes, estimatedMonthlyStorageCostUSD: policy.costPerGiBMonthUSD === null ? null : cacheBytes / 1024 ** 3 * policy.costPerGiBMonthUSD } };
  }
  async function measure(selected = lastSelection) { if (selected) cacheBytesByProject.set(selected.projectId, await artifacts.measure(selected.projectId)); }
  function notify(selected = lastSelection) { const value = dto(selected); queueMicrotask(() => { try { onChange(value); } catch {} }); }
  async function validateSelection(job) {
    if (disposed || selectionKey(await selection()) !== job.selectionKey) throw fail('selection-changed');
    await readVerifiedExport(job.exportPath, job.sourceHash);
  }
  function validatePolicy(job) {
    if (!RENDER.has(job.kind)) return;
    const policy = project(job.projectId)?.policy;
    if (!policy?.enabled || policy.epoch !== job.policyEpoch) throw fail('policy-disabled');
    if (!policy.rightsConfirmed || !job.options.rightsConfirmed) throw fail('preview-rights-required');
  }
  async function validateSource(source, signal, progress) {
    if (!source || !sameIdentity(source.identity, await regularIdentity(source.path))) throw fail('source-changed');
    const actual = await fingerprint(source.path, { signal, progress });
    if (actual.sha256 !== source.sha256 || actual.size !== source.identity.size
      || !sameIdentity(source.identity, await regularIdentity(source.path))) throw fail('source-changed');
    return actual;
  }
  function interrupt(status = 'paused', predicate = () => true) {
    if (active && predicate(active.job)) { generation++; active.controller.abort(); }
    for (const job of state.jobs) if (predicate(job) && ['queued', 'running'].includes(job.status)) {
      if (active?.job.id === job.id && job.status === 'running') job.processingMs += Math.max(0, Date.now() - active.started);
      job.status = status; job.runToken = null;
      if (status === 'cancelled') job.error = 'media-job-cancelled';
    }
  }
  async function progress(job, runToken, value) {
    const number = Number.isFinite(value) ? Math.max(0, Math.min(99, Math.floor(value))) : 0;
    await serialize(async () => {
      if (disposed || job.status !== 'running' || job.runToken !== runToken || number <= job.progress) return;
      job.progress = number; await persist(); notify();
    });
  }
  async function execute(job, controller, runToken, runGeneration) {
    let stage; const started = Date.now();
    const guard = async () => {
      if (controller.signal.aborted || disposed || generation !== runGeneration || job.status !== 'running' || job.runToken !== runToken) throw fail('media-job-cancelled');
      validatePolicy(job); await validateSelection(job);
    };
    try {
      await guard();
      let result; let artifact; let timeline;
      if (job.kind === 'timeline-preview') {
        timeline = await loadTimelinePreview({ exportPath: job.exportPath, sourceHash: job.sourceHash });
        for (const [index, clip] of timeline.clips.entries()) {
          clip.fingerprint = await fingerprint(clip.sourcePath, { signal: controller.signal });
          if (!sameIdentity(clip.identity, await regularIdentity(clip.sourcePath))) throw fail('source-changed');
          await progress(job, runToken, (index + 1) / timeline.clips.length * 25);
        }
      } else {
        const actual = await validateSource(job.source, controller.signal, value => { void progress(job, runToken, (value.totalBytes ? value.bytesRead / value.totalBytes : 1) * (RENDER.has(job.kind) ? 25 : 90)).catch(() => {}); });
        if (job.kind === 'hash') result = { sha256: actual.sha256, byteLength: actual.size, verified: true };
        if (job.kind === 'asset-check') {
          result = { available: true, verified: true, byteLength: actual.size, inspection: 'unavailable' };
          if (availability && /\.(png|jpe?g|mov|mp4|m4v)$/i.test(job.source.path)) {
            const inspected = await renderer.inspect({ sourcePath: job.source.path }, { signal: controller.signal });
            if (!['image', 'video'].includes(inspected.kind) || !['width', 'height'].every(key => Number.isInteger(inspected[key]) && inspected[key] > 0 && inspected[key] <= 32768)) throw fail('unsupported-media');
            Object.assign(result, { inspection: 'decoded', kind: inspected.kind, width: inspected.width, height: inspected.height });
            for (const key of ['durationSeconds', 'frameRate']) if (inspected[key] === null || (Number.isFinite(inspected[key]) && inspected[key] >= 0)) result[key] = inspected[key];
            await validateSource(job.source, controller.signal);
          } else if (availability) result.inspection = 'unsupported';
        }
      }
      if (RENDER.has(job.kind)) {
        await guard();
        if (!renderer) throw fail('native-renderer-unavailable');
        let imageProxy = false;
        if (job.kind === 'proxy') {
          const inspected = await renderer.inspect({ sourcePath: job.source.path }, { signal: controller.signal });
          imageProxy = inspected.kind === 'image';
        }
        stage = await artifacts.stage(imageProxy ? 'thumbnail' : job.kind, job.projectId);
        const controls = { signal: controller.signal, progress: value => progress(job, runToken,
          25 + Math.max(0, Math.min(100, typeof value === 'number' ? value : value?.percent || 0)) * 0.65) };
        const dimensions = { width: job.options.width || (job.kind === 'timeline-preview' ? 1280 : 640), height: job.options.height || (job.kind === 'timeline-preview' ? 720 : 360) };
        let output;
        if (job.kind === 'timeline-preview') {
          output = await renderer.renderStoryboard({ clips: timeline.clips.map(clip => ({ sourcePath: clip.sourcePath, seconds: clip.seconds, label: clip.label })), outputPath: stage.outputPath, ...dimensions }, controls);
        } else if (job.kind === 'thumbnail') {
          let seconds = 0;
          if (job.options.frame) {
            const inspected = await renderer.inspect({ sourcePath: job.source.path }, controls);
            if (!Number.isFinite(inspected.frameRate) || inspected.frameRate <= 0) throw fail('unsupported-frame-rate');
            seconds = job.options.frame / inspected.frameRate;
          }
          output = await renderer.renderThumbnail({ sourcePath: job.source.path, outputPath: stage.outputPath, seconds, ...dimensions }, controls);
        } else output = await renderer.renderProxy({ sourcePath: job.source.path, outputPath: stage.outputPath, ...dimensions }, controls);
        await guard();
        if (timeline) {
          for (const clip of timeline.clips) {
            if (!sameIdentity(clip.identity, await regularIdentity(clip.sourcePath))) throw fail('source-changed');
            const actual = await fingerprint(clip.sourcePath, { signal: controller.signal });
            if (actual.sha256 !== clip.fingerprint.sha256 || actual.size !== clip.fingerprint.size) throw fail('source-changed');
          }
        } else await validateSource(job.source, controller.signal);
        artifact = await artifacts.publish(stage, output, guard);
        result = { artifactId: artifact.id, mimeType: artifact.mimeType, width: artifact.width, height: artifact.height,
          byteLength: artifact.byteLength, sha256: artifact.sha256, canonical: false,
          ...(artifact.durationSeconds === undefined ? {} : { durationSeconds: artifact.durationSeconds }),
          ...(timeline ? { clipCount: timeline.clipCount, previewType: 'storyboard' } : {}) };
      }
      await guard();
      await serialize(async () => {
        await guard(); job.status = 'completed'; job.progress = 100; job.result = result; job.artifact = artifact || null;
        if (timeline) job.timelineSources = timeline.clips.map(clip => ({ path: clip.sourcePath, identity: clip.identity, sha256: clip.fingerprint.sha256 }));
        job.error = null; job.runToken = null; job.processingMs += Math.max(0, Date.now() - started);
        await persist(); await measure(); notify();
      });
    } catch (error) {
      await serialize(async () => {
        if (disposed || job.status !== 'running' || job.runToken !== runToken) return;
        job.status = controller.signal.aborted || error.code === 'media-job-cancelled' ? 'cancelled' : 'failed';
        job.error = job.status === 'cancelled' ? 'media-job-cancelled' : errorCode(error);
        job.result = null; job.runToken = null; job.processingMs += Math.max(0, Date.now() - started);
        await persist(); await measure(); notify();
      });
    } finally {
      if (stage) await artifacts.discard(stage);
      if (active?.runToken === runToken) active = null;
      if (!disposed) kick();
    }
  }
  function kick() {
    if (!initialized || disposed || storageError || active || starting) return;
    starting = true;
    void serialize(async () => {
      if (disposed || active) return;
      const selected = await selection(); lastSelection = selected;
      const job = state.jobs.find(item => item.status === 'queued' && item.selectionKey === selectionKey(selected));
      if (!job) return;
      const controller = new AbortController(); const runToken = randomUUID();
      job.status = 'running'; job.attempts++; job.runToken = runToken; job.error = null;
      active = { job, controller, runToken, started: Date.now() };
      await persist(); notify(selected);
      // execute begins after releasing the metadata serialization lane.
      active.promise = Promise.resolve().then(() => execute(job, controller, runToken, generation)).catch(() => { blockStorage(); if (active?.runToken === runToken) active = null; });
    }).catch(() => { blockStorage(); active = null; }).finally(() => { starting = false; });
  }
  async function initialize() {
    return serialize(async () => {
      if (initialized) return dto(await selection());
      if (disposed) throw fail('media-jobs-unavailable');
      await privateDirectory(directory);
      release = await acquireMetadataLock(directory, 250);
      try {
        try {
          const identity = await regularIdentity(filename);
          if (identity.size > 8 * 1024 * 1024) throw fail('media-state-invalid');
          const loaded = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (!journalValid(loaded)) throw fail('media-state-invalid');
          state = loaded;
        } catch (error) { if (error.code !== 'ENOENT') throw fail('media-state-invalid'); }
        for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) { job.status = 'paused'; job.runToken = null; }
        await artifacts.initialize();
        try { const result = typeof renderer?.getAvailability === 'function' ? await renderer.getAvailability() : null; availability = result === true || result?.available === true; }
        catch { availability = false; }
        if (renderer && typeof renderer.getAvailability !== 'function') availability = ['inspect', 'renderThumbnail', 'renderProxy', 'renderStoryboard'].every(key => typeof renderer[key] === 'function');
        initialized = true; lastSelection = await selection(); await persist(); await measure(); notify(); return dto(lastSelection);
      } catch (error) { if (release) await release(); release = null; throw error; }
    });
  }
  async function getState() { return serialize(async () => { requireInitialized(false); lastSelection = await selection(); try { await measure(); } catch { blockStorage(); } return dto(lastSelection); }); }
  async function chooseSource(sourcePath) {
    requireInitialized(); const selected = await selection(); if (!selected) throw fail('no-selected-project');
    const identity = await regularIdentity(sourcePath); const actual = await fingerprint(sourcePath);
    if (!sameIdentity(identity, await regularIdentity(sourcePath))) throw fail('source-changed');
    return serialize(async () => {
      requireInitialized(); if (selectionKey(selected) !== selectionKey(await selection())) throw fail('selection-changed');
      const owner = project(selected.projectId, true); const previous = owner.source;
      if (!(previous && previous.path === sourcePath && previous.sha256 === actual.sha256 && sameIdentity(previous.identity, identity) && previous.selectionKey === selectionKey(selected))) {
        interrupt('cancelled', job => job.projectId === selected.projectId && job.kind !== 'timeline-preview');
        owner.source = { id: randomUUID(), path: sourcePath, name: sourceName(sourcePath), identity, sha256: actual.sha256, selectionKey: selectionKey(selected) };
      }
      lastSelection = selected; await persist(); notify(); return dto(selected);
    });
  }
  async function setPolicy(input) {
    return serialize(async () => {
      requireInitialized(); const selected = await selection(); if (!selected) throw fail('no-selected-project');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'rightsConfirmed', 'costPerGiBMonthUSD'].includes(key))
        || typeof input.enabled !== 'boolean' || (input.rightsConfirmed !== undefined && typeof input.rightsConfirmed !== 'boolean')
        || (input.costPerGiBMonthUSD !== undefined && input.costPerGiBMonthUSD !== null && (!Number.isFinite(input.costPerGiBMonthUSD) || input.costPerGiBMonthUSD < 0 || input.costPerGiBMonthUSD > 100000))) throw fail('invalid-media-policy');
      const owner = project(selected.projectId, true); const policy = owner.policy;
      const rights = input.enabled ? (input.rightsConfirmed ?? policy.rightsConfirmed) : false;
      if (policy.enabled !== input.enabled || policy.rightsConfirmed !== rights) {
        policy.epoch++; interrupt('cancelled', job => job.projectId === selected.projectId && RENDER.has(job.kind));
      }
      policy.enabled = input.enabled; policy.rightsConfirmed = rights;
      if (input.costPerGiBMonthUSD !== undefined) policy.costPerGiBMonthUSD = input.costPerGiBMonthUSD;
      lastSelection = selected; await persist(); notify(); return dto(selected);
    });
  }
  async function enqueue(input) {
    const value = await serialize(async () => {
      requireInitialized(); const selected = await selection(); if (!selected) throw fail('no-selected-project');
      if (!input || typeof input !== 'object' || Array.isArray(input) || !KINDS.has(input.kind)
        || Object.keys(input).some(key => !['kind', 'frame', 'width', 'height', 'rightsConfirmed'].includes(key))
        || ['frame', 'width', 'height'].some(key => input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < (key === 'frame' ? 0 : 1) || input[key] > 4096))
        || (input.rightsConfirmed !== undefined && typeof input.rightsConfirmed !== 'boolean')) throw fail('invalid-media-job');
      const owner = project(selected.projectId, true); const source = sourceFor(selected);
      await readVerifiedExport(selected.exportPath, selected.sourceHash);
      if (input.kind !== 'timeline-preview') {
        if (!source) throw fail('no-selected-media');
        if (!sameIdentity(source.identity, await regularIdentity(source.path))) throw fail('source-changed');
      }
      if (RENDER.has(input.kind) && (!owner.policy.enabled || !owner.policy.rightsConfirmed)) throw fail('policy-disabled');
      if (RENDER.has(input.kind) && input.rightsConfirmed !== true) throw fail('preview-rights-required');
      const options = { ...(input.frame === undefined ? {} : { frame: input.frame }), ...(input.width === undefined ? {} : { width: input.width }),
        ...(input.height === undefined ? {} : { height: input.height }), ...(RENDER.has(input.kind) ? { rightsConfirmed: true } : {}) };
      const key = createHash('sha256').update(JSON.stringify([input.kind, selectionKey(selected), input.kind === 'timeline-preview' ? null : source.id, options, RENDER.has(input.kind) ? owner.policy.epoch : null])).digest('hex');
      let job = state.jobs.find(item => item.key === key);
      if (!job) {
        if (state.jobs.length >= 1000) throw fail('media-queue-full');
        job = { id: randomUUID(), key, kind: input.kind, projectId: selected.projectId, selectionKey: selectionKey(selected),
          exportPath: selected.exportPath, sourceHash: selected.sourceHash, source: input.kind === 'timeline-preview' ? null : { ...source },
          policyEpoch: owner.policy.epoch, options, status: 'queued', progress: 0, attempts: 0, processingMs: 0,
          createdAt: new Date().toISOString(), error: null, result: null, artifact: null, runToken: null };
        state.jobs.push(job); await persist();
      }
      lastSelection = selected; notify(); return { ...dto(selected), lastEnqueuedId: job.id };
    });
    kick(); return value;
  }
  async function updateJob(id, operation) {
    const result = await serialize(async () => {
      requireInitialized(); const selected = await selection();
      const job = state.jobs.find(item => item.id === id && selected && item.projectId === selected.projectId);
      if (!job) throw fail('media-job-not-found');
      if (operation === 'cancel') {
        if (['queued', 'paused', 'running', 'failed'].includes(job.status)) {
          if (active?.job.id === id) active.controller.abort();
          if (active?.job.id === id && job.status === 'running') job.processingMs += Math.max(0, Date.now() - active.started);
          job.status = 'cancelled'; job.error = 'media-job-cancelled'; job.runToken = null;
        }
      } else {
        if (job.selectionKey !== selectionKey(selected)) throw fail('selection-changed');
        validatePolicy(job);
        if (job.kind !== 'timeline-preview' && (sourceFor(selected)?.id !== job.source?.id || !sameIdentity(job.source.identity, await regularIdentity(job.source.path)))) throw fail('source-changed');
        const permitted = operation === 'resume' ? ['paused'] : operation === 'retry' ? ['failed'] : ['failed', 'cancelled', 'completed', 'paused'];
        if (!permitted.includes(job.status)) throw fail('invalid-media-job-state');
        // Retry is bounded within a run. Explicit Restart begins a new run.
        if (operation === 'restart') job.attempts = 0;
        else if (job.attempts >= 3) throw fail('media-job-attempt-limit');
        job.status = 'queued'; job.error = null; job.result = null; job.progress = 0; job.runToken = null;
      }
      lastSelection = selected; await persist(); notify(); return dto(selected);
    });
    if (operation !== 'cancel') kick(); return result;
  }
  async function selectionChanged() {
    return serialize(async () => {
      requireInitialized(); interrupt('paused'); lastSelection = await selection(); await persist(); notify(); return dto(lastSelection);
    });
  }
  async function getArtifact(id) {
    return serialize(async () => {
      requireInitialized(); const selected = await selection();
      const job = state.jobs.find(item => item.id === id && selected && item.projectId === selected.projectId);
      if (!job || job.status !== 'completed' || !job.artifact || job.selectionKey !== selectionKey(selected)) throw fail('artifact-unavailable');
      validatePolicy(job); await validateSelection(job);
      if (job.kind !== 'timeline-preview') {
        if (sourceFor(selected)?.id !== job.source?.id) throw fail('source-changed');
        await validateSource(job.source);
      } else {
        // Captured dependency identities are retained privately with the job.
        if (!job.timelineSources) throw fail('artifact-unavailable');
        for (const source of job.timelineSources) await validateSource(source);
      }
      const artifact = await artifacts.get(job.artifact);
      validatePolicy(job); await validateSelection(job);
      return { ...artifact, sha256: job.artifact.sha256 };
    });
  }
  async function dispose() {
    const pending = await serialize(async () => {
      if (disposed) return;
      if (initialized) { interrupt('paused'); if (!storageError) await persist().catch(() => {}); }
      disposed = true; initialized = false;
      return { promise: active?.promise };
    });
    await pending?.promise?.catch(() => {});
    return serialize(async () => {
      if (release) { await release(); release = null; }
    });
  }
  return { initialize, getState, chooseSource, setPolicy, enqueue, cancel: id => updateJob(id, 'cancel'),
    retry: id => updateJob(id, 'retry'), restart: id => updateJob(id, 'restart'), resume: id => updateJob(id, 'resume'),
    selectionChanged, getArtifact, dispose };
}
module.exports = { createDesktopMediaJobs };
