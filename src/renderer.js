const sample = window.FRAME_SAMPLE;
const changes = new Map(sample.changes.map(change => [change.id, change]));
let selectedChangeId = 'trim';
let currentAppState = null;
let branchBusy = false;
let reviewCopyBusy = false;
let reviewCopySource = null;
let verifiedReviewCopy = null;
let mediaAuditBusy = false;
let mediaAuditReports = {};
let mediaSearchReports = {};
let mediaAuditJobState = null;
let mediaAuditStateVersion = -1;
let mediaAuditActionNotice = '';
let mediaAuditVisibleJobs = 20;
let mediaAuditReportRenderKey = '';
let copyMediaAuditRenderKey = '';
const mediaAuditActions = new Set();
const mediaAuditJobRows = new Map();
const mediaAuditDependencyPages = {};
const mediaAuditDependencyOpen = new Set();
let syncBusy = false;
let serviceState = null;
let serviceStateVersion = -1;
let serviceActionBusy = false;
let serviceActionMethod = null;
let serviceActionNotice = '';
let serviceBaseTransition = false;
let serviceComparisonRenderKey = '';
let serviceLocalSelectionKey = null;
let serviceProjectChoice = '';
let serviceBranchChoice = '';
let serviceBindingChoiceKey = '';
let serviceProjectsRenderKey = '';
let serviceBranchesRenderKey = '';
let serviceFetchedRenderKey = '';
let serviceFetchedVisible = 20;
let serviceOriginInitialized = false;
let branchReviewState = null;
let branchReviewVersion = -1;
let branchReviewAccountKey = '';
let branchReviewAccessKey = '';
let branchReviewEvidenceKey = '';
let branchReviewProjectChoice = '';
let branchReviewBranchChoice = '';
let branchReviewProjectOptionsKey = '';
let branchReviewBranchOptionsKey = '';
let branchReviewCandidateOptionsKey = '';
let branchReviewPolicyDraft = '0';
let branchReviewCandidateChoice = '';
let branchReviewAction = null;
let branchReviewNotice = '';
const branchReviewRows = new Map();
let shareLinksState = null;
let shareLinksVersion = -1;
let shareLinksAccountKey = '';
let shareLinksAccessKey = '';
let shareLinksEvidenceKey = '';
let shareLinksProjectChoice = '';
let shareLinksBranchChoice = '';
let shareLinksProjectOptionsKey = '';
let shareLinksBranchOptionsKey = '';
let shareLinksTtlDraft = '86400000';
let shareLinksAction = null;
let shareLinksNotice = '';
const shareLinksRows = new Map();
let projectActivityState = null;
let projectActivityVersion = -1;
let projectActivityContext = '';
let projectActivityView = 'inbox';
let projectActivityAction = null;
let projectActivityNotice = '';
const projectActivityRows = new Map();
let resolveServiceState = null;
let resolveServiceVersion = -1;
let resolveServiceSelection = null;
let resolveServiceSelectionRequest = 0;
let resolveServiceAction = null;
let resolveServiceNotice = '';
let resolveServiceAccountKey = '';
let resolveServiceContextKey = '';
let resolveServiceProjectChoice = '';
let resolveServiceBranchChoice = '';
let resolveServiceProjectOptionsKey = '';
let resolveServiceBranchOptionsKey = '';
let resolveServicePreviewSource = 'saved-head';
let resolveServiceVisibleJobs = 20;
const resolveServiceJobRows = new Map();
const resolveServiceQueueActions = new Set();
let resolveCommentsState = null;
let resolveCommentsVersion = -1;
let resolveCommentsContext = '';
let resolveCommentsAccessKey = '';
let resolveCommentsScopeId = null;
let resolveCommentsAction = null;
let resolveCommentsNotice = '';
let resolveCommentsDraft = emptyResolveCommentDraft();
let resolveCommentsTimelineKey = '';
let resolveCommentsClipKey = '';
const resolveCommentRows = new Map();
const syncOperationRows = new Map();
let assetTransferState = null;
let assetTransferStateVersion = -1;
let assetTransferContext = '';
let assetTransferForeground = null;
let assetReviewClearing = false;
let assetTransferActionNotice = '';
let assetTransferVisibleJobs = 20;
const assetTransferJobRows = new Map();
const assetTransferJobActions = new Set();
const assetPolicyClasses = ['original', 'proxy', 'audio', 'graphics', 'other'];
let assetPolicyDraft = null;
let assetStorageAction = null;
let assetStorageAutoRefreshedScope = '';
let assetStorageActionNotice = '';
let assetAvailabilityNeedsCheck = false;
let collaborationBusy = false;
let collaborationProjectId = null;
let currentCollaborationState = { available: false, members: [], invitations: [] };

const scanRecovery = {
  'unsupported-format': 'Choose a .fcpxml file or .fcpxmld bundle exported from DaVinci Resolve.',
  'file-unavailable': 'The export is missing or unreadable. Restore it to its original location, or choose a new export. For a .fcpxmld bundle, keep Info.fcpxml inside it, then rescan.',
  'file-access-denied': 'Frameline does not have permission to read this export. Check file and folder permissions, then rescan or choose a readable copy.',
  'file-busy': 'The export is in use. Close the app holding it, or export a separate copy from Resolve, then rescan.',
  'file-too-large': 'This export exceeds the 20 MB scan limit. Export a smaller timeline or sequence, then choose that file.',
  'malformed-xml': 'The export contains malformed XML. Export the timeline again from Resolve, then choose the new file.',
  'unsupported-structure': 'No supported top-level picture sequence was found. Export a timeline with a primary picture track from Resolve, then choose the new file.',
  'unsupported-fcpxml-version': 'This export is not FCPXML 1.10. Export the timeline from the tested Resolve 21.1.2 build, then choose the new file.',
  'unsupported-timing': 'This timeline contains timing that does not align to whole frames. Check clip timing in Resolve and export again.',
  'invalid-manifest': 'Frameline could not verify the scan results. Rescan or choose a new export. The project file was not changed.',
  'metadata-unavailable': 'Frameline could not save local project metadata. Check free disk space and folder permissions, then rescan. The export was not changed.',
  'metadata-locked': 'Local project metadata is in use by another process. Close the other Frameline window and retry. The export was not changed.',
  'metadata-invalid': 'Local project metadata is damaged and no valid backup was found. Keep the metadata files for recovery before trying again. The export was not changed.',
  'metadata-newer-version': 'This project metadata was created by a newer Frameline version. Open it with that version to avoid losing data.',
  'revision-source-changed': 'The export changed since the last scan. Rescan it before saving a revision.',
  'scan-cancelled': 'Scan cancelled. The export was not changed. Rescan when ready.',
  'revision-head-changed': 'Revision history changed while saving. Choose the project again and retry.',
  'revision-message-invalid': 'Enter a revision message of 1 to 120 characters.',
  'revision-scan-required': 'Scan the selected export before saving a revision.',
  'revision-not-found': 'This revision is no longer in the local history for this project.',
  'revision-corrupt': 'This revision could not be verified. Keep the local metadata and revision files for recovery.',
  'branch-name-invalid': 'Use 1–40 lowercase letters, numbers, dots, underscores, or hyphens. Start with a letter or number.',
  'branch-exists': 'A branch with that name already exists. Choose another name.',
  'branch-not-found': 'That branch is no longer available. Choose the project again to refresh the branch list.',
  'branch-project-required': 'Choose an FCPXML export before managing branches.',
  'revision-transfer-invalid': 'This backup is damaged or is not a supported Frameline revision backup. No revisions were imported.',
  'revision-transfer-too-large': 'This backup exceeds the 50 MB import limit.',
  'relink-unavailable': 'This history can no longer be relinked. Rescan the export and try again.',
  'relink-source-changed': 'The export or matching revision changed. Rescan and choose its history again.'
};

function renderAppState(state) {
  currentAppState = state;
  const projectName = state?.selectedProject?.name;
  const scan = state?.scan;
  const copySource = projectName && scan?.sourceHash ? `${state.selectedProject.id || projectName}:${scan.sourceHash}` : null;
  if (copySource !== reviewCopySource) {
    document.getElementById('review-copy-result').textContent = '';
    verifiedReviewCopy = null;
    mediaAuditReports = {};
    mediaSearchReports = {};
    for (const key of Object.keys(mediaAuditDependencyPages)) delete mediaAuditDependencyPages[key];
    mediaAuditDependencyOpen.clear();
    mediaAuditReportRenderKey = ''; copyMediaAuditRenderKey = '';
    renderCopyMediaAudit();
  }
  const mediaSelectionChanged = reviewCopySource !== copySource;
  reviewCopySource = copySource;
  if (mediaSelectionChanged) refreshMediaAuditJobs();
  const canCopy = !state?.error && state?.scanStatus === 'ready' && !!scan && state?.selectedProject?.format === 'FCPXML' && /\.fcpxml$/i.test(projectName || '');
  document.getElementById('review-copy-panel').hidden = !canCopy;
  renderMediaAuditControls();
  document.getElementById('rescan-project').hidden = !projectName;
  document.querySelector('.branch-label').textContent = `${state?.currentBranch || 'main'} · ${projectName ? 'Local project' : 'Sample project'}`;
  document.getElementById('file-name').textContent = projectName
    ? `${projectName} · ${state.selectedProject.format} · ${state.scanStatus}`
    : 'No project file selected';
  if (projectName) {
    document.querySelector('.project-context strong').textContent = projectName;
    document.querySelector('.workspace-bar > span:first-child').firstChild.textContent = `${projectName} `;
    document.querySelector('.sample-mark').textContent = 'Read-only scan';
    document.querySelector('[data-view="workspace"]').firstChild.textContent = 'Scan';
    if (document.getElementById('view-workspace').classList.contains('active')) document.getElementById('view-label').textContent = 'Timeline scan';
    document.getElementById('sample-review').hidden = true;
    document.querySelector('.revision-jump').hidden = true;
    document.getElementById('audio-track').hidden = true;
    document.querySelector('.nav-count').textContent = '';
    document.querySelector('#view-history .secondary-hero p').textContent = `${state.revisions?.length || 0} revision${state.revisions?.length === 1 ? '' : 's'} on ${state.currentBranch}. Open a revision to compare its sequence and media inventory with its parent.`;
    document.getElementById('branch-controls').hidden = false;
    const branchSelect = document.getElementById('branch-switch');
    branchSelect.replaceChildren();
    (state.branches || ['main']).forEach(name => {
      const option = make('option', '', name);
      option.value = name;
      branchSelect.append(option);
    });
    branchSelect.value = state.currentBranch;
    document.getElementById('revision-form').hidden = false;
    const relinkPanel = document.getElementById('relink-panel');
    const relinkSelect = document.getElementById('relink-source');
    relinkSelect.replaceChildren();
    for (const candidate of state.relinkCandidates || []) {
      const option = make('option', '', `${candidate.message} · ${candidate.branch} · ${candidate.projectId.slice(0, 8)}`);
      option.value = candidate.projectId;
      relinkSelect.append(option);
    }
    relinkPanel.hidden = !state.relinkCandidates?.length;
    document.getElementById('save-revision').disabled = state.scanStatus !== 'ready' || state.revisionStatus === 'saving';
    renderRealHistory(state.revisions || [], state.selectedRevision?.id);
    renderRevisionDetail(state.selectedRevision, state.revisionDetailError, state.selectedComparison, state.comparisonError);
    document.querySelector('#view-history .view-footnote').textContent = 'History follows the selected branch. Clip-level comparison and pull remain unavailable until stable IDs are proven.';
    document.querySelector('#view-media .secondary-hero p').textContent = scan
      ? window.mediaAvailabilitySummary(scan.media) : 'Media could not be scanned.';
    document.getElementById('media-inventory-kind').textContent = 'Read-only scan';
    document.querySelector('#view-media .view-footnote').textContent = 'Only local file references are checked. External and unspecified sources are not resolved; media paths stay on this device.';
    if (scan) renderScan(scan);
    else {
      document.querySelector('.masthead h1').textContent = 'Timeline scan';
      document.getElementById('video-track').replaceChildren();
      document.getElementById('media-list').replaceChildren();
      document.getElementById('workspace-finding').textContent = state.error ? 'Scan stopped. The project file was not changed.' : 'The timeline could not be scanned.';
      document.getElementById('timeline-selection').textContent = 'No scan data';
      document.getElementById('film-title').textContent = projectName;
      document.querySelector('.sample-line span').textContent = 'Read-only FCPXML inventory';
      document.querySelector('.sample-line p').textContent = scanRecovery[state.error] || 'Choose another export or rescan to try again.';
      document.getElementById('sequence-summary').textContent = 'Scan unavailable';
    }
  }
  if (state?.error) {
    const notice = document.getElementById('file-notice');
    notice.textContent = scanRecovery[state.error] || 'The timeline scan failed. Try exporting it again from Resolve.';
    notice.hidden = false;
  }
  const nextCollaborationProject = state?.selectedProject?.id || null;
  if (nextCollaborationProject !== collaborationProjectId) {
    collaborationProjectId = nextCollaborationProject;
    refreshCollaborationState();
  }
  renderMediaAuditJobs();
  const nextServiceSelection = `${state?.selectedProject?.id || ''}:${state?.currentBranch || 'main'}:${state?.revisions?.[0]?.id || ''}`;
  if (nextServiceSelection !== serviceLocalSelectionKey) {
    serviceLocalSelectionKey = nextServiceSelection;
    refreshServiceState();
  }
  renderServicePanel();
  syncAssetTransferContext();
  renderAssetTransferPanel();
}

function renderScan(scan) {
  document.querySelector('.masthead h1').textContent = 'Timeline scan';
  document.getElementById('workspace-finding').textContent = `${scan.clips.length} picture clips · read only · clip identity unresolved`;
  document.getElementById('film-title').textContent = scan.sequence.name;
  document.getElementById('timeline-selection').textContent = scan.warnings.length ? `${scan.warnings.length} scan warning${scan.warnings.length === 1 ? '' : 's'}` : 'Top level picture track';
  document.querySelector('.film-strip').setAttribute('aria-label', 'Scanned top level picture clips');
  const video = document.getElementById('video-track');
  video.replaceChildren();
  let cursor = 0;
  scan.clips.forEach((clip, index) => {
    if (clip.offsetFrames > cursor) {
      const gap = make('div', 'scan-gap', 'Gap');
      gap.style.flex = `${clip.offsetFrames - cursor} 1 0`;
      video.append(gap);
    }
    const segment = make('div', 'clip scanned-clip');
    segment.style.flex = `${Math.max(clip.durationFrames, 1)} 1 0`;
    segment.append(make('span', 'clip-code', `V1 · ${index + 1}`), make('span', 'clip-name', clip.name), make('span', 'clip-duration', `${clip.durationFrames}f`));
    segment.title = `${clip.name} · source in ${clip.sourceInFrames} frames · ${clip.mediaName}`;
    video.append(segment);
    cursor = Math.max(cursor, clip.offsetFrames + clip.durationFrames);
  });
  document.querySelector('.sample-line span').textContent = 'Read-only FCPXML inventory';
  document.querySelector('.sample-line p').textContent = scan.warnings.length ? scan.warnings.join(' · ') : 'Clip IDs in the XML are not treated as stable. Editing and pull remain unavailable.';
  document.querySelectorAll('.film-meta span').forEach((node, index) => { node.textContent = index === 0 ? 'V1 · Picture' : index === 1 ? '0f' : index === 4 ? `${scan.sequence.durationFrames}f` : ''; });
  document.getElementById('sequence-summary').textContent = `${scan.sequence.frameDuration} per frame · ${scan.sequence.durationFrames} frames`;
  const media = document.getElementById('media-list');
  media.replaceChildren();
  const availabilityLabels = { local: 'Available locally', missing: 'Missing', external: 'External source · not checked', unknown: 'Source unspecified', unavailable: 'Could not check' };
  scan.media.forEach(({ name, availability }) => {
    const row = make('div', 'media-row scanned-media');
    row.append(make('strong', '', name), make('span', '', 'Referenced in timeline'), make('span', `media-availability ${availability}`, availabilityLabels[availability] || 'Could not check'));
    media.append(row);
  });
}

function make(tag, className, textValue) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined) node.textContent = textValue;
  return node;
}

function renderChangeChoices() {
  const queue = document.getElementById('change-queue');
  const compact = document.getElementById('compact-queue');
  queue.replaceChildren();
  compact.replaceChildren();
  document.getElementById('queue-total').textContent = String(sample.changes.length);
  document.querySelector('.nav-count').textContent = sample.changes.length;
  const conflicts = sample.changes.filter(change => change.status === 'Conflict').length;
  document.getElementById('workspace-finding').textContent = `${sample.changes.length} proposed edits. ${conflicts} overlapping trim needs your attention.`;

  sample.changes.forEach((change, index) => {
    const choice = make('button', 'queue-item');
    choice.type = 'button';
    choice.dataset.changeId = change.id;
    choice.setAttribute('aria-pressed', 'false');
    const top = make('span', 'queue-top');
    top.append(make('strong', '', change.title), make('small', '', change.code));
    choice.append(top, make('span', 'queue-kind', change.kind), make('span', `queue-status ${change.status.toLowerCase()}`, change.status));
    choice.addEventListener('click', () => selectChange(change.id));
    queue.append(choice);

    const smallChoice = make('button', 'compact-change');
    smallChoice.type = 'button';
    smallChoice.dataset.changeId = change.id;
    smallChoice.setAttribute('aria-pressed', 'false');
    smallChoice.append(make('strong', '', change.title), make('small', '', `${change.kind} · ${change.status}`));
    smallChoice.addEventListener('click', () => selectChange(change.id));
    compact.append(smallChoice);
  });
}

function renderTimeline() {
  const video = document.getElementById('video-track');
  video.replaceChildren();
  sample.clips.forEach(clip => {
    const affected = Boolean(clip.changeId);
    const segment = make(affected ? 'button' : 'div', 'clip');
    segment.dataset.clipId = clip.id;
    if (affected) {
      segment.type = 'button';
      segment.dataset.changeId = clip.changeId;
      segment.setAttribute('aria-pressed', 'false');
      segment.setAttribute('aria-label', `${clip.name}, incoming ${changes.get(clip.changeId).kind} change`);
      segment.addEventListener('click', () => selectChange(clip.changeId));
    }
    segment.style.flex = `${clip.duration} 1 0`;
    segment.append(make('span', 'clip-code', clip.code), make('span', 'clip-name', clip.name), make('span', 'clip-duration', `${clip.duration}s`));
    video.append(segment);
  });

  const audio = document.getElementById('audio-track');
  audio.dataset.changeId = 'audio';
  audio.setAttribute('aria-pressed', 'false');
  audio.append(make('span', '', 'Music bed'));
  const waveform = make('span', 'waveform');
  for (let index = 0; index < 160; index += 1) {
    const bar = make('i');
    const height = 4 + Math.round(15 * Math.abs(Math.sin(index * 1.74) * Math.cos(index * 0.21)));
    bar.style.setProperty('--wave-height', `${height}px`);
    waveform.append(bar);
  }
  audio.append(waveform);
  audio.addEventListener('click', () => selectChange('audio'));
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.replaceChildren();
  sample.revisions.forEach(revision => {
    const row = make('div', 'history-item');
    const main = make('div', 'history-main');
    main.append(make('strong', '', revision.title), make('small', '', revision.detail));
    const state = make('div', 'history-state');
    if (revision.state) state.append(make('strong', '', revision.state));
    state.append(make('span', '', revision.time));
    row.append(make('span', 'history-id', revision.id), main, state);
    list.append(row);
  });
}

function syncErrorLabel(code) {
  return ({
    'sync-network-unavailable': 'Network unavailable. Retry when the connection returns.',
    'sync-branch-conflict': 'Remote work changed this branch. Fetch before reconciling.',
    'sync-reconciliation-required': 'This branch diverged and needs reconciliation.'
  })[code] || 'Sync stopped safely. Retry or cancel this queued push.';
}

