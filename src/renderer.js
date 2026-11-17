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
let syncBusy = false;
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
    renderCopyMediaAudit();
  }
  reviewCopySource = copySource;
  const canCopy = !state?.error && state?.scanStatus === 'ready' && !!scan && state?.selectedProject?.format === 'FCPXML' && /\.fcpxml$/i.test(projectName || '');
  document.getElementById('review-copy-panel').hidden = !canCopy;
  document.getElementById('prepare-review-copy').disabled = reviewCopyBusy || mediaAuditBusy || !canCopy;
  document.getElementById('verify-review-copy').disabled = reviewCopyBusy || mediaAuditBusy || !canCopy;
  document.getElementById('reveal-review-copy').disabled = reviewCopyBusy || mediaAuditBusy || !canCopy || !verifiedReviewCopy;
  document.getElementById('audit-project-media').disabled = reviewCopyBusy || mediaAuditBusy || !canCopy;
  document.getElementById('find-project-media').disabled = reviewCopyBusy || mediaAuditBusy || !canCopy || !mediaAuditReports.source;
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
    document.querySelector('#view-media .section-head span').textContent = 'Read-only scan';
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
  const service = document.getElementById('sync-service-state');
  list.replaceChildren();
  service.textContent = state?.connected ? 'Connected' : 'Local only';
  const operations = state?.operations || [];
  if (!operations.length) {
    summary.textContent = state?.connected ? 'No sync work is queued' : 'No hosted service is configured';
    list.append(make('p', 'sync-empty', state?.connected
      ? 'Local and remote history have no pending operations.'
      : 'The durable queue is ready, but this build cannot push until a service connection is configured.'));
    return;
  }
  summary.textContent = `${operations.length} queued operation${operations.length === 1 ? '' : 's'}`;
  operations.forEach(operation => {
    const row = make('article', 'sync-operation');
    const details = make('div', 'sync-operation-main');
    const title = make('div', 'sync-operation-title');
    title.append(make('strong', '', `Push ${operation.branch}`), make('span', `sync-state ${operation.status}`, operation.status.replace('-', ' ')));
    const completed = operation.progress?.completed || 0; const total = operation.progress?.total || 0;
    details.append(title, make('p', '', operation.lastError ? syncErrorLabel(operation.lastError)
      : `${completed} of ${total} revision${total === 1 ? '' : 's'} uploaded`));
    const progress = make('progress', 'sync-progress'); progress.max = Math.max(total, 1); progress.value = completed;
    progress.setAttribute('aria-label', `${completed} of ${total} revisions uploaded`); details.append(progress);
    const actions = make('div', 'sync-actions');
    if (operation.actions.includes('retry')) {
      const retry = make('button', '', 'Retry'); retry.type = 'button'; retry.disabled = syncBusy || !operation.recoverable;
      retry.addEventListener('click', () => runSyncAction('retry', operation.id)); actions.append(retry);
    }
    const cancel = make('button', '', 'Cancel'); cancel.type = 'button'; cancel.disabled = syncBusy;
    cancel.addEventListener('click', () => runSyncAction('cancel', operation.id)); actions.append(cancel);
    row.append(details, actions); list.append(row);
  });
}

