(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductTruth = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const VIEWS = new Set(['workspace', 'history', 'media', 'resolve']);
  const count = value => Array.isArray(value) ? value.length : null;
  function describeProductTruth({ view = 'workspace', appState = null, resolveState = null, serviceState = null } = {}) {
    if (!VIEWS.has(view)) view = 'workspace';
    const selected = !!appState?.selectedProject, scanReady = selected && appState?.scanStatus === 'ready' && !!appState.scan;
    let sourceKind, title, detail;
    if (view === 'resolve') {
      const ready = resolveState?.status === 'ready' && !!resolveState.plan;
      sourceKind = ready ? 'observation' : 'empty';
      title = ready ? resolveState.sourceMode === 'service-history' ? 'Service history observations' : 'Resolve source observations' : 'No Resolve sources selected';
      detail = ready
        ? 'This review compares captured values from the three verified sources. Matching observations do not prove complete editor equivalence, the current live branch, or a successful apply.'
        : 'Choose base, local, and incoming captures, or explicitly preview saved history. This view has no demonstration timeline.';
    } else if (!selected) {
      sourceKind = 'sample';
      title = { workspace: 'Sample comparison', history: 'Sample local revision history', media: 'Sample media inventory' }[view];
      detail = { workspace: 'The proposed edits, conflicts, footage, and timeline values below are illustrative. Choose an FCPXML export or Resolve captures to inspect your own sources.',
        history: 'The example local history list contains demonstration messages, branches, dates, and authors. Service panels show their own selected service scope independently.',
        media: 'The example media table contains demonstration names and availability. Actual local-file checks appear after an FCPXML export is selected; service asset controls describe their own linked scope.' }[view];
    } else if (view === 'history') {
      sourceKind = 'history'; title = 'Local branch history';
      const revisions = count(appState.revisions);
      detail = `${revisions === null ? 'Revision count unavailable' : `${revisions} saved revision${revisions === 1 ? '' : 's'}`} on the selected branch. Sequence and media inventory comparisons are read only; saved observations do not authorize editor changes.`;
    } else if (scanReady) {
      sourceKind = 'scan'; title = view === 'media' ? 'Local media checks' : 'Read-only FCPXML scan';
      detail = view === 'media'
        ? 'Local availability describes the last scan. External references are unchecked, unspecified sources remain unknown, and a missing file is distinct from an uncheckable one. This inventory check does not upload or relink media; service transfers require their separate explicit review.'
        : 'This is the supported top-level picture inventory from the selected export. Omitted constructs and unresolved clip identity remain explicit; these frames are not a complete editor project.';
    } else {
      sourceKind = 'unavailable'; title = appState?.scanStatus === 'scanning' ? 'Scanning the selected export' : 'Selected export inventory unavailable';
      detail = 'No sample values stand in for this selected export. Resolve the scan error or wait for the scan to finish before inspecting its inventory.';
    }
    const status = serviceState?.status;
    const service = status === 'connected' ? { state: 'connected', text: 'Connected service: access and history describe the selected service scope. Media availability still needs its own explicit check.' }
      : status === 'offline' ? { state: 'offline', text: 'Service offline: retained service history and access describe the last successful check, not current remote availability.' }
        : ['not-configured', 'disconnected', 'sign-in-required'].includes(status)
          ? { state: 'disconnected', text: 'Service disconnected. This view is available locally.' }
          : status === 'connecting' ? { state: 'connecting', text: 'Service connection is being checked.' }
            : { state: 'unknown', text: 'Service connection status is unavailable.' };
    return { view, sourceKind, title, detail, service, ordinaryApplyAvailable: false, releaseSupported: false };
  }
  return Object.freeze({ describeProductTruth });
});