function renderSyncState(state) {
  const list = document.getElementById('sync-operations');
  const summary = document.getElementById('sync-summary');
  const operations = state?.operations || [];
  const ids = new Set(operations.map(operation => operation.id));
  for (const [id, view] of syncOperationRows) {
    if (!ids.has(id)) { view.row.remove(); syncOperationRows.delete(id); }
  }
  let empty = list.querySelector('.sync-empty');
  if (!operations.length) {
    setServiceText(summary, 'No queued pushes');
    if (!empty) { empty = make('p', 'sync-empty'); list.append(empty); }
    setServiceText(empty, state?.connected ? 'A completed push leaves this queue. Check history to compare branch heads.'
      : 'Queued pushes appear here after a service project is linked.');
    return;
  }
  empty?.remove();
  setServiceText(summary, `${operations.length} queued push${operations.length === 1 ? '' : 'es'}`);
  operations.forEach((operation, index) => {
    let view = syncOperationRows.get(operation.id);
    if (!view) {
      const row = make('article', 'sync-operation'), details = make('div', 'sync-operation-main');
      const title = make('div', 'sync-operation-title'), name = make('strong'), status = make('span', 'sync-state');
      const description = make('p'), progress = make('progress', 'sync-progress'), actions = make('div', 'sync-actions');
      title.append(name, status); details.append(title, description, progress);
      const retry = make('button', '', 'Retry'), cancel = make('button', '', 'Cancel'); retry.type = cancel.type = 'button';
      retry.addEventListener('click', () => runSyncAction('retry', operation.id));
      cancel.addEventListener('click', () => runSyncAction('cancel', operation.id));
      actions.append(retry, cancel); row.append(details, actions);
      view = { row, name, status, description, progress, retry, cancel }; syncOperationRows.set(operation.id, view);
    }
    setServiceText(view.name, `Push ${operation.branch}`);
    setServiceText(view.status, operation.status.replaceAll('-', ' ')); view.status.className = `sync-state ${operation.status}`;
    const completed = operation.progress?.completed || 0; const total = operation.progress?.total || 0;
    setServiceText(view.description, operation.lastError ? syncErrorLabel(operation.lastError)
      : `${completed} of ${total} revision${total === 1 ? '' : 's'} acknowledged`);
    view.progress.max = Math.max(total, 1); view.progress.value = completed;
    view.progress.setAttribute('aria-label', `${completed} of ${total} revisions acknowledged`);
    view.retry.hidden = !operation.actions?.includes('retry');
    view.retry.disabled = syncBusy || serviceActionBusy || !!serviceState?.busy || !operation.recoverable;
    view.cancel.disabled = syncBusy;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
}

async function runSyncAction(action, id) {
  if (syncBusy) return; syncBusy = true; renderServicePanel();
  try {
    const state = await (action === 'retry' ? window.desktop.retrySync(id) : window.desktop.cancelSync(id));
    if (Number.isSafeInteger(state?.version)) renderServiceState(state); else renderSyncState(state);
  } catch { serviceActionNotice = 'The queued push could not be updated. Refresh the service state and try again.'; }
  finally { syncBusy = false; renderServicePanel(); }
}

function setServiceText(node, value) { if (node && node.textContent !== value) node.textContent = value; }
function serviceErrorLabel(code) {
  return ({
    'service-sign-in-required': 'Your account details were not accepted or the session expired. Enter your service account details to sign in again.',
    'service-offline': 'The service could not be reached. Check the connection, then refresh projects or check history.',
    'service-access-denied': 'Your account no longer has access to this service project. Refresh projects or choose another project.',
    'service-credential-storage-unavailable': 'Secure credential storage is unavailable on this Mac. Unlock the keychain and try signing in again.',
    'service-project-required': 'Choose a local FCPXML export and save a revision before linking or pushing history.',
    'service-project-unavailable': 'Link this local branch to an accessible service project. Refresh projects if access changed.',
    'service-viewer-read-only': 'Viewer access allows fetching history. Pushing requires editor or owner access.',
    'service-selection-changed': 'The selected local branch changed. Check history again for the current branch.',
    'service-sync-busy': 'Another service action is still running. Wait for it to finish before trying again.',
    'service-binding-invalid': 'The saved service mapping could not be read. Keep the app data for recovery before trying again.',
    'service-storage-unavailable': 'Local service data could not be saved. Check disk space and file permissions, then retry.',
    'sync-base-version-changed': 'The shared-base record changed during this check. Check history again for the current branch.',
    'revision-head-changed': 'The local branch changed during this check. Check history again for the current branch.',
    'sync-base-regression': 'The service history no longer retains the recorded lineage. Fetch history to inspect it before reconciling.',
    'sync-base-invalid': 'Saved sharing evidence could not be verified. Check history to verify it with the service.',
    'revision-cache-miss': 'Saved sharing evidence is unavailable. Check history to verify it with the service.',
    'revision-cache-corrupt': 'Saved sharing evidence could not be verified. Check history to verify it with the service.',
    'metadata-storage-uncertain': 'The local save is not confirmed. Restart the app, then check history again.',
    'revision-cache-uncertain': 'The local save is not confirmed. Restart the app, then check history again.',
    'metadata-unavailable': 'Local storage could not save sharing evidence. Check disk space and file permissions, then check history again.',
    'revision-cache-storage-unavailable': 'Local storage could not save sharing evidence. Check disk space and file permissions, then check history again.',
    'sync-history-invalid': 'The fetched history could not be verified. Local revisions are unchanged. Contact the service administrator.',
    'credentials-invalid': 'The email or password was not accepted. Check your account details and sign in again.',
    'access-token-invalid': 'Your session has expired. Sign in again to continue.',
    'refresh-token-invalid': 'Your session has expired. Sign in again to continue.',
    'secure-transport-required': 'Enter an HTTPS service URL supplied by your administrator.',
    'sync-origin-invalid': 'Enter a valid HTTPS service URL without a path, query, or embedded credentials.',
    'service-origin-invalid': 'Enter a valid HTTPS service URL without a path, query, or embedded credentials.',
    'sync-network-unavailable': 'The service could not be reached. Check the connection, then refresh projects or check history.',
    'forbidden': 'Your account no longer has access to this service project. Refresh projects or choose another project.',
    'project-not-found': 'This service project is no longer available. Refresh projects to choose an accessible project.',
    'branch-not-found': 'This service branch is no longer available. Refresh projects to choose another branch.',
    'sync-branch-conflict': 'The service branch changed during the push. Check and fetch history before continuing.',
    'branch-approval-required': 'This branch requires approval. Request review in Branch approvals, then retry the queued push after approval.',
    'approval-head-stale': 'The service head changed. Refresh Branch approvals and request review for the current head before retrying the push.',
    'sync-reconciliation-required': 'Both branches changed. Fetch history to inspect the revisions before reconciling.',
    'sync-project-unbound': 'Link this local branch to a service project first.',
    'revision-scan-required': 'Scan a local FCPXML export and save a revision before pushing.',
    'branch-project-required': 'Choose a local FCPXML export before linking a service project.',
    'revision-source-changed': 'The export changed since scanning. Rescan it before continuing.',
    'credential-storage-unavailable': 'Secure credential storage is unavailable on this Mac. Unlock the keychain and try signing in again.',
    'credential-vault-unavailable': 'Secure credential storage is unavailable on this Mac. Unlock the keychain and try signing in again.'
  })[code] || 'The service action could not finish. Check the connection or sign in again, then retry.';
}
function currentShareLinksAccount() {
  return serviceState?.account?.id && ['connected', 'offline'].includes(serviceState?.status)
    ? JSON.stringify([serviceState.origin, serviceState.account.id]) : '';
}
function shareLinksSelectionMatches(state = shareLinksState) {
  const project = serviceState?.projects?.find(item => item.id === state?.selection?.projectId);
  return !!currentShareLinksAccount() && currentShareLinksAccount() === shareLinksAccountKey && !!project
    && project.branches.includes(state.selection.branch);
}
function syncShareLinksAccount() {
  const account = currentShareLinksAccount();
  const access = JSON.stringify([account, serviceState?.status, (serviceState?.projects || []).map(item => [item.id, item.role, item.branches])]);
  if (account !== shareLinksAccountKey) {
    shareLinksAccountKey = account; shareLinksState = null; shareLinksAction = null; shareLinksNotice = '';
    shareLinksEvidenceKey = ''; shareLinksProjectChoice = ''; shareLinksBranchChoice = ''; shareLinksTtlDraft = '86400000';
  }
  renderShareLinks();
  if (access !== shareLinksAccessKey) { shareLinksAccessKey = access; readShareLinksState(); }
}
async function readShareLinksState() {
  if (!window.desktop?.getShareLinksState) return;
  const account = currentShareLinksAccount();
  try { renderShareLinksState(await window.desktop.getShareLinksState(), account); }
  catch { if (account === currentShareLinksAccount()) { shareLinksNotice = 'Sharing state could not be read. Refresh sharing to retry.'; renderShareLinks(); } }
}
function shareLinksReceiptMatches(action, state) {
  const project = serviceState?.projects?.find(item => item.id === action?.selection?.projectId);
  if (!action || !state?.scopeId || !state.available || action.account !== currentShareLinksAccount()
    || project?.role !== 'owner' || !project.branches.includes(action.selection.branch)
    || state.role !== 'owner' || state.role !== action.role || state.selection?.projectId !== action.selection?.projectId
    || state.selection?.branch !== action.selection?.branch || typeof state.outcome?.linkId !== 'string' || !state.outcome.linkId
    || action.receiptId && state.outcome.linkId !== action.receiptId) return false;
  return action.method === 'copyShareLink' && (state.outcome.kind === 'copied'
    || state.outcome.kind === 'copy-failed' && typeof state.outcome.revoked === 'boolean') && state.outcome.revisionId === action.headRevisionId
    || action.method === 'revokeShareLink' && state.outcome.kind === 'revoked' && state.outcome.linkId === action.linkId;
}
function renderShareLinksState(state, expectedAccount = currentShareLinksAccount()) {
  if (!state || !Number.isSafeInteger(state.version) || state.version < shareLinksVersion
    || expectedAccount !== currentShareLinksAccount()) return false;
  const evidence = JSON.stringify([state.scopeId, state.selection, state.headRevisionId, state.role]);
  if (evidence !== shareLinksEvidenceKey) {
    shareLinksEvidenceKey = evidence; shareLinksTtlDraft = '86400000'; shareLinksNotice = '';
    if (shareLinksAction && shareLinksAction.method !== 'selectShareLinks') {
      if (shareLinksReceiptMatches(shareLinksAction, state)) shareLinksAction.receiptId = state.outcome.linkId;
      else shareLinksAction = null;
    }
  }
  shareLinksState = state; shareLinksVersion = state.version;
  if (state.selection && !shareLinksProjectChoice) { shareLinksProjectChoice = state.selection.projectId; shareLinksBranchChoice = state.selection.branch; }
  renderShareLinks(); return true;
}
function shareLinksErrorLabel(code) {
  return ({
    'share-links-invalid': 'Choose a service branch and one of the supported link expiration periods.',
    'share-links-unavailable': 'Select an accessible service branch as its owner, then refresh sharing.',
    'share-links-capacity': 'The service link limit was reached. Revoke unused links or contact the administrator.',
    'share-cursor-invalid': 'This page is no longer valid. Refresh sharing to start with the newest links.',
    'share-head-stale': 'The service head changed. Refresh sharing and review the revision before copying a new link.',
    'share-revision-unavailable': 'The pinned revision is unavailable. Refresh sharing to check the current service revision.',
    'share-idempotency-conflict': 'The pending link no longer matches its saved request. Refresh sharing before retrying.',
    'share-link-not-found': 'This link is unavailable. Refresh sharing to read the current list.',
    'share-link-unavailable': 'This link is unavailable or no longer active. Refresh sharing to check its status.',
    'share-links-selection-changed': 'The account, branch or head changed. Refresh sharing before continuing.',
    'share-selection-changed': 'The account, branch or head changed. Refresh sharing before continuing.',
    'share-links-refresh-required': 'Refresh sharing to verify the revision before creating or revoking links.',
    'share-refresh-required': 'Refresh sharing to verify the revision before creating or revoking links.',
    'share-links-busy': 'Another sharing action is running. Wait for it to finish, then retry.',
    'share-links-display-limit': 'The display limit was reached. Refresh sharing to start with the newest links.',
    'share-display-limit': 'The display limit was reached. Refresh sharing to start with the newest links.',
    'share-links-local-error': 'Sharing state could not be read locally. Refresh sharing to retry.',
    'share-local-error': 'Sharing state could not be read locally. Refresh sharing to retry.',
    'share-clipboard-unavailable': 'The link could not be copied. Refresh sharing to check its revocation status before retrying.',
    'share-copy-revoke-required': 'The link could not be copied, and revocation was not confirmed. Refresh sharing and revoke the link before creating another one.',
    'clipboard-unavailable': 'The link could not be copied. Refresh sharing to check its revocation status before retrying.',
    forbidden: 'Only a current project owner can create, list or revoke read-only links.'
  })[code] || serviceErrorLabel(code);
}
function renderShareLinks() {
  const account = currentShareLinksAccount(), projects = account ? serviceState?.projects || [] : [];
  const projectSelect = document.getElementById('share-links-project'), branchSelect = document.getElementById('share-links-branch');
  const projectKey = JSON.stringify(projects.map(item => [item.id, item.name, item.role]));
  if (projectKey !== shareLinksProjectOptionsKey) {
    shareLinksProjectOptionsKey = projectKey; projectSelect.replaceChildren(new Option('Choose a service project', ''));
    for (const project of projects) projectSelect.add(new Option(`${project.name} · ${project.role}`, project.id));
  }
  const project = projects.find(item => item.id === shareLinksProjectChoice);
  if (!project) { shareLinksProjectChoice = ''; shareLinksBranchChoice = ''; }
  projectSelect.value = shareLinksProjectChoice;
  const branches = project?.branches || [], branchKey = JSON.stringify([project?.id, branches]);
  if (branchKey !== shareLinksBranchOptionsKey) {
    shareLinksBranchOptionsKey = branchKey; branchSelect.replaceChildren(new Option('Choose a service branch', ''));
    for (const branch of branches) branchSelect.add(new Option(branch, branch));
  }
  if (!branches.includes(shareLinksBranchChoice)) shareLinksBranchChoice = '';
  branchSelect.value = shareLinksBranchChoice;
  const state = shareLinksSelectionMatches() ? shareLinksState : null;
  const selectedProject = projects.find(item => item.id === state?.selection?.projectId);
  const owner = state?.role === 'owner' && selectedProject?.role === 'owner';
  const ready = !!state?.available && !!state?.ready && owner;
  const pending = shareLinksAction, busy = !!pending || !!state?.busy, connected = serviceState?.status === 'connected';
  const hasAPI = typeof window.desktop?.getShareLinksState === 'function';
  projectSelect.disabled = !account || busy || !hasAPI; branchSelect.disabled = !project || busy || !hasAPI;
  document.getElementById('share-links-select').disabled = !account || !project || !shareLinksBranchChoice || busy || !window.desktop?.selectShareLinks;
  document.getElementById('share-links-refresh').disabled = !state?.selection || !owner || busy || !window.desktop?.refreshShareLinks;
  setServiceText(document.getElementById('share-links-selection'), state
    ? `Sharing for ${selectedProject?.name || 'Service project'} · ${state.selection.branch} · ${state.role || 'unknown'} access` : '');
  const revision = owner && state?.revision?.id === state.headRevisionId ? state.revision : null;
  document.getElementById('share-links-revision').hidden = !revision;
  setServiceText(document.getElementById('share-links-revision-message'), revision?.message || '');
  setServiceText(document.getElementById('share-links-revision-stamp'), revision
    ? `Revision ${revision.id.slice(0, 8)} · Saved ${serviceDate(revision.createdAt)} · Head checked ${serviceDate(state.checkedAt)}` : '');
  for (const [id, value] of [['project-id', revision && state.selection.projectId], ['branch-name', revision && state.selection.branch], ['revision-id', revision?.id], ['manifest', revision?.manifestId]])
    setServiceText(document.getElementById(`share-links-${id}`), value || '');
  const ttl = document.getElementById('share-links-ttl'); ttl.value = shareLinksTtlDraft;
  ttl.disabled = !ready || busy || !connected || !revision || !window.desktop?.copyShareLink;
  document.getElementById('share-links-copy').disabled = ttl.disabled || !['3600000', '86400000', '604800000', '2592000000'].includes(shareLinksTtlDraft);
  const links = owner ? (state?.links || []).filter(item => item.projectId === state.selection.projectId && item.branch === state.selection.branch) : [];
  const ids = new Set(links.map(item => item.id)), list = document.getElementById('share-links-list');
  for (const [id, view] of shareLinksRows) if (!ids.has(id)) { view.row.remove(); shareLinksRows.delete(id); }
  links.forEach((link, index) => {
    let view = shareLinksRows.get(link.id);
    if (!view) {
      const row = make('article', 'share-link-row'); row.setAttribute('role', 'listitem');
      const title = make('h4'), detail = make('p'), stamp = make('p'), identity = make('details'), identityTitle = make('summary', '', 'Link revision identity');
      const facts = make('dl', 'service-base-facts'), id = make('dd'), revisionId = make('dd'), manifest = make('dd');
      facts.append(make('dt', '', 'Link ID'), id, make('dt', '', 'Pinned revision'), revisionId, make('dt', '', 'Manifest'), manifest); identity.append(identityTitle, facts);
      const revoke = make('button', '', 'Revoke link'); revoke.type = 'button';
      revoke.addEventListener('click', () => runShareLinksAction('revokeShareLink', { scopeId: shareLinksState?.scopeId, linkId: link.id }));
      row.append(title, detail, stamp, identity, revoke); view = { row, title, detail, stamp, identity, id, revisionId, manifest, revoke }; shareLinksRows.set(link.id, view);
    }
    const statuses = { active: 'Active at last check', expired: 'Expired', revoked: 'Revoked', unavailable: 'Unavailable' };
    setServiceText(view.title, link.revisionMessage);
    setServiceText(view.detail, `${statuses[link.status] || 'Status unavailable'} · Pinned revision ${link.revisionId.slice(0, 8)}`);
    setServiceText(view.stamp, `Created ${serviceDate(link.createdAt)} · Expires ${serviceDate(link.expiresAt)}${link.revokedAt !== null ? ` · Revoked ${serviceDate(link.revokedAt)}` : ''}`);
    setServiceText(view.id, link.id); setServiceText(view.revisionId, link.revisionId); setServiceText(view.manifest, link.manifestId);
    view.revoke.hidden = link.status === 'revoked'; view.revoke.disabled = !ready || busy || !connected || !window.desktop?.revokeShareLink;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  setServiceText(document.getElementById('share-links-checked'), owner && state?.checkedAt ? `Link status checked ${serviceDate(state.checkedAt)}.` : '');
  setServiceText(document.getElementById('share-links-range'), owner && (ready || links.length)
    ? `${links.length} link${links.length === 1 ? '' : 's'} shown${Number.isSafeInteger(state.total) ? ` of ${state.total}` : ''}` : '');
  const more = document.getElementById('share-links-more'); more.hidden = !owner || !state?.nextCursor;
  more.disabled = !ready || busy || !window.desktop?.refreshShareLinks;
  const status = !hasAPI ? 'Read-only sharing is unavailable in this build.' : !account ? 'Sign in and select a service branch to manage read-only links.'
    : pending ? pending.method === 'copyShareLink' ? 'Creating and copying the read-only link…' : pending.method === 'revokeShareLink' ? 'Revoking the link…' : 'Loading sharing metadata…'
      : shareLinksNotice || (state && !owner ? 'Only current project owners can create, list or revoke read-only links. Editor and viewer access does not include link management.'
        : state?.error ? shareLinksErrorLabel(state.error) : !state ? 'Select a service project and branch to manage read-only links.'
          : !ready ? 'Refresh sharing to verify the current revision and link statuses.' : !revision ? 'This service branch is empty. Save and publish a revision before creating a link.'
            : 'Each successful action creates a new link to the revision shown above. Existing links keep their pinned revision.');
  setServiceText(document.getElementById('share-links-status'), status); document.getElementById('share-links-panel').setAttribute('aria-busy', String(busy));
}
async function runShareLinksAction(method, input) {
  const account = currentShareLinksAccount(), scopeId = shareLinksState?.scopeId;
  if (!account || shareLinksAction || shareLinksState?.busy || !window.desktop?.[method]) return;
  if (['copyShareLink', 'revokeShareLink'].includes(method) && (!scopeId || input?.scopeId !== scopeId)) return;
  const action = { method, account, scopeId, selection: shareLinksState?.selection ? { ...shareLinksState.selection } : null,
    role: shareLinksState?.role, headRevisionId: shareLinksState?.headRevisionId, linkId: input?.linkId }, focused = document.activeElement;
  shareLinksAction = action; shareLinksNotice = ''; renderShareLinks();
  try {
    const state = await window.desktop[method](input);
    if (shareLinksAction !== action || account !== currentShareLinksAccount()) return;
    if (['copyShareLink', 'revokeShareLink'].includes(method) && shareLinksState?.scopeId !== scopeId && !shareLinksReceiptMatches(action, state)) return;
    const accepted = renderShareLinksState(state, account);
    if (accepted && shareLinksReceiptMatches(action, state)) {
      shareLinksNotice = state.outcome.kind === 'copied'
        ? `Read-only link copied for revision ${state.outcome.revisionId.slice(0, 8)}. Expires ${serviceDate(state.outcome.expiresAt)}.`
        : state.outcome.kind === 'copy-failed' ? state.outcome.revoked
          ? 'The link could not be copied and was revoked.'
          : `The link could not be copied, and revocation was not confirmed. Refresh sharing and revoke link ${state.outcome.linkId.slice(0, 8)} before creating another one.`
          : 'Link revoked.';
      if (!state.ready || state.error) shareLinksNotice += ' Refresh sharing to reload the current state.';
    } else if (accepted && method === 'copyShareLink' && !state.outcome && ['sync-network-unavailable', 'service-connection-failed'].includes(state.error)) {
      shareLinksNotice = 'The create request was not confirmed. It may have created a link. Refresh sharing to check before retrying.';
    }
  } catch { if (shareLinksAction === action && account === currentShareLinksAccount()) shareLinksNotice = 'The sharing action could not finish. Refresh sharing to check the current state before retrying.'; }
  finally {
    const finishing = shareLinksAction === action; if (finishing) shareLinksAction = null; renderShareLinks();
    if (finishing && focused && account === currentShareLinksAccount() && (document.activeElement === document.body || document.activeElement === focused)) {
      const target = focused.isConnected && !focused.disabled && !focused.closest('[hidden]') ? focused : document.getElementById('share-links-status');
      target.focus({ preventScroll: true });
    }
  }
}
function currentBranchReviewAccount() {
  return serviceState?.account?.id && ['connected', 'offline'].includes(serviceState?.status)
    ? JSON.stringify([serviceState.origin, serviceState.account.id]) : '';
}
function branchReviewSelectionMatches(state = branchReviewState) {
  const project = serviceState?.projects?.find(item => item.id === state?.selection?.projectId);
  return !!currentBranchReviewAccount() && currentBranchReviewAccount() === branchReviewAccountKey && !!project
    && project.branches.includes(state.selection.branch);
}
function syncBranchReviewAccount() {
  const account = currentBranchReviewAccount();
  const access = JSON.stringify([account, serviceState?.status, (serviceState?.projects || []).map(item => [item.id, item.role, item.branches])]);
  if (account !== branchReviewAccountKey) {
    branchReviewAccountKey = account; branchReviewState = null; branchReviewAction = null; branchReviewNotice = '';
    branchReviewEvidenceKey = ''; branchReviewProjectChoice = ''; branchReviewBranchChoice = '';
    branchReviewPolicyDraft = '0'; branchReviewCandidateChoice = '';
  }
  renderBranchReview();
  if (access !== branchReviewAccessKey) { branchReviewAccessKey = access; readBranchReviewState(); }
}
async function readBranchReviewState() {
  if (!window.desktop?.getBranchReviewState) return;
  const account = currentBranchReviewAccount();
  try { renderBranchReviewState(await window.desktop.getBranchReviewState(), account); }
  catch { if (account === currentBranchReviewAccount()) { branchReviewNotice = 'Branch review state could not be read. Refresh branch review to retry.'; renderBranchReview(); } }
}
function branchReviewReceiptMatches(action, state) {
  const kinds = { setBranchProtection: 'policy-saved', requestBranchApproval: 'requested', approveBranchRequest: 'approved' };
  if (!action || !kinds[action.method] || !state?.scopeId || !state.available || action.account !== currentBranchReviewAccount()
    || state.selection?.projectId !== action.selection?.projectId || state.selection?.branch !== action.selection?.branch
    || state.role !== action.role || state.headRevisionId !== action.headRevisionId || state.outcome?.kind !== kinds[action.method]) return false;
  if (action.method === 'setBranchProtection') {
    const nextVersion = action.policyVersion + (action.requiredApprovals === action.requestedApprovals ? 0 : 1);
    return state.policy?.version === action.policyVersion && state.policy.requiredApprovals === action.requiredApprovals
      || state.policy?.version === nextVersion && state.policy.requiredApprovals === action.requestedApprovals;
  }
  return state.policy?.version === action.policyVersion && state.policy.requiredApprovals === action.requiredApprovals
    && typeof state.outcome.requestId === 'string' && !!state.outcome.requestId
    && (!action.receiptId || state.outcome.requestId === action.receiptId)
    && (action.method !== 'approveBranchRequest' || state.outcome.requestId === action.requestId);
}
function renderBranchReviewState(state, expectedAccount = currentBranchReviewAccount()) {
  if (!state || !Number.isSafeInteger(state.version) || state.version < branchReviewVersion
    || expectedAccount !== currentBranchReviewAccount()) return false;
  const evidence = JSON.stringify([state.scopeId, state.selection, state.headRevisionId, state.policy?.version, state.role]);
  if (evidence !== branchReviewEvidenceKey) {
    branchReviewEvidenceKey = evidence; branchReviewPolicyDraft = String(state.policy?.requiredApprovals || 0);
    branchReviewCandidateChoice = ''; branchReviewNotice = '';
    if (branchReviewAction && branchReviewAction.method !== 'selectBranchReview') {
      if (branchReviewReceiptMatches(branchReviewAction, state)) branchReviewAction.receiptId = state.outcome.requestId || null;
      else branchReviewAction = null;
    }
  }
  branchReviewState = state; branchReviewVersion = state.version;
  if (state.selection && !branchReviewProjectChoice) {
    branchReviewProjectChoice = state.selection.projectId; branchReviewBranchChoice = state.selection.branch;
  }
  renderBranchReview(); return true;
}
function branchReviewErrorLabel(code) {
  return ({
    'branch-review-unavailable': 'Sign in and select an accessible service branch, then refresh branch review.',
    'branch-review-selection-changed': 'The branch, head or policy changed. Refresh branch review before continuing.',
    'branch-review-refresh-required': 'Refresh branch review to verify the current head and policy first.',
    'branch-review-busy': 'Another branch review action is running. Wait for it to finish, then retry.',
    'branch-review-invalid': 'Choose a service branch and a proposal from its saved revision list.',
    'branch-review-display-limit': 'The display limit was reached. Refresh branch review to start with the newest entries.',
    'branch-review-cursor-invalid': 'This page is no longer valid. Refresh branch review to start with the newest entries.',
    'branch-review-capacity': 'The service review limit was reached. Contact the project owner.',
    'branch-review-idempotency-conflict': 'This pending review no longer matches its saved request. Refresh branch review before retrying.',
    'branch-policy-version-conflict': 'The branch policy changed. Refresh branch review before saving it again.',
    'branch-protection-invalid': 'Choose a whole number of required approvals from 0 to 5.',
    'branch-protection-forbidden': 'Only a project owner can change branch protection.',
    'branch-policy-stale': 'The policy changed. Refresh branch review before saving it again.',
    'branch-not-protected': 'This branch does not require approvals. Refresh branch review to check its current policy.',
    'approval-request-invalid': 'Choose a saved proposal that is a direct child of the current head.',
    'approval-request-unavailable': 'This request is unavailable or expired. Refresh branch review.',
    'approval-forbidden': 'Only an eligible owner or editor can approve. The requester and revision author cannot approve this proposal.',
    'approval-policy-stale': 'The approval policy changed. Refresh branch review and request review again.',
    'approval-head-stale': 'The service head changed. Refresh branch review and choose a proposal for the current head.',
    'approval-candidate-invalid': 'This revision is not an eligible direct child of the current service head. Refresh branch review.',
    'approval-cursor-invalid': 'This page is no longer valid. Refresh branch review to start again.',
    'approval-capacity': 'The service review limit was reached. Contact the project owner.'
  })[code] || serviceErrorLabel(code);
}
function branchReviewMember(id) { return id === serviceState?.account?.id ? 'You' : `Member ${(id || '').slice(0, 8)}`; }
function renderBranchReview() {
  const account = currentBranchReviewAccount(), projects = account ? serviceState?.projects || [] : [];
  const projectSelect = document.getElementById('branch-review-project'), branchSelect = document.getElementById('branch-review-branch');
  const projectKey = JSON.stringify(projects.map(item => [item.id, item.name, item.role]));
  if (projectKey !== branchReviewProjectOptionsKey) {
    branchReviewProjectOptionsKey = projectKey; projectSelect.replaceChildren(new Option('Choose a service project', ''));
    for (const project of projects) projectSelect.add(new Option(`${project.name} · ${project.role}`, project.id));
  }
  const project = projects.find(item => item.id === branchReviewProjectChoice);
  if (!project) { branchReviewProjectChoice = ''; branchReviewBranchChoice = ''; }
  projectSelect.value = branchReviewProjectChoice;
  const branches = project?.branches || [], branchesKey = JSON.stringify([project?.id, branches]);
  if (branchesKey !== branchReviewBranchOptionsKey) {
    branchReviewBranchOptionsKey = branchesKey; branchSelect.replaceChildren(new Option('Choose a service branch', ''));
    for (const branch of branches) branchSelect.add(new Option(branch, branch));
  }
  if (!branches.includes(branchReviewBranchChoice)) branchReviewBranchChoice = '';
  branchSelect.value = branchReviewBranchChoice;
  const state = branchReviewSelectionMatches() ? branchReviewState : null;
  const pending = branchReviewAction, busy = !!pending || !!state?.busy, ready = !!state?.ready && !!state?.available;
  const write = ready && ['owner', 'editor'].includes(state.role), owner = ready && state.role === 'owner';
  const selectedProject = projects.find(item => item.id === state?.selection?.projectId);
  const hasAPI = typeof window.desktop?.getBranchReviewState === 'function';
  projectSelect.disabled = !account || busy || !hasAPI; branchSelect.disabled = !project || busy || !hasAPI;
  document.getElementById('branch-review-select').disabled = !account || !project || !branchReviewBranchChoice || busy || !window.desktop?.selectBranchReview;
  document.getElementById('branch-review-refresh').disabled = !state?.selection || busy || !window.desktop?.refreshBranchReview;
  setServiceText(document.getElementById('branch-review-selection'), state
    ? `Reviewing ${selectedProject?.name || 'Service project'} · ${state.selection.branch} · ${state.role || 'unknown'} access` : '');
  setServiceText(document.getElementById('branch-review-head'), ready
    ? `Service head at last check: ${state.headRevisionId || 'Empty branch'} · Policy version ${state.policy.version}${state.checkedAt ? ` · Checked ${serviceDate(state.checkedAt)}` : ''}` : '');
  const policyInput = document.getElementById('branch-review-required'); policyInput.value = branchReviewPolicyDraft;
  policyInput.disabled = busy || !owner || !window.desktop?.setBranchProtection;
  document.getElementById('branch-review-policy-save').disabled = busy || !owner || !window.desktop?.setBranchProtection
    || !/^[0-5]$/.test(branchReviewPolicyDraft) || Number(branchReviewPolicyDraft) === state?.policy?.requiredApprovals;
  setServiceText(document.getElementById('branch-review-policy-status'), ready
    ? `${state.policy.requiredApprovals ? `${state.policy.requiredApprovals} independent approval${state.policy.requiredApprovals === 1 ? '' : 's'} required` : 'Branch protection is off'}. ${owner ? 'Changes apply to this service branch.' : 'Only a project owner can change this policy.'}`
    : 'Refresh branch review to load the policy. Only a project owner can change it.');
  const candidates = ready ? (state.candidates || []).filter(item => (!item.projectId || item.projectId === state.selection.projectId) && item.parentRevisionId === state.headRevisionId) : [];
  const candidateSelect = document.getElementById('branch-review-candidate');
  const candidateKey = JSON.stringify([state?.scopeId, candidates.map(item => [item.revisionId, item.message, item.canRequest])]);
  if (candidateKey !== branchReviewCandidateOptionsKey) {
    branchReviewCandidateOptionsKey = candidateKey; candidateSelect.replaceChildren(new Option(candidates.length ? 'Choose a saved proposal' : 'No saved direct-child proposals', ''));
    for (const candidate of candidates) {
      const option = new Option(`${candidate.message || 'Saved proposal'} · ${candidate.revisionId.slice(0, 8)}`, candidate.revisionId);
      option.disabled = candidate.canRequest !== true; candidateSelect.add(option);
    }
  }
  const candidate = candidates.find(item => item.revisionId === branchReviewCandidateChoice);
  if (!candidate) branchReviewCandidateChoice = '';
  candidateSelect.value = branchReviewCandidateChoice;
  candidateSelect.disabled = busy || !write || !state?.policy?.requiredApprovals || !window.desktop?.requestBranchApproval;
  document.getElementById('branch-review-request').disabled = candidateSelect.disabled || candidate?.canRequest !== true;
  const requests = state ? (state.requests || []).filter(item => item.projectId === state.selection.projectId && item.branch === state.selection.branch) : [];
  const ids = new Set(requests.map(item => item.id)), list = document.getElementById('branch-review-requests');
  for (const [id, view] of branchReviewRows) if (!ids.has(id)) { view.row.remove(); branchReviewRows.delete(id); }
  requests.forEach((request, index) => {
    let view = branchReviewRows.get(request.id);
    if (!view) {
      const row = make('article', 'branch-review-request'); row.setAttribute('role', 'listitem');
      const title = make('h4'), summary = make('p'), proposal = make('p'), stamp = make('p'), approve = make('button', '', 'Approve proposal');
      const evidence = make('details'), evidenceTitle = make('summary', '', 'Proposal identity'), facts = make('dl', 'service-base-facts');
      const requestId = make('dd'), expectedHead = make('dd'), revisionId = make('dd'), manifestId = make('dd');
      facts.append(make('dt', '', 'Request'), requestId, make('dt', '', 'Expected head'), expectedHead,
        make('dt', '', 'Revision'), revisionId, make('dt', '', 'Manifest'), manifestId); evidence.append(evidenceTitle, facts);
      approve.type = 'button'; approve.addEventListener('click', () => runBranchReviewAction('approveBranchRequest', { scopeId: branchReviewState?.scopeId, requestId: request.id }));
      row.append(title, summary, proposal, stamp, evidence, approve); view = { row, title, summary, proposal, stamp, evidence, requestId, expectedHead, revisionId, manifestId, approve }; branchReviewRows.set(request.id, view);
    }
    const statuses = { pending: 'Awaiting approvals', approved: 'Approved — requester must retry push', stale: 'Stale — head or policy changed', expired: 'Expired', applied: 'Published' };
    setServiceText(view.title, request.proposal?.message || 'Saved revision proposal');
    setServiceText(view.summary, `${statuses[request.status] || 'Review status unavailable'} · ${request.activeApprovals} active / ${request.requiredApprovals} required · ${request.recordedApprovals} recorded`);
    setServiceText(view.proposal, `Requested by ${branchReviewMember(request.requesterId)} · Revision author ${branchReviewMember(request.proposal?.authorId)}`);
    view.proposal.title = `Requester ID: ${request.requesterId}; author ID: ${request.proposal?.authorId || ''}`;
    setServiceText(view.stamp, `Requested ${serviceDate(request.createdAt)} · Expires ${serviceDate(request.expiresAt)} · Policy ${request.policyVersion}`);
    for (const [field, value] of [['requestId', request.id], ['expectedHead', request.expectedHead || 'Empty branch'], ['revisionId', request.revisionId], ['manifestId', request.proposal?.manifestId]]) setServiceText(view[field], value || 'Unavailable');
    view.approve.hidden = request.canApprove !== true; view.approve.disabled = busy || !write || !window.desktop?.approveBranchRequest;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  for (const [suffix, cursor] of [['candidates', state?.nextCandidateCursor], ['requests', state?.nextRequestCursor]]) {
    const more = document.getElementById(`branch-review-${suffix}-more`); more.hidden = !cursor;
    more.disabled = busy || !ready || !window.desktop?.refreshBranchReview;
  }
  const status = !hasAPI ? 'Branch reviews are unavailable in this build.' : !account ? 'Sign in to review service branch approvals.'
    : pending ? 'Updating branch review…' : branchReviewNotice || (state?.error ? branchReviewErrorLabel(state.error)
      : !state ? 'Select a service project and branch to review approvals.' : !ready ? 'Refresh branch review to verify the current head, policy and requests.'
        : state.role === 'viewer' ? 'Viewer access allows reading branch reviews. Requesting or approving requires editor or owner access.'
          : 'Approvals authorize the exact proposal, head and policy shown here. They do not publish it.');
  setServiceText(document.getElementById('branch-review-status'), status);
  setServiceText(document.getElementById('branch-review-range'), ready || requests.length ? `${requests.length} request${requests.length === 1 ? '' : 's'} shown · ${candidates.length} proposal${candidates.length === 1 ? '' : 's'} loaded` : '');
  document.getElementById('branch-review-panel').setAttribute('aria-busy', String(busy));
}
async function runBranchReviewAction(method, input) {
  const account = currentBranchReviewAccount(), scopeId = branchReviewState?.scopeId;
  if (!account || branchReviewAction || branchReviewState?.busy || !window.desktop?.[method]) return;
  if (['setBranchProtection', 'requestBranchApproval', 'approveBranchRequest'].includes(method) && (!scopeId || input?.scopeId !== scopeId)) return;
  const action = { method, account, scopeId, selection: branchReviewState?.selection ? { ...branchReviewState.selection } : null,
    role: branchReviewState?.role, headRevisionId: branchReviewState?.headRevisionId, policyVersion: branchReviewState?.policy?.version,
    requiredApprovals: branchReviewState?.policy?.requiredApprovals, requestedApprovals: input?.requiredApprovals, requestId: input?.requestId }, focused = document.activeElement;
  branchReviewAction = action; branchReviewNotice = ''; renderBranchReview();
  try {
    const state = await window.desktop[method](input);
    if (branchReviewAction !== action || account !== currentBranchReviewAccount()) return;
    if (method !== 'selectBranchReview' && method !== 'refreshBranchReview' && branchReviewState?.scopeId !== scopeId
      && !branchReviewReceiptMatches(action, state)) return;
    if (renderBranchReviewState(state, account) && branchReviewReceiptMatches(action, state)) {
      const messages = { 'policy-saved': 'Branch policy saved.', requested: 'Review requested. Eligible reviewers can now approve the proposal.', approved: 'Approval recorded. The requester must retry the push to publish.' };
      branchReviewNotice = messages[state.outcome.kind];
      if (!state.ready || state.error) branchReviewNotice += ' Refresh branch review to reload the current state.';
    }
  } catch { if (branchReviewAction === action && account === currentBranchReviewAccount()) branchReviewNotice = 'The branch review action could not finish. Refresh branch review and retry.'; }
  finally {
    const finishing = branchReviewAction === action;
    if (finishing) branchReviewAction = null;
    renderBranchReview();
    if (finishing && focused && account === currentBranchReviewAccount() && (document.activeElement === document.body || document.activeElement === focused)) {
      const target = focused.isConnected && !focused.disabled && !focused.closest('[hidden]') ? focused : document.getElementById('branch-review-status');
      target.focus({ preventScroll: true });
    }
  }
}
function serviceSelectionMatches(state = serviceState) {
  return !!state?.selection && state.selection.localProjectId === currentAppState?.selectedProject?.id
    && state.selection.branch === (currentAppState?.currentBranch || 'main');
}
function serviceProjectOptions() {
  const projects = serviceState?.projects || [];
  const projectSelect = document.getElementById('service-project');
  const key = JSON.stringify(projects.map(project => [project.id, project.name, project.role, project.branches]));
  if (key !== serviceProjectsRenderKey) {
    serviceProjectsRenderKey = key; projectSelect.replaceChildren(new Option(projects.length ? 'Choose a service project' : 'No accessible service projects', ''));
    for (const project of projects) projectSelect.add(new Option(`${project.name} · ${project.role}`, project.id));
  }
  if (!projects.some(project => project.id === serviceProjectChoice)) serviceProjectChoice = '';
  if (projectSelect.value !== serviceProjectChoice) projectSelect.value = serviceProjectChoice;
  const project = projects.find(item => item.id === serviceProjectChoice);
  const branches = project?.branches || [];
  const branchSelect = document.getElementById('service-branch');
  const branchKey = JSON.stringify([project?.id, branches]);
  if (branchKey !== serviceBranchesRenderKey) {
    serviceBranchesRenderKey = branchKey; branchSelect.replaceChildren(new Option('Choose a service branch', ''));
    for (const branch of branches) branchSelect.add(new Option(branch, branch));
  }
  if (!branches.includes(serviceBranchChoice)) serviceBranchChoice = branches.includes('main') ? 'main' : branches[0] || '';
  if (branchSelect.value !== serviceBranchChoice) branchSelect.value = serviceBranchChoice;
  setServiceText(document.getElementById('service-project-role'), project ? project.role === 'viewer'
    ? 'Viewer access: fetching history is available; pushing revisions requires editor or owner access.'
    : `${project.role === 'owner' ? 'Owner' : 'Editor'} access permits pushing verified revision metadata.`
    : projects.length ? 'Choose a project to see its branches and your access role.' : 'Refresh projects after an administrator grants your account project access.');
  return project;
}
function serviceDate(value) {
  if (value === null || value === undefined || value === '') return 'Time unavailable';
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable';
}
function renderFetchedServiceHistory(fetched) {
  const details = document.getElementById('service-fetched-history'); details.hidden = !fetched;
  if (!fetched) {
    if (serviceFetchedRenderKey) {
      document.getElementById('service-fetched-list').replaceChildren();
      setServiceText(document.getElementById('service-fetched-summary'), 'Fetched service history');
      setServiceText(document.getElementById('service-fetched-stamp'), '');
      setServiceText(document.getElementById('service-fetched-range'), ''); details.open = false;
    }
    serviceFetchedRenderKey = ''; return;
  }
  const rows = Array.isArray(fetched.revisions) ? fetched.revisions : [];
  const fetchKey = JSON.stringify([fetched.checkedAt, fetched.head, rows.map(row => row.id)]);
  const previousFetch = serviceFetchedRenderKey.split('|')[0];
  if (previousFetch !== fetchKey) serviceFetchedVisible = 20;
  const key = `${fetchKey}|${serviceFetchedVisible}`;
  if (key === serviceFetchedRenderKey) return;
  serviceFetchedRenderKey = key;
  const total = fetched.total ?? fetched.revisionCount ?? rows.length;
  const visible = Math.min(serviceFetchedVisible, rows.length);
  setServiceText(document.getElementById('service-fetched-summary'), `Fetched service history · ${total} revision${total === 1 ? '' : 's'}`);
  setServiceText(document.getElementById('service-fetched-stamp'), `${fetched.manifestCount} manifest${fetched.manifestCount === 1 ? '' : 's'} · ${fetched.checkedAt === null || fetched.checkedAt === undefined ? 'Fetch time unavailable' : `Fetched ${serviceDate(fetched.checkedAt)}`}${fetched.head ? ` · Head ${fetched.head.slice(0, 12)}` : ''}`);
  setServiceText(document.getElementById('service-fetched-range'), rows.length
    ? `Showing 1–${visible} of ${total} revisions, newest first.${rows.length < total ? ` This view includes the latest ${rows.length}; older revisions are not listed here.` : ''}`
    : total ? `${total} revisions were fetched; revision details are unavailable in this view.` : 'The service branch has no revisions.');
  const list = document.getElementById('service-fetched-list'); list.replaceChildren();
  for (const revision of rows.slice(0, visible)) {
    const row = make('article', 'service-fetched-revision');
    row.append(make('h4', '', revision.message), make('p', '', `Author ${revision.authorId}`),
      make('p', '', `${serviceDate(revision.createdAt)} · ${revision.id}`)); list.append(row);
  }
  document.getElementById('service-fetched-more').hidden = visible >= rows.length;
}
function renderServicePanel() {
  const state = serviceState;
  const status = state?.status || 'not-configured';
  const busy = serviceActionBusy || !!state?.busy;
  const available = typeof window.desktop?.getServiceState === 'function';
  const account = state?.account;
  const contact = !!account && ['connected', 'offline'].includes(status);
  const signedIn = !!account && status !== 'sign-in-required';
  const matching = serviceSelectionMatches(state);
  const binding = matching ? state?.binding : null;
  const form = document.getElementById('service-connect-form');
  form.hidden = signedIn;
  document.getElementById('service-connection-help').hidden = signedIn;
  form.querySelectorAll('input, button').forEach(control => { control.disabled = busy || !available; });
  setServiceText(document.getElementById('service-connect'), busy && status === 'connecting' ? 'Signing in…' : 'Sign in');
  if (!serviceOriginInitialized && state?.origin) {
    serviceOriginInitialized = true;
    if (state.origin && !document.getElementById('service-origin').value) document.getElementById('service-origin').value = state.origin;
    if (account?.email && !document.getElementById('service-email').value) document.getElementById('service-email').value = account.email;
  }
  const statusText = { 'not-configured': 'Local only', connecting: 'Connecting', connected: 'Connected', offline: 'Offline', 'sign-in-required': 'Sign in required' }[status] || 'Local only';
  setServiceText(document.getElementById('sync-service-state'), statusText);
  const descriptions = { 'not-configured': 'Sign in to an existing Frameline service account.', connecting: 'Connecting to the service…',
    connected: 'Your service account is connected.', offline: 'The service is unavailable. Last known project access is shown.',
    'sign-in-required': 'Sign in again to continue with service history.' };
  setServiceText(document.getElementById('service-summary'), available ? descriptions[status] || descriptions['not-configured'] : 'Service connections are unavailable in this build.');
  document.getElementById('service-account-row').hidden = !account;
  setServiceText(document.getElementById('service-account-email'), account?.email || '');
  setServiceText(document.getElementById('service-account-origin'), state?.origin || '');
  document.getElementById('service-disconnect').disabled = busy || !available;
  const notice = serviceActionNotice || (state?.error ? serviceErrorLabel(state.error) : '');
  document.getElementById('service-notice').hidden = !notice; setServiceText(document.getElementById('service-notice'), notice);
  document.getElementById('service-panel').setAttribute('aria-busy', String(busy));
  document.getElementById('service-project-area').hidden = !account;
  const bindingKey = matching && binding ? `${state.selection.localProjectId}:${state.selection.branch}:${binding.remoteProjectId}:${binding.remoteBranch}` : '';
  if (bindingKey !== serviceBindingChoiceKey) {
    serviceBindingChoiceKey = bindingKey;
    if (binding) { serviceProjectChoice = binding.remoteProjectId; serviceBranchChoice = binding.remoteBranch; }
  }
  const project = serviceProjectOptions();
  document.getElementById('service-project').disabled = busy || !contact;
  document.getElementById('service-branch').disabled = busy || !contact || !project;
  document.getElementById('service-projects-refresh').disabled = busy || !contact;
  const local = currentAppState?.selectedProject;
  const localBranch = currentAppState?.currentBranch || 'main';
  setServiceText(document.getElementById('service-local-selection'), local?.id
    ? `Local branch: ${local.name} · ${localBranch}` : 'Choose a local FCPXML export before linking a service project.');
  document.getElementById('service-bind').disabled = busy || !state?.connected || !local?.id || !matching || !project || !serviceBranchChoice;
  document.getElementById('service-bound-row').hidden = !binding;
  setServiceText(document.getElementById('service-binding-summary'), binding
    ? `Linked to ${binding.remoteProjectName} · ${binding.remoteBranch} · ${binding.role} access` : '');
  document.getElementById('service-unlink').disabled = busy || !binding;
  document.getElementById('service-unlink').title = 'Remove this local mapping. Service revisions stay on the service.';
  const sync = matching ? state?.sync : null;
  const syncLabels = { unbound: binding ? 'Check the linked branch heads before pushing.' : 'Link this local branch to a service project to check history.',
    checking: busy ? 'Checking local and service branch heads…' : 'Check history to compare the local and service branch heads.', 'in-sync': 'Branch heads matched at last check.',
    'local-ahead': 'The local branch has revisions ready to push.', 'remote-ahead': 'The service branch has newer revisions. Fetch history to inspect them.',
    diverged: 'Both branches changed. Fetch history to inspect the revisions; reconciliation is not available.',
    offline: 'The service is unavailable. Check history when the connection returns.', error: serviceErrorLabel(sync?.error) };
  setServiceText(document.getElementById('service-sync-status'), syncLabels[sync?.status || 'unbound'] || syncLabels.unbound);
  const hasRevision = !!currentAppState?.revisions?.length;
  const ready = hasRevision && currentAppState?.scanStatus === 'ready' && !currentAppState?.error && local?.format === 'FCPXML';
  const writeRole = binding && ['owner', 'editor'].includes(binding.role);
  document.getElementById('service-check').disabled = busy || !contact || !binding;
  document.getElementById('service-fetch').disabled = busy || !state?.connected || !binding;
  document.getElementById('service-push').disabled = busy || !state?.connected || !binding || !writeRole || !ready || sync?.status !== 'local-ahead';
  setServiceText(document.getElementById('service-sync-help'), binding?.role === 'viewer'
    ? 'Viewer access allows fetching history. Pushing requires editor or owner access.'
    : !ready ? 'Scan the selected FCPXML export and save a local revision before pushing.'
      : !binding ? 'Link the selected local branch to a service project before checking history.'
        : sync?.status === 'local-ahead' ? 'Push sends the verified saved revisions on this local branch.'
          : 'Check history after saving a revision. Push becomes available when the local branch is ahead.');
  renderFetchedServiceHistory(matching ? state?.fetched : null);
  renderSyncState(state);
  renderServiceSharedBase(); refreshHistorySharingDisplay();
  renderServiceComparison();
  syncProjectActivityContext(); renderProjectActivity();
  syncBranchReviewAccount();
  syncShareLinksAccount();
}
function renderServiceState(state) {
  if (!state || !Number.isSafeInteger(state.version) || state.version < serviceStateVersion) return;
  if ((state.error && state.error !== serviceState?.error)
    || state.status === 'sign-in-required' && serviceState?.status !== 'sign-in-required') document.getElementById('service-password').value = '';
  serviceStateVersion = state.version; serviceState = state; renderServicePanel();
  syncAssetTransferContext(); renderAssetTransferPanel();
  syncResolveServiceAccount();
}
async function refreshServiceState() {
  if (!window.desktop?.getServiceState) return;
  try { renderServiceState(await window.desktop.getServiceState()); }
  catch { serviceActionNotice = 'Could not refresh the service state. Try again after the app is ready.'; renderServicePanel(); }
}
async function runServiceAction(method, input) {
  if (serviceActionBusy || serviceState?.busy || typeof window.desktop?.[method] !== 'function') return;
  serviceActionBusy = true; serviceActionMethod = method; serviceActionNotice = '';
  serviceBaseTransition = ['connectService', 'disconnectService', 'bindServiceProject', 'unlinkServiceProject'].includes(method);
  renderServicePanel();
  try {
    renderServiceState(await window.desktop[method](input));
    if (method === 'fetchServiceRevisions' && serviceState?.fetched && serviceSelectionMatches()) document.getElementById('service-fetched-history').open = true;
  } catch { serviceActionNotice = 'The service action could not finish. Check your connection and try again.'; }
  finally {
    document.getElementById('service-password').value = '';
    serviceActionBusy = false; serviceActionMethod = null; serviceBaseTransition = false; renderServicePanel();
  }
}

function serviceComparisonScopeReady() {
  return !serviceBaseTransition && serviceSelectionMatches() && !!serviceState?.account && !!serviceState?.binding
    && ['connected', 'offline'].includes(serviceState.status);
}
function currentServiceComparison() {
  if (!serviceComparisonScopeReady() || currentAppState?.scanStatus !== 'ready' || currentAppState?.error) return null;
  const result = serviceState.comparison?.status === 'ready' ? serviceState.comparison.result : null;
  const base = currentServiceBase(), binding = result?.binding;
  if (!result || result.readOnly !== true || result.safeToApply !== false || base?.status !== 'recorded' || !binding
    || binding.baseLocalRevisionId !== base.localRevisionId || binding.baseRemoteRevisionId !== base.remoteRevisionId
    || binding.incomingRevisionId !== serviceState.fetched?.head || !binding.incomingRevisionId
    || binding.localHeadId !== (currentAppState.revisions?.[0]?.id || null)
    || binding.localSourceHash !== currentAppState.scan?.sourceHash || !binding.localSourceHash
    || binding.fetchedAt !== serviceState.fetched?.checkedAt || !Array.isArray(result.changes) || result.changes.length > 3) return null;
  const fields = new Set();
  for (const change of result.changes) {
    if (!['name', 'frameDuration', 'durationFrames'].includes(change.field) || fields.has(change.field)
      || !['incoming-only', 'local-only', 'already-applied', 'conflict'].includes(change.status)) return null;
    fields.add(change.field);
  }
  return result;
}
function serviceComparisonErrorLabel(code) {
  return ({ 'comparison-source-required': 'Scan the selected FCPXML export before comparing its sequence.',
    'revision-source-changed': 'The export changed since scanning. Rescan it, then compare again.',
    'comparison-fetch-required': 'Fetch service history explicitly before comparing the captured incoming sequence.',
    'comparison-stale': 'The comparison sources changed. Rescan the export or fetch current service history, then compare again.',
    'comparison-base-invalid': 'The shared base could not be verified for comparison. Check history, then fetch service history again.',
    'service-comparison-invalid': 'The sequence comparison could not be verified. Check history and fetch service history, then retry.',
    'service-comparison-base-invalid': 'The comparison base could not be verified. Check history before comparing again.',
    'service-comparison-incoming-invalid': 'The incoming comparison source could not be verified. Fetch service history again.',
    'service-comparison-unsupported': 'These sources are outside the supported sequence comparison. Clip edits and media identity cannot be compared here.',
    'service-comparison-too-large': 'These sources exceed the local comparison limits. Use a smaller supported export.',
    'file-unavailable': 'The selected export is unavailable. Choose a readable export and scan it again.' })[code] || serviceErrorLabel(code);
}
function renderServiceComparison() {
  const scoped = serviceComparisonScopeReady(), comparison = scoped ? serviceState?.comparison : null;
  const base = scoped ? currentServiceBase() : null, result = currentServiceComparison();
  const scanReady = currentAppState?.scanStatus === 'ready' && !currentAppState?.error && !!currentAppState?.scan?.sourceHash;
  const busy = serviceActionBusy || !!serviceState?.busy;
  const button = document.getElementById('service-comparison-run');
  button.disabled = !scoped || busy || !scanReady || base?.status !== 'recorded' || !serviceState?.fetched?.head
    || typeof window.desktop?.compareServiceRevisions !== 'function';
  setServiceText(button, serviceActionMethod === 'compareServiceRevisions' ? 'Comparing…'
    : comparison?.result ? 'Refresh comparison' : 'Compare sequence');
  const conflicts = result?.changes.filter(change => change.status === 'conflict').length || 0;
  const status = !scoped ? 'Sign in and link the selected local branch to compare sequence snapshots.'
    : !window.desktop?.compareServiceRevisions ? 'Service sequence comparison is unavailable in this build.'
      : serviceActionMethod === 'compareServiceRevisions' ? 'Comparing the captured sequence values…'
        : comparison?.status === 'error' ? serviceComparisonErrorLabel(comparison.error)
          : !scanReady ? 'Scan the selected FCPXML export before comparing. Unsaved scan changes can be compared.'
            : base?.status !== 'recorded' ? 'Check history to record a verified shared base before comparing.'
              : !serviceState?.fetched?.head ? 'Fetch service history to capture an incoming revision before comparing.'
                : comparison?.result && !result ? 'The captured comparison no longer matches these sources. Refresh comparison to compare the current scan and fetched history.'
                  : result ? result.changes.length ? `${result.changes.length} changed sequence field${result.changes.length === 1 ? '' : 's'} · ${conflicts} conflict${conflicts === 1 ? '' : 's'}. Read-only observation.`
                    : 'No sequence-level differences were observed in these snapshots.'
                    : 'Compare the current scan with the recorded base and explicitly fetched service head. No network request is made by this comparison.';
  setServiceText(document.getElementById('service-comparison-status'), status);
  document.getElementById('service-comparison-result').hidden = !result;
  const key = JSON.stringify([currentProjectActivityContext(), result]);
  if (key === serviceComparisonRenderKey) return;
  serviceComparisonRenderKey = key;
  const fields = document.getElementById('service-comparison-fields'), facts = document.getElementById('service-comparison-facts');
  const context = document.getElementById('service-comparison-context'), warnings = document.getElementById('service-comparison-warnings');
  for (const node of [fields, facts, context, warnings]) node.replaceChildren();
  setServiceText(document.getElementById('service-comparison-stamp'), result
    ? `Comparison captured ${serviceDate(result.createdAt)}. Incoming history fetched ${serviceDate(result.binding.fetchedAt)}; newer service changes require another fetch.` : '');
  if (!result) { document.getElementById('service-comparison-evidence').open = false; return; }
  const fieldLabels = { name: 'Sequence name', frameDuration: 'Frame duration', durationFrames: 'Sequence length' };
  const statusLabels = { 'incoming-only': 'Incoming change', 'local-only': 'Local change', 'already-applied': 'Same change observed', conflict: 'Different local and incoming changes' };
  for (const change of result.changes) {
    const row = make('div', 'service-comparison-field'), heading = make('div', 'service-comparison-field-heading');
    heading.append(make('h4', '', fieldLabels[change.field]), make('span', '', statusLabels[change.status]));
    const values = make('dl', 'service-comparison-values');
    for (const [role, label] of [['base', 'Base'], ['local', 'Current scan'], ['incoming', 'Fetched incoming']]) {
      const cell = make('div'); const value = change[role];
      cell.append(make('dt', '', label), make('dd', '', change.field === 'durationFrames' ? `${value} frames` : String(value)));
      values.append(cell);
    }
    row.append(heading, values); fields.append(row);
  }
  for (const [label, value] of [['Base local revision', result.binding.baseLocalRevisionId], ['Base service revision', result.binding.baseRemoteRevisionId],
    ['Local saved head', result.binding.localHeadId || 'No saved revision'], ['Incoming revision', result.binding.incomingRevisionId],
    ['Base source hash', result.binding.baseSourceHash], ['Current scan hash', result.binding.localSourceHash], ['Incoming source hash', result.binding.incomingSourceHash]]) {
    facts.append(make('dt', '', label), make('dd', '', value));
  }
  for (const [role, label] of [['base', 'Base'], ['local', 'Current scan'], ['incoming', 'Fetched incoming']]) {
    const observed = result.context?.[role];
    if (observed) context.append(make('p', 'service-help', `${label}: ${observed.clipCount} picture clips · ${observed.mediaCount} media references${observed.mediaNamesAmbiguous ? ' · repeated media names observed' : ''}. Counts are context only; clips and media were not matched.`));
  }
  for (const warning of result.warnings || []) warnings.append(make('li', '', warning));
  warnings.hidden = !warnings.children.length;
}

function currentServiceBase() {
  return !serviceBaseTransition && serviceSelectionMatches() && serviceState?.account && serviceState?.binding
    && ['connected', 'offline'].includes(serviceState.status) ? serviceState.base : null;
}
function recordedServiceBase() {
  const base = currentServiceBase();
  return base && ['recorded', 'unconfirmed'].includes(base.status)
    && typeof base.localRevisionId === 'string' && base.localRevisionId
    && typeof base.remoteRevisionId === 'string' && base.remoteRevisionId
    && typeof base.manifestId === 'string' && base.manifestId
    && Number.isSafeInteger(base.verifiedAt) && base.verifiedAt >= 0 ? base : null;
}
function serviceBaseEvidenceKey() {
  return JSON.stringify([currentProjectActivityContext(), serviceState?.status, serviceBaseTransition, currentServiceBase() || null]);
}
function revisionSharingLabel(revision) {
  const base = recordedServiceBase();
  if (!base) return { label: 'Local revision', kind: 'local-only' };
  if (revision.id === base.localRevisionId) return { label: 'Last shared base', kind: 'shared-base' };
  const records = new Map((currentAppState?.revisions || []).map(item => [item.id, item]));
  const visited = new Set(); let parent = revision.parentRevisionId;
  while (parent && !visited.has(parent)) {
    if (parent === base.localRevisionId) return { label: 'After shared base', kind: 'after-shared-base' };
    visited.add(parent); parent = records.get(parent)?.parentRevisionId;
  }
  return { label: 'Local revision', kind: 'local-only' };
}
function renderServiceSharedBase() {
  const base = currentServiceBase(), recorded = recordedServiceBase();
  const panel = document.getElementById('service-shared-base');
  panel.hidden = serviceBaseTransition || !serviceSelectionMatches() || !serviceState?.account || !serviceState?.binding
    || !['connected', 'offline'].includes(serviceState?.status);
  const labels = { none: 'No shared base has been recorded for this linked account and branch. Check history to verify a match.',
    recorded: 'Recorded after a verified service exchange.',
    invalid: 'The saved shared-base record could not be verified. Check history to verify the linked history again.',
    unconfirmed: recorded ? 'The latest shared-base record is not confirmed saved. Showing the prior recorded base. Check history to retry.'
      : 'The shared-base record is not confirmed saved. Check history to retry.' };
  setServiceText(document.getElementById('service-base-status'), `${labels[base?.status] || labels.none}${serviceState?.status === 'offline' ? ' Current service state is unchecked while offline.' : ''}`);
  document.getElementById('service-base-facts').hidden = !recorded;
  for (const [id, value] of [['local', recorded?.localRevisionId], ['remote', recorded?.remoteRevisionId],
    ['manifest', recorded?.manifestId], ['time', recorded ? serviceDate(recorded.verifiedAt) : null]]) {
    setServiceText(document.getElementById(`service-base-${id}`), value || '');
  }
}
function refreshHistorySharingDisplay() {
  if (!currentAppState?.selectedProject) return;
  const evidenceKey = serviceBaseEvidenceKey();
  if (historyWindow && historyWindow.evidenceKey !== evidenceKey) {
    for (const row of document.querySelectorAll('#history-list [data-revision-index]')) {
      const revision = displayedRevisions[Number(row.dataset.revisionIndex)], label = row.querySelector('.revision-sync-state');
      if (!revision || !label) continue;
      const sharing = revisionSharingLabel(revision); setServiceText(label, sharing.label);
      label.className = `revision-sync-state ${sharing.kind}`;
    }
    historyWindow.evidenceKey = evidenceKey;
  }
  const detail = document.getElementById('revision-detail-sharing');
  if (detail && currentAppState.selectedRevision) setServiceText(detail, revisionSharingLabel(currentAppState.selectedRevision).label);
}

function currentProjectActivityContext() {
  if (!serviceSelectionMatches() || !serviceState?.account || !serviceState?.binding) return '';
  return JSON.stringify([serviceState.origin, serviceState.account.id, serviceState.selection.localProjectId,
    serviceState.selection.branch, serviceState.binding.remoteProjectId, serviceState.binding.remoteBranch]);
}
function projectActivityScopeMatches(state = projectActivityState) {
  const scope = state?.scope;
  return !!currentProjectActivityContext() && !!scope && scope.accountId === serviceState?.account?.id
    && scope.localProjectId === serviceState?.selection?.localProjectId && scope.localBranch === serviceState?.selection?.branch
    && scope.remoteProjectId === serviceState?.binding?.remoteProjectId && scope.remoteBranch === serviceState?.binding?.remoteBranch;
}
function syncProjectActivityContext() {
  const context = currentProjectActivityContext();
  if (context === projectActivityContext) return;
  projectActivityContext = context; projectActivityState = null; projectActivityView = 'inbox';
  projectActivityAction = null; projectActivityNotice = '';
  for (const view of projectActivityRows.values()) view.row.remove();
  projectActivityRows.clear();
  refreshProjectActivityState(context);
}
function projectActivityRow(event) {
  if (projectActivityRows.has(event.id)) return projectActivityRows.get(event.id);
  const row = make('div', 'project-activity-row'); row.setAttribute('role', 'listitem');
  const body = make('div', 'project-activity-body'), title = make('h4'), meta = make('p'), subject = make('p');
  const read = make('button', '', 'Mark read'); read.type = 'button';
  read.addEventListener('click', () => runProjectActivityAction('markProjectNotificationRead', event.id));
  body.append(title, meta, subject); row.append(body, read);
  const view = { row, title, meta, subject, read }; projectActivityRows.set(event.id, view); return view;
}
function renderProjectActivity() {
  const matching = projectActivityScopeMatches(), state = matching ? projectActivityState : null;
  const available = !!state?.available, pending = projectActivityAction?.context === currentProjectActivityContext() ? projectActivityAction : null;
  const busy = !!pending || !!state?.busy, list = document.getElementById('project-activity-list');
  const blocked = state?.status === 'access-changed';
  const items = blocked || !state || state.view !== projectActivityView ? [] : state.items || [];
  const ids = new Set(items.map(event => event.id));
  const focused = document.activeElement;
  let removedFocus = false;
  for (const [id, view] of projectActivityRows) if (!ids.has(id)) {
    if (view.row.contains(focused)) removedFocus = true;
    view.row.remove(); projectActivityRows.delete(id);
  }
  const labels = { 'revision.created': 'Revision published', 'branch.changed': 'Branch updated', 'pull.completed': 'Pull completed',
    'member.invited': 'Project invitation created', 'member.joined': 'Member joined', 'member.role-changed': 'Member permissions changed',
    'member.removed': 'Member removed', 'owner.transferred': 'Project ownership transferred', 'project.deleted': 'Project deleted',
    'branch.protection-changed': 'Branch protection changed', 'approval.requested': 'Branch review requested',
    'approval.recorded': 'Branch approval recorded', 'approval.applied': 'Approved revision published',
    'share.created': 'Read-only link created', 'share.revoked': 'Read-only link revoked' };
  items.forEach((event, index) => {
    const view = projectActivityRow(event), unread = event.read === false;
    setServiceText(view.title, `${labels[event.type] || 'Project updated'}${unread ? ' · Unread' : ''}`);
    setServiceText(view.meta, `Actor ${event.actorId} · ${serviceDate(event.at)}`);
    setServiceText(view.subject, event.subjectId ? `${['branch.changed', 'branch.protection-changed'].includes(event.type) ? 'Branch' : 'Subject'} ${event.subjectId}` : 'Project-wide update');
    const wasFocused = focused === view.read;
    view.read.hidden = !unread; view.read.disabled = busy || !available;
    view.read.setAttribute('aria-label', `Mark ${labels[event.type]?.toLowerCase() || 'project update'} read`);
    if (wasFocused && !unread) removedFocus = true;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  const refresh = document.getElementById('project-activity-refresh');
  refresh.disabled = busy || !currentProjectActivityContext() || !window.desktop?.refreshProjectActivity;
  setServiceText(refresh, pending?.method === 'refreshProjectActivity' ? 'Refreshing…' : 'Refresh activity');
  const select = document.getElementById('project-activity-view');
  select.disabled = busy || !available || !window.desktop?.refreshProjectActivity;
  if (select.value !== projectActivityView) select.value = projectActivityView;
  const watch = document.getElementById('project-activity-watch');
  watch.checked = !!state?.watch; watch.disabled = busy || !available || !window.desktop?.setProjectActivityWatch;
  setServiceText(document.getElementById('project-activity-unread'), state && state.status !== 'idle' && !blocked
    ? `${(state.unreadCount || 0).toLocaleString()} unread` : 'Unread not checked');
  const errorLabel = ({ 'activity-display-limit': 'Showing the most recent 500 updates. Refresh activity to start again with the newest page.',
    'activity-input-invalid': 'Choose Inbox or All activity, then refresh activity.',
    'activity-unavailable': 'Link an accessible service project, then refresh activity.',
    'activity-busy': 'Another activity request is running. Wait for it to finish, then retry.',
    'activity-selection-changed': 'The linked project changed. Refresh activity for the current project.',
    'activity-local-error': 'Project updates could not be read locally. Refresh activity to retry.' })[state?.error];
  const status = !currentProjectActivityContext() ? 'Sign in and link a service project to check its activity.'
    : !window.desktop?.getProjectActivityState ? 'Project activity is unavailable in this build.'
      : blocked ? 'Project access changed. Refresh projects and choose an accessible project.'
        : state?.status === 'offline' ? 'The service is unavailable. These updates describe the last successful check; refresh when connected.'
          : state?.status === 'error' ? 'Project updates could not be loaded. Refresh activity or sign in again, then retry.'
            : projectActivityNotice || errorLabel || (busy || state?.status === 'loading' ? 'Checking project updates…'
              : !state || state.status === 'idle' ? 'Refresh activity to check for project updates.'
                : items.length ? 'Project-wide updates. Opening this list does not mark inbox items read.'
                  : projectActivityView === 'inbox' ? 'No inbox updates were found for your account in this project.' : 'No recorded project activity was found.');
  setServiceText(document.getElementById('project-activity-status'), status);
  setServiceText(document.getElementById('project-activity-stamp'), state?.lastUpdatedAt && !blocked ? `Last checked ${serviceDate(state.lastUpdatedAt)}` : '');
  setServiceText(document.getElementById('project-activity-range'), items.length ? `${items.length.toLocaleString()} update${items.length === 1 ? '' : 's'} shown${state?.nextCursor ? ' · Older updates available' : ''}` : '');
  const more = document.getElementById('project-activity-more'); more.hidden = !state?.nextCursor || blocked;
  more.disabled = busy || !available || !window.desktop?.loadOlderProjectActivity;
  if (removedFocus) document.getElementById('project-activity-status').focus({ preventScroll: true });
}
function renderProjectActivityState(state, expectedContext = currentProjectActivityContext()) {
  if (!state || expectedContext !== currentProjectActivityContext()) return;
  if (Number.isSafeInteger(state.version) && state.version < projectActivityVersion) return;
  if (state.scope && !projectActivityScopeMatches(state)) return;
  if (Number.isSafeInteger(state.version)) projectActivityVersion = state.version;
  projectActivityState = state;
  const requestedView = projectActivityAction?.context === expectedContext && projectActivityAction.method === 'refreshProjectActivity'
    ? projectActivityAction.view : null;
  if (['inbox', 'activity'].includes(state.view) && (!requestedView || !state.busy || state.view === requestedView)) projectActivityView = state.view;
  renderProjectActivity();
}
async function refreshProjectActivityState(context = currentProjectActivityContext()) {
  if (!window.desktop?.getProjectActivityState) return;
  try { renderProjectActivityState(await window.desktop.getProjectActivityState(), context); }
  catch { if (context === currentProjectActivityContext()) { projectActivityNotice = 'Could not read project activity. Refresh activity to retry.'; renderProjectActivity(); } }
}
async function runProjectActivityAction(method, input) {
  const context = currentProjectActivityContext();
  if (!context || projectActivityAction || projectActivityState?.busy || typeof window.desktop?.[method] !== 'function') return;
  const focused = document.activeElement;
  const action = { context, method, view: input?.view }; projectActivityAction = action; projectActivityNotice = ''; renderProjectActivity();
  try { renderProjectActivityState(await window.desktop[method](input), context); }
  catch { if (context === currentProjectActivityContext()) projectActivityNotice = 'This update could not finish. Refresh activity and try again.'; }
  finally {
    if (projectActivityAction === action) {
      projectActivityAction = null; renderProjectActivity();
      if (context === currentProjectActivityContext() && focused
        && (document.activeElement === document.body || document.activeElement === focused)) {
        const target = focused.isConnected && !focused.disabled && !focused.closest('[hidden]') && focused.getClientRects().length
          ? focused : document.getElementById('project-activity-status');
        target.focus({ preventScroll: true });
      }
    }
  }
}

function currentAssetTransferContext() {
  if (!serviceSelectionMatches() || !serviceState?.account || !serviceState?.binding) return '';
  return JSON.stringify([serviceState.origin, serviceState.account.id, serviceState.selection.localProjectId,
    serviceState.selection.branch, serviceState.binding.remoteProjectId, serviceState.binding.remoteBranch,
    serviceState.binding.role, serviceState.connected]);
}
function syncAssetTransferContext() {
  const context = currentAssetTransferContext();
  if (context === assetTransferContext) return;
  assetTransferContext = context; assetTransferState = null; assetTransferVisibleJobs = 20; assetTransferActionNotice = '';
  assetPolicyDraft = null; assetStorageAutoRefreshedScope = ''; assetStorageActionNotice = ''; assetAvailabilityNeedsCheck = false;
  refreshAssetTransferState();
}
function assetTransferScopeMatches() {
  return !!currentAssetTransferContext() && !!assetTransferState?.scope
    && assetTransferState.scope.remoteProjectId === serviceState?.binding?.remoteProjectId;
}
function assetTransferErrorLabel(code) {
  return ({
    'asset-policy-excluded': 'This media class is disabled for the project. Ask a project owner to enable it before transferring these bytes.',
    'asset-policy-invalid': 'Choose valid media classes and refresh the current policy before saving.',
    'asset-policy-forbidden': 'Only a project owner can change the storage policy or archive state.',
    'asset-policy-version-conflict': 'The storage policy changed while you were editing. Refresh storage and review the saved classes before saving again.',
    'asset-archive-invalid': 'The archive change could not be validated. Check availability again before retrying.',
    'asset-archive-conflict': 'The archive state changed. Check availability again before changing it.',
    'asset-archived': 'This media is archived on the service. A project owner must restore it before it can be downloaded.',
    'asset-transfer-input-invalid': 'Check the content ID, media class and transfer speed limit, then try again.',
    'asset-transfer-unavailable': 'Sign in and link the matching service project before starting or resuming this transfer.',
    'asset-transfer-busy': 'Another media action is running. Cancel it or wait for it to finish.',
    'asset-transfer-capacity-exceeded': 'The saved transfer history has reached its limit. Keep the app data and contact your administrator.',
    'asset-transfer-journal-invalid': 'Saved transfer history could not be verified. Keep the app data for recovery before retrying.',
    'asset-transfer-storage-unavailable': 'Local transfer data could not be saved. Check disk space and permissions, then retry.',
    'asset-transfer-storage-uncertain': 'The transfer save status could not be confirmed. Keep the app data for recovery before retrying.',
    'asset-transfer-interrupted': 'The transfer was interrupted. Resume to continue from verified chunks.',
    'asset-selection-changed': 'The account or linked branch changed. Return to the matching project before resuming its transfer.',
    'asset-viewer-read-only': 'Uploading requires editor or owner access. Viewer access allows downloads.',
    'asset-file-invalid': 'Choose a readable regular media file. Folders and symbolic links are not supported.',
    'asset-identity-mismatch': 'The source no longer matches the reviewed content hash. Choose the file again.',
    'asset-checkpoint-invalid': 'The saved transfer checkpoint could not be verified. Keep the transfer data for recovery.',
    'asset-cache-corrupt': 'A saved media chunk could not be verified. Keep the transfer data for recovery.',
    'asset-local-io-failed': 'The local file could not be read or saved. Check file access and free disk space, then retry.',
    'asset-local-io-uncertain': 'The local save status could not be confirmed. Check the chosen destination before trying again.',
    'asset-storage-uncertain': 'The service save status could not be confirmed. Ask your administrator to check storage before retrying.',
    'asset-network-unavailable': 'The media service could not be reached. Resume the transfer when the connection returns.',
    'asset-cancelled': 'The media action was cancelled.',
    'asset-forbidden': 'Your account cannot access this media operation. Check project access with your administrator.',
    forbidden: 'Your account no longer has access to this project. Check access with your administrator.',
    'access-token-invalid': 'Your service session expired. Sign in again before resuming.',
    'service-sign-in-required': 'Sign in and link a service project before transferring media.',
    'service-project-required': 'Choose a local project and link its branch to a service project first.',
    'service-project-unavailable': 'The linked service project is unavailable. Refresh projects and check access.',
    'asset-source-changed': 'The selected file changed. Choose it again and review its new content hash.',
    'asset-content-mismatch': 'The full content hash did not match. The file was not marked verified.',
    'asset-chunk-corrupt': 'A media chunk could not be verified. Keep the source file and retry the transfer.',
    'asset-chunk-invalid': 'A media chunk failed its size or checksum check. Resume to retry it.',
    'asset-not-found': 'This content ID is not available to the linked project. Check the ID with the project member who shared it.',
    'upload-not-found': 'The service could not find this upload. Choose the source file again to review a new transfer.',
    'asset-verification-timeout': 'Server verification is still unresolved. Resume to check its result before using this media.',
    'asset-download-conflict': 'The destination already exists. Choose another filename for the download.',
    'asset-destination-exists': 'The destination already exists. Choose another filename for the download.',
    'asset-review-required': 'Choose a media file and review its details before confirming the upload.',
    'asset-review-stale': 'This upload review is no longer current. Choose the file again.',
    'asset-request-invalid': 'Enter a content ID beginning with sha256: followed by 64 hexadecimal characters.',
    'asset-identity-invalid': 'The file identity could not be verified. Choose the file again.',
    'asset-state-invalid': 'Saved transfer data could not be verified. Keep the app data for recovery before retrying.',
    'asset-storage-unavailable': 'Transfer data could not be saved. Check disk space and permissions, then retry.',
    'asset-source-unavailable': 'The source file is unavailable. Restore it before resuming this upload.',
    'asset-file-unavailable': 'The selected file is unavailable. Check it in Finder before trying again.'
  })[code] || 'This media action could not finish. Check the service connection and the selected file, then try again.';
}
function assetBytes(value, exact = false) {
  if (!Number.isSafeInteger(value) || value < 0) return 'Size not known yet';
  let label = `${value.toLocaleString()} B`;
  if (value >= 1024 ** 3) label = `${(value / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
  else if (value >= 1024 ** 2) label = `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
  else if (value >= 1024) label = `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} KiB`;
  return exact && value >= 1024 ? `${label} (${value.toLocaleString()} bytes)` : label;
}
function setAssetProgress(progress, text, bytes, total, completed = false) {
  const known = Number.isSafeInteger(total) && total >= 0;
  const count = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
  if (known) {
    progress.max = Math.max(total, 1); progress.value = completed && total === 0 ? 1 : Math.min(count, total);
    const percentage = total ? Math.floor(Math.min(count, total) / total * 100) : completed ? 100 : 0;
    setServiceText(text, `${assetBytes(count)} of ${assetBytes(total)} · ${percentage}%`);
    progress.setAttribute('aria-valuetext', `${count.toLocaleString()} of ${total.toLocaleString()} bytes${completed ? ', complete and verified' : ''}`);
  } else {
    progress.removeAttribute('value'); setServiceText(text, count ? `${assetBytes(count)} transferred · total not known yet` : 'Waiting for the media size');
    progress.setAttribute('aria-valuetext', 'Total size not known yet');
  }
}
function assetTransferJobView(job) {
  let view = assetTransferJobRows.get(job.id);
  if (view) return view;
  const row = make('article', 'asset-transfer-job'), heading = make('div', 'asset-transfer-job-head');
  const name = make('h4'), status = make('span', 'asset-transfer-job-status'), identity = make('p', 'asset-transfer-job-identity');
  const detail = make('p', 'asset-transfer-job-detail'), progressRow = make('div', 'asset-progress-row');
  const progress = make('progress', 'asset-transfer-progress'), bytes = make('span');
  const receipt = make('p', 'asset-transfer-receipt'), notice = make('p', 'asset-transfer-job-error');
  const actions = make('div', 'asset-transfer-job-actions');
  const resume = make('button', '', 'Resume'), cancel = make('button', '', 'Cancel'); resume.type = cancel.type = 'button';
  resume.dataset.assetJobId = cancel.dataset.assetJobId = job.id;
  resume.addEventListener('click', () => runAssetTransferJobAction('resumeAssetTransfer', job.id));
  cancel.addEventListener('click', () => runAssetTransferJobAction('cancelAssetTransfer', job.id));
  heading.append(name, status); progressRow.append(progress, bytes); actions.append(resume, cancel);
  row.append(heading, identity, detail, progressRow, receipt, notice, actions);
  view = { row, name, status, identity, detail, progressRow, progress, bytes, receipt, notice, actions, resume, cancel };
  assetTransferJobRows.set(job.id, view); return view;
}
function renderAssetTransferJobs(jobs, available) {
  const list = document.getElementById('asset-transfer-jobs');
  const visible = jobs.slice(0, assetTransferVisibleJobs), visibleIds = new Set(visible.map(job => job.id));
  for (const [id, view] of assetTransferJobRows) if (!visibleIds.has(id)) { view.row.remove(); assetTransferJobRows.delete(id); }
  let empty = list.querySelector('.asset-transfer-empty');
  if (!jobs.length) {
    if (!empty) { empty = make('p', 'asset-transfer-empty'); list.append(empty); }
    setServiceText(empty, available ? 'Confirmed uploads and chosen downloads appear here. Transfers resume only when you choose Resume.'
      : 'Media transfer history appears for the currently linked service project.');
  } else empty?.remove();
  const statusLabels = { queued: 'Queued', running: 'Running', paused: 'Paused', completed: 'Verified', cancelled: 'Cancelled', failed: 'Failed' };
  const stageLabels = { queued: 'Waiting to transfer.', hashing: 'Reading and checking the local file.', uploading: 'Uploading media chunks.',
    verifying: 'Checking the complete content hash. Transferred bytes are not ready until verification finishes.',
    downloading: 'Downloading verified media chunks.', writing: 'Writing the chosen file and checking its content hash.',
    complete: 'Content hash verified.', paused: 'Paused. Resume continues this transfer when its source and service are available.',
    cancelled: 'Cancelled. Partial uploaded chunks may remain on the service.', failed: 'The transfer stopped before completion.' };
  visible.forEach((job, index) => {
    const view = assetTransferJobView(job), direction = job.direction === 'upload' ? 'Upload' : 'Download';
    setServiceText(view.name, `${direction} · ${job.name || 'Project media'}`);
    setServiceText(view.status, statusLabels[job.status] || 'Waiting'); view.status.className = `asset-transfer-job-status ${job.status}`;
    setServiceText(view.identity, job.assetId || 'Content ID not available yet');
    setServiceText(view.detail, job.stage === 'verifying'
      ? job.direction === 'upload' ? 'Service is verifying media. Completion is confirmed only after the full content hash matches.'
        : 'Checking the complete downloaded file against its content hash.'
      : job.stage === 'cancelled' && job.direction === 'download' ? 'Download cancelled. A completed verified file has not been confirmed.'
        : stageLabels[job.stage] || 'Checking transfer state.');
    view.progress.setAttribute('aria-label', `${direction} progress for ${job.name || 'project media'}`);
    setAssetProgress(view.progress, view.bytes, job.bytes, job.totalBytes, job.status === 'completed');
    view.progress.hidden = job.totalBytes === null && !['queued', 'running'].includes(job.status);
    if (job.stage === 'verifying' && job.status !== 'completed') {
      view.progress.removeAttribute('value');
      setServiceText(view.bytes, job.direction === 'upload' ? 'Service is verifying media' : 'Verifying the downloaded file');
      view.progress.setAttribute('aria-valuetext', 'Content verification is still running; completion is not confirmed');
    }
    view.receipt.hidden = job.status !== 'completed';
    setServiceText(view.receipt, job.status === 'completed' ? `${direction} verified · ${serviceDate(job.completedAt)} · ${assetBytes(job.size, true)}` : '');
    view.notice.hidden = !job.error; setServiceText(view.notice, job.error ? assetTransferErrorLabel(job.error) : '');
    view.resume.hidden = !job.canResume; view.cancel.hidden = !job.canCancel;
    view.resume.disabled = assetTransferJobActions.has(job.id) || !!assetTransferState?.busy || !!assetTransferForeground || !available
      || job.direction === 'upload' && (!assetTransferState?.canUpload || !['owner', 'editor'].includes(serviceState?.binding?.role));
    view.cancel.disabled = assetTransferJobActions.has(job.id);
    view.actions.hidden = !job.canResume && !job.canCancel;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  setServiceText(document.getElementById('asset-transfer-range'), jobs.length ? `Showing 1–${visible.length} of ${jobs.length}` : 'No transfers');
  document.getElementById('asset-transfer-more').hidden = visible.length >= jobs.length;
}
function assetClassLabel(value) {
  return ({ original: 'Original', proxy: 'Proxy', audio: 'Audio', graphics: 'Graphics', other: 'Other' })[value] || 'Unknown class';
}
function sameAssetClasses(left, right) { return [...left].sort().join('|') === [...right].sort().join('|'); }
function currentAssetPolicy() {
  const policy = assetTransferScopeMatches() ? assetTransferState?.storage?.policy : null;
  const projectId = assetTransferState?.scope?.remoteProjectId;
  return projectId && policy && policy.projectId === projectId ? policy : null;
}
function adoptAssetPolicy(policy, preserveChanges = false) {
  const context = currentAssetTransferContext();
  const classes = preserveChanges && assetPolicyDraft?.context === context && assetPolicyDraft.dirty
    ? [...assetPolicyDraft.classes] : [...policy.syncClasses];
  assetPolicyDraft = { context, version: policy.version, classes, savedClasses: [...policy.syncClasses],
    dirty: !sameAssetClasses(classes, policy.syncClasses), requiresRefresh: false };
}
function currentAssetStorageAction() {
  return assetStorageAction?.context === currentAssetTransferContext() ? assetStorageAction.method : null;
}
function renderAssetStorage(available) {
  const storage = assetTransferScopeMatches() ? assetTransferState?.storage : null;
  const policy = currentAssetPolicy(), context = currentAssetTransferContext(), pending = currentAssetStorageAction();
  const canManage = available && !!storage?.canManage && serviceState?.binding?.role === 'owner';
  if (policy && (!assetPolicyDraft || assetPolicyDraft.context !== context)) adoptAssetPolicy(policy);
  else if (policy && policy.version !== assetPolicyDraft.version) {
    if (assetPolicyDraft.dirty && !sameAssetClasses(assetPolicyDraft.classes, policy.syncClasses)) assetPolicyDraft.requiresRefresh = true;
    else adoptAssetPolicy(policy);
  }
  const draft = assetPolicyDraft?.context === context ? assetPolicyDraft : null;
  document.getElementById('asset-policy-fields').disabled = !canManage || !policy || !!pending || storage?.status === 'loading';
  for (const value of assetPolicyClasses) {
    const checkbox = document.getElementById(`asset-policy-${value}`), checked = !!draft?.classes.includes(value);
    if (checkbox.checked !== checked) checkbox.checked = checked;
  }
  setServiceText(document.getElementById('asset-policy-saved'), policy
    ? `Saved classes: ${policy.syncClasses.length ? policy.syncClasses.map(assetClassLabel).join(', ') : 'none'}. Policy version ${policy.version}.`
    : 'New projects begin with no media classes enabled. Refresh storage to load the current policy.');
  setServiceText(document.getElementById('asset-policy-status'), draft?.requiresRefresh
    ? 'The saved policy changed. Refresh storage and review its classes before saving again.'
    : !policy ? 'Load the current policy before editing classes.'
      : !canManage ? 'Read-only. Project owners manage the classes enabled for transfer.'
        : draft?.dirty ? 'Unsaved class changes.' : 'Choose the classes this project may upload and download, then save.');
  document.getElementById('asset-policy-save').disabled = !canManage || !policy || !!pending || !draft?.dirty || draft.requiresRefresh;
  document.getElementById('asset-storage-refresh').disabled = !available || !!pending || !window.desktop?.refreshAssetStorage;
  setServiceText(document.getElementById('asset-storage-refresh'), pending === 'refreshAssetStorage' ? 'Refreshing storage…' : 'Refresh storage');
  const notice = assetStorageActionNotice || (storage?.error ? assetTransferErrorLabel(storage.error) : '');
  const status = !available ? 'Sign in and link a service project to load its storage policy.'
    : storage?.status === 'loading' || pending === 'refreshAssetStorage' ? 'Refreshing this project’s storage metadata…'
      : notice || (storage?.status === 'ready' ? 'Storage metadata is loaded for this linked service project.' : 'Refresh storage to load this project’s policy and logical usage.');
  setServiceText(document.getElementById('asset-storage-status'), status);
  const projectId = assetTransferState?.scope?.remoteProjectId;
  const usage = projectId && storage?.usage && storage.usage.projectId === projectId ? storage.usage : null;
  setServiceText(document.getElementById('asset-usage-published'), usage
    ? `${usage.assetCount.toLocaleString()} asset${usage.assetCount === 1 ? '' : 's'} · ${assetBytes(usage.logicalBytes, true)}` : 'Not loaded');
  for (const kind of ['available', 'archived', 'excluded']) setServiceText(document.getElementById(`asset-usage-${kind}`),
    usage ? assetBytes(usage[`${kind}Bytes`], true) : 'Not loaded');
  setServiceText(document.getElementById('asset-usage-partial'), usage
    ? `${usage.inProgressUploads.toLocaleString()} upload${usage.inProgressUploads === 1 ? '' : 's'} · ${assetBytes(usage.inProgressReceivedBytes, true)} received of ${assetBytes(usage.inProgressDeclaredBytes, true)} declared`
    : 'Not loaded');
  return policy;
}
function currentAssetAvailability() {
  const input = document.getElementById('asset-content-id').value.trim().toLowerCase();
  const value = assetTransferScopeMatches() ? assetTransferState?.availability : null;
  return !assetAvailabilityNeedsCheck && value?.assetId === input ? value : null;
}
function renderAssetAvailability(available, busy) {
  const availability = currentAssetAvailability(), pending = currentAssetStorageAction();
  const canManage = available && !!assetTransferState?.storage?.canManage && serviceState?.binding?.role === 'owner';
  const input = document.getElementById('asset-content-id').value.trim().toLowerCase();
  document.getElementById('asset-availability-check').disabled = !available || !!pending;
  setServiceText(document.getElementById('asset-availability-check'), pending === 'checkServiceAssetAvailability' ? 'Checking availability…' : 'Check availability');
  document.getElementById('asset-availability-result').hidden = !availability && !assetAvailabilityNeedsCheck;
  const labels = { 'cloud-present': 'On this service', excluded: 'Excluded by project policy', archived: 'Archived', 'not-on-service': 'Not on this service' };
  setServiceText(document.getElementById('asset-availability-state'), availability ? labels[availability.state] || 'Availability could not be confirmed'
    : 'Check availability again to load the current media state.');
  setServiceText(document.getElementById('asset-availability-detail'), availability
    ? `${availability.assetClass ? `${assetClassLabel(availability.assetClass)} · ` : ''}${availability.size === null ? 'No published media was found for this content ID in the linked project.' : assetBytes(availability.size, true)}${availability.excluded && availability.archived ? ' · Also archived.' : ''}`
    : 'The previous availability result is no longer current.');
  const archive = document.getElementById('asset-archive-toggle');
  archive.hidden = !canManage || !availability?.cloudPresent;
  archive.disabled = !!pending;
  setServiceText(archive, availability?.archived ? 'Restore media' : 'Archive media');
  document.getElementById('asset-archive-help').hidden = !availability?.cloudPresent;
  const blocked = availability && (availability.state !== 'cloud-present' || availability.excluded || availability.archived || !availability.cloudPresent);
  document.getElementById('asset-download').disabled = !available || busy || !!pending || !!blocked || currentAssetPolicy()?.syncClasses.length === 0;
  if (!availability && !input) document.getElementById('asset-availability-result').hidden = true;
}
async function runAssetStorageAction(method, input, { automatic = false } = {}) {
  if (currentAssetStorageAction() || typeof window.desktop?.[method] !== 'function') return;
  const context = currentAssetTransferContext(), action = { method, context };
  assetStorageAction = action; assetStorageActionNotice = ''; renderAssetTransferPanel();
  try {
    const state = await window.desktop[method](input);
    if (context !== currentAssetTransferContext()) return;
    renderAssetTransferState(state);
    const storage = assetTransferState?.storage, policy = currentAssetPolicy();
    const failure = method === 'checkServiceAssetAvailability'
      ? assetTransferState?.availability?.assetId === input ? null : assetTransferState?.error || storage?.error
      : storage?.status === 'ready' ? null : storage?.error || assetTransferState?.error;
    if (failure === 'asset-policy-version-conflict' && assetPolicyDraft) assetPolicyDraft.requiresRefresh = true;
    if (failure === 'asset-archive-conflict') assetAvailabilityNeedsCheck = true;
    if (!failure) {
      if (method === 'refreshAssetStorage' && policy) adoptAssetPolicy(policy, !automatic);
      if (method === 'saveAssetStoragePolicy' && policy && sameAssetClasses(policy.syncClasses, input.syncClasses)) {
        adoptAssetPolicy(policy); assetStorageActionNotice = 'Storage policy saved.';
      }
      if (method === 'checkServiceAssetAvailability') assetAvailabilityNeedsCheck = false;
      if (method === 'setServiceAssetArchived') assetStorageActionNotice = input.archived ? 'Media archived. Its bytes are retained.' : 'Media restored. The project class policy still applies.';
    }
  } catch { if (context === currentAssetTransferContext()) assetStorageActionNotice = 'Storage metadata could not be updated. Refresh storage or check availability, then try again.'; }
  finally { if (assetStorageAction === action) assetStorageAction = null; renderAssetTransferPanel(); }
}
function renderAssetTransferPanel() {
  const state = assetTransferState, matching = assetTransferScopeMatches();
  const available = matching && !!state?.available && !!serviceState?.connected;
  const canUpload = available && !!state?.canUpload && ['owner', 'editor'].includes(serviceState?.binding?.role);
  const busy = !!assetTransferForeground || !!state?.busy;
  const preparing = matching ? state?.preparing : null, review = matching ? state?.review : null;
  const jobs = matching ? state?.jobs || [] : [];
  const api = typeof window.desktop?.getAssetTransferState === 'function';
  const scopeName = state?.scope?.remoteProjectName || serviceState?.binding?.remoteProjectName;
  const active = jobs.filter(job => ['running', 'queued'].includes(job.status)).length;
  setServiceText(document.getElementById('asset-transfer-summary'), !api ? 'Media transfers are unavailable in this build.'
    : preparing ? 'Reading the selected media file for review…'
      : !available ? 'Sign in and link a service project to transfer media.'
        : `${scopeName || 'Linked service project'}${jobs.length ? ` · ${jobs.length} transfer${jobs.length === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}` : ' · No media transfers yet'}`);
  const notice = assetTransferActionNotice || (state?.error ? assetTransferErrorLabel(state.error) : '');
  document.getElementById('asset-transfer-notice').hidden = !notice; setServiceText(document.getElementById('asset-transfer-notice'), notice);
  const policy = renderAssetStorage(available);
  const selectedClass = document.getElementById('asset-class').value;
  const selectedClassAllowed = !!policy?.syncClasses.includes(selectedClass);
  for (const option of document.getElementById('asset-class').options) option.disabled = !policy?.syncClasses.includes(option.value);
  document.getElementById('asset-class').disabled = !canUpload || busy || !!review || !policy?.syncClasses.length;
  document.getElementById('asset-bandwidth').disabled = !available || busy || !!review;
  document.getElementById('asset-choose-upload').disabled = !canUpload || busy || !!review || !selectedClassAllowed;
  setServiceText(document.getElementById('asset-choose-upload'), assetTransferForeground === 'prepareAssetUpload' ? 'Choosing and reading…' : 'Choose media file');
  setServiceText(document.getElementById('asset-upload-help'), available && !canUpload
    ? 'Viewer access allows downloads. Uploading requires editor or owner access.'
    : !policy ? 'Refresh storage to load the classes this project may transfer.'
      : !selectedClassAllowed ? `${assetClassLabel(selectedClass)} is disabled for this project. ${serviceState?.binding?.role === 'owner' ? 'Enable it in Storage policy and usage, or choose an enabled class.' : 'Choose an enabled class or ask a project owner to enable it.'}`
        : 'Checking for existing media shares its content ID with this service. File bytes are sent only after you confirm.');
  document.getElementById('asset-preparing').hidden = !preparing;
  if (preparing) {
    setServiceText(document.getElementById('asset-preparing-status'), 'Reading the selected file and calculating its content hash. No media bytes are uploaded during this review.');
    setAssetProgress(document.getElementById('asset-preparing-progress'), document.getElementById('asset-preparing-bytes'), preparing.bytes, preparing.totalBytes);
  }
  document.getElementById('asset-upload-review').hidden = !review;
  const identity = review?.identity;
  setServiceText(document.getElementById('asset-review-name'), review?.name || '');
  setServiceText(document.getElementById('asset-review-size'), identity ? assetBytes(identity.size, true) : '');
  setServiceText(document.getElementById('asset-review-class'), identity ? ({ original: 'Original', proxy: 'Proxy', audio: 'Audio', graphics: 'Graphics', other: 'Other' })[identity.assetClass] || 'Other' : '');
  setServiceText(document.getElementById('asset-review-hash'), identity?.contentId || '');
  setServiceText(document.getElementById('asset-review-estimate'), review ? Number.isSafeInteger(review.estimatedUploadBytes)
    ? assetBytes(review.estimatedUploadBytes, true) : `Up to ${assetBytes(identity?.size, true)}` : '');
  setServiceText(document.getElementById('asset-review-reuse'), !review ? '' : review.reused === true
    ? 'Matching verified bytes are already available to this project. This transfer can reuse them.'
    : review.reused === false ? 'The service needs the reviewed media bytes. Upload starts only after you confirm.'
      : 'Service reuse has not been confirmed. The complete file may need to be uploaded.');
  document.getElementById('asset-review-controls').hidden = !review && !preparing;
  document.getElementById('asset-confirm-upload').hidden = !review;
  document.getElementById('asset-confirm-upload').disabled = !canUpload || busy || assetReviewClearing || !policy?.syncClasses.includes(identity?.assetClass);
  document.getElementById('asset-dismiss-review').disabled = assetReviewClearing;
  setServiceText(document.getElementById('asset-dismiss-review'), preparing ? 'Cancel preparation' : 'Dismiss review');
  document.getElementById('asset-content-id').disabled = !available || busy;
  renderAssetAvailability(available, busy);
  renderAssetTransferJobs(jobs, available);
}
function renderAssetTransferState(state) {
  if (!state || !Number.isSafeInteger(state.version) || state.version < assetTransferStateVersion) return;
  assetTransferStateVersion = state.version; assetTransferState = state; renderAssetTransferPanel();
  const context = currentAssetTransferContext();
  if (assetTransferScopeMatches() && state.available && serviceState?.connected && (state.storage?.status || 'idle') === 'idle'
    && context !== assetStorageAutoRefreshedScope && window.desktop?.refreshAssetStorage) {
    assetStorageAutoRefreshedScope = context; runAssetStorageAction('refreshAssetStorage', undefined, { automatic: true });
  }
}
async function refreshAssetTransferState() {
  if (!window.desktop?.getAssetTransferState) return;
  const context = currentAssetTransferContext();
  try { const state = await window.desktop.getAssetTransferState(); if (context === currentAssetTransferContext()) renderAssetTransferState(state); }
  catch { assetTransferActionNotice = 'Could not refresh media transfers. Check the service connection and try again.'; renderAssetTransferPanel(); }
}
function assetTransferLimit() { const value = document.getElementById('asset-bandwidth').value; return value ? Number(value) : null; }
async function runAssetTransferAction(method, input) {
  if (assetTransferForeground || typeof window.desktop?.[method] !== 'function') return;
  assetTransferForeground = method; assetTransferActionNotice = ''; renderAssetTransferPanel();
  try {
    renderAssetTransferState(await window.desktop[method](input));
    if (method === 'prepareAssetUpload' && assetTransferState?.review && assetTransferScopeMatches()) document.getElementById('asset-review-title').focus();
  } catch { assetTransferActionNotice = 'The media action could not finish. Check the selected file and service connection, then try again.'; }
  finally { assetTransferForeground = null; renderAssetTransferPanel(); }
}
async function clearAssetTransferReview() {
  if (assetReviewClearing || !window.desktop?.clearAssetUploadReview) return;
  const wasPreparing = !!assetTransferState?.preparing, context = currentAssetTransferContext();
  assetReviewClearing = true; assetTransferActionNotice = ''; renderAssetTransferPanel();
  try {
    renderAssetTransferState(await window.desktop.clearAssetUploadReview());
    if (wasPreparing && context === currentAssetTransferContext() && !assetTransferState?.error) assetTransferActionNotice = 'Media preparation cancelled. No file bytes were uploaded.';
  }
  catch { assetTransferActionNotice = 'The media review could not be cleared. Try again.'; }
  finally { assetReviewClearing = false; renderAssetTransferPanel(); }
}
async function runAssetTransferJobAction(method, id) {
  if (assetTransferJobActions.has(id) || typeof window.desktop?.[method] !== 'function') return;
  assetTransferJobActions.add(id); assetTransferActionNotice = ''; renderAssetTransferPanel();
  try { renderAssetTransferState(await window.desktop[method](id)); }
  catch { assetTransferActionNotice = 'The transfer could not be updated. Check the service connection and try again.'; }
  finally { assetTransferJobActions.delete(id); renderAssetTransferPanel(); }
}

function renderCollaborationState(state) {
  currentCollaborationState = state;
  const form = document.getElementById('invite-form'); const list = document.getElementById('members-list');
  const summary = document.getElementById('members-summary'); const notice = document.getElementById('invite-notice');
  [...form.querySelectorAll('input, select, button')].forEach(control => {
    control.disabled = collaborationBusy || !state?.available;
  });
  list.replaceChildren();
  if (!state?.available) {
    summary.textContent = 'Choose a project to manage collaborators';
    list.append(make('p', 'members-empty', 'Project invitations become available after selecting a local FCPXML export.'));
    notice.textContent = 'These invitations are recorded only on this device. Service access is managed by your administrator.';
    return;
  }
  const pending = state.invitations.filter(item => item.status === 'pending').length;
  summary.textContent = `${state.members.length} active · ${pending} pending`;
  state.members.forEach(member => {
    const row = make('div', 'member-row');
    row.append(make('span', 'member-avatar', member.displayName.slice(0, 1)), make('strong', '', member.displayName), make('span', '', member.role));
    list.append(row);
  });
  state.invitations.forEach(invitation => {
    const row = make('div', 'member-row pending');
    row.append(make('span', 'member-avatar', invitation.email.slice(0, 1).toUpperCase()), make('strong', '', invitation.email),
      make('span', '', `${invitation.role} · ${invitation.status}`));
    list.append(row);
  });
  notice.textContent = state.error ? ({
    'invitation-invalid': 'Enter a valid collaborator email.',
    'invitation-exists': 'A pending invitation already exists for this email.',
    'invitation-forbidden': 'Only the project owner can create editor or viewer invitations.'
  })[state.error] || 'The invitation could not be created.'
    : 'These invitations are recorded only on this device. Service access is managed by your administrator.';
}

async function refreshCollaborationState() {
  if (!window.desktop?.getCollaborationState) return renderCollaborationState({ available: false, members: [], invitations: [] });
  try { renderCollaborationState(await window.desktop.getCollaborationState()); }
  catch { renderCollaborationState({ available: false, members: [], invitations: [] }); }
}

async function inviteCollaborator(event) {
  event.preventDefault(); if (collaborationBusy || !currentCollaborationState.available) return;
  collaborationBusy = true; renderCollaborationState(currentCollaborationState);
  const email = document.getElementById('invite-email'); const role = document.getElementById('invite-role');
  try {
    const state = await window.desktop.inviteCollaborator(email.value, role.value);
    if (!state.error) email.value = '';
    currentCollaborationState = state;
  } catch {
    currentCollaborationState = { ...currentCollaborationState, error: 'invitation-invalid' };
  } finally {
    collaborationBusy = false; renderCollaborationState(currentCollaborationState);
  }
}

let displayedRevisions = [];
let displayedRevisionId = null;
let historyWindow = null;
function renderRealHistory(revisions, selectedId) {
  displayedRevisions = revisions; displayedRevisionId = selectedId;
  historyWindow = null;
  drawHistoryWindow();
}
function drawHistoryWindow() {
  if (!currentAppState?.selectedProject) return;
  const list = document.getElementById('history-list');
  const revisions = displayedRevisions;
  if (!revisions.length) {
    list.replaceChildren(); historyWindow = null;
    list.append(make('p', 'history-empty', 'No saved revisions yet. Scan this export, then save the current cut above.'));
    return;
  }
  const { start, end, beforePx, afterPx } = window.visibleRange(revisions.length, list.scrollTop, list.clientHeight || 600, 96);
  const evidenceKey = serviceBaseEvidenceKey();
  if (historyWindow?.start === start && historyWindow.end === end && historyWindow.evidenceKey === evidenceKey) return;
  historyWindow = { start, end, evidenceKey };
  list.replaceChildren();
  const before = make('div', 'history-spacer'); before.style.height = `${beforePx}px`; before.setAttribute('aria-hidden', 'true'); list.append(before);
  revisions.slice(start, end).forEach((revision, offset) => {
    const index = start + offset;
    const row = make('button', 'history-item revision-history-button');
    row.type = 'button';
    row.dataset.revisionIndex = String(index);
    row.setAttribute('aria-pressed', String(revision.id === displayedRevisionId));
    row.setAttribute('aria-label', `Revision ${revisions.length - index} of ${revisions.length}: ${revision.message}`);
    row.addEventListener('click', () => openRevision(revision.id));
    const main = make('div', 'history-main');
    main.append(make('strong', '', revision.message),
      make('small', '', `${revision.author} · ${revision.branch}`),
      make('small', 'history-reference', `${revision.manifestVersion === 2 ? 'Read-only scan' : 'Scan'} · ${revision.contentHash.slice(0, 10)} · ${revision.id.slice(0, 8)}`));
    const state = make('div', 'history-state');
    const sharing = revisionSharingLabel(revision);
    const saved = make('time', '', new Date(revision.createdAt).toLocaleString());
    saved.dateTime = revision.createdAt;
    state.append(make('strong', `revision-sync-state ${sharing.kind}`, sharing.label), saved);
    row.append(make('span', 'history-id', String(revisions.length - index).padStart(2, '0')), main, state);
    list.append(row);
  });
  const after = make('div', 'history-spacer'); after.style.height = `${afterPx}px`; after.setAttribute('aria-hidden', 'true'); list.append(after);
}
document.getElementById('history-list').addEventListener('scroll', drawHistoryWindow);
document.getElementById('history-list').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const index = Number(document.activeElement?.dataset.revisionIndex);
  if (!Number.isSafeInteger(index) || !displayedRevisions[index]) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? displayedRevisions.length - 1
    : Math.max(0, Math.min(displayedRevisions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  let target = document.querySelector(`#history-list [data-revision-index="${next}"]`);
  if (!target) {
    const list = document.getElementById('history-list');
    list.scrollTop = next * 96;
    drawHistoryWindow();
    target = list.querySelector(`[data-revision-index="${next}"]`);
  }
  target?.focus();
});

function renderRevisionDetail(revision, error, comparison = null, comparisonError = null) {
  const section = document.getElementById('revision-detail');
  const title = document.getElementById('revision-detail-title');
  const body = document.getElementById('revision-detail-body');
  body.replaceChildren();
  section.hidden = !revision && !error;
  if (error) {
    title.textContent = 'Revision unavailable';
    body.append(make('p', '', scanRecovery[error] || 'This revision could not be opened.'));
    return;
  }
  if (!revision) return;
  title.textContent = revision.message;
  const manifest = revision.manifest;
  if (revision.parentRevisionId) {
    body.append(make('h4', '', 'Compared with parent'));
    if (comparisonError) body.append(make('p', 'revision-detail-note', scanRecovery[comparisonError] || 'The parent revision could not be compared.'));
    else if (comparison) {
      if (!comparison.changes.length) body.append(make('p', 'revision-detail-note', 'No observable sequence or media-label changes found.'));
      else {
        const list = make('ul', 'revision-comparison-list');
        const sequenceLabels = { name: 'Sequence name', frameDuration: 'Frame duration', durationFrames: 'Sequence length' };
        comparison.changes.forEach(change => {
          const label = change.kind === 'sequence' ? sequenceLabels[change.name] : `Media label · ${change.name}`;
          const formatValue = value => value === null ? 'Not referenced'
            : change.name === 'durationFrames' ? `${value} frames` : String(value);
          list.append(make('li', '', `${label}: ${formatValue(change.before)} → ${formatValue(change.after)}`));
        });
        body.append(list);
      }
      if (comparison.mediaNamesAmbiguous) body.append(make('p', 'revision-detail-note', 'Some media names repeat, so asset-level changes were not matched.'));
      body.append(make('p', 'revision-detail-note', 'Media is compared by display name and availability. A different asset with the same name may not appear here.'));
      body.append(make('p', 'revision-detail-note', `Picture clip counts: ${comparison.beforeClipCount} → ${comparison.afterClipCount}. Clip identities and edits are not compared.`));
    }
  }
  const details = make('dl', 'revision-facts');
  const facts = [
    ['Saved', new Date(revision.createdAt).toLocaleString()],
    ['Author', revision.author],
    ['Branch', revision.branch || 'Unknown'],
    ['Sharing record', revisionSharingLabel(revision).label],
    ['Sequence', manifest.sequence.name],
    ['Timing', `${manifest.sequence.durationFrames} frames · ${manifest.sequence.frameDuration} per frame`],
    ['Parent', revision.parentRevisionId || 'First revision'],
    ['Source hash', revision.contentHash],
    ['Editor version', revision.editorVersion || 'Unknown']
  ];
  facts.forEach(([key, value]) => {
    const fact = make('dd', '', value); if (key === 'Sharing record') fact.id = 'revision-detail-sharing';
    details.append(make('dt', '', key), fact);
  });
  body.append(details, make('h4', '', `Picture clips (${manifest.clips.length})`));
  const clips = make('ul', 'revision-detail-list');
  manifest.clips.forEach(clip => clips.append(make('li', '', `${clip.name} · ${clip.offsetFrames}f → ${clip.offsetFrames + clip.durationFrames}f · source in ${clip.sourceInFrames}f`)));
  body.append(clips, make('h4', '', `Referenced media (${manifest.media.length})`));
  const media = make('ul', 'revision-detail-list');
  manifest.media.forEach(item => media.append(make('li', '', `${item.name} · ${item.availability}`)));
  body.append(media);
  if (manifest.warnings.length) body.append(make('p', 'revision-detail-warnings', `Scan warnings: ${manifest.warnings.join(' · ')}`));
  body.append(make('p', 'revision-detail-note', 'Clip identity is unresolved. This snapshot cannot be used for pull.'));
}

async function openRevision(revisionId) {
  try {
    const state = await window.desktop.openRevision(revisionId);
    renderAppState(state);
    document.getElementById('revision-detail-title').focus();
  } catch {
    renderRevisionDetail(null, 'revision-corrupt');
    document.getElementById('revision-detail-title').focus();
  }
}

async function changeBranch(name, create) {
  if (branchBusy) return;
  branchBusy = true;
  const notice = document.getElementById('file-notice');
  const branchSelect = document.getElementById('branch-switch');
  const createButton = document.querySelector('#branch-form button');
  branchSelect.disabled = true;
  createButton.disabled = true;
  try {
    const state = create ? await window.desktop.createBranch(name) : await window.desktop.switchBranch(name);
    renderAppState(state);
    notice.textContent = state.branchError ? scanRecovery[state.branchError] || 'Could not change branches.' : `${create ? 'Created and switched to' : 'Switched to'} ${state.currentBranch}.`;
    notice.hidden = false;
    if (create && !state.branchError) document.getElementById('branch-name').value = '';
  } catch {
    notice.textContent = 'Could not change branches. Try again.';
    notice.hidden = false;
  } finally {
    branchBusy = false;
    branchSelect.disabled = false;
    createButton.disabled = false;
  }
}

function renderMedia() {
  const list = document.getElementById('media-list');
  list.replaceChildren();
  sample.media.forEach(asset => {
    const row = make('div', 'media-row');
    row.append(make('strong', '', asset.name), make('span', '', asset.track), make('span', '', asset.format), make('span', 'media-availability', asset.availability));
    list.append(row);
  });
}

function showView(name) {
  const resolveMode = name === 'resolve';
  document.body.classList.toggle('resolve-mode', resolveMode);
  document.querySelector('.project-context strong').textContent = resolveMode ? 'Resolve review' : (currentAppState?.selectedProject?.name || 'Launch film');
  document.querySelector('.workspace-bar > span:first-child').firstChild.textContent = resolveMode ? 'Resolve snapshots ' : `${currentAppState?.selectedProject?.name || 'Launch film'} `;
  document.getElementById('view-label').textContent = {workspace: document.getElementById('sample-review').hidden ? 'Timeline scan' : 'Review changes', history: 'Revision history', media: 'Project media', resolve: 'Resolve preview'}[name];
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function selectChange(id) {
  const change = changes.get(id);
  if (!change) return;
  selectedChangeId = id;
  document.querySelectorAll('[data-change-id]').forEach(node => {
    const active = node.dataset.changeId === id;
    node.classList.toggle('selected', active);
    if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('timeline-selection').textContent = `${change.code} · ${change.title}`;
  document.getElementById('change-position').textContent = change.code === change.track
    ? `${change.track} · ${change.kind}`
    : `${change.code} · ${change.track} · ${change.kind}`;
  document.getElementById('change-title').textContent = change.title;
  document.getElementById('change-description').textContent = change.description;
  document.getElementById('base-value').textContent = change.base;
  document.getElementById('local-value').textContent = change.local;
  document.getElementById('incoming-value').textContent = change.incoming;
  const status = document.getElementById('change-status');
  status.className = `status ${change.status.toLowerCase()}`;
  status.lastChild.textContent = change.status;
  const explanation = document.getElementById('change-explanation');
  explanation.className = `change-explanation ${change.status.toLowerCase()}`;
  explanation.textContent = change.explanation;
  showView('workspace');
  const detail = document.querySelector('.detail-section');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) detail.animate([{opacity: .6, transform: 'translateY(4px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 180, easing: 'ease-out'});
}

function chooseMode(button) {
  document.querySelectorAll('[data-mode]').forEach(option => {
    const active = option === button;
    option.classList.toggle('selected', active);
    option.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('mode-explanation').textContent = button.dataset.mode === 'copy'
    ? 'Your current project would stay untouched while you review the result.'
    : 'A restore point would be created before the current project is updated.';
}

async function chooseFile() {
  const notice = document.getElementById('file-notice');
  setScanBusy(true);
  try {
    if (!window.desktop?.chooseProject) throw new Error('Desktop picker unavailable');
    const state = await window.desktop.chooseProject();
    if (!state) return;
    renderAppState(state);
    if (state.selectedProject && !state.error) {
      notice.textContent = state.selectedProject.metadataRecovered
        ? 'Local project metadata was restored from its backup. The damaged file was preserved. The export was scanned read only.'
        : `${state.selectedProject.name} scanned read only. Clip identity is unresolved; edits and pull are unavailable.`;
      notice.hidden = false;
    }
  } catch {
    notice.textContent = 'The file picker is available in the desktop app.';
  } finally {
    setScanBusy(false);
  }
  notice.hidden = false;
}

function setScanBusy(busy) {
  document.getElementById('choose-file').disabled = busy;
  document.getElementById('rescan-project').disabled = busy;
  document.getElementById('rescan-project').textContent = busy ? 'Scanning…' : 'Rescan project';
  document.getElementById('cancel-scan').hidden = !busy;
  document.getElementById('view-workspace').setAttribute('aria-busy', String(busy));
}

async function rescanProject() {
  const notice = document.getElementById('file-notice');
  setScanBusy(true);
  try {
    if (!window.desktop?.rescanProject) throw new Error('Rescan unavailable');
    const state = await window.desktop.rescanProject();
    renderAppState(state);
    if (!state.error) {
      notice.textContent = 'Timeline and local media availability refreshed. This scan did not change the project.';
      notice.hidden = false;
    }
  } catch {
    notice.textContent = 'Could not rescan the selected project. Try again.';
    notice.hidden = false;
  } finally {
    setScanBusy(false);
  }
}

async function saveRevision(event) {
  event.preventDefault();
  const button = document.getElementById('save-revision');
  const input = document.getElementById('revision-message');
  const notice = document.getElementById('file-notice');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const state = await window.desktop.saveRevision(input.value);
    renderAppState(state);
    notice.textContent = state.revisionError ? scanRecovery[state.revisionError] || 'Could not save the revision.' : 'Revision saved locally. The FCPXML export was not changed.';
    notice.hidden = false;
    if (!state.revisionError) input.value = '';
  } catch {
    notice.textContent = 'Could not save the revision. Try again.';
    notice.hidden = false;
  } finally {
    button.textContent = 'Save revision';
    button.disabled = currentAppState?.scanStatus !== 'ready' || !window.desktop?.saveRevision;
  }
}

async function transferRevisions(importing) {
  const button = document.getElementById(importing ? 'import-revisions' : 'export-revisions');
  const notice = document.getElementById('file-notice');
  button.disabled = true;
  try {
    const response = await (importing ? window.desktop.importRevisions() : window.desktop.exportRevisions());
    if (response.canceled) return;
    if (response.state) renderAppState(response.state);
    notice.textContent = response.error ? scanRecovery[response.error] || 'Could not transfer revisions. Try again.'
      : importing ? `Imported ${response.result.revisionCount} revisions onto ${response.result.branches.join(', ')}. Switch branches to review them.`
        : `Exported ${response.revisionCount} revisions from ${response.branchCount} branches.`;
    notice.hidden = false;
  } catch {
    notice.textContent = 'Could not transfer revisions. Try again.';
    notice.hidden = false;
  } finally { button.disabled = false; }
}

renderChangeChoices();
renderTimeline();
renderHistory();
renderMedia();
selectChange(selectedChangeId);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => chooseMode(button)));
document.getElementById('choose-file').addEventListener('click', chooseFile);
window.desktop?.getFirstRun?.().then(state => {
  const panel = document.getElementById('first-run');
  panel.hidden = state?.completed === true || !!currentAppState?.selectedProject;
  if (state?.workspaceName) document.getElementById('first-run-workspace').value = state.workspaceName;
}).catch(() => {});
document.getElementById('first-run-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await window.desktop.saveFirstRun({ editor: document.getElementById('first-run-editor').value,
      workspaceName: document.getElementById('first-run-workspace').value });
    document.getElementById('first-run').hidden = true;
    await chooseFile();
  } catch { document.getElementById('file-notice').textContent = 'Could not save first-run choices. Try again.';
    document.getElementById('file-notice').hidden = false; }
  finally { button.disabled = false; }
});
document.getElementById('first-run-skip').addEventListener('click', () => { document.getElementById('first-run').hidden = true; });
let reviewedDiagnosticsHash = null;
document.getElementById('diagnostics-review').addEventListener('click', async () => {
  const panel = document.getElementById('diagnostics-preview');
  try {
    const preview = await window.desktop.previewDiagnostics();
    reviewedDiagnosticsHash = preview.sha256;
    document.getElementById('diagnostics-content').textContent = JSON.stringify(preview.report, null, 2);
    panel.hidden = false;
  } catch { document.getElementById('diagnostics-status').textContent = 'Diagnostics are unavailable. Retry after the app starts.'; panel.hidden = false; }
});
document.getElementById('diagnostics-export').addEventListener('click', async () => {
  const status = document.getElementById('diagnostics-status');
  try {
    const result = await window.desktop.exportDiagnostics(reviewedDiagnosticsHash);
    status.textContent = result.saved ? 'Reviewed diagnostics saved.' : result.cancelled ? 'Export cancelled.'
      : result.error === 'diagnostics-changed' ? 'App state changed. Review the report again before exporting.' : 'Could not save diagnostics. Choose a new filename.';
  } catch { status.textContent = 'Could not save diagnostics. Try again.'; }
});
document.getElementById('rescan-project').addEventListener('click', rescanProject);
document.getElementById('cancel-scan').addEventListener('click', async () => {
  const state = await window.desktop.cancelScan(); renderAppState(state); setScanBusy(false);
});
document.getElementById('revision-form').addEventListener('submit', saveRevision);
document.getElementById('invite-form').addEventListener('submit', inviteCollaborator);
document.getElementById('service-connect-form').addEventListener('submit', event => {
  event.preventDefault();
  const password = document.getElementById('service-password');
  const input = { origin: document.getElementById('service-origin').value.trim(),
    email: document.getElementById('service-email').value.trim(), password: password.value };
  password.value = '';
  runServiceAction('connectService', input);
});
document.getElementById('service-disconnect').addEventListener('click', () => {
  document.getElementById('service-password').value = '';
  runServiceAction('disconnectService');
});
document.getElementById('service-projects-refresh').addEventListener('click', () => runServiceAction('refreshServiceProjects'));
document.getElementById('service-project').addEventListener('change', event => {
  serviceProjectChoice = event.target.value; serviceBranchChoice = ''; renderServicePanel();
});
document.getElementById('service-branch').addEventListener('change', event => {
  serviceBranchChoice = event.target.value; renderServicePanel();
});
document.getElementById('service-binding-form').addEventListener('submit', event => {
  event.preventDefault();
  runServiceAction('bindServiceProject', { remoteProjectId: serviceProjectChoice, remoteBranch: serviceBranchChoice });
});
document.getElementById('service-unlink').addEventListener('click', () => runServiceAction('unlinkServiceProject'));
document.getElementById('service-check').addEventListener('click', () => runServiceAction('checkServiceSync'));
document.getElementById('service-push').addEventListener('click', () => runServiceAction('pushServiceRevisions'));
document.getElementById('service-fetch').addEventListener('click', () => runServiceAction('fetchServiceRevisions'));
document.getElementById('service-comparison-run').addEventListener('click', async event => {
  const control = event.currentTarget;
  await runServiceAction('compareServiceRevisions');
  if (document.activeElement === document.body && !control.disabled && !control.closest('[hidden]')) control.focus({ preventScroll: true });
});
document.getElementById('service-fetched-more').addEventListener('click', () => {
  serviceFetchedVisible += 20; renderFetchedServiceHistory(serviceSelectionMatches() ? serviceState?.fetched : null);
});
document.getElementById('project-activity-refresh').addEventListener('click', () => runProjectActivityAction('refreshProjectActivity', { view: projectActivityView }));
document.getElementById('project-activity-view').addEventListener('change', event => {
  projectActivityView = event.target.value;
  runProjectActivityAction('refreshProjectActivity', { view: projectActivityView });
});
document.getElementById('project-activity-watch').addEventListener('change', event => runProjectActivityAction('setProjectActivityWatch', event.target.checked));
document.getElementById('project-activity-more').addEventListener('click', () => runProjectActivityAction('loadOlderProjectActivity'));
document.getElementById('asset-choose-upload').addEventListener('click', () => runAssetTransferAction('prepareAssetUpload', {
  assetClass: document.getElementById('asset-class').value, maxBytesPerSecond: assetTransferLimit()
}));
document.getElementById('asset-confirm-upload').addEventListener('click', () => {
  if (assetTransferState?.review && assetTransferScopeMatches()) runAssetTransferAction('confirmAssetUpload', assetTransferState.review.id);
});
document.getElementById('asset-dismiss-review').addEventListener('click', clearAssetTransferReview);
document.getElementById('asset-class').addEventListener('change', renderAssetTransferPanel);
document.getElementById('asset-storage-refresh').addEventListener('click', () => runAssetStorageAction('refreshAssetStorage'));
for (const value of assetPolicyClasses) document.getElementById(`asset-policy-${value}`).addEventListener('change', () => {
  if (!assetPolicyDraft || assetPolicyDraft.context !== currentAssetTransferContext()) return;
  assetPolicyDraft.classes = assetPolicyClasses.filter(item => document.getElementById(`asset-policy-${item}`).checked);
  assetPolicyDraft.dirty = !sameAssetClasses(assetPolicyDraft.classes, assetPolicyDraft.savedClasses);
  renderAssetTransferPanel();
});
document.getElementById('asset-policy-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!assetPolicyDraft?.dirty || assetPolicyDraft.requiresRefresh || !assetTransferState?.storage?.canManage
    || serviceState?.binding?.role !== 'owner') return;
  runAssetStorageAction('saveAssetStoragePolicy', { expectedVersion: assetPolicyDraft.version, syncClasses: [...assetPolicyDraft.classes].sort() });
});
document.getElementById('asset-content-id').addEventListener('input', renderAssetTransferPanel);
document.getElementById('asset-availability-check').addEventListener('click', () => {
  const input = document.getElementById('asset-content-id');
  if (input.reportValidity()) runAssetStorageAction('checkServiceAssetAvailability', input.value.trim().toLowerCase());
});
document.getElementById('asset-archive-toggle').addEventListener('click', () => {
  const availability = currentAssetAvailability();
  if (!availability?.cloudPresent || !assetTransferState?.storage?.canManage || serviceState?.binding?.role !== 'owner') return;
  runAssetStorageAction('setServiceAssetArchived', { assetId: availability.assetId,
    expectedArchived: availability.archived, archived: !availability.archived });
});
document.getElementById('asset-download-form').addEventListener('submit', event => {
  event.preventDefault();
  const availability = currentAssetAvailability();
  if (currentAssetPolicy()?.syncClasses.length === 0
    || availability && (availability.state !== 'cloud-present' || availability.excluded || availability.archived || !availability.cloudPresent)) return;
  runAssetTransferAction('downloadServiceAsset', { assetId: document.getElementById('asset-content-id').value.trim().toLowerCase(),
    maxBytesPerSecond: assetTransferLimit() });
});
document.getElementById('asset-transfer-more').addEventListener('click', () => {
  assetTransferVisibleJobs += 20; renderAssetTransferPanel();
});
document.getElementById('branch-form').addEventListener('submit', event => {
  event.preventDefault();
  changeBranch(document.getElementById('branch-name').value, true);
});
document.getElementById('branch-switch').addEventListener('change', event => changeBranch(event.target.value, false));
document.getElementById('export-revisions').addEventListener('click', () => transferRevisions(false));
document.getElementById('import-revisions').addEventListener('click', () => transferRevisions(true));
document.getElementById('relink-action').addEventListener('click', async () => {
  const button = document.getElementById('relink-action');
  const notice = document.getElementById('file-notice');
  button.disabled = true;
  try {
    const state = await window.desktop.relinkProject(document.getElementById('relink-source').value);
    renderAppState(state);
    notice.hidden = false;
    notice.textContent = state.relinkError ? scanRecovery[state.relinkError] || 'Could not relink history.' : 'History relinked to this export. Its local project ID and branches are restored.';
  } catch {
    notice.hidden = false;
    notice.textContent = 'Could not relink history. Rescan the export and retry.';
  } finally { button.disabled = false; }
});
document.getElementById('share-links-project').addEventListener('change', event => {
  shareLinksProjectChoice = event.target.value; shareLinksBranchChoice = ''; renderShareLinks();
});
document.getElementById('share-links-branch').addEventListener('change', event => { shareLinksBranchChoice = event.target.value; renderShareLinks(); });
document.getElementById('share-links-select-form').addEventListener('submit', event => {
  event.preventDefault(); const project = serviceState?.projects?.find(item => item.id === shareLinksProjectChoice);
  if (project?.branches.includes(shareLinksBranchChoice)) runShareLinksAction('selectShareLinks', { projectId: project.id, branch: shareLinksBranchChoice });
});
document.getElementById('share-links-refresh').addEventListener('click', () => runShareLinksAction('refreshShareLinks', { append: false }));
document.getElementById('share-links-more').addEventListener('click', () => runShareLinksAction('refreshShareLinks', { append: true }));
document.getElementById('share-links-ttl').addEventListener('change', event => { shareLinksTtlDraft = event.target.value; renderShareLinks(); });
document.getElementById('share-links-copy-form').addEventListener('submit', event => {
  event.preventDefault(); if (document.getElementById('share-links-copy').disabled) return;
  runShareLinksAction('copyShareLink', { scopeId: shareLinksState.scopeId, ttlMs: Number(shareLinksTtlDraft) });
});
window.desktop?.onShareLinksState?.(state => renderShareLinksState(state));
document.getElementById('branch-review-project').addEventListener('change', event => {
  branchReviewProjectChoice = event.target.value; branchReviewBranchChoice = ''; renderBranchReview();
});
document.getElementById('branch-review-branch').addEventListener('change', event => {
  branchReviewBranchChoice = event.target.value; renderBranchReview();
});
document.getElementById('branch-review-select-form').addEventListener('submit', event => {
  event.preventDefault();
  const project = serviceState?.projects?.find(item => item.id === branchReviewProjectChoice);
  if (!project || !project.branches.includes(branchReviewBranchChoice)) return;
  runBranchReviewAction('selectBranchReview', { projectId: project.id, branch: branchReviewBranchChoice });
});
document.getElementById('branch-review-refresh').addEventListener('click', () => runBranchReviewAction('refreshBranchReview', { view: 'all' }));
document.getElementById('branch-review-required').addEventListener('change', event => {
  branchReviewPolicyDraft = event.target.value; renderBranchReview();
});
document.getElementById('branch-review-policy-form').addEventListener('submit', event => {
  event.preventDefault();
  if (document.getElementById('branch-review-policy-save').disabled) return;
  runBranchReviewAction('setBranchProtection', { scopeId: branchReviewState.scopeId, requiredApprovals: Number(branchReviewPolicyDraft) });
});
document.getElementById('branch-review-candidate').addEventListener('change', event => {
  branchReviewCandidateChoice = event.target.value; renderBranchReview();
});
document.getElementById('branch-review-request-form').addEventListener('submit', event => {
  event.preventDefault();
  if (document.getElementById('branch-review-request').disabled) return;
  runBranchReviewAction('requestBranchApproval', { scopeId: branchReviewState.scopeId, revisionId: branchReviewCandidateChoice });
});
for (const view of ['requests', 'candidates']) document.getElementById(`branch-review-${view}-more`).addEventListener('click', () => runBranchReviewAction('refreshBranchReview', { view }));
window.desktop?.onBranchReviewState?.(state => renderBranchReviewState(state));
window.desktop?.getAppState?.().then(renderAppState).catch(() => {});
if (window.desktop?.getServiceState) {
  window.desktop.onServiceState?.(renderServiceState);
  refreshServiceState();
} else {
  renderServicePanel();
  window.desktop?.getSyncState?.().then(renderSyncState).catch(() => renderSyncState({ connected: false, operations: [] }));
}
if (window.desktop?.getAssetTransferState) {
  window.desktop.onAssetTransferState?.(renderAssetTransferState);
  refreshAssetTransferState();
} else renderAssetTransferPanel();
window.desktop?.onProjectActivityState?.(renderProjectActivityState);
refreshProjectActivityState(); renderProjectActivity();
window.desktop?.getCollaborationState?.().then(renderCollaborationState)
  .catch(() => renderCollaborationState({ available: false, members: [], invitations: [] }));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && ['1', '2', '3', '4'].includes(event.key)) {
    event.preventDefault();
    const view = ['workspace', 'history', 'media', 'resolve'][Number(event.key) - 1];
    showView(view);
    document.querySelector(`[data-view="${view}"]`)?.focus();
  }
});
for (const listId of ['video-track', 'change-queue', 'resolve-queue']) {
  document.getElementById(listId)?.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || buttons.length < 2) return;
    const next = (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].focus();
  });
}

let resolveState = null;
let resolveSelected = null;
let resolveBusy = false;
let resolveActionNotice = '';
let resolveReviewEventGeneration = 0;
let resolveReviewEventState = null;
let resolveCoveragePage = 0;
let resolveCoverageKey = '';
const resolveLabels = { 'incoming-only': 'Incoming edit', 'local-only': 'Local edit', 'already-applied': 'Already applied', conflict: 'Conflict' };
function resolveValue(value) {
  if (value === undefined || value === null) return 'Not present';
  if (typeof value === 'object' && Object.keys(value).join(',') === 'decimal' && typeof value.decimal === 'string') {
    const match = /^(-?)(\d)\.(\d{16})e([+-]\d{2,3})$/.exec(value.decimal);
    if (match) {
      const digits = (match[2] + match[3]).replace(/0+$/, '');
      if (!digits) return '0';
      const exponent = Number(match[4]), position = exponent + 1;
      if (Math.abs(exponent) > 12) return value.decimal;
      return match[1] + (position <= 0 ? `0.${'0'.repeat(-position)}${digits}`
        : position >= digits.length ? digits.padEnd(position, '0') : `${digits.slice(0, position)}.${digits.slice(position)}`);
    }
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
function resolveCoverageText(coverage) {
  if (!coverage) return 'Snapshot fields only. Clip properties, effect metadata and track enabled/locked states were not captured.';
  if (coverage.schemaVersion !== 2) return `${coverage.effectCount} ${coverage.effectCount === 1 ? 'effect' : 'effects'} observed across ${coverage.itemCount} items. Clip properties and track states were not captured.`;
  return `${coverage.propertyKeyCount} returned clip property keys (${coverage.propertyValueCount} values), ${coverage.trackCount} ${coverage.trackCount === 1 ? 'track' : 'tracks'} and ${coverage.effectCount} ${coverage.effectCount === 1 ? 'effect' : 'effects'}. Unavailable reads: ${coverage.unavailablePropertyReads} for clip properties, ${coverage.unavailableTrackStateReads} for track state.`;
}
function resolveChanges() {
  return resolveState?.plan?.classification?.decisions || [];
}
function resolveConflict(change) {
  return resolveState?.review?.conflicts?.find(item => item.timelineId === change.timelineId && item.itemId === change.itemId && item.field === change.field);
}
function resolveChoice(conflict) {
  return resolveState?.decisions?.find(item => item.conflictId === conflict?.id)?.choice;
}
function renderResolveState(state) {
  resolveState = state;
  renderResolveServiceProvenance(); renderResolveServicePanel();
  const coverageKey = JSON.stringify(state?.sourceHashes || null);
  if (coverageKey !== resolveCoverageKey) { resolveCoveragePage = 0; resolveCoverageKey = coverageKey; }
  renderResolveTrial();
  const items = resolveChanges();
  const ready = state?.status === 'ready' && !!state.plan;
  const locked = resolveBusy || activeResolveTrial();
  document.getElementById('resolve-refresh').disabled = locked || !ready;
  setServiceText(document.getElementById('resolve-refresh'), state?.sourceMode === 'service-history' ? 'Reverify sources' : 'Refresh sources');
  document.getElementById('resolve-save').disabled = locked || !ready;
  document.getElementById('resolve-choose').disabled = locked;
  document.getElementById('resolve-recover').disabled = locked;
  document.getElementById('resolve-notice').textContent = resolveTrialState?.phase?.startsWith('recovery-')
    ? 'Recovering a retained disposable drill. Snapshot review controls are locked until recovery is resolved.'
    : state?.error?.message || resolveActionNotice || (ready ? `${items.length} classified ${items.length === 1 ? 'field' : 'fields'}${state.plan.classification.observationCoverage ? ` · ${state.plan.classification.observationCoverage.gaps.length} coverage gaps excluded from field choices` : ' · snapshot fields only'}. Save review to preserve choices; applying to Resolve remains unavailable.` : 'Choose base, local, and incoming Resolve capture or snapshot JSON files. No timeline will be modified.');
  const sources = document.getElementById('resolve-sources');
  sources.replaceChildren();
  const counts = items.reduce((result, item) => { result[item.status] = (result[item.status] || 0) + 1; return result; }, {});
  for (const [key, label] of Object.entries(resolveLabels)) {
    const row = make('div', 'resolve-classification');
    row.append(make('strong', '', String(counts[key] || 0)), make('span', '', label));
    sources.append(row);
  }
  for (const [id, key, label] of [['resolve-timeline', 'timelineId', 'All timelines'], ['resolve-field', 'field', 'All fields']]) {
    const select = document.getElementById(id);
    const previous = select.value;
    select.replaceChildren();
    for (const value of ['all', ...new Set(items.map(item => item[key]).filter(Boolean).sort())]) {
      const option = make('option', '', value === 'all' ? label : key === 'timelineId' ? items.find(item => item.timelineId === value)?.context?.timelineName || value : value);
      option.value = value; select.append(option);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'all';
  }
  const unresolved = items.filter(item => item.status === 'conflict' && !resolveChoice(resolveConflict(item)));
  document.getElementById('resolve-next').disabled = resolveBusy || !unresolved.length;
  document.getElementById('resolve-save-review').disabled = locked || !ready;
  document.getElementById('resolve-review-recover').disabled = locked;
  const sourcePanel = document.getElementById('resolve-source-hashes');
  sourcePanel.replaceChildren();
  for (const [role, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']]) {
    const stale = state?.sourceVerification?.staleRoles?.includes(role);
    const row = make('div', stale ? 'source-stale' : '');
    row.append(make('strong', '', label), make('code', '', state?.sourceHashes?.[role]?.slice(0, 12) || 'No source'), make('span', '', stale ? 'Changed on refresh · choices reset' : state?.sourceHashes?.[role] ? 'Source fingerprint' : 'Choose sources'));
    sourcePanel.append(row);
  }
  renderResolveExport(state, ready);
  renderResolveInspection();
  const filter = document.getElementById('resolve-filter').value;
  const visible = items.filter(item => {
    if (document.getElementById('resolve-timeline').value !== 'all' && item.timelineId !== document.getElementById('resolve-timeline').value) return false;
    if (document.getElementById('resolve-field').value !== 'all' && item.field !== document.getElementById('resolve-field').value) return false;
    if (filter === 'unresolved') return item.status === 'conflict' && !resolveChoice(resolveConflict(item));
    if (filter === 'all') return true;
    if (filter === 'resolved') return !!resolveChoice(resolveConflict(item));
    if (filter === 'conflict') return item.status === 'conflict';
    return item.status === filter;
  });
  document.getElementById('resolve-count').textContent = `${visible.length} of ${items.length}`;
  if (!visible.includes(resolveSelected)) resolveSelected = visible.find(item => item.timelineId === resolveSelected?.timelineId && item.itemId === resolveSelected?.itemId && item.field === resolveSelected?.field) || visible[0] || null;
  const queue = document.getElementById('resolve-queue');
  queue.replaceChildren();
  if (!visible.length) queue.append(make('p', 'history-empty', ready ? 'No changes match this filter.' : 'No sources selected.'));
  visible.forEach(item => {
    const choice = resolveChoice(resolveConflict(item));
    const button = make('button', `queue-item${item === resolveSelected ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item === resolveSelected));
    button.append(make('strong', '', item.context?.itemName || item.context?.timelineName || item.itemId || item.timelineId || 'Timeline'), make('small', '', item.field || 'Change'), make('span', 'queue-kind', [item.context?.timelineName || item.timelineId, item.context?.track].filter(Boolean).join(' · ')), make('span', `queue-status${item.status === 'conflict' && !choice ? ' conflict' : ''}`, choice ? 'Decided' : resolveLabels[item.status] || item.status));
    button.addEventListener('click', () => { resolveSelected = item; renderResolveState(resolveState); });
    queue.append(button);
  });
  renderResolveDetail();
  const audit = document.getElementById('resolve-audit');
  const auditHash = state?.audit?.auditHash || state?.audit?.hash || state?.audit?.id;
  const complete = (state?.review?.conflicts || []).every(conflict => !!resolveChoice(conflict));
  const auditSummary = state?.audit && complete ? `Audit ${auditHash ? String(auditHash).slice(0, 20) : 'available'} · ${state.decisions?.length || 0} recorded choice(s)` : 'Audit pending: decide every conflict.';
  audit.textContent = state?.artifactId ? `Saved preview: ${state.artifactId} · ${auditSummary}` : ready ? auditSummary : 'No saved preview loaded.';
  if (state?.artifactId) document.getElementById('resolve-artifact').value = state.artifactId;
  document.getElementById('resolve-review-saved').textContent = state?.reviewArtifactId ? `Saved review: ${state.reviewArtifactId} · ${auditSummary}` : ready ? `${unresolved.length} unresolved conflict(s). Save review to preserve current choices.` : 'No saved review loaded.';
  if (state?.reviewArtifactId) document.getElementById('resolve-review-artifact').value = state.reviewArtifactId;
}
function renderResolveDetail() {
  const detail = document.getElementById('resolve-detail');
  detail.replaceChildren();
  const item = resolveSelected;
  detail.append(make('h2', '', item ? `${item.field} comparison` : 'Source comparison'));
  if (!item) { detail.append(make('p', '', 'Select a change to inspect base, local, and incoming source values.')); return; }
  detail.append(make('p', 'resolve-context', [item.context?.timelineName || `Timeline ${item.timelineId || 'unspecified'}`, item.context?.itemName || item.itemId, item.context?.track, resolveLabels[item.status] || item.status].filter(Boolean).join(' · ')));
  const values = make('div', 'resolve-values');
  for (const [key, label] of [['base', 'Common base'], ['local', 'Your local cut'], ['incoming', 'Incoming cut']]) {
    const column = make('div', key === 'incoming' ? 'incoming-value' : '');
    column.append(make('h3', '', label), make('pre', '', resolveValue(item[key])));
    values.append(column);
  }
  detail.append(values);
  const conflict = resolveConflict(item);
  if (conflict) {
    detail.append(make('p', 'resolve-context', resolveState.plan.schemaVersion === 2 ? 'Local and incoming observations differ from the common base. Choose the value to record in this review; missing observations remain unknown.' : 'Both cuts changed this field from the common base. Choose the value to record in this review.'));
    const controls = make('div', 'resolve-decisions');
    const selected = resolveChoice(conflict);
    for (const choice of conflict.options || ['keep-local', 'take-incoming']) {
      const button = make('button', selected === choice ? 'selected' : '', choice === 'keep-local' ? 'Keep local' : 'Take incoming');
      button.type = 'button'; button.disabled = resolveBusy || activeResolveTrial();
      button.setAttribute('aria-pressed', String(selected === choice));
      button.addEventListener('click', () => resolveAction('setResolveDecision', conflict.id, choice));
      controls.append(button);
    }
    detail.append(controls);
  }
}
function renderResolveInspection() {
  const section = document.getElementById('resolve-inspection');
  const expanded = new Set([...section.querySelectorAll('details[open]')].map(detail => detail.dataset.section));
  section.replaceChildren();
  const assessment = resolveState?.plan?.assessment;
  const coverage = resolveState?.plan?.classification?.observationCoverage;
  if (coverage) renderResolveCoverage(section, coverage, expanded);
  for (const [label, entries] of [['Warning categories', assessment?.warnings || []], ['Media requirements', assessment?.mediaRequirements || []]]) {
    const disclosure = make('details', '');
    disclosure.dataset.section = label; disclosure.open = expanded.has(label);
    disclosure.append(make('summary', '', `${label} (${entries.length})`));
    if (!entries.length) disclosure.append(make('p', '', assessment ? `No ${label.toLowerCase()} reported.` : 'Choose sources to inspect requirements.'));
    for (const entry of entries) {
      const row = make('div', 'resolve-inspection-row');
      if (label === 'Warning categories') row.append(make('strong', '', entry.code || 'Warning'), make('span', '', `${entry.count || 0} occurrence(s)`));
      else row.append(make('strong', '', `${entry.timelineId} · ${entry.itemId || 'Timeline'}`), make('span', '', `Media ${entry.mediaPoolId || 'identity unknown'} · availability ${entry.availability || 'unknown'}`), make('span', '', `Identity: ${entry.identity || 'unknown'}${entry.pendingConflictResolution ? ' · conflict choice required' : ''}`));
      disclosure.append(row);
    }
    section.append(disclosure);
  }
}
function renderResolveCoverage(section, coverage, expanded) {
  const details = make('details', 'resolve-observation-coverage');
  details.dataset.section = 'coverage'; details.open = expanded.has('coverage');
  details.append(make('summary', '', `Capture coverage (${coverage.gaps.length} gaps)`));
  details.append(make('p', '', 'Only returned values observed in all three sources are classified as property, effect-slot or track-state edits. Gaps are excluded from field choices. Whole-item or timeline decisions retain the observations available on each side.'));
  for (const [role, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']]) {
    const row = make('div', 'resolve-inspection-row');
    row.append(make('strong', '', label), make('span', '', resolveCoverageText(coverage.roles[role])));
    details.append(row);
  }
  details.append(make('p', '', coverage.capturedContextDiffers
    ? 'Sources were captured with different active timelines. Properties of inactive timelines may be unavailable; this capture context is not a mergeable edit.'
    : 'Effect category/index and track type/index are observed positions. Persistent instance identities, effect parameters and full native project coverage remain unproven.'));
  const pageSize = 20;
  resolveCoveragePage = Math.min(resolveCoveragePage, Math.max(0, Math.ceil(coverage.gaps.length / pageSize) - 1));
  const start = resolveCoveragePage * pageSize;
  if (coverage.gaps.length) {
    const range = make('p', '', `Gaps ${start + 1}–${Math.min(start + pageSize, coverage.gaps.length)} of ${coverage.gaps.length}`);
    range.id = 'resolve-coverage-range'; range.tabIndex = -1; details.append(range);
    for (const gap of coverage.gaps.slice(start, start + pageSize)) {
      const row = make('div', 'resolve-coverage-gap');
      row.append(make('h3', '', [gap.context?.timelineName || gap.timelineId, gap.context?.itemName || gap.itemId, gap.context?.track, gap.field].filter(Boolean).join(' · ')));
      const values = make('div', 'resolve-values');
      for (const [role, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']]) {
        const value = gap[role];
        const reasons = { 'not-captured': 'not captured', 'read-unavailable': 'read unavailable', 'key-not-returned': 'key not returned' };
        const column = make('div', role === 'incoming' ? 'incoming-value' : '');
        column.append(make('h3', '', label), make('pre', '', value.observed ? resolveValue(value.value) : `Not observed (${reasons[value.reason] || 'unknown'})`));
        values.append(column);
      }
      row.append(values); details.append(row);
    }
    const controls = make('div', 'resolve-toolbar resolve-coverage-pages');
    for (const [label, delta, disabled] of [['Previous gaps', -1, start === 0], ['Next gaps', 1, start + pageSize >= coverage.gaps.length]]) {
      const button = make('button', '', label); button.type = 'button'; button.disabled = disabled;
      button.addEventListener('click', () => { resolveCoveragePage += delta; renderResolveInspection(); document.getElementById('resolve-coverage-range')?.focus(); });
      controls.append(button);
    }
    details.append(controls);
  }
  section.append(details);
}
function nextResolveConflict() {
  if (resolveBusy) return;
  const items = resolveChanges();
  const index = items.indexOf(resolveSelected);
  const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
  const next = ordered.find(item => item.status === 'conflict' && !resolveChoice(resolveConflict(item)));
  if (!next) return;
  for (const id of ['resolve-timeline', 'resolve-field']) document.getElementById(id).value = 'all';
  document.getElementById('resolve-filter').value = 'unresolved';
  resolveSelected = next;
  renderResolveState(resolveState);
  document.querySelector('#resolve-queue [aria-pressed="true"]')?.focus();
}

async function resolveAction(method, ...args) {
  if (resolveBusy) return;
  const reviewEventGeneration = resolveReviewEventGeneration;
  resolveBusy = true;
  resolveActionNotice = '';
  renderResolveState(resolveState);
  document.getElementById('resolve-notice').textContent = 'Reading and verifying preview…';
  try {
    if (!window.desktop?.[method]) throw new Error('Resolve preview is available in the desktop app.');
    const state = await window.desktop[method](...args);
    if (state) resolveState = state;
    if (state?.error?.code && (method === 'previewResolveServiceHistory' || state.error.code.startsWith('service-resolve-'))) {
      resolveState = { ...state, error: { ...state.error, message: resolveServiceErrorLabel(state.error.code) } };
    }
    if (method === 'refreshResolvePreview' && !state?.error) resolveActionNotice = state?.sourceVerification?.changed ? `Changed sources: ${(state.sourceVerification.staleRoles || []).join(', ')}. Previous choices cleared; review the refreshed comparison.` : 'Capture source bytes verified unchanged. Current review choices retained.';
    if (method === 'saveResolvePreview' && !state?.error) resolveActionNotice = 'Preview saved. Session decisions are not restored by recovery.';
    if (method === 'saveResolveReview' && !state?.error) resolveActionNotice = 'Review saved with current choices. An audit is included only when every conflict is decided. No changes applied.';
    if (method === 'recoverResolveReview' && !state?.error) resolveActionNotice = 'Review recovered and source bytes verified. Saved choices restored; no changes applied.';
    if (method === 'recoverResolvePreview' && !state?.error) resolveActionNotice = 'Saved preview recovered. Review conflict decisions again.';
  } catch (error) {
    resolveState = { ...resolveState, error: { message: error.message || 'Preview failed. Choose the sources again to retry.' } };
  } finally {
    if (reviewEventGeneration !== resolveReviewEventGeneration) {
      try { resolveState = await window.desktop.getResolveReviewState(); }
      catch { resolveState = resolveReviewEventState; }
    }
    if (resolveState?.error?.code && (method === 'previewResolveServiceHistory' || resolveState.error.code.startsWith('service-resolve-'))) {
      resolveState = { ...resolveState, error: { ...resolveState.error, message: resolveServiceErrorLabel(resolveState.error.code) } };
    }
    resolveBusy = false; renderResolveState(resolveState); refreshResolveServiceState();
  }
}
document.getElementById('resolve-export-choose').addEventListener('click', () => resolveAction('chooseResolveExport', document.getElementById('resolve-timeline').value === 'all' ? undefined : document.getElementById('resolve-timeline').value));
let companionBusy = false;
let verifiedResolveCaptureAvailable = false;
document.getElementById('resolve-companion-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  const read = document.getElementById('resolve-companion-read');
  document.getElementById('resolve-companion-save').disabled = true;
  document.getElementById('resolve-companion-save-rich').disabled = true;
  document.getElementById('resolve-companion-revision').disabled = true;
  verifiedResolveCaptureAvailable = false;
  read.disabled = true;
  status.textContent = 'Preparing a private capture request…';
  try {
    const result = await window.desktop.prepareResolveCapture(document.getElementById('resolve-companion-name').value);
    if (!result?.ready) throw new Error(result?.error || 'Could not prepare a capture.');
    read.disabled = false;
    status.textContent = `Command copied. Paste it into Resolve’s Lua Console and press Return. Click the output, press Cmd+A and Cmd+C, then return within ${result.expiresMinutes} minutes and select Read copied result.`;
  } catch (error) { status.textContent = error.message || 'Could not prepare a capture.'; }
  finally { companionBusy = false; refreshResolveHistory(); }
});
document.getElementById('resolve-companion-read').addEventListener('click', async () => {
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  document.getElementById('resolve-companion-save').disabled = true;
  document.getElementById('resolve-companion-save-rich').disabled = true;
  document.getElementById('resolve-companion-revision').disabled = true;
  status.textContent = 'Verifying the capture…';
  try {
    const result = await window.desktop.readResolveCapture();
    if (result?.collecting) {
      status.textContent = `Received capture part ${result.received} of ${result.total}. The next Console command is copied. Paste it into Resolve’s Lua Console, press Return, copy the output, then select Read copied result again.`;
      return;
    }
    if (!result?.ready) throw new Error(result?.error || 'No valid capture is ready.');
    verifiedResolveCaptureAvailable = true;
    document.getElementById('resolve-companion-save').disabled = false;
    document.getElementById('resolve-companion-save-rich').disabled = !result.coverage;
    document.getElementById('resolve-companion-revision').disabled = false;
    status.textContent = `Verified read-only capture: ${result.timelineCount} timeline${result.timelineCount === 1 ? '' : 's'}, ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}. ${resolveCoverageText(result.coverage)} Save a local revision to retain these observations. Capture JSON includes these observations for previews; snapshot JSON includes timeline and clip fields only. Missing properties and effect parameters remain unobserved.`;
  } catch (error) { verifiedResolveCaptureAvailable = false; status.textContent = error.message || 'Could not read the capture.'; }
  finally { companionBusy = false; refreshResolveHistory(); }
});
document.getElementById('resolve-companion-revision-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  status.textContent = 'Saving the verified observation…';
  try {
    const result = await window.desktop.saveResolveCaptureRevision(document.getElementById('resolve-companion-message').value);
    if (result?.unchanged) { status.textContent = result.message; return; }
    if (!result?.saved) throw new Error(result?.error || 'Could not save the observation.');
    status.textContent = `Read-only observation saved on ${result.branch}: revision ${result.revisionId}${result.changeCount === null ? '' : ` · ${result.changeCount} observed field ${result.changeCount === 1 ? 'change' : 'changes'}`}. The Resolve project was not changed.`;
    document.getElementById('resolve-companion-message').value = '';
    await refreshResolveHistory();
  } catch (error) { status.textContent = error.message || 'Could not save the observation.'; }
  finally { companionBusy = false; }
});
let resolveHistoryGeneration = 0;
let resolveHistoryOpenToken = 0;
let resolveTransferReview = null;
let resolveTransferBusy = false;
function renderResolveTransfer() {
  const reviewing = !!resolveTransferReview;
  document.getElementById('resolve-history-export').disabled = resolveTransferBusy || reviewing
    || !document.getElementById('resolve-history-project').value;
  document.getElementById('resolve-history-import').disabled = resolveTransferBusy || reviewing;
  document.getElementById('resolve-history-transfer-review').hidden = !reviewing;
  document.getElementById('resolve-history-transfer-confirm').disabled = resolveTransferBusy;
  document.getElementById('resolve-history-transfer-cancel').disabled = resolveTransferBusy;
  if (!reviewing) return;
  const review = resolveTransferReview, exporting = review.operation === 'export';
  const count = (value, singular, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
  document.getElementById('resolve-history-transfer-title').textContent = exporting
    ? `Export observations for ${review.projectName}` : `Import observations into ${review.projectName}`;
  document.getElementById('resolve-history-transfer-summary').textContent =
    `${count(review.revisionCount, 'revision')} · ${count(review.branchCount, 'branch', 'branches')} · ${(review.byteCount / 1024).toFixed(1)} KB. `
    + `${count(review.auditCount, 'trial audit')} · ${count(review.choiceCount, 'recorded choice')} · ${review.effectAuditCount} with effect observations · ${review.recoveryAuditCount} with recovery evidence. `
    + (exporting ? 'The file will be saved locally.' : `${review.createsProject ? 'Creates a local observation history. ' : ''}Adds separate import branches. Your current branch stays selected.`);
  document.getElementById('resolve-history-transfer-confirm').textContent = exporting ? 'Save reviewed backup' : 'Import reviewed revisions';
}
async function resolveTransferAction(operation) {
  if (resolveTransferBusy) return;
  let focusTarget = null;
  resolveTransferBusy = true; renderResolveTransfer();
  const status = document.getElementById('resolve-history-transfer-status');
  status.textContent = operation === 'confirm' ? 'Transferring reviewed observations…' : operation === 'cancel' ? 'Cancelling review…' : 'Verifying revision backup…';
  try {
    let result;
    if (operation === 'export') result = await window.desktop.prepareResolveHistoryExport(document.getElementById('resolve-history-project').value);
    else if (operation === 'import') result = await window.desktop.prepareResolveHistoryImport();
    else if (operation === 'cancel') result = await window.desktop.cancelResolveHistoryTransfer(resolveTransferReview?.token);
    else if (resolveTransferReview?.operation === 'export') result = await window.desktop.saveResolveHistoryExport(resolveTransferReview.token);
    else if (resolveTransferReview) result = await window.desktop.importReviewedResolveHistory(resolveTransferReview.token);
    if (result?.error || !result) throw new Error(result?.error || 'Could not transfer the backup. Prepare a new review and try again.');
    if (result.ready) {
      resolveTransferReview = result; renderResolveTransfer();
      document.getElementById('resolve-history-transfer-title').focus();
      status.textContent = 'Review the included information before continuing.';
    } else if (result.saved || result.imported) {
      resolveTransferReview = null;
      status.textContent = result.saved ? `Saved ${result.revisionCount} observation revisions.`
        : `Imported ${result.revisionCount} revisions onto ${result.branches.join(', ')}. Switch branches to inspect them.`;
      await refreshResolveHistory(result.projectId);
      focusTarget = result.saved ? 'resolve-history-export' : 'resolve-history-import';
    } else if (result.cancelled) {
      if (operation === 'cancel') resolveTransferReview = null;
      status.textContent = resolveTransferReview ? 'Save cancelled. The reviewed backup is ready to retry.' : 'Backup review cancelled.';
      if (!resolveTransferReview) focusTarget = 'resolve-history-import';
    }
  } catch (error) {
    status.textContent = error.message || 'Could not transfer the backup. Prepare a new review and try again.';
  } finally {
    resolveTransferBusy = false; renderResolveTransfer();
    if (focusTarget) document.getElementById(focusTarget).focus();
  }
}
document.getElementById('resolve-history-export').addEventListener('click', () => resolveTransferAction('export'));
document.getElementById('resolve-history-import').addEventListener('click', () => resolveTransferAction('import'));
document.getElementById('resolve-history-transfer-confirm').addEventListener('click', () => resolveTransferAction('confirm'));
document.getElementById('resolve-history-transfer-cancel').addEventListener('click', () => resolveTransferAction('cancel'));
function emptyResolveCommentDraft() {
  return { body: '', timelineId: '', kind: 'clip', clipId: '', startFrame: '', endFrame: '' };
}
function currentResolveCommentsContext() {
  return resolveServiceScopeMatches() && resolveServiceState?.binding && resolveServiceState?.fetched?.head
    ? JSON.stringify([resolveServiceExpectedContext(), resolveServiceState.fetched.head]) : '';
}
function resetResolveCommentsDraft() {
  resolveCommentsDraft = emptyResolveCommentDraft(); resolveCommentsTimelineKey = ''; resolveCommentsClipKey = '';
}
function syncResolveCommentsContext() {
  const context = currentResolveCommentsContext();
  const accessKey = JSON.stringify([context, serviceState?.status, resolveServiceState?.binding?.role]);
  if (context !== resolveCommentsContext) {
    resolveCommentsContext = context; resolveCommentsState = null; resolveCommentsScopeId = null;
    resolveCommentsAction = null; resolveCommentsNotice = ''; resetResolveCommentsDraft();
    document.getElementById('resolve-comments-identity').open = false;
  }
  renderResolveComments();
  if (accessKey !== resolveCommentsAccessKey) { resolveCommentsAccessKey = accessKey; readResolveCommentsState(); }
}
function applyResolveCommentsState(state, expectedContext = currentResolveCommentsContext()) {
  if (!state || !Number.isSafeInteger(state.version) || state.version < resolveCommentsVersion
    || expectedContext !== currentResolveCommentsContext()) return false;
  if (state.target && (!expectedContext || state.target.serviceProjectId !== resolveServiceState?.binding?.remoteProjectId
    || state.target.revisionId !== resolveServiceState?.fetched?.head)) return false;
  if (state.scopeId !== resolveCommentsScopeId) {
    if (resolveCommentsScopeId) resolveCommentsAction = null;
    resetResolveCommentsDraft(); resolveCommentsNotice = ''; resolveCommentsScopeId = state.scopeId || null;
  }
  resolveCommentsVersion = state.version; resolveCommentsState = state; renderResolveComments(); return true;
}
async function readResolveCommentsState() {
  if (!window.desktop?.getResolveComments) return;
  const context = currentResolveCommentsContext();
  try { applyResolveCommentsState(await window.desktop.getResolveComments(), context); }
  catch { if (context === currentResolveCommentsContext()) { resolveCommentsNotice = 'Could not read comment state. Refresh comments to retry.'; renderResolveComments(); } }
}
function resolveCommentsErrorLabel(code) {
  return ({ 'comments-invalid': 'Check the comment text and choose an anchor from this incoming revision.',
    'comment-anchor-invalid': 'Choose a valid clip or frame range from this incoming revision.',
    'comment-anchor-unverified': 'The anchor could not be verified in this revision. Refresh comments and choose it again.',
    'comment-revision-unsupported': 'Comments require a supported saved Resolve observation revision.',
    'comment-not-found': 'The comment is unavailable. Refresh comments to read the current thread.',
    'comment-idempotency-conflict': 'This pending comment no longer matches its saved request. Refresh comments and review the draft before retrying.',
    'comment-cursor-invalid': 'The comment page is no longer valid. Refresh comments to start with the newest page.',
    'comment-capacity': 'The service comment limit was reached. Contact the project owner.',
    'comments-display-limit': 'The comment display limit was reached. Refresh comments to start with the newest page.',
    'comments-unavailable': 'Fetch incoming Resolve history for an accessible linked project, then refresh comments.',
    'comments-busy': 'Another comment action is running. Wait for it to finish, then retry.',
    'comments-selection-changed': 'The incoming comment target changed. Refresh comments for the current fetched revision.',
    'comments-refresh-required': 'Refresh comments to verify this revision’s thread before posting.',
    'comments-target-too-large': 'The incoming snapshot exceeds the comment anchor limits. Comments are unavailable for this revision.',
    'comments-local-error': 'Comment state could not be read locally. Refresh comments to retry.',
    forbidden: 'Your account cannot perform this comment action. Check project access or sign in again.',
    'access-token-invalid': 'Your service session expired. Sign in again before refreshing comments.',
    'service-sign-in-required': 'Sign in through Service history, then refresh comments.',
    'service-offline': 'The service is unavailable. Previously loaded comments may be shown; refresh after reconnecting.',
    'sync-network-unavailable': 'The service is unavailable. Previously loaded comments may be shown; refresh after reconnecting.' })[code]
    || 'The comment action could not finish. Refresh comments and try again.';
}
function resolveCommentAnchor(state = resolveCommentsState) {
  const draft = resolveCommentsDraft, timeline = state?.timelines?.find(item => item.id === draft.timelineId);
  if (!timeline) return null;
  if (draft.kind === 'clip') return timeline.clips.some(item => item.id === draft.clipId)
    ? { kind: 'clip', timelineId: timeline.id, clipId: draft.clipId } : null;
  const start = Number(draft.startFrame), end = Number(draft.endFrame);
  return draft.kind === 'range' && draft.startFrame !== '' && draft.endFrame !== '' && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= timeline.startFrame && end > start && end <= timeline.endFrame
    ? { kind: 'range', timelineId: timeline.id, startFrame: start, endFrame: end } : null;
}
function resolveCommentAnchorLabel(anchor, timelines) {
  const timeline = timelines.find(item => item.id === anchor.timelineId), name = timeline?.name || 'Timeline';
  if (anchor.kind === 'clip') {
    const clip = timeline?.clips.find(item => item.id === anchor.clipId);
    const frames = clip && Number.isSafeInteger(clip.startFrame) && Number.isSafeInteger(clip.endFrame)
      ? `frames ${clip.startFrame}–${clip.endFrame} (end excluded)` : 'Frame range unavailable';
    return `${name} · ${clip?.name || 'Clip'} · ${frames}`;
  }
  return `${name} · frames ${anchor.startFrame}–${anchor.endFrame} (end excluded)`;
}
function renderResolveComments() {
  const context = currentResolveCommentsContext(), state = context && context === resolveCommentsContext ? resolveCommentsState : null;
  const target = state?.target, available = !!state?.available && !!target, ready = available && !!state.ready;
  const pending = resolveCommentsAction?.context === context ? resolveCommentsAction : null, busy = !!pending || !!state?.busy;
  const canPost = ready && !!state.postingAvailable && ['owner', 'editor'].includes(state.role) && typeof window.desktop?.addResolveComment === 'function';
  const timelines = target ? state.timelines || [] : [], draft = resolveCommentsDraft;
  setServiceText(document.getElementById('resolve-comments-target'), target
    ? `${target.revisionMessage || 'Fetched incoming observation'} · service revision ${target.revisionId}`
    : 'Fetch incoming Resolve history to choose the comment target.');
  setServiceText(document.getElementById('resolve-comments-stamp'), target ? `Incoming history fetched ${serviceDate(target.fetchedAt)} · ${state.role || 'unknown'} access` : '');
  document.getElementById('resolve-comments-identity').hidden = !target;
  for (const [id, value] of [['project-id', target?.serviceProjectId], ['revision-id', target?.revisionId], ['manifest', target?.manifestSha256]]) {
    setServiceText(document.getElementById(`resolve-comments-${id}`), value || '');
  }
  const timelineSelect = document.getElementById('resolve-comments-timeline');
  const timelineKey = JSON.stringify([state?.scopeId, timelines.map(item => [item.id, item.name, item.startFrame, item.endFrame])]);
  if (timelineKey !== resolveCommentsTimelineKey) {
    resolveCommentsTimelineKey = timelineKey; timelineSelect.replaceChildren(new Option('Choose a timeline', ''));
    for (const timeline of timelines) timelineSelect.add(new Option(timeline.name || timeline.id, timeline.id));
  }
  const timeline = timelines.find(item => item.id === draft.timelineId);
  if (!timeline) { draft.timelineId = ''; draft.clipId = ''; }
  if (timelineSelect.value !== draft.timelineId) timelineSelect.value = draft.timelineId;
  const clipSelect = document.getElementById('resolve-comments-clip'), clips = timeline?.clips || [];
  const clipKey = JSON.stringify([state?.scopeId, timeline?.id, clips.map(item => [item.id, item.name])]);
  if (clipKey !== resolveCommentsClipKey) {
    resolveCommentsClipKey = clipKey; clipSelect.replaceChildren(new Option('Choose a clip', ''));
    for (const clip of clips) clipSelect.add(new Option(`${clip.name || 'Unnamed clip'} · ${clip.id}`, clip.id));
  }
  if (!clips.some(item => item.id === draft.clipId)) draft.clipId = '';
  if (clipSelect.value !== draft.clipId) clipSelect.value = draft.clipId;
  document.getElementById('resolve-comments-kind').value = draft.kind;
  document.getElementById('resolve-comments-clip-field').hidden = draft.kind !== 'clip';
  document.getElementById('resolve-comments-range-fields').hidden = draft.kind !== 'range';
  clipSelect.required = draft.kind === 'clip';
  for (const [id, value] of [['start', draft.startFrame], ['end', draft.endFrame]]) {
    const input = document.getElementById(`resolve-comments-${id}`); if (input.value !== value) input.value = value;
    input.required = draft.kind === 'range'; input.min = timeline ? String(timeline.startFrame + (id === 'end' ? 1 : 0)) : '';
    input.max = timeline ? String(timeline.endFrame - (id === 'start' ? 1 : 0)) : '';
  }
  setServiceText(document.getElementById('resolve-comments-frame-help'), timeline
    ? `Absolute timeline frames ${timeline.startFrame}–${timeline.endFrame}. The end frame is excluded.`
    : 'Use absolute timeline frame numbers. The end frame is excluded.');
  const body = document.getElementById('resolve-comments-body'); if (body.value !== draft.body) body.value = draft.body;
  setServiceText(document.getElementById('resolve-comments-count'), `${draft.body.length} / 1000 characters`);
  document.getElementById('resolve-comments-fields').disabled = !canPost || busy;
  document.getElementById('resolve-comments-post').disabled = !canPost || busy || !draft.body.trim() || draft.body.length > 1000 || !resolveCommentAnchor(state);
  const refresh = document.getElementById('resolve-comments-refresh');
  refresh.disabled = !context || busy || !window.desktop?.refreshResolveComments;
  setServiceText(refresh, pending?.method === 'refreshResolveComments' ? 'Refreshing…' : 'Refresh comments');
  const items = target ? (state.items || []).filter(item => item.projectId === target.serviceProjectId && item.revisionId === target.revisionId) : [];
  const ids = new Set(items.map(item => item.id));
  for (const [id, view] of resolveCommentRows) if (!ids.has(id)) { view.row.remove(); resolveCommentRows.delete(id); }
  const list = document.getElementById('resolve-comments-list');
  items.forEach((item, index) => {
    let view = resolveCommentRows.get(item.id);
    if (!view) {
      const row = make('article', 'resolve-comment-row'); row.setAttribute('role', 'listitem');
      const meta = make('p', 'resolve-comment-meta'), anchor = make('p', 'resolve-comment-anchor'), text = make('p', 'resolve-comment-body');
      const resolve = make('button', '', 'Resolve comment'); resolve.type = 'button';
      resolve.addEventListener('click', () => runResolveCommentsAction('resolveResolveComment', item.id));
      row.append(meta, anchor, text, resolve); view = { row, meta, anchor, text, resolve }; resolveCommentRows.set(item.id, view);
    }
    const author = resolveServiceState?.account?.id && item.authorId === resolveServiceState.account.id ? 'You' : `Member ${item.authorId.slice(0, 8)}`;
    view.meta.title = `Author ID: ${item.authorId}`;
    setServiceText(view.meta, `${author} · ${serviceDate(item.createdAt)} · ${item.status === 'resolved' ? `Resolved${item.resolvedAt ? ` ${serviceDate(item.resolvedAt)}` : ''}` : 'Open'}`);
    setServiceText(view.anchor, resolveCommentAnchorLabel(item.anchor, timelines)); setServiceText(view.text, item.body);
    view.resolve.hidden = item.status !== 'open' || item.canResolve !== true;
    view.resolve.disabled = busy || !ready || !available || !window.desktop?.resolveResolveComment;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  const status = !window.desktop?.getResolveComments ? 'Revision comments are unavailable in this build.'
    : !context ? 'Fetch incoming Resolve history for the linked project before reading comments.'
      : pending ? pending.method === 'addResolveComment' ? 'Posting comment…' : pending.method === 'resolveResolveComment' ? 'Recording the resolution…' : 'Refreshing comments…'
        : resolveCommentsNotice || (state?.error ? resolveCommentsErrorLabel(state.error)
          : !ready ? 'Refresh comments to read this revision’s thread before posting.'
            : state.role === 'viewer' ? 'Viewer access allows reading comments. Posting requires editor or owner access.'
              : !items.length ? 'No comments have been recorded for this incoming revision.' : 'Comments remain attached to this incoming revision.');
  setServiceText(document.getElementById('resolve-comments-status'), status);
  setServiceText(document.getElementById('resolve-comments-range'), ready || items.length ? `${items.length} comment${items.length === 1 ? '' : 's'} shown` : '');
  const more = document.getElementById('resolve-comments-more'); more.hidden = !state?.nextCursor;
  more.disabled = busy || !ready || !window.desktop?.refreshResolveComments;
}
async function runResolveCommentsAction(method, input) {
  const context = currentResolveCommentsContext(), scopeId = resolveCommentsState?.scopeId;
  if (!context || resolveCommentsAction || resolveCommentsState?.busy || typeof window.desktop?.[method] !== 'function') return;
  if (method === 'addResolveComment' && input?.scopeId !== scopeId) {
    resolveCommentsNotice = 'The comment target changed. Review the current fetched revision before posting.'; renderResolveComments(); return;
  }
  const action = { method, context }, focused = document.activeElement, body = resolveCommentsDraft.body;
  resolveCommentsAction = action; resolveCommentsNotice = ''; renderResolveComments();
  let added = false;
  try {
    const state = await window.desktop[method](input);
    if (resolveCommentsAction !== action || context !== currentResolveCommentsContext()
      || method !== 'refreshResolveComments' && resolveCommentsState?.scopeId !== scopeId) return;
    const accepted = applyResolveCommentsState(state, context);
    if (accepted && context === currentResolveCommentsContext() && scopeId && state.scopeId === scopeId) {
      if (method === 'addResolveComment' && state.outcome?.kind === 'added' && state.outcome.commentId) {
        added = true; if (resolveCommentsDraft.body === body) resolveCommentsDraft.body = '';
        resolveCommentsNotice = `Comment posted.${state.error || !state.ready ? ' Refresh comments to reload the thread.' : ''}`;
      } else if (method === 'resolveResolveComment' && state.outcome?.kind === 'resolved') {
        resolveCommentsNotice = `Comment marked resolved.${state.error || !state.ready ? ' Refresh comments to reload the thread.' : ''}`;
      }
    }
  } catch {
    if (resolveCommentsAction === action && context === currentResolveCommentsContext() && resolveCommentsState?.scopeId === scopeId)
      resolveCommentsNotice = 'The comment action could not finish. Your draft is retained; refresh comments or retry.';
  }
  finally {
    if (resolveCommentsAction === action) {
      resolveCommentsAction = null; renderResolveComments();
      if (focused && context === currentResolveCommentsContext() && (document.activeElement === document.body || document.activeElement === focused)) {
        const target = added && !document.getElementById('resolve-comments-fields').disabled ? document.getElementById('resolve-comments-body')
          : focused.isConnected && !focused.disabled && !focused.closest('[hidden]') ? focused : document.getElementById('resolve-comments-status');
        target.focus({ preventScroll: true });
      }
    }
  }
}

function resolveServiceExpectedContext() {
  const account = serviceState?.account;
  return JSON.stringify([serviceState?.origin || null, account?.id || null,
    resolveServiceSelection?.projectId || null, resolveServiceSelection?.branch || null,
    resolveServiceState?.binding?.remoteProjectId || null, resolveServiceState?.binding?.remoteBranch || null]);
}
function resolveServiceScopeMatches(state = resolveServiceState) {
  return !!resolveServiceSelection && !!state?.local && !!state.account && !!serviceState?.account
    && ['connected', 'offline'].includes(state.status) && ['connected', 'offline'].includes(serviceState.status)
    && state.origin === serviceState.origin && state.account.id === serviceState.account.id
    && state.local.projectId === resolveServiceSelection.projectId && state.local.branch === resolveServiceSelection.branch;
}
function clearResolveServicePreviewDisplay() {
  if (resolveState?.sourceMode === 'service-history') { resolveSelected = null; renderResolveState(null); }
}
function resetResolveServiceChoices() {
  resolveServiceProjectChoice = ''; resolveServiceBranchChoice = ''; resolveServicePreviewSource = 'saved-head';
  resolveServiceVisibleJobs = 20;
  resolveServiceContextKey = ''; resolveServiceNotice = '';
}
function syncResolveServiceAccount() {
  let reselect = null;
  const key = JSON.stringify([serviceState?.origin || null,
    ['connected', 'offline'].includes(serviceState?.status) ? serviceState?.account?.id || null : null]);
  if (key !== resolveServiceAccountKey) {
    resolveServiceAccountKey = key; resolveServiceState = null; resolveServiceAction = null;
    reselect = resolveServiceSelection;
    resetResolveServiceChoices(); clearResolveServicePreviewDisplay();
  }
  renderResolveServicePanel();
  if (reselect) void setResolveServiceSelection(reselect.projectId, reselect.branch, true);
  else refreshResolveServiceState();
}
async function setResolveServiceSelection(projectId, branch, force = false) {
  const selected = projectId && branch ? { projectId, branch } : null;
  if (!force && JSON.stringify(selected) === JSON.stringify(resolveServiceSelection)) { await refreshResolveServiceState(); return; }
  const request = ++resolveServiceSelectionRequest;
  resolveServiceSelection = selected; resolveServiceState = null; resolveServiceAction = null;
  resetResolveServiceChoices(); clearResolveServicePreviewDisplay(); renderResolveServicePanel();
  if (!window.desktop?.selectResolveServiceProject) return;
  const context = resolveServiceExpectedContext();
  try {
    const state = await window.desktop.selectResolveServiceProject(selected?.projectId || null);
    if (request === resolveServiceSelectionRequest) renderResolveServiceState(state, context);
  } catch {
    if (request === resolveServiceSelectionRequest) { resolveServiceNotice = 'Could not select service history for this Resolve project. Refresh local history to retry.'; renderResolveServicePanel(); }
  }
}
function resolveServiceErrorLabel(code) {
  return ({ 'service-resolve-project-required': 'Choose a saved Resolve project and branch first.',
    'service-resolve-capture-required': 'Verify a Resolve capture before using it as the local preview source.',
    'service-resolve-preview-stale': 'The preview sources changed. Check and fetch history, then rebuild the service preview.',
    'service-resolve-comparison-invalid': 'The service preview sources could not be verified. Check history and fetch the incoming observations again.',
    'service-resolve-comparison-verification-invalid': 'The capture verification could not be confirmed. Verify a fresh capture before previewing again.',
    'service-resolve-comparison-capture-expired': 'The accepted capture is older than five minutes. Verify a fresh capture, then rebuild the preview.',
    'service-resolve-comparison-unsupported': 'These observations cannot be previewed together. Matching Resolve API project IDs and supported saved observations are required.',
    'service-resolve-comparison-too-large': 'These observations exceed the local preview limits. Use a smaller supported capture.',
    'service-comparison-invalid': 'The service preview could not be verified. Check and fetch history before previewing again.',
    'service-comparison-base-invalid': 'The saved comparison base could not be verified. Check history before previewing again.',
    'service-comparison-incoming-invalid': 'The incoming observations could not be verified. Fetch service history again.',
    'service-comparison-unsupported': 'The linked histories cannot be previewed safely. Matching Resolve API project IDs and verified ancestry are required.',
    'service-comparison-too-large': 'These histories exceed the local preview limits. Use smaller supported captures.',
    'comparison-source-required': 'Save a Resolve observation or verify a capture before previewing.',
    'comparison-fetch-required': 'Fetch service history before previewing incoming observations.',
    'comparison-base-invalid': 'Check history to record a verified shared base before previewing.',
    'service-viewer-read-only': 'Viewer access allows fetching and read-only preview. Pushing requires editor or owner access.' })[code] || serviceErrorLabel(code);
}
function renderResolveServiceState(state, expectedContext = resolveServiceExpectedContext()) {
  if (!state || expectedContext !== resolveServiceExpectedContext() || !Number.isSafeInteger(state.version) || state.version < resolveServiceVersion) return;
  if (state.local && !resolveServiceScopeMatches(state)) return;
  resolveServiceVersion = state.version; resolveServiceState = state;
  if (state.comparison?.status !== 'ready') clearResolveServicePreviewDisplay();
  renderResolveServicePanel();
}
async function refreshResolveServiceState() {
  if (!window.desktop?.getResolveServiceState) return;
  const context = resolveServiceExpectedContext();
  try { renderResolveServiceState(await window.desktop.getResolveServiceState(), context); }
  catch { if (context === resolveServiceExpectedContext()) { resolveServiceNotice = 'Could not read Resolve service history. Refresh local history to retry.'; renderResolveServicePanel(); } }
}
function renderResolveServicePanel() {
  const state = resolveServiceState, matches = resolveServiceScopeMatches();
  const local = matches ? state.local : null, binding = matches ? state.binding : null;
  const accountMatches = !!state?.account && state.account.id === serviceState?.account?.id && state.origin === serviceState?.origin
    && ['connected', 'offline'].includes(state.status) && ['connected', 'offline'].includes(serviceState?.status);
  const connected = accountMatches && state.status === 'connected', contact = accountMatches && ['connected', 'offline'].includes(state.status);
  const pending = resolveServiceAction?.context === resolveServiceExpectedContext() ? resolveServiceAction : null;
  const busy = !!pending || !!state?.busy || resolveBusy || companionBusy || !!resolveHistoryBranchBusy;
  const contextKey = JSON.stringify([resolveServiceExpectedContext(), binding?.remoteProjectId || null, binding?.remoteBranch || null]);
  if (contextKey !== resolveServiceContextKey) {
    resolveServiceContextKey = contextKey; resolveServiceProjectChoice = binding?.remoteProjectId || '';
    resolveServiceBranchChoice = binding?.remoteBranch || ''; resolveServicePreviewSource = 'saved-head';
  }
  setServiceText(document.getElementById('resolve-service-local'), local
    ? `${local.name} · ${local.branch} · ${local.revisionCount} saved observation${local.revisionCount === 1 ? '' : 's'}`
    : 'Select a saved Resolve project and branch first.');
  const projects = accountMatches ? state.projects || [] : [], projectSelect = document.getElementById('resolve-service-project');
  const optionsKey = JSON.stringify(projects.map(project => [project.id, project.name, project.role, project.branches]));
  if (optionsKey !== resolveServiceProjectOptionsKey) {
    resolveServiceProjectOptionsKey = optionsKey;
    projectSelect.replaceChildren(new Option(projects.length ? 'Choose a service project' : 'No accessible service projects', ''));
    for (const project of projects) projectSelect.add(new Option(`${project.name} · ${project.role}`, project.id));
  }
  if (!projects.some(project => project.id === resolveServiceProjectChoice)) resolveServiceProjectChoice = '';
  if (projectSelect.value !== resolveServiceProjectChoice) projectSelect.value = resolveServiceProjectChoice;
  const project = projects.find(value => value.id === resolveServiceProjectChoice), branchSelect = document.getElementById('resolve-service-branch');
  const branchKey = JSON.stringify([project?.id, project?.branches]);
  if (branchKey !== resolveServiceBranchOptionsKey) {
    resolveServiceBranchOptionsKey = branchKey; branchSelect.replaceChildren(new Option('Choose a service branch', ''));
    for (const branch of project?.branches || []) branchSelect.add(new Option(branch, branch));
  }
  if (!project?.branches.includes(resolveServiceBranchChoice)) resolveServiceBranchChoice = '';
  if (branchSelect.value !== resolveServiceBranchChoice) branchSelect.value = resolveServiceBranchChoice;
  projectSelect.disabled = busy || !contact || !local; branchSelect.disabled = busy || !contact || !local || !project;
  document.getElementById('resolve-service-bind').disabled = busy || !connected || !local || !project || !resolveServiceBranchChoice;
  document.getElementById('resolve-service-unlink').disabled = busy || !binding;
  document.getElementById('resolve-service-check').disabled = busy || !contact || !binding;
  document.getElementById('resolve-service-fetch').disabled = busy || !connected || !binding;
  document.getElementById('resolve-service-push').disabled = busy || !connected || !binding || !['owner', 'editor'].includes(binding?.role)
    || !local?.revisionCount || state?.sync?.status !== 'local-ahead';
  const error = resolveServiceNotice || (state?.error || state?.comparison?.error ? resolveServiceErrorLabel(state.error || state.comparison.error) : '');
  const syncLabels = { checking: 'Check the linked branch heads before pushing.', 'in-sync': 'Branch heads matched at last check.',
    'local-ahead': 'The local Resolve branch has observations ready to push.', 'remote-ahead': 'The service branch has newer observations. Fetch history to inspect them.',
    diverged: 'Both branches changed. Fetch history before reviewing their observations.', offline: 'The service is unavailable. Last recorded history is shown.' };
  setServiceText(document.getElementById('resolve-service-status'), error || (!window.desktop?.getResolveServiceState
    ? 'Resolve service history is unavailable in this build.' : !accountMatches ? 'Sign in through Service history in the History view.'
      : busy ? 'Checking Resolve service history…' : !local ? 'Choose a saved Resolve project and branch.'
        : !binding ? 'Link this local Resolve branch to an existing service project and branch.'
          : `Linked to ${binding.remoteProjectName} · ${binding.remoteBranch} · ${binding.role} access. ${syncLabels[state.sync?.status] || 'Check history to verify the linked branch.'}`));
  const base = binding ? state.base : null, recorded = base && ['recorded', 'unconfirmed'].includes(base.status) && base.localRevisionId && base.remoteRevisionId;
  setServiceText(document.getElementById('resolve-service-base'), recorded
    ? `Last shared base: local ${base.localRevisionId} · service ${base.remoteRevisionId} · recorded ${serviceDate(base.verifiedAt)}.${base.status === 'unconfirmed' ? ' Latest shared-base save is unconfirmed; this is the prior record.' : ''}`
    : base?.status === 'invalid' ? 'The recorded sharing evidence could not be verified. Check history before previewing.'
      : base?.status === 'unconfirmed' ? 'The shared-base save is unconfirmed. Check history to retry.' : 'No shared base recorded for this linked account and branch.');
  const fetched = binding ? state.fetched : null;
  setServiceText(document.getElementById('resolve-service-fetched'), fetched
    ? `${fetched.revisionCount} fetched revision${fetched.revisionCount === 1 ? '' : 's'} · fetched ${serviceDate(fetched.checkedAt)} · head ${fetched.head || 'empty branch'}. This is a captured service snapshot.`
    : 'No incoming service history fetched for this linked branch.');
  const operations = matches ? state.operations || [] : [];
  setServiceText(document.getElementById('resolve-service-queue'), operations.length ? `${operations.length} pending metadata push${operations.length === 1 ? '' : 'es'} · showing ${Math.min(operations.length, resolveServiceVisibleJobs)}.` : '');
  renderResolveServiceJobs(operations, busy, contact);
  const source = document.getElementById('resolve-service-source');
  source.querySelector('option[value="verified-capture"]').disabled = !verifiedResolveCaptureAvailable;
  if (resolveServicePreviewSource === 'verified-capture' && !verifiedResolveCaptureAvailable) resolveServicePreviewSource = 'saved-head';
  source.value = resolveServicePreviewSource; source.disabled = busy || !binding;
  const canPreview = !!binding && contact && base?.status === 'recorded' && !!fetched?.head
    && (resolveServicePreviewSource === 'verified-capture' ? verifiedResolveCaptureAvailable : !!local?.revisionCount);
  const preview = document.getElementById('resolve-service-preview');
  preview.disabled = busy || !canPreview || typeof window.desktop?.previewResolveServiceHistory !== 'function';
  setServiceText(preview, state?.comparison?.result ? 'Rebuild service preview' : 'Preview service history');
  const summary = matches && state.comparison?.status === 'ready' ? state.comparison.result : null;
  setServiceText(document.getElementById('resolve-service-preview-status'), summary?.id
    ? `${summary.decisionCount} classified field${summary.decisionCount === 1 ? '' : 's'} · ${summary.conflictCount} conflict${summary.conflictCount === 1 ? '' : 's'} · incoming ${summary.incomingRevisionId}. Review the observed values below; choices do not apply changes.`
    : !binding ? 'Link a service project to preview incoming Resolve observations.'
      : base?.status !== 'recorded' ? 'Check history to record a verified shared base before previewing.'
        : !fetched?.head ? 'Fetch history to capture incoming observations before previewing.'
          : 'Preview the saved branch head or latest verified capture against the recorded base and fetched incoming observations.');
  syncResolveCommentsContext();
}
function renderResolveServiceJobs(operations, busy, contact) {
  const list = document.getElementById('resolve-service-jobs'), visible = operations.slice(0, resolveServiceVisibleJobs);
  const ids = new Set(visible.map(job => job.id));
  for (const [id, view] of resolveServiceJobRows) if (!ids.has(id)) { view.row.remove(); resolveServiceJobRows.delete(id); }
  visible.forEach((job, index) => {
    let view = resolveServiceJobRows.get(job.id);
    if (!view) {
      const row = make('div', 'resolve-service-job'), detail = make('div'), title = make('strong'), status = make('p');
      const actions = make('div', 'resolve-service-job-actions'), retry = make('button', '', 'Retry'), cancel = make('button', '', 'Cancel');
      retry.type = cancel.type = 'button';
      retry.addEventListener('click', () => runResolveServiceQueueAction('retryResolveServiceSync', job.id));
      cancel.addEventListener('click', () => runResolveServiceQueueAction('cancelResolveServiceSync', job.id));
      detail.append(title, status); actions.append(retry, cancel); row.append(detail, actions);
      view = { row, title, status, retry, cancel }; resolveServiceJobRows.set(job.id, view);
    }
    const completed = job.progress?.completed || 0, total = job.progress?.total || 0;
    setServiceText(view.title, `Push ${job.branch} · ${job.status.replaceAll('-', ' ')}`);
    setServiceText(view.status, job.lastError ? syncErrorLabel(job.lastError) : `${completed} of ${total} observations acknowledged`);
    const pending = resolveServiceQueueActions.has(`${resolveServiceExpectedContext()}:${job.id}`);
    view.retry.hidden = !job.actions?.includes('retry');
    view.retry.disabled = pending || busy || !contact || !job.recoverable || !window.desktop?.retryResolveServiceSync;
    view.cancel.disabled = pending || !window.desktop?.cancelResolveServiceSync;
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  document.getElementById('resolve-service-jobs-more').hidden = visible.length >= operations.length;
}
async function runResolveServiceQueueAction(method, id) {
  const context = resolveServiceExpectedContext(), key = `${context}:${id}`, focused = document.activeElement;
  if (resolveServiceQueueActions.has(key) || typeof window.desktop?.[method] !== 'function') return;
  resolveServiceQueueActions.add(key); renderResolveServicePanel();
  try { renderResolveServiceState(await window.desktop[method](id), context); }
  catch { if (context === resolveServiceExpectedContext()) resolveServiceNotice = 'The queued Resolve push could not be updated. Check history before retrying.'; }
  finally {
    resolveServiceQueueActions.delete(key); renderResolveServicePanel();
    if (focused && context === resolveServiceExpectedContext() && (document.activeElement === document.body || document.activeElement === focused)) {
      const target = focused.isConnected && !focused.disabled && !focused.closest('[hidden]') ? focused : document.getElementById('resolve-service-status');
      target.focus({ preventScroll: true });
    }
  }
}
async function runResolveServiceAction(method, input) {
  if (resolveServiceAction || resolveServiceState?.busy || typeof window.desktop?.[method] !== 'function') return;
  const context = resolveServiceExpectedContext(), focused = document.activeElement, action = { context, method };
  if (['bindResolveServiceProject', 'unlinkResolveServiceProject', 'checkResolveServiceSync', 'pushResolveServiceRevisions', 'fetchResolveServiceRevisions'].includes(method)) clearResolveServicePreviewDisplay();
  resolveServiceAction = action; resolveServiceNotice = ''; renderResolveServicePanel();
  try { renderResolveServiceState(await window.desktop[method](input), context); }
  catch { if (context === resolveServiceExpectedContext()) resolveServiceNotice = 'The Resolve service action could not finish. Check history or sign in again, then retry.'; }
  finally {
    if (resolveServiceAction === action) {
      resolveServiceAction = null; renderResolveServicePanel();
      if (focused && context === resolveServiceExpectedContext() && (document.activeElement === document.body || document.activeElement === focused)) {
        const target = focused.isConnected && !focused.disabled && !focused.closest('[hidden]') ? focused : document.getElementById('resolve-service-status');
        target.focus({ preventScroll: true });
      }
    }
  }
}
function renderResolveServiceProvenance() {
  const summary = resolveState?.sourceMode === 'service-history' ? resolveState.servicePreview : null;
  document.getElementById('resolve-service-provenance').hidden = !summary;
  const facts = document.getElementById('resolve-service-provenance-facts'); facts.replaceChildren();
  setServiceText(document.getElementById('resolve-service-provenance-summary'), summary
    ? `${summary.source === 'verified-capture' ? 'Accepted verified capture' : 'Saved branch head'} · ${summary.decisionCount} classified field${summary.decisionCount === 1 ? '' : 's'} · ${summary.conflictCount} conflict${summary.conflictCount === 1 ? '' : 's'} · incoming fetched ${serviceDate(summary.fetchedAt)}${summary.acceptedAt !== null && summary.acceptedAt !== undefined ? ` · capture accepted ${serviceDate(summary.acceptedAt)}` : ''}.` : '');
  if (!summary) return;
  for (const [label, value] of [['Base local revision', summary.baseLocalRevisionId], ['Local saved head', summary.localHeadId || 'No saved head'],
    ['Incoming revision', summary.incomingRevisionId], ['Base source hash', summary.sourceHashes?.base],
    ['Local source hash', summary.sourceHashes?.local], ['Incoming source hash', summary.sourceHashes?.incoming]]) {
    facts.append(make('dt', '', label), make('dd', '', value || 'Unavailable'));
  }
}

async function refreshResolveHistory(preferredProjectId = null) {
  const generation = ++resolveHistoryGeneration;
  const select = document.getElementById('resolve-history-project');
  const status = document.getElementById('resolve-history-status');
  const previous = preferredProjectId || select.value;
  status.textContent = 'Checking local observations…';
  try {
    const result = await window.desktop.listResolveProjects();
    if (generation !== resolveHistoryGeneration) return;
    if (!result?.ready) throw new Error(result?.error || 'Could not read local Resolve history.');
    select.replaceChildren();
    if (!result.projects.length) {
      void setResolveServiceSelection(null, null, true);
      const option = make('option', '', 'No saved Resolve projects'); option.value = ''; select.append(option);
      document.getElementById('resolve-history-list').replaceChildren();
      document.getElementById('resolve-history-detail').replaceChildren();
      document.getElementById('resolve-history-branch').replaceChildren();
      document.getElementById('resolve-history-branch').disabled = true;
      document.getElementById('resolve-history-branch-create').disabled = true;
      clearResolveHistoryPreviewChoices();
      renderResolveTransfer();
      status.textContent = 'No Resolve observation revisions saved yet.';
      return;
    }
    for (const project of result.projects) {
      const option = make('option', '', `${project.displayName || 'Unnamed project'} · ${project.revisionCount} revisions`);
      option.value = project.id; select.append(option);
    }
    select.value = result.projects.some(project => project.id === previous) ? previous : result.projects[0].id;
    renderResolveTransfer();
    await loadResolveHistory(select.value, generation);
  } catch (error) { if (generation === resolveHistoryGeneration) status.textContent = error.message || 'Could not read local Resolve history.'; }
}
async function loadResolveHistory(projectId, generation = ++resolveHistoryGeneration) {
  if (projectId !== resolveServiceSelection?.projectId) void setResolveServiceSelection(null, null, true);
  const status = document.getElementById('resolve-history-status');
  const list = document.getElementById('resolve-history-list');
  const detail = document.getElementById('resolve-history-detail');
  resolveHistoryOpenToken++;
  list.replaceChildren(); detail.replaceChildren();
  clearResolveHistoryPreviewChoices();
  status.textContent = 'Reading local revisions…';
  try {
    const result = await window.desktop.listResolveRevisions(projectId);
    if (generation !== resolveHistoryGeneration) return;
    if (!result?.ready) throw new Error(result?.error || 'Could not read local revisions.');
    status.textContent = `${result.total} saved observation${result.total === 1 ? '' : 's'} on ${result.branch}${result.total > result.revisions.length ? ` · newest ${result.revisions.length} shown` : ''}.`;
    if (!result.revisions.length) {
      list.append(make('p', '', 'No revisions on this branch.'));
      await loadResolveHistoryGraph(projectId, generation);
      return;
    }
    for (const revision of result.revisions) {
      const button = make('button', 'resolve-history-entry'); button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.append(make('strong', '', revision.message), make('small', '', `${revision.createdAt} · ${revision.id.slice(0, 12)}`));
      button.addEventListener('click', () => openResolveHistoryRevision(projectId, revision.id, generation, button));
      list.append(button);
    }
    detail.append(make('p', '', 'Choose a revision to inspect its observed field changes.'));
    await loadResolveHistoryGraph(projectId, generation);
  } catch (error) { if (generation === resolveHistoryGeneration) status.textContent = error.message || 'Could not read local revisions.'; }
}
function clearResolveHistoryPreviewChoices() {
  for (const role of ['base', 'local', 'incoming']) {
    const select = document.getElementById(`resolve-history-${role}`);
    select.replaceChildren(); select.disabled = true;
  }
  document.getElementById('resolve-history-preview').disabled = true;
}
async function loadResolveHistoryGraph(projectId, generation) {
  const result = await window.desktop.getResolveRevisionGraph(projectId);
  if (generation !== resolveHistoryGeneration) return;
  if (!result?.ready) throw new Error(result?.error || 'Could not read revision ancestry.');
  const branchSelect = document.getElementById('resolve-history-branch');
  branchSelect.replaceChildren();
  for (const branch of Object.keys(result.branches).sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b))) {
    const option = make('option', '', branch); option.value = branch; branchSelect.append(option);
  }
  branchSelect.value = result.currentBranch;
  branchSelect.dataset.currentBranch = result.currentBranch;
  await setResolveServiceSelection(projectId, result.currentBranch);
  if (generation !== resolveHistoryGeneration) return;
  branchSelect.disabled = false;
  document.getElementById('resolve-history-branch-create').disabled = false;
  for (const role of ['base', 'local', 'incoming']) {
    const select = document.getElementById(`resolve-history-${role}`);
    const placeholder = make('option', '', `Choose ${role === 'base' ? 'common base' : role} revision`);
    placeholder.value = ''; select.append(placeholder);
    for (const revision of result.revisions) {
      const option = make('option', '', `${revision.message} · ${revision.id.slice(0, 12)}`);
      option.value = revision.id; select.append(option);
    }
    if (role === 'local' && verifiedResolveCaptureAvailable) {
      const option = make('option', '', 'Current verified capture · this session');
      option.value = 'verified-capture'; select.append(option);
    }
    select.disabled = result.revisions.length === 0;
  }
  document.getElementById('resolve-history-preview').disabled = result.revisions.length < 1;
}
function renderResolveHistoryAudit(detail, audit, openPage) {
  if (!audit?.available) {
    detail.append(make('p', '', 'This observation has no portable trial audit.'));
    return;
  }
  const section = make('section', 'resolve-history-audit');
  section.setAttribute('aria-label', 'Recorded trial audit');
  const heading = make('h4', '', 'Recorded trial audit'); heading.tabIndex = -1;
  const outcomeNames = { applied: 'Applied', 'rolled-back': 'Rolled back', restored: 'Restored', 'source-verified': 'Source verified' };
  section.append(heading, make('p', '', `${outcomeNames[audit.status] || audit.status} · ${audit.recordedAt}`),
    make('p', '', 'Choices record review intent. The outcome comes from copied Console observations and covers captured fields only.'));
  section.append(make('p', '', audit.effects
    ? `${audit.effects.effectCount} ${audit.effects.effectCount === 1 ? 'effect' : 'effects'} observed across ${audit.effects.itemCount} items. Effect parameters and complete native properties were not checked.`
    : 'This trial did not capture effect metadata.'));
  if (audit.recovery) section.append(make('p', '', audit.recovery.operation === 'restore-name'
    ? 'Recovery restored the original clip name after a fresh state inspection.' : 'Recovery verified the saved source after a fresh state inspection.'));
  const verification = make('details', 'resolve-audit-verification');
  verification.append(make('summary', '', 'Verification details'));
  const facts = make('dl', 'resolve-audit-values');
  for (const [label, value] of [['Transaction', audit.transactionId], ['Audit SHA-256', audit.auditHash],
    ['Base source SHA-256', audit.sourceHashes.base], ['Local source SHA-256', audit.sourceHashes.local],
    ['Incoming source SHA-256', audit.sourceHashes.incoming], ['Result SHA-256', audit.resultSnapshotHash],
    ['Native backup SHA-256', audit.backup.sha256],
    ...(audit.effects ? [['Effect source SHA-256', audit.effects.sourceHash], ['Effect result SHA-256', audit.effects.resultHash]] : []),
    ...(audit.recovery ? [['Recovery attempt', audit.recovery.attemptId], ['Inspection SHA-256', audit.recovery.inspectionHash]] : [])]) {
    facts.append(make('dt', '', label), make('dd', '', value));
  }
  verification.append(facts, make('p', '', 'The native backup is excluded from this revision. Its availability is not checked here.'));
  section.append(verification);
  section.append(make('p', '', audit.choiceCount ? `Choices ${audit.offset + 1}–${audit.offset + audit.choices.length} of ${audit.choiceCount}` : 'No conflicts required a review choice.'));
  for (const choice of audit.choices) {
    const row = make('article', 'resolve-audit-choice');
    row.append(make('h5', '', `${choice.timelineName} · ${choice.track || 'Timeline'} · ${choice.itemName || choice.itemId || 'Timeline'} · ${choice.field}`),
      make('p', '', `Recorded choice: ${choice.choice === 'take-incoming' ? 'Take incoming' : 'Keep local'}`));
    const values = make('dl', 'resolve-audit-values');
    for (const [key, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming'], ['selected', 'Selected value']]) {
      const value = choice[key], definition = make('dd');
      definition.append(make('pre', '', value.text));
      if (value.truncated) definition.append(make('span', '', `Showing 1,200 of ${value.characterCount} characters. Export the revision backup to inspect the complete value.`));
      values.append(make('dt', '', label), definition);
    }
    row.append(values); section.append(row);
  }
  if (audit.previousOffset !== null || audit.nextOffset !== null) {
    const controls = make('div', 'resolve-toolbar');
    for (const [offset, label] of [[audit.previousOffset, 'Earlier choices'], [audit.nextOffset, 'More choices']]) {
      if (offset === null) continue;
      const action = make('button', '', label); action.type = 'button';
      action.addEventListener('click', () => openPage(offset)); controls.append(action);
    }
    section.append(controls);
  }
  detail.append(section);
}
async function openResolveHistoryRevision(projectId, revisionId, generation, button, filters = {}, auditOffset = 0) {
  if (generation !== resolveHistoryGeneration) return;
  const openToken = ++resolveHistoryOpenToken;
  const detail = document.getElementById('resolve-history-detail');
  detail.replaceChildren(make('p', '', 'Verifying revision…'));
  try {
    const result = await window.desktop.openResolveRevision(projectId, revisionId, filters, auditOffset);
    if (generation !== resolveHistoryGeneration || openToken !== resolveHistoryOpenToken) return;
    if (!result?.ready) throw new Error(result?.error || 'Could not verify this revision.');
    for (const entry of document.querySelectorAll('#resolve-history-list button')) entry.setAttribute('aria-pressed', String(entry === button));
    detail.replaceChildren();
    detail.append(make('h3', '', result.message), make('p', '', `${result.createdAt} · ${result.changeCount === null ? 'First observation' : `${result.changeCount} observed field ${result.changeCount === 1 ? 'change' : 'changes'}`} · SHA-256 ${result.sourceHash.slice(0, 12)}`));
    detail.append(make('p', 'resolve-history-coverage', resolveCoverageText(result.observationCoverage)));
    if (result.observationCoverage?.schemaVersion === 2) detail.append(make('p', '', 'Only returned properties are represented. Missing keys and effect parameters remain unobserved; track indexes and effect slots are not persistent identities.'));
    if (result.comparisonCoverage && !result.comparisonCoverage.comparableProperties) detail.append(make('p', '', 'Clip properties and track states cannot be compared with this parent. Missing coverage does not mean those values were unchanged.'));
    if (result.changeCount === 0) detail.append(make('p', '', result.comparisonCoverage?.comparableProperties ? 'No observed fields changed.' : 'No changes in the fields both observations can compare.'));
    renderResolveHistoryAudit(detail, result.trialAudit, offset => openResolveHistoryRevision(projectId, revisionId, generation, button, filters, offset));
    if (auditOffset) detail.querySelector('.resolve-history-audit h4')?.focus();
    if (result.options && result.changeCount > 0) {
      const controls = make('div', 'resolve-history-filters');
      const fields = [
        ['timelineId', 'Timeline', result.options.timelines.map(item => [item.value, item.label])],
        ['track', 'Track index', result.options.tracks.map(item => [item, item])],
        ['status', 'Status', result.options.statuses.map(item => [item, item])],
        ['kind', 'Change type', result.options.kinds.map(item => [item, item.replaceAll('-', ' ')])]
      ];
      for (const [key, labelText, choices] of fields) {
        const label = make('label', '', labelText);
        const select = make('select'); select.dataset.filter = key;
        const all = make('option', '', { timelineId: 'All timelines', track: 'All track indexes', status: 'All statuses', kind: 'All change types' }[key]); all.value = ''; select.append(all);
        for (const [value, text] of choices) { const option = make('option', '', text); option.value = value; select.append(option); }
        select.value = filters[key] || '';
        select.addEventListener('change', () => {
          const selected = Object.fromEntries([...controls.querySelectorAll('select')]
            .map(input => [input.dataset.filter, input.value]));
          openResolveHistoryRevision(projectId, revisionId, generation, button, selected);
        });
        label.append(select); controls.append(label);
      }
      detail.append(controls);
      detail.append(make('p', '', `Showing ${Math.min(result.filteredCount, result.changes.length)} of ${result.filteredCount} matching changes. Track labels use observed indexes.`));
    }
    let lastTimeline = null;
    for (const change of result.changes) {
      if (change.timelineId !== lastTimeline) {
        detail.append(make('h4', 'resolve-history-timeline', change.timelineName));
        lastTimeline = change.timelineId;
      }
      const row = make('div', 'resolve-history-change');
      const slot = change.category ? `${change.category} slot ${change.index} · ` : '';
      const value = input => input === null && ['item-property-changed', 'track-state-changed'].includes(change.kind) ? 'Not observed' : resolveValue(input);
      row.append(make('strong', '', `${change.tracks.join(' / ') || 'Timeline'} · ${change.itemName || change.itemId || (change.kind === 'track-state-changed' ? 'Track' : change.kind)} · ${slot}${change.field || change.kind}`),
        make('span', '', `${value(change.before)} → ${value(change.after)}`));
      detail.append(row);
    }
  } catch (error) { if (generation === resolveHistoryGeneration && openToken === resolveHistoryOpenToken) detail.replaceChildren(make('p', '', error.message || 'Could not verify this revision.')); }
}
document.getElementById('resolve-history-refresh').addEventListener('click', () => refreshResolveHistory());
document.getElementById('resolve-service-signin').addEventListener('click', () => {
  showView('history');
  const title = document.getElementById('sync-title'); title.tabIndex = -1; title.focus();
  document.getElementById('service-panel').scrollIntoView({ block: 'start' });
});
document.getElementById('resolve-service-project').addEventListener('change', event => {
  resolveServiceProjectChoice = event.target.value; resolveServiceBranchChoice = ''; renderResolveServicePanel();
});
document.getElementById('resolve-service-branch').addEventListener('change', event => {
  resolveServiceBranchChoice = event.target.value; renderResolveServicePanel();
});
document.getElementById('resolve-service-binding-form').addEventListener('submit', event => {
  event.preventDefault(); runResolveServiceAction('bindResolveServiceProject', {
    remoteProjectId: resolveServiceProjectChoice, remoteBranch: resolveServiceBranchChoice });
});
for (const [id, method] of [['unlink', 'unlinkResolveServiceProject'], ['check', 'checkResolveServiceSync'],
  ['push', 'pushResolveServiceRevisions'], ['fetch', 'fetchResolveServiceRevisions']]) {
  document.getElementById(`resolve-service-${id}`).addEventListener('click', () => runResolveServiceAction(method));
}
document.getElementById('resolve-service-source').addEventListener('change', event => {
  resolveServicePreviewSource = event.target.value; renderResolveServicePanel();
});
document.getElementById('resolve-service-jobs-more').addEventListener('click', () => {
  resolveServiceVisibleJobs += 20; renderResolveServicePanel();
});
document.getElementById('resolve-service-preview').addEventListener('click', async () => {
  await resolveAction('previewResolveServiceHistory', { source: resolveServicePreviewSource });
  await refreshResolveServiceState();
  const title = document.getElementById(resolveState?.sourceMode === 'service-history' && resolveState.servicePreview
    ? 'resolve-service-provenance-title' : 'resolve-service-status');
  title.tabIndex = -1; title.focus();
});
document.getElementById('resolve-comments-refresh').addEventListener('click', () => runResolveCommentsAction('refreshResolveComments', false));
document.getElementById('resolve-comments-more').addEventListener('click', () => runResolveCommentsAction('refreshResolveComments', true));
document.getElementById('resolve-comments-timeline').addEventListener('change', event => {
  resolveCommentsDraft.timelineId = event.target.value; resolveCommentsDraft.clipId = '';
  resolveCommentsDraft.startFrame = ''; resolveCommentsDraft.endFrame = ''; renderResolveComments();
});
document.getElementById('resolve-comments-kind').addEventListener('change', event => {
  resolveCommentsDraft.kind = event.target.value === 'range' ? 'range' : 'clip'; renderResolveComments();
});
document.getElementById('resolve-comments-clip').addEventListener('change', event => {
  resolveCommentsDraft.clipId = event.target.value; renderResolveComments();
});
for (const [id, key] of [['start', 'startFrame'], ['end', 'endFrame'], ['body', 'body']]) {
  document.getElementById(`resolve-comments-${id}`).addEventListener('input', event => {
    resolveCommentsDraft[key] = event.target.value; renderResolveComments();
  });
}
document.getElementById('resolve-comments-form').addEventListener('submit', event => {
  event.preventDefault();
  const anchor = resolveCommentAnchor(), state = resolveCommentsState, body = resolveCommentsDraft.body;
  if (!anchor || !body.trim() || body.length > 1000 || !state?.available || !state.ready || !state.postingAvailable
    || !['owner', 'editor'].includes(state.role) || document.getElementById('resolve-comments-post').disabled) return;
  runResolveCommentsAction('addResolveComment', { scopeId: state.scopeId, anchor, body });
});
window.desktop?.onResolveServiceState?.(renderResolveServiceState);
refreshResolveServiceState();
document.getElementById('resolve-history-project').addEventListener('change', event => loadResolveHistory(event.target.value));
let resolveHistoryBranchBusy = false;
document.getElementById('resolve-history-branch').addEventListener('change', async event => {
  if (resolveHistoryBranchBusy) return;
  resolveHistoryBranchBusy = true;
  void setResolveServiceSelection(null, null, true);
  const projectId = document.getElementById('resolve-history-project').value;
  try {
    const result = await window.desktop.switchResolveBranch(projectId, event.target.value);
    if (!result?.ready) throw new Error(result?.error || 'Could not switch branch.');
    await refreshResolveHistory(projectId);
  } catch (error) {
    event.target.value = event.target.dataset.currentBranch;
    document.getElementById('resolve-history-status').textContent = error.message || 'Could not switch branch.';
  }
  finally { resolveHistoryBranchBusy = false; renderResolveServicePanel(); }
});
document.getElementById('resolve-history-branch-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (resolveHistoryBranchBusy) return;
  resolveHistoryBranchBusy = true;
  void setResolveServiceSelection(null, null, true);
  const projectId = document.getElementById('resolve-history-project').value;
  const name = document.getElementById('resolve-history-branch-name').value;
  try {
    const result = await window.desktop.createResolveBranch(projectId, name);
    if (!result?.ready) throw new Error(result?.error || 'Could not create branch.');
    document.getElementById('resolve-history-branch-name').value = '';
    await refreshResolveHistory(projectId);
  } catch (error) { document.getElementById('resolve-history-status').textContent = error.message || 'Could not create branch.'; }
  finally { resolveHistoryBranchBusy = false; renderResolveServicePanel(); }
});
document.getElementById('resolve-history-preview-form').addEventListener('submit', event => {
  event.preventDefault();
  const projectId = document.getElementById('resolve-history-project').value;
  const ids = Object.fromEntries(['base', 'local', 'incoming'].map(role =>
    [role, document.getElementById(`resolve-history-${role}`).value]));
  if (!projectId || Object.values(ids).some(value => !value)) return;
  resolveAction('previewResolveHistory', projectId, ids, document.getElementById('resolve-history-include-observations').checked);
});
if (window.desktop?.listResolveProjects) refreshResolveHistory();
for (const [id, method, label] of [['resolve-companion-save', 'saveResolveCapture', 'snapshot'], ['resolve-companion-save-rich', 'saveResolveObservation', 'capture']]) {
  document.getElementById(id).addEventListener('click', async () => {
    if (companionBusy) return;
    companionBusy = true;
    const status = document.getElementById('resolve-companion-status');
    try {
      const result = await window.desktop[method]();
      if (result?.saved) status.textContent = `Verified ${label} saved. Choose it as base, local, or incoming in the three-source preview.`;
      else if (!result?.cancelled) status.textContent = result?.error || `Could not save the ${label}.`;
    } catch { status.textContent = `Could not save the ${label}.`; }
    finally { companionBusy = false; }
  });
}
document.getElementById('resolve-export-refresh').addEventListener('click', () => resolveAction('refreshResolveExport'));
document.getElementById('resolve-choose').addEventListener('click', () => resolveAction('chooseResolveSnapshots'));
document.getElementById('resolve-refresh').addEventListener('click', () => resolveAction('refreshResolvePreview'));
document.getElementById('resolve-save').addEventListener('click', () => resolveAction('saveResolvePreview'));
document.getElementById('resolve-filter').addEventListener('change', () => renderResolveState(resolveState));
document.getElementById('resolve-recover-form').addEventListener('submit', event => { event.preventDefault(); resolveAction('recoverResolvePreview', document.getElementById('resolve-artifact').value.trim()); });
document.getElementById('resolve-save-review').addEventListener('click', () => resolveAction('saveResolveReview'));
for (const id of ['resolve-timeline', 'resolve-field']) document.getElementById(id).addEventListener('change', () => renderResolveState(resolveState));
document.getElementById('resolve-next').addEventListener('click', nextResolveConflict);
document.getElementById('resolve-review-recover-form').addEventListener('submit', event => { event.preventDefault(); resolveAction('recoverResolveReview', document.getElementById('resolve-review-artifact').value.trim()); });
document.addEventListener('keydown', event => {
  if (event.altKey && event.key.toLowerCase() === 'n' && document.getElementById('view-resolve').classList.contains('active') && !event.target?.closest?.('input, textarea, select, [contenteditable]')) { event.preventDefault(); nextResolveConflict(); }
});
renderResolveState(null);
window.desktop?.getResolveReviewState?.().then(renderResolveState).catch(() => {});
window.desktop?.onResolveReviewState?.(state => {
  resolveReviewEventGeneration++; resolveReviewEventState = state;
  if (!resolveBusy) renderResolveState(state);
});

var resolveTrialState = null;
var resolveTrialBusy = false;
var resolveTrialModeDraft = 'forced-rollback';
function activeResolveTrial() {
  return resolveTrialBusy || resolveTrialState?.busy || ['effect-command', 'backup-command', 'rollback-command', 'edit-command',
    'recovery-capture', 'recovery-ready', 'recovery-command', 'recovery-required'].includes(resolveTrialState?.phase);
}
function renderRetainedResolveTrials() {
  const state = resolveTrialState, catalog = state?.discovery;
  const items = catalog?.items || [], inProgress = Boolean(activeResolveTrial());
  const reminder = document.getElementById('resolve-recovery-reminder');
  reminder.hidden = !state?.enabled || !(items.length || catalog?.error || catalog?.hasMore || inProgress);
  document.getElementById('resolve-recovery-reminder-text').textContent = inProgress
    ? 'A disposable Resolve drill is in progress. Return to Resolve preview to finish it.'
    : catalog?.error || (items.length ? `${items.length} retained ${items.length === 1 ? 'drill needs' : 'drills need'} attention.`
      : 'Older retained drill records remain to inspect.');
  document.getElementById('resolve-recovery-review').textContent = inProgress ? 'Return to drill' : 'Review retained drills';
  const blocked = resolveTrialBusy || state?.busy;
  document.getElementById('resolve-retained-refresh').disabled = Boolean(blocked);
  document.getElementById('resolve-retained-more').hidden = !catalog?.hasMore;
  document.getElementById('resolve-retained-more').disabled = Boolean(blocked);
  document.getElementById('resolve-retained-status').textContent = catalog?.error || (!catalog?.ready
    ? 'Checking retained drill records…'
    : `${items.length ? `${items.length} retained ${items.length === 1 ? 'drill needs' : 'drills need'} attention.` : 'No unfinished drills found.'} ${catalog.scanned} records inspected.${catalog.hasMore ? ' Check older records to continue.' : ''}`);
  const list = document.getElementById('resolve-retained-list'); list.replaceChildren();
  const labels = { unfinished: 'Issued rename · live inspection needed', outcome: 'Verified outcome · history save pending',
    prepared: 'Preparation only · rename command not issued', manual: 'Manual inspection required', unreadable: 'Record could not be verified' };
  for (const item of items) {
    const retainedReady = item.action === 'recover' && item.state !== 'outcome' && item.transportOutputAvailable === true;
    const row = make('div', 'resolve-retained-row'), summary = make('div');
    summary.append(make('strong', '', item.projectName || 'Unverified drill record'));
    const date = item.createdAt ? new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable';
    summary.append(make('span', '', `${date} · ${item.mode === null ? 'Mode unavailable' : item.mode === 'rename-verify' ? 'Rename and verify' : 'Force rollback test'} · Trial ${item.transactionId.slice(0, 8)}`), make('span', '', retainedReady ? 'Retained result ready to read' : labels[item.state] || labels.unreadable));
    row.append(summary);
    if (item.action !== 'none') {
      const label = item.action === 'recover' ? item.state === 'outcome' ? 'Open outcome' : retainedReady ? 'Read retained result' : 'Inspect live state'
        : item.action === 'cancel' ? 'Cancel preparation' : 'Reveal records';
      const button = make('button', '', label); button.type = 'button';
      button.setAttribute('aria-label', `${label} for ${item.projectName || 'unverified drill'} ${item.transactionId.slice(0, 8)}`);
      button.disabled = Boolean(blocked || !['idle', 'saved'].includes(state?.phase));
      button.addEventListener('click', () => resolveTrialAction(item.action === 'recover' ? 'recoverDiscoveredResolveTrial'
        : item.action === 'cancel' ? 'cancelDiscoveredResolveTrial' : 'revealResolveTrialRecords', item.recordId));
      row.append(button);
    }
    list.append(row);
  }
}
function renderResolveTrial() {
  const state = resolveTrialState;
  document.getElementById('resolve-trial').hidden = !state?.enabled;
  renderRetainedResolveTrials();
  const blocked = resolveTrialBusy || state?.busy;
  const phase = state?.phase;
  const modeLocked = Boolean(blocked || phase && !['idle', 'saved'].includes(phase));
  const recordedMode = state?.mode === 'rename-verify' ? 'rename-verify' : 'forced-rollback';
  const mode = phase && !['idle', 'saved'].includes(phase) ? recordedMode
    : resolveTrialModeDraft === 'rename-verify' ? 'rename-verify' : 'forced-rollback';
  const modeSelect = document.getElementById('resolve-trial-mode'); modeSelect.value = mode; modeSelect.disabled = modeLocked;
  const modeLabel = recordedMode === 'rename-verify' ? 'Rename and verify' : 'Force rollback test';
  setServiceText(document.getElementById('resolve-trial-mode-help'), mode === 'rename-verify'
    ? 'On successful captured-field verification, the reviewed rename remains in the disposable project. This does not establish full native project safety.'
    : 'The reviewed rename is followed by a forced rollback and verification of the original observed state. This does not establish full native project safety.');
  const acknowledgement = mode === 'rename-verify'
    ? 'I am using the named disposable project for this rename verification experiment.'
    : 'I am using the named disposable project for this forced rollback test.';
  setServiceText(document.getElementById('resolve-trial-ack-label'), acknowledgement);
  document.getElementById('resolve-trial-ack').setAttribute('aria-label', acknowledgement);
  document.getElementById('resolve-trial-name').disabled = modeLocked;
  document.getElementById('resolve-trial-ack').disabled = modeLocked;
  if (phase && !['idle', 'saved'].includes(phase) && state.projectName) document.getElementById('resolve-trial-name').value = state.projectName;
  document.getElementById('resolve-trial-prepare').disabled = blocked || !resolveState?.audit || resolveState?.plan?.schemaVersion !== 1
    || resolveState?.sourceMode === 'service-history'
    || !['idle', 'saved'].includes(phase) || !document.getElementById('resolve-trial-ack').checked;
  document.getElementById('resolve-trial-issue').disabled = blocked || !['backup-command', 'recovery-ready'].includes(phase);
  document.getElementById('resolve-trial-issue').textContent = phase === 'recovery-ready'
    ? state.recovery?.classification === 'source' ? 'Verify saved source' : 'Restore original name'
    : mode === 'rename-verify' ? 'Verify backup and copy rename experiment' : 'Verify backup and copy rollback test';
  document.getElementById('resolve-trial-copy').disabled = blocked || !['effect-command', 'backup-command', 'rollback-command', 'edit-command', 'recovery-capture', 'recovery-command'].includes(phase);
  document.getElementById('resolve-trial-cancel').disabled = blocked || !['effect-command', 'backup-command'].includes(phase);
  document.getElementById('resolve-trial-read').disabled = blocked || !['effect-command', 'rollback-command', 'edit-command', 'recovery-capture', 'recovery-command'].includes(phase);
  document.getElementById('resolve-trial-read').textContent = phase?.startsWith('recovery-')
    ? phase === 'recovery-capture' ? 'Read recovery capture' : 'Read recovery result'
    : ['idle', 'effect-command'].includes(phase) ? 'Read state capture' : mode === 'rename-verify' ? 'Read rename result' : 'Read rollback result';
  document.getElementById('resolve-trial-save').disabled = blocked || phase !== 'verified' || state?.outcome?.status === 'recovery-required';
  document.getElementById('resolve-trial-reveal').disabled = blocked || !state?.backup;
  document.getElementById('resolve-trial-recover').disabled = blocked || !['idle', 'saved'].includes(phase);
  document.getElementById('resolve-trial-inspect').hidden = !phase?.startsWith('recovery-');
  document.getElementById('resolve-trial-inspect').disabled = blocked;
  const messages = { idle: resolveState?.sourceMode === 'service-history' ? 'Service history reviews are read only and cannot start the rename drill.'
    : resolveState?.plan?.schemaVersion === 2 ? 'Richer captures support review only. Use snapshot-only history mode or three snapshot JSON files for the separate disposable rename drill.' : 'Review one rename and acknowledge the disposable project to begin.',
    'effect-command': 'Read-only state capture copied. Run it in Resolve’s Lua Console, copy all Console output, then read the state capture here.',
    'backup-command': 'State capture matches the reviewed snapshot. Backup command copied: run it in Resolve’s Lua Console, then verify the backup here.',
    'rollback-command': state?.resultTransport === 'retained-file'
      ? 'Backup verified. Rollback test copied: run it in Resolve. After the project reopens, return to Frameline and choose Read rollback result to verify the private retained output.'
      : 'Backup verified. Drill command copied: run it in Resolve, then copy all Console output and read the result.',
    'edit-command': state?.resultTransport === 'retained-file'
      ? 'Backup verified. Rename experiment copied: run it in Resolve. After the project reopens, return to Frameline and choose Read rename result to verify the private retained output. A verified result leaves the reviewed name in the disposable project. If interrupted, return here for inspection and recovery.'
      : 'Backup verified. Rename experiment copied: run it in Resolve, then copy all Console output and read the result. A verified result leaves the reviewed name in the disposable project. If interrupted, return here for inspection and recovery.',
    'recovery-capture': 'Original drill command retired. Read-only inspection copied: run it in Resolve’s Lua Console, copy all output, then read the recovery capture here.',
    'recovery-ready': state?.recovery?.classification === 'source'
      ? 'The captured state matches the original. Verify it by saving and reopening Resolve; no rename is needed.'
      : 'The captured state matches the interrupted rename. Restore the original clip name, then save, reopen, and verify the captured fields.',
    'recovery-command': state?.resultTransport === 'retained-file'
      ? 'Recovery command copied. Run it in Resolve. After the project reopens, return to Frameline and choose Read recovery result to verify the private retained output.'
      : 'Recovery command copied. Run it in Resolve, copy all Console output, then read the recovery result here.',
    'recovery-required': 'The original state could not be verified. Keep the retained backup and inspect the disposable project manually. Choose Inspect again for a fresh capture after inspection.',
    verified: `${modeLabel}: ${{ applied: 'reviewed rename observed after save/reopen', 'rolled-back': 'original observed state verified after rollback',
      restored: 'original observed state restored and verified', 'source-verified': 'original observed state verified', 'recovery-required': 'manual recovery required' }[state?.outcome?.status] || 'recorded outcome available'}. Save an observation revision to retain the history link.`,
    saved: `${modeLabel} outcome revision saved on ${state?.branch || 'the selected branch'}: ${state?.revisionId || ''}.` };
  const coverage = state?.effectGuard?.coverage;
  const observedCount = (value, singular) => `${value} ${value === 1 ? singular : `${singular}s`}`;
  const coverageText = coverage?.schemaVersion === 2
    ? `Bound source: ${observedCount(coverage.propertyKeyCount, 'returned property key')} across ${observedCount(coverage.itemCount, 'item')} and ${observedCount(coverage.trackCount, 'track')}. Unavailable reads: ${coverage.unavailablePropertyReads} for clip properties, ${coverage.unavailableTrackStateReads} for track state.`
    : state?.effectGuard ? 'Legacy capture: effect metadata only. Inspector properties and track states were not captured.' : '';
  document.getElementById('resolve-trial-status').textContent = blocked ? 'Verifying drill records…' : state?.error
    || [messages[phase] || messages.idle, state?.backup ? `Retained backup: ${state.backup.size.toLocaleString()} bytes · SHA-256 ${state.backup.sha256.slice(0, 12)}` : '',
      state?.effectGuard ? `State capture bound: SHA-256 ${state.effectGuard.sourceSha256.slice(0, 12)}` : '', coverageText,
      state?.outcome ? state.outcome.effectObservation
        ? coverage?.schemaVersion === 2
          ? 'Validation compares returned clip properties, observed track states and effect metadata. Missing properties, effect parameters and complete native semantics remain unverified.'
          : 'Validation includes effect type, name, index, and enabled state. Effect parameters and full editor properties remain unverified.'
        : 'This older drill checked snapshot fields only. Effect metadata and full editor properties were not verified.' : ''].filter(Boolean).join('\n');
}
async function resolveTrialAction(method, ...args) {
  if (resolveTrialBusy) return;
  const previousPhase = resolveTrialState?.phase;
  resolveTrialBusy = true; renderResolveTrial();
  try {
    resolveTrialState = await window.desktop[method](...args);
    if (method === 'saveResolveTrialRevision' && !resolveTrialState.error) await refreshResolveHistory();
  } catch { resolveTrialState = { ...resolveTrialState, error: 'Could not complete the drill action. Keep the backup and retry.' }; }
  finally {
    resolveTrialBusy = false; renderResolveState(resolveState);
    if (method === 'cancelDiscoveredResolveTrial' && !resolveTrialState?.error) document.getElementById('resolve-retained-refresh').focus();
    if (!resolveTrialState?.error && resolveTrialState?.phase !== previousPhase) {
      const next = { 'effect-command': 'read', 'backup-command': 'issue', 'rollback-command': 'read', 'edit-command': 'read',
        'recovery-capture': 'read', 'recovery-ready': 'issue', 'recovery-command': 'read', 'recovery-required': 'inspect', verified: 'save' }[resolveTrialState?.phase];
      if (next && !document.getElementById(`resolve-trial-${next}`).disabled) document.getElementById(`resolve-trial-${next}`).focus();
    }
  }
}
document.getElementById('resolve-trial-form').addEventListener('submit', event => {
  event.preventDefault(); resolveTrialAction('prepareResolveTrial', document.getElementById('resolve-trial-name').value.trim(), document.getElementById('resolve-trial-ack').checked, document.getElementById('resolve-trial-mode').value);
});
function changeResolveTrialMode() {
  if (resolveTrialBusy || resolveTrialState?.busy || resolveTrialState?.phase && !['idle', 'saved'].includes(resolveTrialState.phase)) { renderResolveTrial(); return; }
  const value = document.getElementById('resolve-trial-mode').value === 'rename-verify' ? 'rename-verify' : 'forced-rollback';
  if (value !== resolveTrialModeDraft) { resolveTrialModeDraft = value; document.getElementById('resolve-trial-ack').checked = false; }
  renderResolveTrial();
}
document.getElementById('resolve-trial-mode').addEventListener('change', changeResolveTrialMode);
document.getElementById('resolve-trial-ack').addEventListener('change', renderResolveTrial);
document.getElementById('resolve-retained-refresh').addEventListener('click', () => resolveTrialAction('discoverResolveTrials', false));
document.getElementById('resolve-retained-more').addEventListener('click', () => resolveTrialAction('discoverResolveTrials', true));
document.getElementById('resolve-recovery-review').addEventListener('click', () => {
  showView('resolve');
  const target = document.getElementById(activeResolveTrial() ? 'resolve-trial-title' : 'resolve-retained-title');
  target.scrollIntoView({ block: 'start' });
  if (target.id === 'resolve-retained-title') target.focus();
});
for (const [id, method] of [['issue', 'issueResolveTrial'], ['copy', 'copyResolveTrialCommand'], ['cancel', 'cancelResolveTrialPreparation'], ['read', 'readResolveTrial'],
  ['save', 'saveResolveTrialRevision'], ['reveal', 'revealResolveTrialBackup'], ['recover', 'recoverResolveTrial'], ['inspect', 'inspectResolveTrialRecovery']]) {
  document.getElementById(`resolve-trial-${id}`).addEventListener('click', () => resolveTrialAction(method));
}
window.desktop?.getResolveTrialState?.().then(state => { resolveTrialState = state; renderResolveState(resolveState); }).catch(() => {});

async function reviewCopyAction(method) {
  if (reviewCopyBusy || mediaAuditBusy || mediaAuditJobState?.busy || document.getElementById('review-copy-panel').hidden) return;
  reviewCopyBusy = true;
  const result = document.getElementById('review-copy-result');
  const sourceKey = reviewCopySource;
  const saving = method === 'prepareReviewCopy';
  const revealing = method === 'revealReviewCopy';
  result.textContent = revealing ? 'Revalidating the copy before revealing it…' : saving ? 'Checking source bytes and the saved copy…' : 'Choose an existing copy to verify against the selected export.';
  renderAppState(currentAppState);
  try {
    if (!window.desktop?.[method]) throw new Error('desktop-unavailable');
    const response = await window.desktop[method]();
    if (sourceKey !== reviewCopySource) return;
    if (response?.status === 'cancelled' || response?.status === 'canceled') {
      result.textContent = `${saving ? 'Save' : 'Verification'} cancelled. ${verifiedReviewCopy ? 'The previous copy still requires revalidation before reveal.' : 'No copy is verified.'}`;
    } else if (response?.error || response?.status === 'error') {
      verifiedReviewCopy = null;
      delete mediaAuditReports.copy;
      result.textContent = response?.error?.message || 'Copy verification failed. Rescan the selected export and verify the copy again.';
      renderCopyMediaAudit();
    } else if (response?.status === 'ready' && response.copyName && (revealing || response.sourceHash)) {
      verifiedReviewCopy = { copyName: response.copyName, sourceHash: response.sourceHash };
      if (!revealing) delete mediaAuditReports.copy;
      result.textContent = `${response.copyName} · ${revealing ? 'revalidated and revealed' : saving ? 'saved and verified unchanged' : 'verified unchanged'}. Reveal revalidates the copy each time. Editor import and apply readiness are not established.`;
      renderCopyMediaAudit();
    } else {
      verifiedReviewCopy = null;
      result.textContent = 'The review copy could not be verified. Rescan the selected export and try again.';
    }
  } catch {
    if (sourceKey === reviewCopySource) {
      verifiedReviewCopy = null;
      result.textContent = 'Could not complete the copy check. Use the desktop app, rescan the selected export, and try again.';
    }
  } finally {
    reviewCopyBusy = false;
    renderAppState(currentAppState);
    refreshMediaAuditJobs();
  }
}

function renderCopyMediaAudit() {
  const result = document.getElementById('copy-media-result');
  const entries = document.getElementById('copy-media-entries');
  const details = document.getElementById('copy-media-details');
  const dependencyKey = JSON.stringify([Object.entries(mediaAuditReports).map(([target, r]) => [target,r.checkId,r.checkedAt,r.sourceHash]),mediaAuditDependencyPages['copy-source'] || 0,mediaAuditDependencyPages['copy-copy'] || 0]);
  const rebuild = dependencyKey !== copyMediaAuditRenderKey;
  if (rebuild) { entries.replaceChildren(); copyMediaAuditRenderKey = dependencyKey; }
  const summaries = [];
  for (const [target, label] of [['source', 'Selected export'], ['copy', 'Verified copy']]) {
    const report = mediaAuditReports[target];
    if (!report) continue;
    if (report.status !== 'ready') {
      summaries.push(`${label}: ${report.error?.message || 'Audit unavailable. Rescan and try again.'}`);
      continue;
    }
    const counts = report.counts || {};
    const gate = report.requirements?.decision === 'blocked' ? 'Required media is blocked.'
      : report.requirements?.decision === 'confirmation-required' ? 'Available media still lacks expected identity evidence.'
        : 'Required media matches prior audit fingerprints.';
    summaries.push(`${label}${report.checkedAt ? ` · last checked ${mediaAuditDate(report.checkedAt)}` : ''}: ${counts.total || 0} dependencies · ${counts.local || 0} local · ${counts.missing || 0} missing · ${counts['offline-volume'] || 0} offline · ${counts['proxy-only'] || 0} proxy only · ${counts.excluded || 0} excluded · ${counts.external || 0} external · ${counts.unknown || 0} unknown · ${counts.fingerprinted || 0} fingerprinted. ${gate}`);
    if (rebuild) {
      const group = make('section', 'copy-media-group');
      group.append(make('h4', '', label));
      appendMediaDependencies(group, target, report, 'copy');
      entries.append(group);
    }
  }
  const running = mediaAuditJobState?.busy ? 'A media check is running. View checks for progress or cancellation.\n' : '';
  const summary = summaries.length ? `${summaries.join('\n')}\nFingerprinted means the bytes were read; original media identity is not verified. Audit results describe the last check.` : 'Run an audit to check local availability and fingerprint coverage.';
  if (result.textContent !== running + summary) result.textContent = running + summary;
  const searchResult = document.getElementById('copy-media-search-result');
  const search = mediaSearchReports.source;
  searchResult.textContent = !search ? '' : search.status !== 'ready' ? search.error?.message || 'The folder search failed.'
    : search.canceled ? 'Folder search canceled.'
      : `${search.items?.length || 0} unresolved dependencies searched · ${search.resolvedCount || 0} verified · ${search.ambiguousCount || 0} ambiguous · ${(search.items || []).filter(item => item.resolution === 'unverified').length} filename-only matches. The project export was not changed.`;
  details.hidden = !entries.childElementCount;
}

async function auditCopyMedia() {
  if (mediaAuditBusy || reviewCopyBusy || mediaAuditJobState?.busy || !canAuditSelectedMedia()) return;
  const sourceKey = reviewCopySource;
  const targets = verifiedReviewCopy ? ['source', 'copy'] : ['source'];
  mediaAuditBusy = true; mediaAuditActionNotice = '';
  renderMediaAuditControls(); renderMediaAuditJobs();
  try {
    for (const target of targets) {
      if (sourceKey !== reviewCopySource) return;
      const state = await window.desktop.auditProjectMedia(target);
      applyMediaAuditState(state);
      if (state?.error) break;
      delete mediaSearchReports[target];
    }
  } catch { mediaAuditActionNotice = 'Could not queue the media check. Use the desktop app and try again.'; }
  finally { mediaAuditBusy = false; renderMediaAuditControls(); renderMediaAuditJobs(); renderCopyMediaAudit(); }
}

async function findProjectMedia() {
  if (mediaAuditBusy || reviewCopyBusy || mediaAuditJobState?.busy || !mediaAuditReports.source) return;
  mediaAuditBusy = true;
  renderAppState(currentAppState);
  document.getElementById('copy-media-search-result').textContent = 'Searching the selected folder without following symlinks…';
  try { mediaSearchReports.source = await window.desktop.findProjectMedia('source'); }
  catch { mediaSearchReports.source = { status: 'error', error: { message: 'The folder search could not finish.' } }; }
  finally { mediaAuditBusy = false; renderCopyMediaAudit(); renderAppState(currentAppState); }
}

function canAuditSelectedMedia() {
  const state = currentAppState;
  return !state?.error && state?.scanStatus === 'ready' && !!state.scan?.sourceHash
    && state.selectedProject?.format === 'FCPXML' && /\.fcpxml$/i.test(state.selectedProject?.name || '');
}
function renderMediaAuditControls() {
  const canAudit = canAuditSelectedMedia();
  const blocked = reviewCopyBusy || mediaAuditBusy || mediaAuditJobState?.busy;
  document.getElementById('prepare-review-copy').disabled = blocked || !canAudit;
  document.getElementById('verify-review-copy').disabled = blocked || !canAudit;
  document.getElementById('reveal-review-copy').disabled = blocked || !canAudit || !verifiedReviewCopy;
  document.getElementById('audit-project-media').disabled = blocked || !canAudit;
  document.getElementById('find-project-media').disabled = blocked || !canAudit || !mediaAuditReports.source;
  document.getElementById('media-audit-start').disabled = blocked || !canAudit || !window.desktop?.auditProjectMedia;
  document.getElementById('copy-media-view-jobs').hidden = !mediaAuditJobState?.jobs?.length;
}
function mediaAuditDate(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : 'time unavailable';
}
function mediaAuditBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'size unavailable';
  if (value < 1024) return `${value} B`;
  for (const [size, suffix] of [[1024 ** 3, 'GiB'], [1024 ** 2, 'MiB'], [1024, 'KiB']]) {
    if (value >= size) return `${(value / size).toFixed(1)} ${suffix}`;
  }
}
function mediaAuditError(code) {
  const messages = {
    'media-audit-source-required': 'Reselect and scan the matching export before restarting this check. For a review-copy check, verify the copy again.',
    'media-job-retry-unavailable': 'This check reached its retry limit. Start a new check for the selected export.',
    'media-audit-unavailable': 'Choose and scan a regular FCPXML export before starting its media check.',
    'media-audit-job-unavailable': 'This check is no longer available. Refresh the project and try again.',
    'stale-export': 'The export changed during the check. Rescan it and start a new audit.',
    'media-audit-copy-unverified': 'Verify the review copy against the selected export, then retry this check.',
    'media-job-progress-failed': 'Progress could not be saved. Check local storage and retry the audit.'
  };
  return messages[code] || 'The local media check could not finish. Keep the local job records and retry in the desktop app.';
}
function applyMediaAuditState(state) {
  if (!state || typeof state !== 'object') return;
  if (Number.isSafeInteger(state.version)) {
    if (state.version < mediaAuditStateVersion) return;
    mediaAuditStateVersion = state.version;
  }
  if (state.error) mediaAuditActionNotice = mediaAuditError(state.error);
  if (Array.isArray(state.jobs)) mediaAuditJobState = state;
  const selection = currentAppState?.selectedProject;
  if (selection?.id && state.selection?.projectId === selection.id && state.selection.sourceHash === currentAppState.scan?.sourceHash) {
    for (const target of ['source', 'copy']) {
      const report = state.reports?.[target];
      if (report?.status === 'ready' && report.sourceHash === currentAppState.scan.sourceHash
        && (target !== 'copy' || verifiedReviewCopy)) mediaAuditReports[target] = report;
    }
  }
  renderMediaAuditControls(); renderCopyMediaAudit(); renderMediaAuditJobs();
}
async function refreshMediaAuditJobs() {
  if (!window.desktop?.getMediaAuditState) { renderMediaAuditControls(); renderMediaAuditJobs(); return; }
  try { applyMediaAuditState(await window.desktop.getMediaAuditState()); }
  catch { mediaAuditActionNotice = 'Could not read local media checks. Retry in the desktop app.'; renderMediaAuditJobs(); }
}
function currentMediaJobBound(job) {
  return job.bound && job.projectId === currentAppState?.selectedProject?.id
    && job.sourceHash === currentAppState?.scan?.sourceHash && (job.target !== 'copy' || !!verifiedReviewCopy);
}
function mediaAuditJobDescription(job) {
  if (job.status === 'running') {
    const p = job.detail;
    if (p?.phase === 'hashing') return `Reading file ${Math.min(p.checked + 1, p.total)} of ${p.total} · ${mediaAuditBytes(p.bytesRead)} of ${mediaAuditBytes(p.totalBytes)}`;
    return p ? `Checking dependencies · ${p.checked} of ${p.total} checked` : 'Preparing the local media check…';
  }
  if (job.status === 'queued') return job.scheduled ? 'Queued for this session.'
    : currentMediaJobBound(job) ? 'Ready to restart. Media files will be read again from the beginning.'
      : `Reselect and scan this export to restart.${job.target === 'copy' ? ' Verify its review copy again.' : ''}`;
  if (job.status === 'cancelled') return 'Cancelled. Start a new check when ready.';
  if (job.status === 'failed') return mediaAuditError(job.error);
  return job.reportUnavailable ? 'The saved result could not be verified. Start a new check.' : `Last checked ${mediaAuditDate(job.completedAt)}.`;
}
function setMediaAuditText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function mediaAuditJobRow(job) {
  let view = mediaAuditJobRows.get(job.id);
  if (view) return view;
  const row = make('article', 'media-audit-job');
  const description = make('div', 'media-audit-job-description');
  const title = make('h3', ''), source = make('p', 'media-audit-job-source');
  description.append(title, source);
  const status = make('span', 'media-audit-job-status');
  const detail = make('p', 'media-audit-job-detail');
  row.append(description, status, detail);
  view = { row, title, source, status, detail, actions: make('div', 'media-audit-actions'), buttons: new Map(), progressRow: null };
  mediaAuditJobRows.set(job.id, view);
  return view;
}
function updateMediaAuditJobRow(view, job) {
  const label = job.label || 'Timeline export';
  const role = job.target === 'copy' ? 'Review copy' : 'Selected export';
  const rowLabel = `${label} · ${role} media check`;
  if (view.row.getAttribute('aria-label') !== rowLabel) view.row.setAttribute('aria-label', rowLabel);
  setMediaAuditText(view.title, label);
  setMediaAuditText(view.source, `${role} · source ${job.sourceHash.slice(0, 12)}`);
  const statusClass = `media-audit-job-status ${job.status}`;
  if (view.status.className !== statusClass) view.status.className = statusClass;
  setMediaAuditText(view.status, ({queued:'Queued',running:'Running',failed:'Failed',completed:'Completed',cancelled:'Cancelled'})[job.status] || 'Unknown');
  setMediaAuditText(view.detail, mediaAuditJobDescription(job));
  if (job.status === 'running') {
    if (!view.progressRow) {
      view.progress = make('progress', 'media-audit-progress'); view.progress.max = 100;
      view.percent = make('span', '');
      view.progressRow = make('div', 'media-audit-progress-row'); view.progressRow.append(view.progress, view.percent);
      view.row.insertBefore(view.progressRow, view.actions.parentNode === view.row ? view.actions : null);
    }
    const value = Math.max(0, Math.min(100, job.progress));
    if (view.progress.value !== value) view.progress.value = value;
    const progressLabel = `Media check progress for ${label}`;
    if (view.progress.getAttribute('aria-label') !== progressLabel) view.progress.setAttribute('aria-label', progressLabel);
    const progressText = `${value}% · ${view.detail.textContent}`;
    if (view.progress.getAttribute('aria-valuetext') !== progressText) view.progress.setAttribute('aria-valuetext', progressText);
    setMediaAuditText(view.percent, `${value}%`);
  } else if (view.progressRow) {
    view.progressRow.remove(); view.progressRow = view.progress = view.percent = null;
  }
  const bound = currentMediaJobBound(job);
  const actions = [[job.canCancel,'cancelMediaAudit','Cancel'],[job.canResume && bound,'resumeMediaAudit','Restart check'],[job.canRetry && bound,'retryMediaAudit','Retry'],[job.canRestart && bound,'restartMediaAudit','Start new check']].filter(([allowed]) => allowed);
  const allowedMethods = new Set(actions.map(([, method]) => method));
  for (const [method, button] of view.buttons) if (!allowedMethods.has(method)) { button.remove(); view.buttons.delete(method); }
  actions.forEach(([, method, text], index) => {
    let button = view.buttons.get(method);
    if (!button) {
      button = make('button', ''); button.type = 'button'; button.dataset.jobId = job.id; button.dataset.mediaJobAction = method;
      button.addEventListener('click', () => mediaAuditJobAction(method, job.id)); view.buttons.set(method, button);
    }
    setMediaAuditText(button, mediaAuditActions.has(job.id) ? 'Working…' : text);
    const disabled = mediaAuditActions.has(job.id);
    if (button.disabled !== disabled) button.disabled = disabled;
    if (view.actions.children[index] !== button) view.actions.insertBefore(button, view.actions.children[index] || null);
  });
  if (view.actions.childElementCount) {
    if (view.actions.parentNode !== view.row) view.row.append(view.actions);
  } else if (view.actions.parentNode === view.row) view.actions.remove();
}
function renderMediaAuditJobs() {
  const section = document.getElementById('media-audit-jobs');
  const jobs = mediaAuditJobState?.jobs || [];
  section.hidden = !canAuditSelectedMedia() && !jobs.length && !mediaAuditActionNotice;
  if (section.hidden) return;
  const counts = jobs.reduce((value, job) => { value[job.status] = (value[job.status] || 0) + 1; return value; }, {});
  setMediaAuditText(document.getElementById('media-audit-summary'), jobs.length
    ? `${counts.running || 0} running · ${counts.queued || 0} queued · ${counts.failed || 0} failed · ${counts.completed || 0} completed · ${counts.cancelled || 0} cancelled`
    : 'No local checks queued. Start an audit to read the selected export’s media.');
  const notice = document.getElementById('media-audit-notice'); notice.hidden = !mediaAuditActionNotice; setMediaAuditText(notice, mediaAuditActionNotice);
  const list = document.getElementById('media-audit-job-list');
  const focused = document.activeElement?.closest?.('[data-media-job-action]');
  const focusKey = focused && list.contains(focused) ? { id: focused.dataset.jobId, action: focused.dataset.mediaJobAction } : null;
  const visible = jobs.slice(0, mediaAuditVisibleJobs), visibleIds = new Set(visible.map(job => job.id));
  // Progress updates preserve native accessibility elements and focused controls.
  // Only membership/order changes move rows; existing action nodes stay keyed.
  for (const [id, view] of mediaAuditJobRows) if (!visibleIds.has(id)) { view.row.remove(); mediaAuditJobRows.delete(id); }
  visible.forEach((job, index) => {
    const view = mediaAuditJobRow(job); updateMediaAuditJobRow(view, job);
    if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
  });
  const shown = Math.min(jobs.length, mediaAuditVisibleJobs);
  setMediaAuditText(document.getElementById('media-audit-job-range'), jobs.length ? `Showing ${shown} of ${mediaAuditJobState?.total ?? jobs.length} checks` : '');
  document.getElementById('media-audit-more').hidden = shown >= jobs.length;
  if (focusKey) {
    const buttons = [...list.querySelectorAll('[data-media-job-action]')];
    const replacement = buttons.find(b => b.dataset.jobId === focusKey.id && b.dataset.mediaJobAction === focusKey.action && !b.disabled)
      || buttons.find(b => b.dataset.jobId === focusKey.id && !b.disabled);
    const next = replacement || document.getElementById('media-audit-jobs-title');
    if (document.activeElement !== next) next.focus({ preventScroll: true });
  }
  renderMediaAuditReports();
}
async function mediaAuditJobAction(method, id) {
  if (mediaAuditActions.has(id)) return;
  mediaAuditActions.add(id); mediaAuditActionNotice = ''; renderMediaAuditJobs();
  try {
    if (!window.desktop?.[method]) throw Error('desktop-unavailable');
    applyMediaAuditState(await window.desktop[method](id));
  } catch { mediaAuditActionNotice = 'Could not update this check. Retry in the desktop app.'; }
  finally { mediaAuditActions.delete(id); renderMediaAuditControls(); renderMediaAuditJobs(); }
}
function appendMediaDependencies(container, target, report, surface) {
  const key = `${surface}-${target}`, assets = report.assets || [], pageSize = 50;
  const page = Math.min(mediaAuditDependencyPages[key] || 0, Math.max(0, Math.ceil(assets.length / pageSize) - 1));
  mediaAuditDependencyPages[key] = page;
  const details = make('details', 'media-audit-dependencies');
  details.open = mediaAuditDependencyOpen.has(key);
  details.append(make('summary', '', `${assets.length} ${assets.length === 1 ? 'dependency' : 'dependencies'}`));
  details.addEventListener('toggle', () => { if (details.open) mediaAuditDependencyOpen.add(key); else mediaAuditDependencyOpen.delete(key); });
  const start = page * pageSize;
  const range = make('p', 'media-audit-dependency-range', assets.length ? `Dependencies ${start + 1}–${Math.min(start + pageSize, assets.length)} of ${assets.length}` : 'No referenced media dependencies.');
  range.id = `media-dependency-${key}-range`; range.tabIndex = -1; details.append(range);
  for (const asset of assets.slice(start, start + pageSize)) {
    const row = make('div', 'copy-media-entry');
    const names = Array.isArray(asset.displayNames) ? asset.displayNames.join(', ') : 'Unnamed dependency';
    row.append(make('strong', '', names || 'Unnamed dependency'), make('span', '', `${asset.status || 'unknown'}${asset.reason ? ` · ${asset.reason}` : ''}`), make('span', '', asset.identityVerified ? 'Identity matched prior audit' : asset.expectedIdentityAvailable ? 'Prior identity available' : asset.fingerprintAvailable ? 'Fingerprint observed' : 'No fingerprint'));
    details.append(row);
  }
  if (assets.length > pageSize) {
    const controls = make('div', 'media-audit-dependency-paging');
    for (const [label, change, disabled] of [['Previous dependencies',-1,page === 0],['Next dependencies',1,start + pageSize >= assets.length]]) {
      const button = make('button', '', label); button.type = 'button'; button.disabled = disabled;
      button.addEventListener('click', () => {
        mediaAuditDependencyPages[key] = page + change; mediaAuditDependencyOpen.add(key); mediaAuditReportRenderKey = '';
        if (surface === 'copy') renderCopyMediaAudit(); else renderMediaAuditReports();
        document.getElementById(`media-dependency-${key}-range`)?.focus();
      }); controls.append(button);
    }
    details.append(controls);
  }
  container.append(details);
}
function renderMediaAuditReports() {
  const key = JSON.stringify(Object.entries(mediaAuditReports).map(([target, r]) => [target,r.checkId,r.checkedAt,r.sourceHash]));
  if (key === mediaAuditReportRenderKey) return;
  mediaAuditReportRenderKey = key;
  const section = document.getElementById('media-audit-reports'); section.replaceChildren();
  for (const [target, label] of [['source','Selected export'],['copy','Verified copy']]) {
    const report = mediaAuditReports[target]; if (!report || report.status !== 'ready') continue;
    const group = make('section', 'media-audit-report'); group.append(make('h3', '', `${label} · last completed check`));
    const counts = report.counts || {};
    group.append(make('p', '', `${counts.total || 0} dependencies · ${counts.local || 0} local · ${counts.missing || 0} missing · ${counts.fingerprinted || 0} fingerprinted${report.checkedAt ? ` · ${mediaAuditDate(report.checkedAt)}` : ''}`));
    group.append(make('p', '', 'Results describe the last check. A fingerprint records the bytes read; it does not establish original media identity.'));
    appendMediaDependencies(group, target, report, 'media'); section.append(group);
  }
}
document.getElementById('copy-media-view-jobs').addEventListener('click', () => { showView('media'); document.getElementById('media-audit-jobs-title').focus(); });
document.getElementById('media-audit-start').addEventListener('click', auditCopyMedia);
document.getElementById('media-audit-more').addEventListener('click', () => { mediaAuditVisibleJobs += 20; renderMediaAuditJobs(); });
window.desktop?.onMediaAuditState?.(applyMediaAuditState);
refreshMediaAuditJobs();

document.getElementById('prepare-review-copy').addEventListener('click', () => reviewCopyAction('prepareReviewCopy'));
document.getElementById('verify-review-copy').addEventListener('click', () => reviewCopyAction('verifyReviewCopy'));
document.getElementById('reveal-review-copy').addEventListener('click', () => reviewCopyAction('revealReviewCopy'));
document.getElementById('audit-project-media').addEventListener('click', auditCopyMedia);
document.getElementById('find-project-media').addEventListener('click', findProjectMedia);

function renderResolveExport(state, ready) {
  const report = state?.exportComparison;
  const panel = document.getElementById('resolve-export-report');
  panel.replaceChildren();
  document.getElementById('resolve-export-choose').disabled = resolveBusy || !ready;
  document.getElementById('resolve-export-refresh').disabled = resolveBusy || !ready || !report;
  document.getElementById('resolve-export-notice').textContent = state?.exportError?.message || ((state?.exportError?.code || state?.exportError) === 'select-timeline' ? 'Choose a timeline in the Timeline filter, then choose its FCPXML export.' : state?.exportError ? 'The export comparison failed. Choose a supported FCPXML export or refresh to retry.' : report ? 'Read-only candidate comparison. No mapping is approved and no edits can be applied.' : ready ? 'Choose an FCPXML file or bundle exported from the local timeline.' : 'Choose the three sources first.');
  if (!report) return;
  const facts = make('dl', 'export-facts');
  const groups = Array.isArray(report.unresolved) ? report.unresolved : [];
  const matches = Array.isArray(report.matches) ? report.matches : [];
  const unmatchedSnapshot = groups.filter(group => !group.xmlSpineIndices?.length).reduce((total, group) => total + (group.apiItemIds?.length || 0), 0);
  const unmatchedExport = groups.filter(group => !group.apiItemIds?.length).reduce((total, group) => total + (group.xmlSpineIndices?.length || 0), 0);
  const collisions = groups.filter(group => group.apiItemIds?.length && group.xmlSpineIndices?.length);
  for (const [label, value] of [['Candidate matches', matches.length], ['Unmatched snapshot items', unmatchedSnapshot], ['Unmatched export clips', unmatchedExport], ['Collision groups', collisions.length]]) {
    facts.append(make('dt', '', label), make('dd', '', String(value)));
  }
  if (report.exportSha256) panel.append(make('p', '', `Export fingerprint ${report.exportSha256.slice(0, 12)} · local snapshot ${report.snapshotSha256?.slice(0, 12) || 'unavailable'}`));
  panel.append(facts);
  const candidates = report.candidates || report.matches || report.candidateMatches;
  if (Array.isArray(candidates) && candidates.length) {
    const details = make('details');
    details.append(make('summary', '', `Inspect ${candidates.length} candidate matches`));
    for (const candidate of candidates.slice(0, 100)) {
      const row = make('div', 'resolve-inspection-row');
      row.append(make('strong', '', candidate.name || candidate.clipName || candidate.itemId || candidate.snapshotItemId || candidate.apiItemId || 'Clip candidate'), make('span', '', candidate.reason || candidate.status || `Spine position ${candidate.xmlSpineIndex ?? '?'} · candidate only; identity unverified`));
      details.append(row);
    }
    if (candidates.length > 100) details.append(make('p', '', 'Showing the first 100 candidates. Counts cover the full comparison.'));
    panel.append(details);
  }
  if (groups.length) {
    const details = make('details');
    details.append(make('summary', '', `Inspect ${groups.length} unmatched or collision groups`));
    for (const group of groups.slice(0, 100)) {
      const row = make('div', 'resolve-inspection-row');
      row.append(make('strong', '', `Frames ${(group.frames || []).join(' / ')}`), make('span', '', `${group.apiItemIds?.length || 0} snapshot items · ${group.xmlSpineIndices?.length || 0} export clips`));
      details.append(row);
    }
    if (groups.length > 100) details.append(make('p', '', 'Showing the first 100 groups. Counts cover the full comparison.'));
    panel.append(details);
  }
  for (const warning of report.warnings || []) panel.append(make('p', '', typeof warning === 'string' ? warning : warning.message || warning.code || 'Comparison warning'));
}
