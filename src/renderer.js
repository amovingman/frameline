const sample = window.FRAME_SAMPLE;
const changes = new Map(sample.changes.map(change => [change.id, change]));
let selectedChangeId = 'trim';

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
  document.getElementById('view-label').textContent = {workspace: 'Review changes', history: 'Revision history', media: 'Project media'}[name];
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
    const selected = await window.desktop.chooseProject();
    if (!selected) return;
    if (selected.error === 'unsupported-format') {
      notice.textContent = 'Choose an FCPXML timeline (.fcpxml or .fcpxmld) exported from DaVinci Resolve.';
      notice.hidden = false;
      return;
    }
    document.getElementById('file-name').textContent = `Chosen file: ${selected.name}`;
    notice.textContent = `${selected.name} · ${selected.format} selected. Timeline scanning is the next adapter step.`;
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
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    showView(['workspace', 'history', 'media'][Number(event.key) - 1]);
  }
});
