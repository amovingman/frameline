'use strict';
const path = require('node:path');
const { createRevisionHttpClient } = require('./revision-http-client');
const { createAssetHttpClient } = require('./asset-http-client');
const { COMMENT_ERROR_CODES } = require('./review-comments-protocol');

const ENTRY = 'desktop-service-connection';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9._~=-]{16,4096}$/;
const AUTH_ERRORS = new Set(['access-token-invalid', 'refresh-token-invalid', 'credentials-invalid', 'service-sign-in-required']);
const REQUEST_ERRORS = new Set([...AUTH_ERRORS, ...COMMENT_ERROR_CODES, 'forbidden', 'rate-limit-exceeded', 'project-not-found', 'manifest-not-found',
  'manifest-project-mismatch', 'revision-not-found', 'parent-revision-not-found', 'branch-not-found', 'branch-head-changed',
  'revision-parent-mismatch', 'source-revision-exists', 'idempotency-key-reused', 'branch-approval-required', 'approval-head-stale',
  'request-too-large', 'manifest-invalid', 'revision-invalid', 'invalid-idempotency-key', 'invalid-request-headers',
  'sync-request-invalid', 'sync-request-too-large', 'sync-response-invalid', 'sync-response-too-large', 'sync-cancelled',
  'sync-network-unavailable', 'sync-service-failed', 'service-offline', 'service-credential-storage-unavailable',
  'asset-network-unavailable', 'asset-service-failed', 'asset-request-invalid', 'asset-request-too-large', 'asset-response-invalid',
  'asset-response-too-large', 'asset-forbidden', 'asset-not-found', 'upload-not-found', 'asset-upload-not-found', 'asset-ticket-invalid',
  'asset-identity-collision', 'asset-chunk-conflict', 'upload-incomplete', 'asset-upload-incomplete', 'asset-content-mismatch',
  'asset-identity-invalid', 'asset-chunk-invalid', 'asset-chunk-corrupt', 'asset-state-invalid', 'asset-state-newer-version',
  'asset-key-rotation-required', 'asset-capacity-exceeded', 'asset-storage-unavailable', 'asset-storage-uncertain',
  'asset-cancelled', 'asset-verification-timeout', 'asset-policy-excluded', 'asset-policy-forbidden', 'asset-policy-invalid',
  'asset-policy-version-conflict', 'asset-archived', 'asset-archive-invalid', 'asset-archive-conflict', 'activity-page-invalid',
  'activity-cursor-invalid', 'activity-state-invalid', 'activity-state-newer-version', 'activity-capacity-exceeded', 'notification-not-found']);
