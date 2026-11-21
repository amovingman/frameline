'use strict';
const { safeErrorCode, count } = require('./observability-catalog');
const DOMAINS = ['nativePull', 'mediaRelink', 'assetTransfers', 'scanRecovery', 'localIntegrity'];
const CATEGORIES = ['active', 'review', 'pendingValidation', 'recoveryRequired', 'verified', 'rolledBack', 'cancelled', 'retired', 'failed', 'paused', 'noOp', 'unknown'];
const STATES = {
  nativePull: {
    preparing:'active', 'preparing-transaction':'active', 'needs-review':'review', ready:'review', blocked:'review',
    'transaction-prepared':'review', 'no-op':'noOp', 'pending-editor-validation':'pendingValidation',
    'pending-rollback-editor-validation':'pendingValidation', completed:'verified', 'rolled-back':'rolledBack',
    cancelled:'cancelled', 'recovery-required':'recoveryRequired'
  },
  mediaRelink: {
    capturing:'active', captured:'review', reviewing:'active', prepared:'review', publishing:'active',
    published:'pendingValidation', validated:'verified', 'import-prepared':'pendingValidation', imported:'pendingValidation',
    'import-validated':'verified', 'import-retired':'retired', cancelled:'cancelled', 'recovery-required':'recoveryRequired'
  },
  assetTransfers: {queued:'review', running:'active', paused:'paused', completed:'verified', cancelled:'cancelled', failed:'failed'},
  scanRecovery: {running:'active', interrupted:'recoveryRequired', completed:'verified', failed:'failed', cancelled:'cancelled'},
  localIntegrity: {'not-checked':'review', checking:'active', verified:'verified', empty:'noOp', failed:'failed'}
};
const CHECK_STATES = ['prepared', 'pending', 'waiting', 'native-error', 'imported', 'verified', 'retired', 'captured', 'not-prepared'];
const safeCheck = value => value == null ? 'not-observed' : CHECK_STATES.includes(value) ? value : 'unknown';
const fields = ['busyPeriodsStarted','busyPeriodsCompleted','averageBusyPeriodMs','recentSampleCount','recentP50BusyPeriodMs','recentP95BusyPeriodMs'];
function emptyCounts() { return Object.fromEntries(CATEGORIES.map(key => [key, 0])); }
function rowsFor(domain, state) {
  if (domain === 'nativePull') return Array.isArray(state.retained) ? state.retained : state.intent ? [state.intent] : [];
  if (domain === 'mediaRelink') return Array.isArray(state.intents) ? state.intents : state.intent ? [state.intent] : [];
  if (domain === 'assetTransfers') return Array.isArray(state.jobs) ? state.jobs : [];
  if (domain === 'scanRecovery') return Array.isArray(state.operations) ? state.operations : [];
  return [state];
}
function projectState(domain, state) {
  const statusCounts = emptyCounts(), errorCodes = {};
  const error = value => { if (value !== null && value !== undefined && value !== '') {
    const code = safeErrorCode(value); errorCodes[code] = (errorCodes[code] || 0) + 1;
  } };
  error(state.errorCode || state.error);
  const rows = rowsFor(domain, state), shown = rows.slice(0, 10000);
  for (const row of shown) {
    const status = domain === 'assetTransfers' || domain === 'scanRecovery' || domain === 'localIntegrity' ? row?.status : row?.state;
    const category = domain === 'nativePull' && status === 'cancelled' && row?.retirement ? 'retired' : (Object.hasOwn(STATES[domain], status) ? STATES[domain][status] : 'unknown');
    statusCounts[category]++;
    // Top-level local integrity failure is already counted above.
    if (domain !== 'localIntegrity') error(row?.errorCode || row?.error);
  }
  const checkStatus = domain === 'mediaRelink' ? state.intent?.importCheck?.status : domain === 'nativePull' ? state.editorCheck?.status : null;
  const result = { editorCheckStatus:safeCheck(checkStatus), observed:true, busy:state.busy === true, scope:domain === 'assetTransfers' ? 'current-selection' : 'retained-controller-state',
    statusCounts, errorCodes, truncated:rows.length > shown.length,
    unverifiedStagingCount:domain === 'assetTransfers' ? count(state.stagingRecovery?.retainedCount) : null };
  return result;
}
// Observers are passive and cannot throw into workflow callbacks. Only completed
// session busy periods are timed; no promise resolution is called a success.
function createOperationHealth({now = () => Date.now()} = {}) {
  const entries = new Map();
  function observe(domain, state) {
    try {
      if (!DOMAINS.includes(domain) || !state || typeof state !== 'object') return;
      const projected = projectState(domain, state);
      const prior = entries.get(domain) || {start:null, started:0, completed:0, total:0, durations:[]};
      const time = now();
      if (projected.busy && prior.start === null) { prior.start = Number.isFinite(time) ? time : 0; prior.started++; }
      if (!projected.busy && prior.start !== null) {
        const elapsed = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round((Number.isFinite(time) ? time : prior.start) - prior.start)));
        prior.start = null; prior.completed++; prior.total += elapsed; prior.durations.push(elapsed);
        if (prior.durations.length > 128) prior.durations.shift();
      }
      prior.state = projected; entries.set(domain, prior);
    } catch { /* Diagnostics must never affect a workflow or its public state. */ }
  }
  function snapshot() {
    const workflows = {};
    for (const domain of DOMAINS) {
      const entry = entries.get(domain);
      if (!entry) { workflows[domain] = {observed:false}; continue; }
      const sorted = [...entry.durations].sort((a,b) => a-b);
      const percentile = fraction => sorted.length ? sorted[Math.ceil(sorted.length*fraction)-1] : null;
      workflows[domain] = {...entry.state, statusCounts:{...entry.state.statusCounts}, errorCodes:{...entry.state.errorCodes},
        busyPeriodsStarted:entry.started, busyPeriodsCompleted:entry.completed,
        averageBusyPeriodMs:entry.completed ? Math.round(entry.total/entry.completed) : null,
        recentSampleCount:sorted.length, recentP50BusyPeriodMs:percentile(.5), recentP95BusyPeriodMs:percentile(.95)};
    }
    return {schemaVersion:1, scope:'local-session-and-current-retained-state', workflows};
  }
  return {observe, snapshot};
}
// Reports apply a second projection even when the producer is trusted. No raw
// object, identifier, arbitrary key or error string is copied into the export.
function sanitizeOperationHealth(value) {
  if (!value || typeof value !== 'object') return null;
  const workflows = {};
  for (const domain of DOMAINS) {
    const source = value.workflows?.[domain];
    if (source?.observed !== true) {workflows[domain] = {observed:false}; continue;}
    const errorCodes = {};
    for (const [code, amount] of Object.entries(source.errorCodes || {})) {
      if (count(amount) === null) continue;
      const safe = safeErrorCode(code);
      errorCodes[safe] = Math.min(Number.MAX_SAFE_INTEGER, (errorCodes[safe] || 0) + amount);
    }
    workflows[domain] = {observed:true, editorCheckStatus:safeCheck(source.editorCheckStatus === 'not-observed' ? null : source.editorCheckStatus), busy:source.busy === true,
      scope:domain === 'assetTransfers' ? 'current-selection' : 'retained-controller-state',
      statusCounts:Object.fromEntries(CATEGORIES.map(category => [category,count(source.statusCounts?.[category])])),
      errorCodes, truncated:source.truncated === true,
      unverifiedStagingCount:domain === 'assetTransfers' ? count(source.unverifiedStagingCount) : null,
      ...Object.fromEntries(fields.map(field => [field,count(source[field])]))};
  }
  return {schemaVersion:1, scope:'local-session-and-current-retained-state', workflows};
}
module.exports = {createOperationHealth, sanitizeOperationHealth};
