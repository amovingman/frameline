const sample = window.FRAME_SAMPLE;
const changes = new Map(sample.changes.map(change => [change.id, change]));
let selectedChangeId = 'trim';

function renderAppState(state) {
  const projectName = state?.selectedProject?.name;
  const scan = state?.scan;
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
    document.querySelector('#view-history .secondary-hero p').textContent = 'No revisions have been saved for this file.';
    document.getElementById('history-list').replaceChildren();
    document.querySelector('#view-history .view-footnote').textContent = 'Local revision history is not implemented yet.';
    document.querySelector('#view-media .secondary-hero p').textContent = scan ? `${scan.media.length} referenced media assets · ${scan.media.filter(item => item.availability === 'local').length} available locally · ${scan.media.filter(item => item.availability === 'missing').length} missing` : 'Media could not be scanned.';
    document.querySelector('#view-media .section-head span').textContent = 'Read-only scan';
    document.querySelector('#view-media .view-footnote').textContent = 'Only local file references are checked. External and unspecified sources are not resolved; media paths stay on this device.';
    if (scan) renderScan(scan);
    else {
      document.querySelector('.masthead h1').textContent = 'Timeline scan';
      document.getElementById('video-track').replaceChildren();
      document.getElementById('media-list').replaceChildren();
      document.getElementById('workspace-finding').textContent = 'The timeline could not be scanned.';
      document.getElementById('timeline-selection').textContent = 'No scan data';
      document.getElementById('film-title').textContent = projectName;
      document.querySelector('.sample-line span').textContent = 'Read-only FCPXML inventory';
      document.querySelector('.sample-line p').textContent = 'Choose another export to try again.';
      document.getElementById('sequence-summary').textContent = 'Scan unavailable';
    }
  }
  if (state?.error) {
    const notice = document.getElementById('file-notice');
    notice.textContent = {
      'unsupported-format': 'Choose an FCPXML timeline (.fcpxml or .fcpxmld) exported from DaVinci Resolve.',
      'file-unavailable': 'The selected FCPXML could not be read. Check that the file or bundle is available.',
      'file-too-large': 'This FCPXML exceeds the 20 MB scan limit.',
      'malformed-xml': 'The selected file is malformed XML. Export the timeline again from Resolve.',
      'unsupported-structure': 'This FCPXML has no supported sequence and spine.',
      'unsupported-timing': 'This timeline uses timing that cannot be represented in whole frames.'
    }[state.error] || 'The timeline scan failed. Try exporting it again from Resolve.';
    notice.hidden = false;
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
  document.getElementById('view-label').textContent = {workspace: document.getElementById('sample-review').hidden ? 'Timeline scan' : 'Review changes', history: 'Revision history', media: 'Project media'}[name];
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
  try {
    if (!window.desktop?.chooseProject) throw new Error('Desktop picker unavailable');
    const state = await window.desktop.chooseProject();
    if (!state) return;
    renderAppState(state);
    if (state.selectedProject && !state.error) {
      notice.textContent = `${state.selectedProject.name} scanned read only. Clip identity is unresolved; edits and pull are unavailable.`;
      notice.hidden = false;
    }
  } catch {
    notice.textContent = 'The file picker is available in the desktop app.';
  }
  notice.hidden = false;
}

renderChangeChoices();
renderTimeline();
renderHistory();
renderMedia();
selectChange(selectedChangeId);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => chooseMode(button)));
document.getElementById('choose-file').addEventListener('click', chooseFile);
window.desktop?.getAppState?.().then(renderAppState).catch(() => {});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    showView(['workspace', 'history', 'media'][Number(event.key) - 1]);
  }
});