function fail(code) { return Object.assign(new Error(code), { code }); }
const clone = value => structuredClone(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
function origin(value) {
  let parsed; try { parsed = new URL(value); } catch { throw fail('service-origin-invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) throw fail('service-origin-invalid');
  return parsed.origin;
}
function account(value, stored = false) {
  if (!exact(value, stored ? ['id', 'email'] : ['id', 'email', 'status']) || !ID.test(value.id || '')
    || typeof value.email !== 'string' || value.email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    || !stored && value.status !== 'active') throw fail('service-response-invalid');
  return { id: value.id, email: value.email };
}
function session(value) {
  if (!exact(value, ['sessionId', 'accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'])
    || !ID.test(value.sessionId || '') || !TOKEN.test(value.accessToken || '') || !TOKEN.test(value.refreshToken || '')
    || !Number.isSafeInteger(value.accessExpiresAt) || !Number.isSafeInteger(value.refreshExpiresAt)
    || value.accessExpiresAt < 0 || value.refreshExpiresAt < value.accessExpiresAt) throw fail('service-response-invalid');
  return clone(value);
}
function projects(value) {
  if (!exact(value, ['projects']) || !Array.isArray(value.projects) || value.projects.length > 10000) throw fail('service-response-invalid');
  const seen = new Set();
  return value.projects.map(item => {
    if (!exact(item, ['id', 'name', 'role', 'branches']) || !ID.test(item.id || '') || seen.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || /[\\/\x00-\x1f\x7f]/.test(item.name)
      || !['owner', 'editor', 'viewer'].includes(item.role) || !Array.isArray(item.branches) || item.branches.length > 10000
      || item.branches.some(name => typeof name !== 'string' || !ID.test(name))
      || new Set(item.branches).size !== item.branches.length) throw fail('service-response-invalid');
    seen.add(item.id); return clone(item);
  });
}
function publicError(error) {
  if (['service-offline', 'sync-network-unavailable', 'asset-network-unavailable', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code)) return 'service-offline';
  if (['credentials-invalid', 'access-token-invalid', 'refresh-token-invalid', 'service-sign-in-required'].includes(error?.code)) return 'service-sign-in-required';
  if (error?.code === 'service-origin-invalid' || error?.code === 'secure-transport-required' || error?.code === 'sync-origin-invalid') return 'service-origin-invalid';
  if (error?.code === 'forbidden') return 'service-access-denied';
  if (error?.code?.startsWith('credential-') || error?.code === 'service-credential-storage-unavailable') return 'service-credential-storage-unavailable';
  return 'service-connection-failed';
}

function createDesktopServiceConnection({ directory, vault, createClient = createRevisionHttpClient,
  createAssetClient = createAssetHttpClient, onChange = () => {} } = {}) {
  if (!path.isAbsolute(directory || '') || !vault || !['set', 'get', 'remove'].every(key => typeof vault[key] === 'function')
    || typeof createClient !== 'function' || typeof createAssetClient !== 'function' || typeof onChange !== 'function') throw fail('service-connection-invalid');
  let generation = 0, binding = null, controller = null, disposed = false, projectRefresh = null;
  const tasks = new Set();
  let state = { version: 0, status: 'not-configured', connected: false, busy: false, origin: null, account: null, projects: [], error: null };
  function publish(patch) {
    state = { ...state, ...patch, version: state.version + 1 };
    try { onChange(clone(state)); } catch { /* Display delivery cannot change credentials. */ }
    return clone(state);
  }
  function track(promise) {
    tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;
  }
  function current(value) { return binding === value && generation === value.generation && !value.controller.signal.aborted; }
  function checked(value) { if (!current(value) || !value.session) throw fail('service-sign-in-required'); }
  async function persist(value, candidate) {
    checked(value);
    try { await vault.set(ENTRY, JSON.stringify({ schemaVersion: 1, origin: value.origin, session: candidate, account: value.account })); }
    catch {
      // A rotated refresh token cannot safely be used again after an ambiguous save.
      value.session = null;
      try { await vault.remove(ENTRY); } catch { /* The public storage error remains generic. */ }
      if (current(value)) publish({ status: 'sign-in-required', connected: false, busy: false, error: 'service-credential-storage-unavailable' });
      throw fail('service-credential-storage-unavailable');
    }
    checked(value); value.session = candidate;
  }
  function makeBinding(serviceOrigin, savedSession, savedAccount, run) {
    const value = { origin: serviceOrigin, session: savedSession, account: savedAccount, projects: [], generation: run.generation,
      controller: run.controller, refreshing: null, client: null, authenticated: null };
    value.client = createClient({ origin: serviceOrigin, getAccessToken: () => accessToken(value) });
    const arities = { putManifest: 2, createRevision: 1, compareAndSwapBranch: 1, getBranch: 2, getRevision: 2,
      getManifest: 2, findRevisionBySource: 2, getAccount: 0, listProjects: 0, listActivity: 2, listNotifications: 2, markNotificationRead: 3,
      listReviewComments: 3, addReviewComment: 1, resolveReviewComment: 3 };
    function protect(client, methods) { return Object.fromEntries(Object.entries(methods).filter(([name]) => typeof client[name] === 'function')
      .map(([name, count]) => [name, (...args) => track((async () => {
        checked(value);
        try {
          const options = args[count] || {};
          const signal = options.signal ? AbortSignal.any([value.controller.signal, options.signal]) : value.controller.signal;
          const result = await client[name](...args.slice(0, count), { ...options, signal }); checked(value);
          if (state.status === 'offline') publish({ status: 'connected', connected: true, error: null });
          return result;
        } catch (error) {
          if (current(value) && value.session) {
            if (AUTH_ERRORS.has(error?.code)) {
              value.session = null;
              publish({ status: 'sign-in-required', connected: false, busy: false, error: 'service-sign-in-required' });
              value.controller.abort();
            } else if (publicError(error) === 'service-offline') {
              publish({ status: 'offline', connected: false, busy: false, error: 'service-offline' });
            }
          }
          throw fail(REQUEST_ERRORS.has(error?.code) ? error.code : publicError(error) === 'service-offline'
            ? 'sync-network-unavailable' : 'service-connection-failed');
        }
      })())])); }
    value.authenticated = protect(value.client, arities);
    value.assets = protect(createAssetClient({ origin: serviceOrigin, getAccessToken: () => accessToken(value) }), {
      beginUpload: 2, uploadStatus: 2, putChunk: 5, completeUpload: 2, cancelVerification: 2, getAsset: 2, readChunk: 3,
      getPolicy: 1, setPolicy: 2, getUsage: 1, getAvailability: 2, setArchived: 3 });
    return value;
  }
  async function accessToken(value) {
    checked(value);
    if (value.session.accessExpiresAt > Date.now()) return value.session.accessToken;
    // A fresh sign-in must be verified before any credential record is saved.
    if (!value.account) throw fail('service-sign-in-required');
    if (!value.refreshing) {
      value.refreshing = track((async () => {
        try {
          if (value.session.refreshExpiresAt <= Date.now()) throw fail('service-sign-in-required');
          const candidate = session(await value.client.refreshSession(value.session.refreshToken, { signal: value.controller.signal }));
          if (candidate.accessExpiresAt <= Date.now()) throw fail('service-sign-in-required');
          checked(value); await persist(value, candidate); return candidate.accessToken;
        } catch (error) {
          if (current(value)) {
            const code = publicError(error);
            if (code !== 'service-offline') value.session = null;
            publish({ status: code === 'service-offline' ? 'offline' : 'sign-in-required', connected: false, error: code });
          }
          throw fail(publicError(error));
        }
      })()).finally(() => { value.refreshing = null; });
    }
    const token = await value.refreshing; checked(value); return token;
  }
  async function inspect(value) {
    const found = account(await value.client.getAccount({ signal: value.controller.signal })); checked(value);
    if (value.account && (found.id !== value.account.id || found.email !== value.account.email)) throw fail('service-response-invalid');
    const available = projects(await value.client.listProjects({ signal: value.controller.signal })); checked(value);
    value.account = found; value.projects = available;
  }
  function transition(action, patch) {
    if (disposed) return Promise.resolve(clone(state));
    const previous = binding, draining = [...tasks]; controller?.abort();
    const run = { generation: ++generation, controller: new AbortController() }; controller = run.controller; binding = null;
    publish(patch);
    return track((async () => { await Promise.allSettled(draining); if (generation !== run.generation) return clone(state);
      return action(run, previous); })());
  }
  function failure(error, value) {
    if (!current(value)) return clone(state);
    const code = publicError(error), offline = code === 'service-offline';
    if (!offline) value.session = null;
    return publish({ status: offline ? 'offline' : 'sign-in-required', connected: false, busy: false,
      origin: value.origin, account: clone(value.account), projects: clone(value.projects), error: code });
  }
  function initialize() {
    return transition(async run => {
      let value;
      try {
        const encoded = await vault.get(ENTRY); if (generation !== run.generation) return clone(state);
        if (encoded === null) return publish({ status: 'not-configured', busy: false });
        let saved; try { saved = JSON.parse(encoded); } catch { throw fail('service-credential-storage-unavailable'); }
        if (!exact(saved, ['schemaVersion', 'origin', 'session', 'account']) || saved.schemaVersion !== 1) throw fail('service-credential-storage-unavailable');
        value = makeBinding(origin(saved.origin), session(saved.session), account(saved.account, true), run); binding = value;
        publish({ origin: value.origin, account: value.account }); await inspect(value);
        if (!current(value)) return clone(state);
        return publish({ status: 'connected', connected: true, busy: false, projects: value.projects, error: null });
      } catch (error) {
        if (generation !== run.generation) return clone(state);
        if (value) return failure(error, value);
        return publish({ status: 'sign-in-required', connected: false, busy: false, error: publicError(error) });
      }
    }, { status: 'connecting', connected: false, busy: true, origin: null, account: null, projects: [], error: null });
  }
  function connect(input = {}) {
    // Password exists only in this one sign-in invocation and is never saved.
    let serviceOrigin; try { serviceOrigin = origin(input.origin); } catch (error) { return Promise.resolve(publish({ error: publicError(error) })); }
    let email = input.email, password = input.password;
    return transition(async run => {
      let value;
      try {
        value = makeBinding(serviceOrigin, null, null, run); binding = value;
        let issued;
        try { issued = session(await value.client.signIn(email, password, { signal: run.controller.signal })); }
        finally { email = null; password = null; }
        if (!current(value)) return clone(state); value.session = issued;
        await inspect(value); await persist(value, value.session);
        return publish({ status: 'connected', connected: true, busy: false, origin: value.origin, account: value.account, projects: value.projects, error: null });
      } catch (error) {
        if (generation !== run.generation) return clone(state);
        if (value) return failure(error, value);
        return publish({ status: 'sign-in-required', busy: false, error: publicError(error) });
      }
    }, { status: 'connecting', connected: false, busy: true, origin: serviceOrigin, account: null, projects: [], error: null });
  }
  function disconnect() {
    return transition(async (run, previous) => {
      if (previous?.session) {
        try { await previous.client.signOut(previous.session.refreshToken, { signal: run.controller.signal }); } catch { /* Local removal still proceeds. */ }
      }
      if (generation !== run.generation) return clone(state);
      try { await vault.remove(ENTRY); }
      catch { if (generation === run.generation) return publish({ busy: false, error: 'service-credential-storage-unavailable' }); }
      if (generation !== run.generation) return clone(state);
      return publish({ busy: false, error: null });
    }, { status: 'not-configured', connected: false, busy: true, origin: null, account: null, projects: [], error: null });
  }
  function refreshProjects() {
    if (projectRefresh) return projectRefresh;
    const value = binding;
    if (!value?.session || !current(value)) return Promise.resolve(clone(state));
    publish({ busy: true, error: null });
    projectRefresh = track((async () => {
      try { await inspect(value); if (!current(value)) return clone(state);
        return publish({ status: 'connected', connected: true, busy: false, account: value.account, projects: value.projects, error: null });
      } catch (error) { return failure(error, value); }
    })()).finally(() => { projectRefresh = null; });
    return projectRefresh;
  }
  function getClient() {
    if (!binding?.session || !current(binding) || !['connected', 'offline'].includes(state.status)) throw fail('service-sign-in-required');
    return binding.authenticated;
  }
  function getAccount() { getClient(); return clone(binding.account); }
  function getAssetClient() { getClient(); return binding.assets; }
  async function dispose() {
    disposed = true; generation++; controller?.abort(); binding = null;
    await Promise.allSettled([...tasks]);
  }
  return { initialize, connect, disconnect, refreshProjects, getState: () => clone(state), getClient, getAssetClient, getAccount, dispose };
}

module.exports = { createDesktopServiceConnection };
