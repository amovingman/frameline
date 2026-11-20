(function () {
  'use strict';
  const desktop = window.desktop, panel = document.getElementById('publication-review');
  if (!desktop || !panel) return;
  const el = id => document.getElementById(`publication-${id}`);
  let current = null, busy = false, generation = 0, returnFocus = null, preparing = null;
  const latest = new Map();
  const api = kind => kind === 'resolve'
    ? { state: 'getResolveServiceState', preview: 'previewResolvePublication', page: 'getResolvePublicationPage', dismiss: 'dismissResolvePublication', push: 'pushResolveServiceRevisions', retry: 'retryResolveServiceSync' }
    : { state: 'getServiceState', preview: 'previewServicePublication', page: 'getServicePublicationPage', dismiss: 'dismissServicePublication', push: 'pushServiceRevisions', retry: 'retrySync' };
  function clearContent() {
    el('json').textContent = ''; el('scope').textContent = ''; el('hash').textContent = '';
    el('range').textContent = ''; el('consent').checked = false;
  }
  const matches = (review, state) => state?.publicationScopeId === review.scopeId && state.publicationGeneration === review.generation
    && ['owner', 'editor'].includes(state.binding?.role);
  const messages = {
    'publication-review-required': 'Prepare a new review before publishing.',
    'publication-review-stale': 'The project, account, or queued work changed. Review the metadata again.',
    'publication-review-too-large': 'This metadata review exceeds the supported size.',
    'service-viewer-read-only': 'This account can read history but cannot publish revisions.',
    'service-project-required': 'Save and select a local revision before preparing a review.',
    'service-project-unavailable': 'Link an available service project before preparing a review.',
    'service-sign-in-required': 'Sign in before preparing a review.'
  };
  function render() {
    el('approve').disabled = busy || !current?.reviewId || !el('consent').checked;
    el('consent').disabled = busy || !current?.reviewId;
    el('previous').disabled = busy || !current || current.page === 0;
    el('next').disabled = busy || !current || current.page + 1 >= current.pageCount;
    el('cancel').disabled = busy;
  }
  async function close() {
    const old = current, epoch = ++generation; current = null; preparing = null;
    if (old?.reviewId) await desktop[api(old.kind).dismiss]({ reviewId: old.reviewId }).catch(() => {});
    if (epoch !== generation) return;
    panel.hidden = true; clearContent();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  async function start(kind, operationId = null) {
    if (busy) return;
    if (current?.reviewId) await desktop[api(current.kind).dismiss]({ reviewId: current.reviewId }).catch(() => {});
    const epoch = ++generation; busy = true; current = null; preparing = { kind, epoch }; returnFocus = document.activeElement;
    panel.hidden = false; clearContent();
    el('scope').textContent = 'Preparing the exact revision metadata for review…'; el('status').textContent = '';
    el('range').textContent = ''; el('hash').textContent = ''; render();
    panel.scrollIntoView({ block: 'start' }); el('title').focus({ preventScroll: true });
    try {
      const value = await desktop[api(kind).preview]({ action: operationId ? 'retry' : 'push', ...(operationId ? { operationId } : {}) });
      if (epoch !== generation) return;
      if (value.error) throw value;
      const state = await desktop[api(kind).state]();
      if (epoch !== generation) return;
      const newer = latest.get(kind);
      if (!matches(value, state) || newer?.version > state.version && !matches(value, newer)) throw { error: 'publication-review-stale' };
      current = { ...value, kind }; el('json').textContent = value.text;
      el('scope').textContent = `${value.projectName} · ${value.branch} · ${value.destination} · ${value.revisionCount} revision records · ${value.byteLength.toLocaleString()} review bytes`;
      el('range').textContent = `Page ${value.page + 1} of ${value.pageCount}`;
      el('hash').textContent = `Review SHA-256: ${value.sha256}`;
    } catch (error) { if (epoch === generation) { clearContent(); el('status').textContent = messages[error?.error || error?.code] || 'Could not prepare the metadata review. Check the linked project and try again.'; } }
    finally { if (epoch === generation) { preparing = null; busy = false; render(); } }
  }
  async function page(offset) {
    if (!current || busy) return; busy = true; render();
    const captured = current, epoch = generation;
    try {
      const value = await desktop[api(captured.kind).page]({ reviewId: captured.reviewId, page: captured.page + offset });
      if (epoch !== generation || current !== captured) return;
      if (value.error) throw value;
      current = { ...captured, ...value }; el('json').textContent = value.text;
      el('range').textContent = `Page ${value.page + 1} of ${value.pageCount}`;
      el('json').focus({ preventScroll: true });
    } catch (error) { if (epoch === generation && current === captured) { current = null; clearContent(); el('status').textContent = messages[error?.error] || 'Prepare a new metadata review.'; } }
    finally { if (epoch === generation) { busy = false; render(); } }
  }
  async function approve() {
    if (!current || busy || !el('consent').checked) return;
    busy = true; render(); const captured = current, epoch = generation;
    try {
      const approval = { reviewId: captured.reviewId, sha256: captured.sha256, confirmed: true };
      const result = await desktop[api(captured.kind)[captured.operationId ? 'retry' : 'push']](captured.operationId ? { id: captured.operationId, ...approval } : approval);
      if (epoch !== generation) return;
      current = null; clearContent();
      el('status').textContent = result.error ? messages[result.error] || 'Publishing did not finish. Check history, then prepare a fresh review before retrying.'
        : 'The reviewed publication finished. Check service history for its acknowledgment.';
    } catch { if (epoch === generation) { current = null; clearContent(); el('status').textContent = 'Publishing did not finish. Prepare a new review before retrying.'; } }
    finally { if (epoch === generation) { busy = false; render(); } }
  }
  el('consent').addEventListener('change', render);
  el('approve').addEventListener('click', approve); el('cancel').addEventListener('click', close);
  el('previous').addEventListener('click', () => page(-1)); el('next').addEventListener('click', () => page(1));
  const observe = kind => state => {
    const previous = latest.get(kind); latest.set(kind, state);
    if (preparing?.kind === kind && previous && (state.publicationScopeId !== previous.publicationScopeId
      || state.publicationGeneration !== previous.publicationGeneration || !['owner', 'editor'].includes(state.binding?.role))) {
      generation++; preparing = null; busy = false; clearContent(); panel.hidden = true; render();
    }
    if (!current || current.kind !== kind) return;
    if (!matches(current, state)) {
      const old = current; current = null; generation++; busy = false;
      panel.hidden = true; clearContent();
      desktop[api(old.kind).dismiss]({ reviewId: old.reviewId }).catch(() => {});
    }
  };
  desktop.onServiceState?.(observe('fcpxml')); desktop.onResolveServiceState?.(observe('resolve'));
  window.FramePublicationReview = { start };
})();
