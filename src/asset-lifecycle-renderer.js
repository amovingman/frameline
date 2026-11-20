'use strict';
(() => {
  const el = id => document.getElementById(`lifecycle-${id}`);
  let state = null, pending = false, review = null, draftKey = '', retentionKey = '', pendingKey = '', optionsKey = '', rowsKey = '', rowLimit = 100;
  const reasons = { 'not-archived': 'Not archived', 'retention-period': 'Waiting period', 'active-hold': 'Active hold',
    'shared-project': 'Shared content', 'retained-revision': 'Retained revision', 'verification-active': 'Verification active', 'revision-references-unverified': 'Revision references unverified' };
  const errors = { 'lifecycle-report-changed': 'Service state changed between pages. Load the report again.',
    'lifecycle-owner-required': 'A current project owner is required. Refresh owned projects or sign in.',
    'lifecycle-selection-changed': 'The review scope changed. Load a fresh report and review the change again.',
    'lifecycle-refresh-required': 'Load a report before reviewing this action.',
    'asset-lifecycle-version-conflict': 'The saved version changed. Load a fresh report before editing.',
    'asset-lifecycle-plan-stale': 'The reviewed state changed. Load a fresh report and prepare a new plan.',
    'asset-lifecycle-retry-required': 'Resolve the pending request before sending another service change.',
    'asset-lifecycle-intent-storage-uncertain': 'The local retry could not be confirmed. Restart to inspect saved recovery state.',
    'lifecycle-export-stale': 'The export no longer matches service state. Load and review it again.',
    'lifecycle-destination-exists': 'A file exists at that destination. Review the export again and choose a new filename.',
    'service-offline': 'The service is offline. Reconnect before sending a request.',
    'asset-network-unavailable': 'The service did not confirm the request. A saved retry keeps the same request identity.',
    'asset-policy-forbidden': 'Owner access could not be confirmed. Refresh owned projects.',
    'forbidden': 'Project access changed. Refresh owned projects.',
    'asset-response-invalid': 'The service response could not be verified. Load a new report.',
    'asset-gc-blocked': 'Collection is blocked by the current holds, revision references, archive state, or verification. Load a fresh report.',
    'asset-reference-unavailable': 'Retained revision references could not be checked. Reconnect and load a fresh report.',
    'asset-lifecycle-invalid': 'Check the requested settings and expiration time.' };
  const date = at => at === null || at === undefined ? 'Not recorded' : new Date(at).toLocaleString();
  const short = aid => `${aid.slice(0, 19)}…${aid.slice(-6)}`;
  const item = () => state?.items.find(row => row.assetId === state.selectedAssetId);
  const scope = extra => ({ scopeId: state?.scopeId, ...extra });
  function localTime(at) {
    if (at === null) return '';
    const value = new Date(at); return new Date(at - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function isHeld(row) { return row.hold.held && (row.hold.until === null || row.hold.until > state.report.generatedAt); }
  function render() {
    const available = !!state?.available && !!window.desktop?.getAssetLifecycleState, online = available && state.connected;
    const busy = pending || !!state?.busy, ready = online && state.ready, mutable = ready && !busy && !state.pending;
    const row = item(), projectOptions = JSON.stringify(state?.projects || []);
    if (projectOptions !== optionsKey) {
      optionsKey = projectOptions; const placeholder = document.createElement('option'); placeholder.value = '';
      placeholder.textContent = state?.projects.length ? 'Select an owned service project' : 'No owned projects available';
      el('project').replaceChildren(placeholder);
      for (const project of state?.projects || []) {
        const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; el('project').append(option);
      }
    }
    el('project').value = state?.projectId || ''; el('project').disabled = !online || busy || !state?.projects.length;
    el('projects-refresh').disabled = !online || busy;
    el('refresh').disabled = !online || busy || !state?.projectId;
    let message = !available ? 'Sign in to manage media on projects you own.' : !online ? 'Reconnect to load current lifecycle state.'
      : busy ? 'Checking lifecycle state…' : state.outcome?.kind === 'exported' ? 'Reviewed export saved.'
      : state.outcome?.kind === 'gc' ? 'Service confirmed project media collection. The saved receipt records released project bytes and payload bytes scheduled for cleanup. Load a fresh report for current state.'
      : state.outcome?.result ? `Service confirmed ${state.outcome.kind === 'hold' ? state.outcome.result.held ? 'the hold' : 'the release' : 'the waiting period'} at version ${state.outcome.result.version}. Load a fresh report for current state.`
      : state.outcome?.kind === 'dismissed' ? 'Local retry dismissed. The service state was kept.'
      : state.ready ? 'Report loaded. Details describe the recorded check time.' : 'Select an owned project and load its lifecycle report.';
    if (state?.error && available) message = errors[state.error] || 'The lifecycle action could not finish. Check the service connection and retry.';
    el('status').textContent = message; document.getElementById('asset-lifecycle-panel').setAttribute('aria-busy', String(busy));
    if (review?.input.scopeId !== state?.scopeId || review?.method === 'executeLifecycleCollection' && review.input.planId !== state?.plan?.planId) review = null;
    el('mutation-review').hidden = !review;
    el('mutation-summary').textContent = review?.summary || ''; el('mutation-confirm').disabled = !mutable || !review;
    el('mutation-confirm').textContent = review?.method === 'executeLifecycleCollection' ? 'Collect reviewed assets' : 'Confirm service change';
    const record = state?.pending; el('pending').hidden = !record;
    if ((record?.id || '') !== pendingKey) { pendingKey = record?.id || ''; el('dismiss-reviewed').checked = false; }
    el('pending-summary').textContent = record ? `${record.kind === 'gc' ? 'Media collection' : record.kind === 'hold' ? record.settings.held ? 'Hold change' : 'Hold release' : 'Waiting-period change'}${record.kind === 'gc' ? ` · ${record.settings.assetIds.length} assets · plan ${record.settings.planId}` : ` · expected version ${record.settings.expectedVersion}`} · recorded ${date(record.createdAt)}.` : '';
    el('pending-project').textContent = record?.projectId || ''; el('pending-asset').textContent = record?.assetId || (record?.kind === 'gc' ? record.settings.assetIds.join(', ') : 'Project policy');
    el('pending-settings').textContent = record ? record.kind === 'gc' ? `Reviewed source state ${record.settings.expectedStateHash}` : record.kind === 'hold' ? `${record.settings.reason || 'Released'} · ${record.settings.until === null ? 'No expiration' : date(record.settings.until)}`
      : `${record.settings.minimumArchiveAgeMs / 86400000} days` : '';
    el('retry').disabled = !online || busy || !record || !state.projects.some(p => p.id === record.projectId);
    el('dismiss-reviewed').disabled = !online || busy || !record;
    el('dismiss').disabled = el('dismiss-reviewed').disabled || !el('dismiss-reviewed').checked;
    el('report-area').hidden = !state?.report;
    const count = state?.items.length || 0;
    el('report-summary').textContent = state?.report ? `${count} of ${state.report.totalAssets} published assets loaded · checked ${date(state.report.generatedAt)}. Filters apply to loaded assets.` : '';
    el('reference-summary').textContent = state?.report ? `Retained references: ${state.report.referenceCoverage} · ${state.report.revisionCount} revisions · ${state.report.missingRetainedAssets.length} missing retained assets. ${state.report.logicalBytes.toLocaleString()} project bytes · ${state.report.pendingPhysicalBytes.toLocaleString()} payload bytes awaiting cleanup.` : '';
    const search = el('search').value.trim().toLowerCase(), filter = el('filter').value, assetClass = el('class').value;
    const rows = (state?.items || []).filter(value => (!search || value.assetId.includes(search)) && (assetClass === 'all' || value.identity.assetClass === assetClass)
      && (filter === 'all' || filter === 'held' && isHeld(value) || filter === 'archived' && value.archived || filter === 'shared' && value.sharedProjects || filter === 'candidate' && value.cleanupCandidate));
    const nextRowsKey = JSON.stringify([state?.scopeId, state?.items, state?.selectedIds, state?.selectedAssetId, busy, mutable, search, filter, assetClass, rowLimit]);
    if (nextRowsKey !== rowsKey) {
      rowsKey = nextRowsKey; el('assets').replaceChildren();
      for (const value of rows.slice(0, rowLimit)) {
        const tr = document.createElement('tr'), selectCell = document.createElement('td'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = state.selectedIds.includes(value.assetId);
        checkbox.setAttribute('aria-label', `Include ${value.assetId} in cleanup review`);
        checkbox.disabled = !mutable || !checkbox.checked && state.selectedIds.length >= 100;
        checkbox.addEventListener('change', () => run('selectLifecyclePlanAssets', scope({ assetIds: checkbox.checked
          ? [...state.selectedIds, value.assetId] : state.selectedIds.filter(aid => aid !== value.assetId) })));
        selectCell.append(checkbox); tr.append(selectCell);
        const idCell = document.createElement('td'), button = document.createElement('button'); button.type = 'button';
        button.textContent = short(value.assetId); button.title = value.assetId; button.setAttribute('aria-label', `Inspect ${value.assetId}`);
        button.setAttribute('aria-pressed', String(value.assetId === state.selectedAssetId)); button.disabled = !ready || busy;
        button.addEventListener('click', () => run('selectLifecycleAsset', scope({ assetId: value.assetId }))); idCell.append(button); tr.append(idCell);
        for (const text of [value.identity.assetClass, `${value.archived ? 'Archived' : 'Available'}${isHeld(value) ? ' · held' : ''}`]) {
          const cell = document.createElement('td'); cell.textContent = text; tr.append(cell);
        }
        el('assets').append(tr);
      }
    }
    el('visible').textContent = `${Math.min(rowLimit, rows.length)} of ${rows.length} matching loaded assets shown · ${state?.selectedIds.length || 0} selected for planning (maximum 100).`;
    el('show-more').hidden = rowLimit >= rows.length;
    el('more').disabled = !ready || busy || !state?.report?.nextAssetId;
    el('clear-selection').disabled = !mutable || !state?.selectedIds.length;
    el('plan-prepare').disabled = el('clear-selection').disabled;
    el('report-export').disabled = !mutable;
    el('detail-empty').hidden = !!row; el('detail-content').hidden = !row;
    if (row) {
      for (const [key, value] of Object.entries({ id: row.assetId, size: `${row.identity.size.toLocaleString()} bytes · ${row.identity.assetClass}`,
        archive: row.archived ? date(row.archivedAt) : 'No', eligible: row.archived ? date(row.eligibleAt) : 'Not archived',
        shared: row.sharedProjects ? 'Also present in another project' : 'No shared copy observed',
        hold: row.hold.held ? `${row.hold.reason} · ${row.hold.until === null ? 'No expiration' : `expires ${date(row.hold.until)}`}` : 'No hold',
        retained: row.retainedBy.length ? row.retainedBy.join(', ') : 'No retained revision references',
        reclaimable: `${row.physicalBytesReclaimable.toLocaleString()} bytes`,
        version: row.hold.version, blockers: row.blockers.map(reason => reasons[reason]).join(', ') || 'None' })) el(`detail-${key}`).textContent = String(value);
    }
    const nextDraft = `${state?.scopeId}:${row?.assetId}:${row?.hold.version}`;
    if (nextDraft !== draftKey) { draftKey = nextDraft; el('reason').value = row?.hold.reason || 'manual'; el('until').value = row?.hold.until ? localTime(row.hold.until) : ''; }
    el('hold-fields').disabled = !mutable || !row; el('release-review').disabled = !mutable || !row?.hold.held;
    const nextRetention = `${state?.scopeId}:${state?.report?.retentionPolicy.version}`;
    if (nextRetention !== retentionKey) { retentionKey = nextRetention; el('days').value = state?.report ? String(state.report.retentionPolicy.minimumArchiveAgeMs / 86400000) : ''; }
    el('days').disabled = !mutable; el('retention-review').disabled = !mutable;
    el('retention-current').textContent = state?.report ? `Current: ${state.report.retentionPolicy.minimumArchiveAgeMs / 86400000} days · policy version ${state.report.retentionPolicy.version}.` : '';
    el('plan').hidden = !state?.plan; el('plan-items').replaceChildren();
    if (state?.plan) {
      el('plan-summary').textContent = `${state.plan.items.length} ${state.plan.items.length === 1 ? 'asset' : 'assets'} reviewed · ${state.plan.releaseBytes.toLocaleString()} project bytes to release · ${state.plan.physicalBytesReclaimable.toLocaleString()} uniquely stored payload bytes reclaimable · ${state.plan.ready ? 'ready for explicit collection review' : 'deletion blocked'}.`;
      for (const value of state.plan.items) { const li = document.createElement('li'); li.textContent = `${short(value.assetId)}: ${value.blockers.map(reason => reasons[reason]).join(', ') || (value.sharedProjects ? 'Project membership only; shared bytes stay available' : 'Eligible for collection')}`; el('plan-items').append(li); }
    }
    el('plan-hash').textContent = state?.plan?.planId || '';
    el('collect-review').disabled = !mutable || !state?.plan?.ready;
    const receipt = state?.receipt && state.receipt.projectId === state.projectId ? state.receipt : null;
    el('receipt').hidden = !receipt;
    el('receipt-summary').textContent = receipt ? `${receipt.assetIds.length} project assets collected · ${receipt.logicalBytesReleased.toLocaleString()} project bytes released · ${receipt.physicalBytesScheduled.toLocaleString()} uniquely stored payload bytes scheduled for cleanup. Shared project copies remain available. This receipt records the completed operation; load a report for current storage state.` : '';
    el('receipt-operation').textContent = receipt?.operationId || '';
    el('receipt-assets').textContent = receipt?.assetIds.join(', ') || '';
    el('receipt-export').disabled = !online || busy || !!state?.pending || !receipt;
    el('plan-export').disabled = !mutable || !state?.plan;
    el('export').hidden = !state?.exportReview;
    el('export-summary').textContent = state?.exportReview ? `${state.exportReview.kind === 'receipt' ? 'Collection receipt' : state.exportReview.kind === 'plan' ? 'Cleanup plan' : 'Lifecycle report'} · project ${state.exportReview.projectId} · ${state.exportReview.assetCount} ${state.exportReview.assetCount === 1 ? 'asset' : 'assets'}${state.exportReview.complete ? '' : ' · partial report, more pages remain'}. Locations and credentials are omitted.` : '';
    el('export-hash').textContent = state?.exportReview?.hash || ''; el('export-save').disabled = !online || busy || !!state?.pending || !state?.exportReview || state.exportReview.kind !== 'receipt' && !ready;
  }
  function accept(value) { if (value && (!state || value.version >= state.version)) state = value; render(); }
  async function run(method, input) {
    if (pending || !window.desktop?.[method]) return;
    pending = true; const focused = document.activeElement; render();
    try { accept(await window.desktop[method](input)); }
    catch { state = { ...state, error: 'lifecycle-operation-failed' }; }
    finally { pending = false; render(); if (focused?.disabled || focused && !focused.isConnected || focused?.closest('[hidden]')) el('status').focus({ preventScroll: true }); }
  }
  function showReview(method, input, summary) { review = { method, input, summary }; render(); el('mutation-confirm').focus(); }
  el('projects-refresh').addEventListener('click', () => run('refreshLifecycleProjects'));
  el('project').addEventListener('change', () => { rowLimit = 100; review = null; run('selectLifecycleProject', el('project').value || null); });
  el('refresh').addEventListener('click', () => { rowLimit = 100; review = null; run('refreshLifecycleReport'); });
  el('more').addEventListener('click', () => run('loadMoreLifecycleAssets'));
  el('show-more').addEventListener('click', () => { rowLimit += 100; render(); });
  for (const key of ['search', 'class', 'filter']) el(key).addEventListener(key === 'search' ? 'input' : 'change', () => { rowLimit = 100; render(); });
  el('clear-selection').addEventListener('click', () => run('selectLifecyclePlanAssets', scope({ assetIds: [] })));
  el('plan-prepare').addEventListener('click', () => run('prepareLifecyclePlan', scope({})));
  el('collect-review').addEventListener('click', () => {
    if (el('collect-review').disabled || !state?.plan?.ready) return;
    const plan = state.plan;
    showReview('executeLifecycleCollection', scope({ planId: plan.planId, confirmed: true }),
      `Permanently remove ${plan.items.length} reviewed assets from service project ${state.projectId}: ${plan.items.map(row => row.assetId).join(', ')}. Release ${plan.releaseBytes.toLocaleString()} project bytes; ${plan.physicalBytesReclaimable.toLocaleString()} uniquely stored payload bytes may be reclaimed. Shared copies remain. Local originals and editor projects are untouched. The service rechecks this exact plan before collection.`);
  });
  el('hold-form').addEventListener('submit', event => {
    event.preventDefault(); const row = item(); if (el('hold-fields').disabled || !row) return;
    const until = el('until').value ? new Date(el('until').value).getTime() : null;
    if (until !== null && (!Number.isSafeInteger(until) || until <= Date.now())) { el('status').textContent = 'Choose a future expiration or leave it blank.'; el('until').focus(); return; }
    const reason = el('reason').value;
    showReview('saveLifecycleHold', scope({ assetId: row.assetId, expectedVersion: row.hold.version, held: true, reason, until }),
      `Place a ${reason} hold on ${row.assetId}, replacing observed version ${row.hold.version}. ${until === null ? 'The hold has no expiration.' : `It expires ${date(until)}.`}`);
  });
  el('release-review').addEventListener('click', () => {
    const row = item(); if (!row || el('release-review').disabled) return;
    showReview('saveLifecycleHold', scope({ assetId: row.assetId, expectedVersion: row.hold.version, held: false, reason: null, until: null }),
      `Release the hold on ${row.assetId} at observed version ${row.hold.version}. Archive and revision-reference checks continue to apply.`);
  });
  el('retention-form').addEventListener('submit', event => {
    event.preventDefault(); if (el('retention-review').disabled) return;
    const days = el('days').value.trim(), value = Number(days), minimumArchiveAgeMs = Math.round(value * 86400000);
    if (!days || !Number.isFinite(value) || value < 0 || value > 3650 || !Number.isSafeInteger(minimumArchiveAgeMs)) { el('days').focus(); return; }
    showReview('saveLifecycleRetention', scope({ expectedVersion: state.report.retentionPolicy.version, minimumArchiveAgeMs }),
      `Set the minimum archive waiting period to ${minimumArchiveAgeMs / 86400000} days for ${state.projectId}, replacing policy version ${state.report.retentionPolicy.version}. Holds and reference checks remain required.`);
  });
  el('mutation-confirm').addEventListener('click', () => { if (!review || el('mutation-confirm').disabled) return; const action = review; review = null; run(action.method, action.input); });
  el('mutation-cancel').addEventListener('click', () => { review = null; render(); el('status').focus(); });
  el('retry').addEventListener('click', () => run('retryLifecycleRequest', scope({ pendingId: state?.pending?.id })));
  el('dismiss-reviewed').addEventListener('change', render);
  el('dismiss').addEventListener('click', () => { if (!el('dismiss').disabled) run('dismissLifecycleRequest', scope({ pendingId: state.pending.id, reviewed: true })); });
  for (const kind of ['report', 'plan', 'receipt']) el(`${kind}-export`).addEventListener('click', () => run('prepareLifecycleExport', scope({ kind })));
  el('export-save').addEventListener('click', () => run('saveLifecycleExport', scope({ hash: state?.exportReview?.hash })));
  window.desktop?.onAssetLifecycleState?.(accept); render(); if (window.desktop?.getAssetLifecycleState) run('getAssetLifecycleState');
})();
