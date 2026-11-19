'use strict';
(() => {
  const el = id => document.getElementById(`storage-${id}`);
  let state = null, pending = false, forgetScope = null, rowLimit = 100, volumeOptionsKey = '', reportRowsKey = '';
  const reasons = { 'size-and-hash-match': 'Verified', 'size-mismatch': 'Size differs', 'hash-mismatch': 'Content differs',
    'candidate-missing': 'Missing', 'candidate-unreadable': 'Cannot read file', 'symlink-unsupported': 'Symbolic link unsupported',
    'not-regular-file': 'Not a regular file', 'file-changed': 'Changed during check' };
  const errors = {
    'shared-storage-label-invalid': 'Enter a label of up to 64 characters, without slashes or colons.',
    'shared-storage-request-invalid': 'This asset request could not be read. Check its format, size, and required hashes.',
    'shared-storage-offline': 'The registered folder is unavailable. Connect its volume and check again.',
    'shared-storage-volume-changed': 'This location has a different folder identity. Locate the original folder or register a new one.',
    'shared-storage-unreadable': 'This folder cannot be read. Check its access permissions.',
    'shared-storage-selection-changed': 'The selection changed. Review the folder and asset request again.',
    'shared-storage-already-registered': 'This folder is already registered. Select its existing registration.',
    'shared-storage-cancelled': 'Check cancelled. No partial report was saved.',
    'shared-storage-report-required': 'Run a new check and resolve every failed asset before preparing a proposal.',
    'shared-storage-proposal-stale': 'The proposal no longer matches the files. Run a fresh check.',
    'shared-storage-state-invalid': 'The saved storage registry could not be verified. Existing media has not been changed.',
    'shared-storage-newer-version': 'This storage registry needs a newer version of Frameline.',
    'shared-storage-storage-uncertain': 'A registry save could not be confirmed. Restart to inspect the saved state.',
    'shared-storage-export-failed': 'The proposal could not be saved. Choose a new filename and retry.',
    'shared-storage-destination-exists': 'A file already exists at that destination. Choose a new filename.'
  };
  const outcomes = { 'volume-registered': 'Folder registered on this computer.', 'volume-renamed': 'Storage label updated.',
    'volume-forgotten': 'Registration forgotten. Files were kept.', 'volume-reconnected': 'The same folder was located and verified.',
    'volume-online': 'Folder connection verified.', 'request-loaded': 'Asset request loaded. Verify its requested media when ready.',
    'verification-complete': 'Media check complete.', 'proposal-ready': 'Relink proposal ready for review.', 'proposal-exported': 'Reviewed proposal saved.' };
  const selected = () => state?.volumes.find(volume => volume.id === state.selectedId);
  const selectionScope = () => selected() ? `${selected().id}:${selected().version}` : null;
  function input() {
    const volume = selected(); return { volumeId: volume?.id, volumeVersion: volume?.version,
      requestHash: state?.request?.requestHash, reportHash: state?.report?.reportHash, proposalHash: state?.proposal?.proposalHash };
  }
  function render() {
    const available = !!state?.available && !!window.desktop?.getSharedStorageState, busy = pending || !!state?.busy;
    const volume = selected(), select = el('volume');
    const optionsKey = JSON.stringify(state?.volumes || []);
    if (optionsKey !== volumeOptionsKey) {
      volumeOptionsKey = optionsKey; select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = '';
      placeholder.textContent = state?.volumes.length ? 'Select a registered folder' : 'No folders registered'; select.append(placeholder);
      for (const item of state?.volumes || []) {
        const option = document.createElement('option'); option.value = item.id;
        option.textContent = `${item.label} · ${item.status}`; select.append(option);
      }
    }
    select.value = state?.selectedId || ''; select.disabled = !available || busy || !state?.volumes.length;
    const validLabel = el('label').value.trim().length > 0 && el('label').value.trim().length <= 64 && !/[\x00-\x1f\x7f/\\:]/.test(el('label').value);
    el('register').disabled = !available || busy || !validLabel;
    for (const action of ['check', 'rename', 'reconnect', 'forget']) el(action).disabled = !available || busy || !volume || action === 'rename' && !validLabel;
    el('import').disabled = !available || busy;
    el('verify').disabled = !available || busy || !volume || !state?.request;
    el('cancel').hidden = !state?.busy || !state?.progress; el('cancel').disabled = !state?.busy;
    if (forgetScope !== selectionScope()) forgetScope = null;
    el('forget-review').hidden = !forgetScope; el('forget-confirm').disabled = busy; el('forget-cancel').disabled = busy;
    let status = !available ? 'Open the desktop app to register and check storage.'
      : busy ? 'Checking storage…' : outcomes[state?.outcome] || (volume ? `${volume.label} · ${volume.status}.` : 'Choose a folder to register, or select an existing registration.');
    if (state?.error) status = errors[state.error] || 'Storage action could not be completed. Check your selection and try again.';
    el('status').textContent = status;
    document.getElementById('shared-storage-panel').setAttribute('aria-busy', String(busy));
    el('interrupted').hidden = !state?.interrupted;
    el('request').hidden = !state?.request;
    el('project').textContent = state?.request?.projectId || ''; el('source').textContent = state?.request?.sourceHash || '';
    el('count').textContent = String(state?.request?.assetCount || 0);
    const progress = state?.progress; el('progress-area').hidden = !progress;
    if (progress) {
      el('progress').max = progress.total; el('progress').value = progress.completed;
      el('progress-text').textContent = `${progress.completed} of ${progress.total} assets checked · ${progress.bytesRead.toLocaleString()} bytes read`;
    }
    const report = state?.report || state?.historicalReport, historical = !state?.report;
    el('report').hidden = !report;
    const rowsKey = `${report?.reportHash || ''}:${el('filter').value}:${rowLimit}`;
    const renderRows = rowsKey !== reportRowsKey;
    if (renderRows) { reportRowsKey = rowsKey; el('results').replaceChildren(); }
    if (report) {
      const verified = report.items.filter(item => item.verified).length;
      el('report-title').textContent = historical ? 'Last saved media check' : 'Media check';
      el('report-summary').textContent = `${verified} of ${report.items.length} verified${historical ? ' at the last check. Import the request and verify again to prepare a proposal.' : '.'}`;
      el('report-time').textContent = `Checked ${new Date(report.checkedAt).toLocaleString()} · requested project ${report.projectId}`;
      const filter = el('filter').value, filtered = report.items.filter(item => filter === 'all' || (filter === 'verified' ? item.verified : !item.verified));
      for (const item of renderRows ? filtered.slice(0, rowLimit) : []) {
        const row = document.createElement('tr');
        for (const value of [item.id, item.assetClass, reasons[item.reason] || 'Unknown']) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        el('results').append(row);
      }
      el('results-count').textContent = `${Math.min(rowLimit, filtered.length)} of ${filtered.length} matching assets shown.`;
      el('more').hidden = rowLimit >= filtered.length;
    }
    el('prepare').disabled = !available || busy || !state?.report || !state?.request || !report?.items.every(item => item.verified);
    el('proposal').hidden = !state?.proposal;
    el('proposal-summary').textContent = state?.proposal ? `${state.proposal.assets.length} verified assets for ${state.proposal.projectId}.` : '';
    el('proposal-hash').textContent = state?.proposal?.proposalHash || '';
    el('export').disabled = !available || busy || !state?.proposal;
  }
  async function run(method, value) {
    if (pending || !window.desktop?.[method]) return;
    pending = true; const focus = document.activeElement; render();
    try { state = await window.desktop[method](value); }
    catch { state = { ...state, error: 'shared-storage-unavailable' }; }
    finally {
      pending = false; render();
      if (focus?.disabled || focus?.closest('[hidden]')) el('status').focus({ preventScroll: true });
    }
  }
  el('register-form').addEventListener('submit', event => { event.preventDefault(); if (!el('register').disabled) run('registerSharedStorage', el('label').value.trim()); });
  el('label').addEventListener('input', render);
  el('volume').addEventListener('change', () => { forgetScope = null; rowLimit = 100; run('selectSharedStorage', el('volume').value || null); });
  for (const [button, method] of [['check', 'checkSharedStorage'], ['reconnect', 'reconnectSharedStorage'],
    ['verify', 'verifySharedStorage'], ['prepare', 'prepareSharedStorageProposal'], ['export', 'exportSharedStorageProposal']]) {
    el(button).addEventListener('click', () => { if (!el(button).disabled) run(method, input()); });
  }
  el('rename').addEventListener('click', () => run('renameSharedStorage', { ...input(), label: el('label').value.trim() }));
  el('forget').addEventListener('click', () => { forgetScope = selectionScope(); render(); el('forget-confirm').focus(); });
  el('forget-cancel').addEventListener('click', () => { forgetScope = null; render(); el('forget').focus(); });
  el('forget-confirm').addEventListener('click', () => { if (forgetScope && forgetScope === selectionScope()) { forgetScope = null; run('forgetSharedStorage', input()); } });
  el('import').addEventListener('click', () => { rowLimit = 100; run('importSharedStorageRequest'); });
  el('cancel').addEventListener('click', async () => { try { await window.desktop?.cancelSharedStorage?.(); } catch { /* Running action reports the final cancellation. */ } });
  el('filter').addEventListener('change', () => { rowLimit = 100; render(); });
  el('more').addEventListener('click', () => { rowLimit += 100; render(); });
  if (window.desktop?.onSharedStorageState) window.desktop.onSharedStorageState(value => { state = value; render(); });
  render(); if (window.desktop?.getSharedStorageState) run('getSharedStorageState');
})();
