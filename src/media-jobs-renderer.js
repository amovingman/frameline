'use strict';
(() => {
  const el = id => document.getElementById(`media-jobs-${id}`);
  const kinds = { hash: 'File hash', 'asset-check': 'Asset check', thumbnail: 'Clip thumbnail', proxy: 'Lightweight proxy', 'timeline-preview': 'Timeline storyboard' };
  const messages = {
    'media-jobs-unavailable': 'Background job storage is unavailable. Check disk space and app folder permissions, then reopen Frameline. Project scanning remains available.',
    'media-jobs-storage-unavailable': 'The job journal could not be saved. Check disk space and app folder permissions, then reopen Frameline. No new jobs will run.',
    'media-storage-unavailable': 'The job journal could not be saved. Check disk space and app folder permissions, then reopen Frameline. No new jobs will run.',
    'selection-changed': 'The selected export changed. Reselect it and queue a new job.',
    'source-changed': 'The media changed. Choose the current file and queue a new job.',
    'policy-disabled': 'Enable previews and confirm permission for this project. If settings changed, queue a new job.',
    'preview-rights-required': 'Confirm permission to generate previews before queuing this job.',
    'no-selected-media': 'Choose a local media file before queuing this job.',
    'no-selected-project': 'Choose and scan a regular FCPXML export first.',
    'invalid-media-job': 'Check the job type and source frame, then queue the job again.',
    'invalid-media-job-state': 'The job changed while the action was pending. Review its current status.',
    'media-job-attempt-limit': 'This job reached its retry limit. Check the source, then choose Restart.',
    'media-queue-full': 'The local queue has reached its 1,000-job capacity. Existing jobs remain available.',
    'invalid-media-policy': 'Enter a storage rate between 0 and 100,000 USD per GiB per month, or leave it blank.',
    'media-job-cancelled': 'The job was cancelled. Restart it when you are ready.',
    'ENOENT': 'The media file is missing. Reconnect the drive or choose an available file.',
    'EACCES': 'The media file cannot be read. Check its permissions, then retry.',
    'EPERM': 'The operating system refused access to this media. Check file permissions, then retry.',
    'symlink-unsupported': 'This source uses a symbolic link. Choose a regular local file.',
    'unsupported-frame-rate': 'A frame rate could not be observed. Use source frame 0 or choose another video.',
    'preview-clip-limit': 'This storyboard exceeds the 24-clip limit. Choose a smaller flat timeline export.',
    'unsupported-preview-structure': 'This timeline contains unsupported constructs. Use a flat primary picture track without effects, transitions or nested clips.',
    'ambiguous-preview-overlap': 'Overlapping picture clips make this storyboard ambiguous. Choose a flat timeline without overlapping pictures.',
    'nonlocal-preview-source': 'The export references nonlocal media. Choose an export referencing local original files.',
    'media-selection-changed': 'The selected export changed. Reselect the current export and queue the job again.',
    'media-preview-disabled': 'Enable preview generation for this project before queuing previews.',
    'media-rights-required': 'Confirm that you have permission to generate these previews.',
    'media-renderer-unavailable': 'The media renderer is unavailable. Install a build containing the macOS media helper. Hashing and checks remain available.',
    'media-artifact-unavailable': 'This preview could not be verified. Restart the job to generate a new result.',
    'media-job-failed': 'The job could not be completed. Check the local media and retry.',
    'media-source-changed': 'The source changed. Choose the current media file and queue a new job.'
  };
  let state = null, pending = false, page = 0, rowsKey = '', scopeKey = '', notice = '', policyKey = '', previewSequence = 0;
  const size = bytes => bytes < 1024 ? `${bytes || 0} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  const errorText = code => messages[code] || `The operation was refused (${String(code || 'media-job-failed').replace(/[^a-z0-9-]/g, '')}). Check the source and settings before retrying.`;
  function clearPreview() { previewSequence++; el('preview-slot').replaceChildren(); el('preview-figure').hidden = true; }
  function accept(next) {
    if (!next || !Array.isArray(next.jobs)) return;
    const nextScope = JSON.stringify([next.projectId, next.sourceHash, next.source?.id, next.available]);
    if (nextScope !== scopeKey || !next.policy?.enabled || !next.policy?.rightsConfirmed || next.error === 'media-storage-unavailable') clearPreview();
    if (nextScope !== scopeKey) { scopeKey = nextScope; page = 0; policyKey = ''; }
    state = next;
    if (next.error) notice = errorText(next.error);
    render();
  }
  async function run(action, success = '') {
    if (pending) return;
    pending = true; notice = ''; render();
    try { const next = await action(); accept(next); if (next?.error) notice = errorText(next.error); else notice = success; }
    catch { notice = errorText('media-job-failed'); }
    finally { pending = false; render(); }
  }
  function button(label, action, job) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    node.dataset.mediaAction = action; node.setAttribute('aria-label', `${label}: ${kinds[job.kind] || 'job'} ${job.id.slice(-8)}`);
    node.disabled = pending || !state?.available || state?.error === 'media-storage-unavailable';
    return node;
  }
  function renderRows() {
    const jobs = [...(state?.jobs || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || a.id.localeCompare(b.id));
    page = Math.min(page, Math.max(0, Math.ceil(jobs.length / 20) - 1));
    const visible = jobs.slice(page * 20, (page + 1) * 20), key = JSON.stringify([visible, pending]);
    el('range').textContent = jobs.length ? `${page * 20 + 1}–${Math.min(jobs.length, (page + 1) * 20)} of ${jobs.length}` : 'No jobs yet';
    el('previous').disabled = pending || page === 0; el('next').disabled = pending || (page + 1) * 20 >= jobs.length;
    if (key === rowsKey) return;
    rowsKey = key;
    const active = document.activeElement, focusJob = active?.closest('[data-job-id]')?.dataset.jobId, focusAction = active?.dataset.mediaAction;
    const nodes = visible.map(job => {
      const row = document.createElement('article'); row.dataset.jobId = job.id; row.className = 'media-job';
      const title = document.createElement('h3'); title.textContent = `${kinds[job.kind] || 'Job'} · ${job.id.slice(-8)}`;
      const source = document.createElement('p'); source.textContent = job.sourceName || 'Selected project media';
      const status = document.createElement('p'); status.textContent = `${job.status} · ${job.progress}% · attempt ${job.attempts} · ${Math.round(job.processingMs || 0)} ms`;
      const progress = document.createElement('progress'); progress.max = 100; progress.value = job.progress; progress.setAttribute('aria-label', `${kinds[job.kind]} progress`);
      const actions = document.createElement('div'); actions.className = 'media-job-actions';
      if (['queued', 'running', 'paused'].includes(job.status)) actions.append(button('Cancel', 'cancel', job));
      if (!job.requiresNewJob && job.status === 'paused' && job.attempts < 3) actions.append(button('Resume', 'resume', job));
      if (!job.requiresNewJob && job.status === 'failed' && job.attempts < 3) actions.append(button('Retry', 'retry', job));
      if (!job.requiresNewJob && ['failed', 'cancelled', 'completed', 'paused'].includes(job.status)) actions.append(button('Restart', 'restart', job));
      if (job.status === 'completed' && job.result?.mimeType) {
        if (job.result.mimeType.startsWith('image/')) actions.append(button('Preview', 'preview', job));
        actions.append(button('Show cached file', 'reveal', job));
      }
      row.append(title, source, status, progress);
      if (job.requiresNewJob) { const stale = document.createElement('p'); stale.textContent = 'Inputs or preview permission changed. Queue a new job for the current selection.'; row.append(stale); }
      if (job.error) { const error = document.createElement('p'); error.className = 'media-job-error'; error.textContent = errorText(job.error); row.append(error); }
      if (job.result?.sha256) { const hash = document.createElement('code'); hash.textContent = `SHA-256 ${job.result.sha256}`; row.append(hash); }
      if (job.result?.byteLength != null) { const bytes = document.createElement('p'); bytes.textContent = `${size(job.result.byteLength)}${job.result.canonical === false ? ' · optional local derivative' : ''}`; row.append(bytes); }
      if (job.result?.width && job.result?.height) { const dimensions = document.createElement('p'); dimensions.textContent = `${job.result.width} × ${job.result.height}${Number.isFinite(job.result.durationSeconds) ? ` · ${job.result.durationSeconds.toFixed(2)} seconds` : ''}${job.result.clipCount ? ` · ${job.result.clipCount} clips` : ''}`; row.append(dimensions); }
      if (job.kind === 'asset-check' && job.result) { const inspection = document.createElement('p'); inspection.textContent = job.result.inspection === 'unavailable' ? 'File bytes verified. Native media inspection is unavailable.' : 'Local file bytes verified.'; row.append(inspection); }
      row.append(actions); return row;
    });
    el('list').replaceChildren(...nodes);
    if (focusJob && focusAction) {
      const row = [...el('list').children].find(node => node.dataset.jobId === focusJob);
      const target = [...(row?.querySelectorAll('button') || [])].find(node => node.dataset.mediaAction === focusAction);
      if (target) target.focus({ preventScroll: true });
      else if (row) { row.tabIndex = -1; row.focus({ preventScroll: true }); }
    }
  }
  function render() {
    const available = !!state?.available && state.error !== 'media-storage-unavailable', kind = el('kind').value, rendering = ['thumbnail', 'proxy', 'timeline-preview'].includes(kind);
    el('availability').textContent = !available ? 'Choose and scan a regular FCPXML export to use background jobs.'
      : state.renderingAvailable ? 'Local worker ready. Preview generation is optional; interrupted jobs need an explicit resume.'
        : 'Hashing and file checks are available. Rendering requires a macOS build with the media helper.';
    const nextPolicy = JSON.stringify([state?.policy, available]);
    if (nextPolicy !== policyKey) {
      policyKey = nextPolicy; el('enable').checked = !!state?.policy?.enabled; el('rights').checked = !!state?.policy?.rightsConfirmed;
      el('cost').value = state?.policy?.costPerGiBMonthUSD ?? '';
    }
    for (const id of ['enable', 'rights', 'source-choose', 'kind', 'settings-save', 'cost']) el(id).disabled = pending || !available;
    el('source-name').textContent = state?.source?.name || 'No media selected';
    el('frame-field').hidden = kind !== 'thumbnail'; el('frame').disabled = pending || !available;
    el('submit').disabled = pending || !available || (kind !== 'timeline-preview' && !state?.source)
      || (rendering && (!state.renderingAvailable || !state.policy?.enabled || !state.policy?.rightsConfirmed));
    el('status').textContent = notice;
    if (state?.available && state.metrics) {
      const m = state.metrics, counts = m.counts || {};
      const cost = m.estimatedMonthlyStorageCostUSD;
      const estimate = cost == null ? 'unknown (no rate set)' : cost > 0 && cost < 0.0001 ? '<$0.0001 USD' : `$${cost.toFixed(4)} USD`;
      el('metrics').textContent = `Backlog ${m.backlog} · Running ${counts.running || 0} · Paused ${counts.paused || 0} · Completed ${counts.completed || 0} · Failures ${m.failures} · Processing ${Math.round(m.processingMs || 0)} ms · Cache ${size(m.cacheBytes)} · Monthly storage estimate ${estimate}`;
    } else el('metrics').textContent = 'No measurements for a current project. Choose and scan a regular FCPXML export.';
    renderRows();
  }
  const policy = () => ({ enabled: el('enable').checked, rightsConfirmed: el('rights').checked,
    costPerGiBMonthUSD: el('cost').value === '' ? null : Number(el('cost').value) });
  el('source-choose').addEventListener('click', () => run(() => window.desktop.chooseMediaJobSource()));
  for (const id of ['enable', 'rights']) el(id).addEventListener('change', () => { const input = policy(); run(() => window.desktop.saveMediaJobsPolicy(input), 'Preview settings saved for this project.'); });
  el('settings-save').addEventListener('click', () => { if (!el('cost').reportValidity()) return; const input = policy(); run(() => window.desktop.saveMediaJobsPolicy(input), 'Storage estimate rate saved.'); });
  el('kind').addEventListener('change', render);
  el('form').addEventListener('submit', event => {
    event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
    const kind = el('kind').value, input = { kind, rightsConfirmed: el('rights').checked };
    if (kind === 'thumbnail') input.frame = Number(el('frame').value);
    run(() => window.desktop.enqueueMediaJob(input), 'Job queued. Identical inputs reuse the same job.');
  });
  el('list').addEventListener('click', event => {
    const target = event.target.closest('button[data-media-action]'); if (!target || pending) return;
    const id = target.closest('[data-job-id]').dataset.jobId, action = target.dataset.mediaAction;
    if (action === 'preview') {
      const request = ++previewSequence, expectedScope = scopeKey;
      const expectedHash = state?.jobs.find(job => job.id === id)?.result?.sha256;
      return run(async () => {
      const result = await window.desktop.previewMediaJob(id);
      const current = state?.jobs.find(job => job.id === id);
      if (request !== previewSequence || scopeKey !== expectedScope || !state?.policy?.enabled || !state?.policy?.rightsConfirmed
        || !expectedHash || current?.result?.sha256 !== expectedHash) return { error: 'media-artifact-unavailable' };
      if (!result.error && typeof result.dataUrl === 'string' && /^data:image\/(png|jpeg);base64,/.test(result.dataUrl)) {
        const preview = document.createElement('img'); preview.id = 'media-jobs-preview';
        preview.alt = 'Generated local media preview'; preview.src = result.dataUrl;
        el('preview-slot').replaceChildren(preview); el('preview-figure').hidden = false;
        el('preview-caption').textContent = `Optional local preview · ${id.slice(-8)}. Original media and canonical edit data are unchanged.`;
      } else clearPreview();
      return result;
      });
    }
    if (action === 'reveal') return run(() => window.desktop.revealMediaJob(id), 'Verified cached file shown in Finder.');
    const methods = { cancel: 'cancelMediaJob', retry: 'retryMediaJob', resume: 'resumeMediaJob', restart: 'restartMediaJob' };
    if (methods[action]) run(() => window.desktop[methods[action]](id));
  });
  el('previous').addEventListener('click', () => { page--; renderRows(); });
  el('next').addEventListener('click', () => { page++; renderRows(); });
  el('preview-close').addEventListener('click', clearPreview);
  if (window.desktop?.getMediaJobsState) {
    window.desktop.onMediaJobsState(accept);
    run(() => window.desktop.getMediaJobsState());
  } else render();
})();