async function runSyncAction(action, id) {
  if (syncBusy) return; syncBusy = true;
  try {
    const state = await (action === 'retry' ? window.desktop.retrySync(id) : window.desktop.cancelSync(id));
    renderSyncState(state);
  } catch { renderSyncState({ connected: false, operations: [] }); }
  finally { syncBusy = false; }
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
    notice.textContent = 'Invitations are recorded locally. This build does not send email.';
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
    : 'Invitations are recorded locally. This build does not send email.';
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
  if (historyWindow?.start === start && historyWindow.end === end) return;
  historyWindow = { start, end };
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
    const syncLabels = { synced: 'Synced', 'local-ahead': 'Local ahead', 'local-only': 'Local only' };
    const saved = make('time', '', new Date(revision.createdAt).toLocaleString());
    saved.dateTime = revision.createdAt;
    state.append(make('strong', `revision-sync-state ${revision.syncState}`, syncLabels[revision.syncState] || 'Local only'), saved);
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
    ['Sync state', ({ synced: 'Synced', 'local-ahead': 'Local ahead', 'local-only': 'Local only' })[revision.syncState] || 'Local only'],
    ['Sequence', manifest.sequence.name],
    ['Timing', `${manifest.sequence.durationFrames} frames · ${manifest.sequence.frameDuration} per frame`],
    ['Parent', revision.parentRevisionId || 'First revision'],
    ['Source hash', revision.contentHash],
    ['Editor version', revision.editorVersion || 'Unknown']
  ];
  facts.forEach(([key, value]) => details.append(make('dt', '', key), make('dd', '', value)));
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
window.desktop?.getAppState?.().then(renderAppState).catch(() => {});
window.desktop?.getSyncState?.().then(renderSyncState).catch(() => renderSyncState({ connected: false, operations: [] }));
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
const resolveLabels = { 'incoming-only': 'Incoming edit', 'local-only': 'Local edit', 'already-applied': 'Already applied', conflict: 'Conflict' };
function resolveValue(value) {
  if (value === undefined || value === null) return 'Not present';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
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
  const items = resolveChanges();
  const ready = state?.status === 'ready' && !!state.plan;
  document.getElementById('resolve-refresh').disabled = resolveBusy || !ready;
  document.getElementById('resolve-save').disabled = resolveBusy || !ready;
  document.getElementById('resolve-choose').disabled = resolveBusy;
  document.getElementById('resolve-recover').disabled = resolveBusy;
  document.getElementById('resolve-notice').textContent = state?.error?.message || resolveActionNotice || (ready ? `${items.length} classified fields. Save review to preserve choices; applying to Resolve remains unavailable.` : 'Choose base, local, and incoming Resolve snapshot JSON files. No timeline will be modified.');
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
      const option = make('option', '', value === 'all' ? label : value);
      option.value = value; select.append(option);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'all';
  }
  const unresolved = items.filter(item => item.status === 'conflict' && !resolveChoice(resolveConflict(item)));
  document.getElementById('resolve-next').disabled = resolveBusy || !unresolved.length;
  document.getElementById('resolve-save-review').disabled = resolveBusy || !ready;
  document.getElementById('resolve-review-recover').disabled = resolveBusy;
  const sourcePanel = document.getElementById('resolve-source-hashes');
  sourcePanel.replaceChildren();
  for (const [role, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']]) {
    const stale = state?.sourceVerification?.staleRoles?.includes(role);
    const row = make('div', stale ? 'source-stale' : '');
    row.append(make('strong', '', label), make('code', '', state?.sourceHashes?.[role]?.slice(0, 12) || 'No source'), make('span', '', stale ? 'Changed on refresh · choices reset' : state?.sourceHashes?.[role] ? 'Source fingerprint' : 'Choose snapshots'));
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
  if (!visible.length) queue.append(make('p', 'history-empty', ready ? 'No changes match this filter.' : 'No snapshots selected.'));
  visible.forEach(item => {
    const choice = resolveChoice(resolveConflict(item));
    const button = make('button', `queue-item${item === resolveSelected ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item === resolveSelected));
    button.append(make('strong', '', item.itemId || item.timelineId || 'Timeline'), make('small', '', item.field || 'Change'), make('span', 'queue-kind', item.timelineId || ''), make('span', `queue-status${item.status === 'conflict' && !choice ? ' conflict' : ''}`, choice ? 'Decided' : resolveLabels[item.status] || item.status));
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
  detail.append(make('p', 'resolve-context', `Timeline ${item.timelineId || 'unspecified'} · Item ${item.itemId || 'timeline'} · ${resolveLabels[item.status] || item.status}`));
  const values = make('div', 'resolve-values');
  for (const [key, label] of [['base', 'Common base'], ['local', 'Your local cut'], ['incoming', 'Incoming cut']]) {
    const column = make('div', key === 'incoming' ? 'incoming-value' : '');
    column.append(make('h3', '', label), make('pre', '', resolveValue(item[key])));
    values.append(column);
  }
  detail.append(values);
  const conflict = resolveConflict(item);
  if (conflict) {
    detail.append(make('p', 'resolve-context', 'Both cuts changed this field from the common base. Choose the value to record in this review.'));
    const controls = make('div', 'resolve-decisions');
    const selected = resolveChoice(conflict);
    for (const choice of conflict.options || ['keep-local', 'take-incoming']) {
      const button = make('button', selected === choice ? 'selected' : '', choice === 'keep-local' ? 'Keep local' : 'Take incoming');
      button.type = 'button'; button.disabled = resolveBusy;
      button.setAttribute('aria-pressed', String(selected === choice));
      button.addEventListener('click', () => resolveAction('setResolveDecision', conflict.id, choice));
      controls.append(button);
    }
    detail.append(controls);
  }
}
function renderResolveInspection() {
  const section = document.getElementById('resolve-inspection');
  section.replaceChildren();
  const assessment = resolveState?.plan?.assessment;
  for (const [label, entries] of [['Warning categories', assessment?.warnings || []], ['Media requirements', assessment?.mediaRequirements || []]]) {
    const disclosure = make('details', '');
    disclosure.append(make('summary', '', `${label} (${entries.length})`));
    if (!entries.length) disclosure.append(make('p', '', assessment ? `No ${label.toLowerCase()} reported.` : 'Choose snapshots to inspect requirements.'));
    for (const entry of entries) {
      const row = make('div', 'resolve-inspection-row');
      if (label === 'Warning categories') row.append(make('strong', '', entry.code || 'Warning'), make('span', '', `${entry.count || 0} occurrence(s)`));
      else row.append(make('strong', '', `${entry.timelineId} · ${entry.itemId || 'Timeline'}`), make('span', '', `Media ${entry.mediaPoolId || 'identity unknown'} · availability ${entry.availability || 'unknown'}`), make('span', '', `Identity: ${entry.identity || 'unknown'}${entry.pendingConflictResolution ? ' · conflict choice required' : ''}`));
      disclosure.append(row);
    }
    section.append(disclosure);
  }
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
  resolveBusy = true;
  resolveActionNotice = '';
  renderResolveState(resolveState);
  document.getElementById('resolve-notice').textContent = 'Reading and verifying preview…';
  try {
    if (!window.desktop?.[method]) throw new Error('Resolve preview is available in the desktop app.');
    const state = await window.desktop[method](...args);
    if (state) resolveState = state;
    if (method === 'refreshResolvePreview' && !state?.error) resolveActionNotice = state?.sourceVerification?.changed ? `Changed sources: ${(state.sourceVerification.staleRoles || []).join(', ')}. Previous choices cleared; review the refreshed comparison.` : 'Snapshot bytes verified unchanged. Current review choices retained.';
    if (method === 'saveResolvePreview' && !state?.error) resolveActionNotice = 'Preview saved. Session decisions are not restored by recovery.';
    if (method === 'saveResolveReview' && !state?.error) resolveActionNotice = 'Review saved with current choices. An audit is included only when every conflict is decided. No changes applied.';
    if (method === 'recoverResolveReview' && !state?.error) resolveActionNotice = 'Review recovered and source bytes verified. Saved choices restored; no changes applied.';
    if (method === 'recoverResolvePreview' && !state?.error) resolveActionNotice = 'Saved preview recovered. Review conflict decisions again.';
  } catch (error) {
    resolveState = { ...resolveState, error: { message: error.message || 'Preview failed. Choose the snapshots again to retry.' } };
  } finally { resolveBusy = false; renderResolveState(resolveState); }
}
document.getElementById('resolve-export-choose').addEventListener('click', () => resolveAction('chooseResolveExport', document.getElementById('resolve-timeline').value === 'all' ? undefined : document.getElementById('resolve-timeline').value));
let companionBusy = false;
let verifiedResolveCaptureAvailable = false;
document.getElementById('resolve-companion-menu-install').addEventListener('click', async event => {
  event.target.disabled = true;
  const status = document.getElementById('resolve-companion-menu-status');
  status.textContent = 'Installing the read-only Scripts menu command…';
  try {
    const result = await window.desktop.installResolveMenuCapture();
    if (!result?.ready) throw new Error(result?.error || 'Could not install the menu command.');
    status.textContent = result.installed
      ? 'Installed. Save the disposable project and restart Resolve once; then prepare a capture request and choose Workspace → Scripts → Utility → Frameline Read Only Capture.'
      : 'Already installed. Prepare a capture request and choose Workspace → Scripts → Utility → Frameline Read Only Capture.';
  } catch (error) { status.textContent = error.message || 'Could not install the menu command.'; }
  finally { event.target.disabled = false; }
});
document.getElementById('resolve-companion-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  const read = document.getElementById('resolve-companion-read');
  document.getElementById('resolve-companion-save').disabled = true;
  document.getElementById('resolve-companion-revision').disabled = true;
  verifiedResolveCaptureAvailable = false;
  read.disabled = true;
  status.textContent = 'Preparing a private capture request…';
  try {
    const result = await window.desktop.prepareResolveCapture(document.getElementById('resolve-companion-name').value);
    if (!result?.ready) throw new Error(result?.error || 'Could not prepare a capture.');
    read.disabled = false;
    status.textContent = `Request prepared. Paste the command into Resolve’s Python Console or run the installed Scripts menu command, then return within ${result.expiresMinutes} minutes and select Read capture.`;
  } catch (error) { status.textContent = error.message || 'Could not prepare a capture.'; }
  finally { companionBusy = false; refreshResolveHistory(); }
});
document.getElementById('resolve-companion-read').addEventListener('click', async () => {
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  document.getElementById('resolve-companion-save').disabled = true;
  document.getElementById('resolve-companion-revision').disabled = true;
  status.textContent = 'Verifying the capture…';
  try {
    const result = await window.desktop.readResolveCapture();
    if (!result?.ready) throw new Error(result?.error || 'No valid capture is ready.');
    verifiedResolveCaptureAvailable = true;
    document.getElementById('resolve-companion-save').disabled = false;
    document.getElementById('resolve-companion-revision').disabled = false;
    status.textContent = `Verified read-only capture: ${result.timelineCount} timeline${result.timelineCount === 1 ? '' : 's'}, ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}. Save it as JSON or use it as the local side of a history preview. SHA-256: ${result.snapshotSha256}.`;
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
    status.textContent = `Read-only observation saved on ${result.branch}: revision ${result.revisionId}${result.changeCount === null ? '' : ` · ${result.changeCount} observed field changes`}. The Resolve project was not changed.`;
    document.getElementById('resolve-companion-message').value = '';
    await refreshResolveHistory();
  } catch (error) { status.textContent = error.message || 'Could not save the observation.'; }
  finally { companionBusy = false; }
});
let resolveHistoryGeneration = 0;
let resolveHistoryOpenToken = 0;
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
      const option = make('option', '', 'No saved Resolve projects'); option.value = ''; select.append(option);
      document.getElementById('resolve-history-list').replaceChildren();
      document.getElementById('resolve-history-detail').replaceChildren();
      document.getElementById('resolve-history-branch').replaceChildren();
      document.getElementById('resolve-history-branch').disabled = true;
      document.getElementById('resolve-history-branch-create').disabled = true;
      clearResolveHistoryPreviewChoices();
      status.textContent = 'No Resolve observation revisions saved yet.';
      return;
    }
    for (const project of result.projects) {
      const option = make('option', '', `${project.displayName || 'Unnamed project'} · ${project.revisionCount} revisions`);
      option.value = project.id; select.append(option);
    }
    select.value = result.projects.some(project => project.id === previous) ? previous : result.projects[0].id;
    await loadResolveHistory(select.value, generation);
  } catch (error) { if (generation === resolveHistoryGeneration) status.textContent = error.message || 'Could not read local Resolve history.'; }
}
async function loadResolveHistory(projectId, generation = ++resolveHistoryGeneration) {
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
async function openResolveHistoryRevision(projectId, revisionId, generation, button, filters = {}) {
  if (generation !== resolveHistoryGeneration) return;
  const openToken = ++resolveHistoryOpenToken;
  const detail = document.getElementById('resolve-history-detail');
  detail.replaceChildren(make('p', '', 'Verifying revision…'));
  try {
    const result = await window.desktop.openResolveRevision(projectId, revisionId, filters);
    if (generation !== resolveHistoryGeneration || openToken !== resolveHistoryOpenToken) return;
    if (!result?.ready) throw new Error(result?.error || 'Could not verify this revision.');
    for (const entry of document.querySelectorAll('#resolve-history-list button')) entry.setAttribute('aria-pressed', String(entry === button));
    detail.replaceChildren();
    detail.append(make('h3', '', result.message), make('p', '', `${result.createdAt} · ${result.changeCount === null ? 'First observation' : `${result.changeCount} observed field changes`} · SHA-256 ${result.sourceHash.slice(0, 12)}`));
    if (result.changeCount === 0) detail.append(make('p', '', 'No observed fields changed.'));
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
        const all = make('option', '', `All ${labelText.toLowerCase()}`); all.value = ''; select.append(all);
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
      row.append(make('strong', '', `${change.tracks.join(' / ') || 'Timeline'} · ${change.itemName || change.itemId || change.kind} · ${change.field || change.kind}`),
        make('span', '', `${resolveValue(change.before)} → ${resolveValue(change.after)}`));
      detail.append(row);
    }
  } catch (error) { if (generation === resolveHistoryGeneration && openToken === resolveHistoryOpenToken) detail.replaceChildren(make('p', '', error.message || 'Could not verify this revision.')); }
}
document.getElementById('resolve-history-refresh').addEventListener('click', () => refreshResolveHistory());
document.getElementById('resolve-history-project').addEventListener('change', event => loadResolveHistory(event.target.value));
let resolveHistoryBranchBusy = false;
document.getElementById('resolve-history-branch').addEventListener('change', async event => {
  if (resolveHistoryBranchBusy) return;
  resolveHistoryBranchBusy = true;
  const projectId = document.getElementById('resolve-history-project').value;
  try {
    const result = await window.desktop.switchResolveBranch(projectId, event.target.value);
    if (!result?.ready) throw new Error(result?.error || 'Could not switch branch.');
    await refreshResolveHistory(projectId);
  } catch (error) {
    event.target.value = event.target.dataset.currentBranch;
    document.getElementById('resolve-history-status').textContent = error.message || 'Could not switch branch.';
  }
  finally { resolveHistoryBranchBusy = false; }
});
document.getElementById('resolve-history-branch-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (resolveHistoryBranchBusy) return;
  resolveHistoryBranchBusy = true;
  const projectId = document.getElementById('resolve-history-project').value;
  const name = document.getElementById('resolve-history-branch-name').value;
  try {
    const result = await window.desktop.createResolveBranch(projectId, name);
    if (!result?.ready) throw new Error(result?.error || 'Could not create branch.');
    document.getElementById('resolve-history-branch-name').value = '';
    await refreshResolveHistory(projectId);
  } catch (error) { document.getElementById('resolve-history-status').textContent = error.message || 'Could not create branch.'; }
  finally { resolveHistoryBranchBusy = false; }
});
document.getElementById('resolve-history-preview-form').addEventListener('submit', event => {
  event.preventDefault();
  const projectId = document.getElementById('resolve-history-project').value;
  const ids = Object.fromEntries(['base', 'local', 'incoming'].map(role =>
    [role, document.getElementById(`resolve-history-${role}`).value]));
  if (!projectId || Object.values(ids).some(value => !value)) return;
  resolveAction('previewResolveHistory', projectId, ids);
});
if (window.desktop?.listResolveProjects) refreshResolveHistory();
document.getElementById('resolve-companion-save').addEventListener('click', async () => {
  if (companionBusy) return;
  companionBusy = true;
  const status = document.getElementById('resolve-companion-status');
  try {
    const result = await window.desktop.saveResolveCapture();
    if (result?.saved) status.textContent = 'Verified snapshot saved. Choose it as base, local, or incoming in the three snapshot preview.';
    else if (!result?.cancelled) status.textContent = result?.error || 'Could not save the snapshot.';
  } catch { status.textContent = 'Could not save the snapshot.'; }
  finally { companionBusy = false; }
});
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

async function reviewCopyAction(method) {
  if (reviewCopyBusy || mediaAuditBusy || document.getElementById('review-copy-panel').hidden) return;
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
  }
}

function renderCopyMediaAudit() {
  const result = document.getElementById('copy-media-result');
  const entries = document.getElementById('copy-media-entries');
  const details = document.getElementById('copy-media-details');
  entries.replaceChildren();
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
        : 'Required media is verified.';
    summaries.push(`${label}: ${counts.total || 0} dependencies · ${counts.local || 0} local · ${counts.missing || 0} missing · ${counts['offline-volume'] || 0} offline · ${counts['proxy-only'] || 0} proxy only · ${counts.excluded || 0} excluded · ${counts.external || 0} external · ${counts.unknown || 0} unknown · ${counts.fingerprinted || 0} fingerprinted. ${gate}`);
    const group = make('section', 'copy-media-group');
    group.append(make('h4', '', label));
    for (const asset of report.assets || []) {
      const row = make('div', 'copy-media-entry');
      const names = Array.isArray(asset.displayNames) ? asset.displayNames.join(', ') : 'Unnamed dependency';
      row.append(make('strong', '', names || 'Unnamed dependency'), make('span', '', `${asset.status || 'unknown'}${asset.reason ? ` · ${asset.reason}` : ''}`), make('span', '', asset.identityVerified ? 'Identity matched prior audit' : asset.expectedIdentityAvailable ? 'Prior identity available' : asset.fingerprintAvailable ? 'Fingerprint observed' : 'No fingerprint'));
      group.append(row);
    }
    entries.append(group);
  }
  result.textContent = summaries.length ? `${summaries.join('\n')}\nFingerprinted means the bytes were read; original media identity is not verified. Audit results describe the last check.` : 'Run an audit to check local availability and fingerprint coverage.';
  const searchResult = document.getElementById('copy-media-search-result');
  const search = mediaSearchReports.source;
  searchResult.textContent = !search ? '' : search.status !== 'ready' ? search.error?.message || 'The folder search failed.'
    : search.canceled ? 'Folder search canceled.'
      : `${search.items?.length || 0} unresolved dependencies searched · ${search.resolvedCount || 0} verified · ${search.ambiguousCount || 0} ambiguous · ${(search.items || []).filter(item => item.resolution === 'unverified').length} filename-only matches. The project export was not changed.`;
  details.hidden = !entries.childElementCount;
}

async function auditCopyMedia() {
  if (mediaAuditBusy || reviewCopyBusy || document.getElementById('review-copy-panel').hidden) return;
  const sourceKey = reviewCopySource;
  const targets = verifiedReviewCopy ? ['source', 'copy'] : ['source'];
  mediaAuditBusy = true;
  renderAppState(currentAppState);
  document.getElementById('copy-media-result').textContent = 'Checking media availability and reading local fingerprints…';
  try {
    for (const target of targets) {
      const report = await window.desktop.auditProjectMedia(target);
      if (sourceKey !== reviewCopySource) return;
      mediaAuditReports[target] = report || { status: 'error' };
      delete mediaSearchReports[target];
    }
    renderCopyMediaAudit();
  } catch {
    if (sourceKey === reviewCopySource) document.getElementById('copy-media-result').textContent = 'Media audit could not finish. Use the desktop app and try again.';
  } finally {
    mediaAuditBusy = false;
    renderAppState(currentAppState);
  }
}

async function findProjectMedia() {
  if (mediaAuditBusy || reviewCopyBusy || !mediaAuditReports.source) return;
  mediaAuditBusy = true;
  renderAppState(currentAppState);
  document.getElementById('copy-media-search-result').textContent = 'Searching the selected folder without following symlinks…';
  try { mediaSearchReports.source = await window.desktop.findProjectMedia('source'); }
  catch { mediaSearchReports.source = { status: 'error', error: { message: 'The folder search could not finish.' } }; }
  finally { mediaAuditBusy = false; renderCopyMediaAudit(); renderAppState(currentAppState); }
}

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
  document.getElementById('resolve-export-notice').textContent = state?.exportError?.message || ((state?.exportError?.code || state?.exportError) === 'select-timeline' ? 'Choose a timeline in the Timeline filter, then choose its FCPXML export.' : state?.exportError ? 'The export comparison failed. Choose a supported FCPXML export or refresh to retry.' : report ? 'Read-only candidate comparison. No mapping is approved and no edits can be applied.' : ready ? 'Choose an FCPXML file or bundle exported from the local timeline.' : 'Choose the three snapshots first.');
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
