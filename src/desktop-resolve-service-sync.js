'use strict';
const { fingerprint } = require('./project-api-contracts');
const { createDesktopRevisionSync } = require('./desktop-revision-sync');
const { createServiceResolveComparison } = require('./service-resolve-comparison');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
function describeResolveServiceComparison(result) {
  const b = result.binding, changes = result.plan.classification.decisions;
  return { id: result.id, readOnly: true, safeToApply: false, source: b.localVerification.mode,
    incomingRevisionId: b.incomingRevisionId, baseLocalRevisionId: b.baseLocalRevisionId, localHeadId: b.localHead,
    sourceHashes: clone(b.sourceHashes), decisionCount: changes.length,
    conflictCount: changes.filter(item => item.status === 'conflict').length,
    fetchedAt: b.incomingCheckedAt, acceptedAt: b.localVerification.acceptedAt ?? null };
}

// This selection and its queue/cache are independent of the FCPXML/media scope.
// A preview returns observed data only; no incoming revision is imported.
function createDesktopResolveServiceSync({ directory, connection, store, getCapture = () => null,
  onChange = () => {}, onInvalidate = () => {}, now = Date.now } = {}) {
  if (!store || typeof store.getResolveRevisionGraph !== 'function' || typeof getCapture !== 'function'
    || typeof onChange !== 'function' || typeof onInvalidate !== 'function' || typeof now !== 'function') throw fail('service-binding-invalid');
  let selected = null, source = 'saved-head', epoch = 0, closed = false, lastPreview = null;
  let localError = null, revalidating = 0;
  function accountKey() {
    const state = connection.getState();
    return ['connected', 'offline'].includes(state.status) && state.account?.id
      ? fingerprint([state.origin, state.account.id]) : null;
  }
  let connectionKey = accountKey();
  function invalidate() { if (lastPreview) { lastPreview = null; onInvalidate(); } }
  function identity(state) {
    return fingerprint({ origin: state.origin, accountId: state.account?.id || null, selection: state.selection,
      binding: state.binding, base: state.base, fetched: state.fetched, local: selected });
  }
  function decorated(state) { return { ...state, local: clone(selected), error: localError || state.error,
    comparison: state.comparison.status === 'ready' && !lastPreview
      ? { status: 'none', result: null, error: null } : state.comparison }; }
  function captureSource() {
    const value = getCapture();
    if (!value?.manifest || !value.verification) throw fail('service-resolve-capture-required');
    const v = value.verification;
    const checkedAt = now();
    if (v.mode !== 'verified-capture' || !Number.isSafeInteger(v.acceptedAt) || !Number.isSafeInteger(checkedAt)
      || v.acceptedAt > checkedAt || checkedAt - v.acceptedAt > 300000) throw fail('service-resolve-comparison-capture-expired');
    return clone(value);
  }
  const controller = createDesktopRevisionSync({ directory, connection, store,
    getSelection: () => selected ? { localProjectId: selected.projectId, branch: selected.branch } : null,
    getLocalComparisonSource: async ({ signal }) => {
      const picked = selected, currentEpoch = epoch;
      if (!picked) throw fail('service-resolve-project-required');
      const graph = await store.getResolveRevisionGraph(picked.projectId);
      if (closed || signal.aborted || epoch !== currentEpoch || selected !== picked || graph.currentBranch !== picked.branch) throw fail('service-selection-changed');
      const headId = graph.branches[picked.branch];
      if (!headId) throw fail('service-resolve-project-required');
      const current = source === 'verified-capture' ? captureSource()
        : { manifest: (await store.getRevision(picked.projectId, headId)).manifest, verification: { mode: 'saved-head' } };
      if (closed || signal.aborted || epoch !== currentEpoch || selected !== picked) throw fail('service-selection-changed');
      if (current.manifest?.snapshot?.project_id !== graph.editorProjectId) throw fail('service-resolve-comparison-unsupported');
      return { localProjectId: picked.projectId, branch: picked.branch, headId, ...current };
    },
    buildComparison: (input, verification) => createServiceResolveComparison(input, verification, { now }),
    describeComparison: describeResolveServiceComparison,
    onChange: state => {
      if (lastPreview && (identity(state) !== lastPreview.context || !revalidating && state.comparison.status !== 'ready')) invalidate();
      onChange(decorated(state));
    } });

  async function getState() {
    const state = await controller.getState();
    let captureMatches = true;
    if (lastPreview?.binding.localVerification.mode === 'verified-capture') {
      try {
        const current = captureSource();
        captureMatches = fingerprint(current.verification) === fingerprint(lastPreview.binding.localVerification)
          && `sha256:${fingerprint(current.manifest)}` === lastPreview.binding.localManifestId;
      } catch { captureMatches = false; }
    }
    if (lastPreview && (identity(state) !== lastPreview.context || !revalidating && state.comparison.status !== 'ready'
      || !captureMatches)) invalidate();
    return decorated(state);
  }
  async function select(projectId) {
    const selectionEpoch = ++epoch; invalidate(); selected = null; localError = null; controller.selectionChanged();
    if (projectId === null) return getState();
    try {
      if (typeof projectId !== 'string' || !UUID.test(projectId)) throw fail('service-resolve-project-required');
      const graph = await store.getResolveRevisionGraph(projectId);
      if (closed || selectionEpoch !== epoch) return getState();
      selected = { projectId, name: graph.displayName || 'Resolve observations', branch: graph.currentBranch, revisionCount: graph.revisions.length };
      controller.selectionChanged();
    } catch { if (selectionEpoch === epoch) localError = 'service-resolve-project-required'; }
    return getState();
  }
  async function preview(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join('|') !== 'source'
      || !['saved-head', 'verified-capture'].includes(input.source)) throw fail('service-resolve-comparison-invalid');
    invalidate(); localError = null;
    if (source !== input.source) { source = input.source; epoch++; controller.selectionChanged(); }
    const previewEpoch = epoch;
    const state = await controller.compare(), result = await controller.getPrivateComparison();
    if (!closed && previewEpoch === epoch && result && state.comparison.status === 'ready') lastPreview = { binding: clone(result.binding), context: identity(state) };
    return decorated(state);
  }
  async function getPreview() {
    if (!lastPreview) return null;
    const state = await getState();
    if (!lastPreview || state.comparison.status !== 'ready') return null;
    const expected = lastPreview;
    const result = await controller.getPrivateComparison();
    return lastPreview === expected && result && fingerprint(result.binding) === fingerprint(expected.binding) ? result : null;
  }
  async function readPreviewSources(expectedBinding) {
    if (!lastPreview || fingerprint(expectedBinding) !== fingerprint(lastPreview.binding)) throw fail('service-resolve-preview-stale');
    const expected = lastPreview, previous = clone(lastPreview); let state, result;
    revalidating++;
    try { state = await controller.compare(); result = await controller.getPrivateComparison(); }
    finally { revalidating--; }
    if (lastPreview !== expected || !result || state.comparison.status !== 'ready' || identity(state) !== previous.context
      || fingerprint(result.binding) !== fingerprint(expectedBinding)) {
      invalidate(); throw fail('service-resolve-preview-stale');
    }
    lastPreview = previous;
    return clone(result.sources);
  }
  function selectionChanged() { epoch++; invalidate(); controller.selectionChanged(); }
  function connectionChanged() {
    const key = accountKey();
    if (key !== connectionKey) { connectionKey = key; epoch++; invalidate(); }
    controller.connectionChanged();
  }
  async function action(method, input) {
    invalidate();
    const picked = selected, currentEpoch = epoch, currentAccount = accountKey();
    if (!picked) return decorated(await controller[method](input));
    const graph = await store.getResolveRevisionGraph(picked.projectId);
    if (closed || epoch !== currentEpoch || currentAccount !== accountKey() || selected !== picked || graph.currentBranch !== picked.branch) {
      selectionChanged(); throw fail('service-selection-changed');
    }
    return decorated(await controller[method](input));
  }
  async function dispose() { closed = true; epoch++; invalidate(); await controller.dispose(); }
  return { getState, select, preview, getPreview, readPreviewSources, selectionChanged, captureChanged: selectionChanged,
    connectionChanged, dispose,
    bind: input => action('bind', input), unlink: () => action('unlink'), check: () => action('check'),
    push: () => action('push'), fetch: () => action('fetch'), retry: id => action('retry', id), cancel: id => action('cancel', id) };
}
module.exports = { createDesktopResolveServiceSync, describeResolveServiceComparison };
