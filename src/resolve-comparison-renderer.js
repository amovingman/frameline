(() => {
  const element = id => document.getElementById(id);
  const make = (tag, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const anchor = value => JSON.stringify([value.timelineId, value.itemId, value.field]);
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const words = value => String(value || '').replaceAll('-', ' ');
  const labels = { 'incoming-only': 'Incoming edits', 'local-only': 'Local edits', 'already-applied': 'Already applied', conflict: 'Conflicts' };
  const PAGE_SIZE = 40;
  const historyContexts = new WeakMap();
  let contextIndex = new Map(), riskIndex = new Map(), state = null, page = 0, selectionKey = '', pendingTarget = null;
  const contextFor = value => contextIndex.get(anchor(value));
  const rate = () => element('resolve-timecode-rate').value || null;
  const time = (frame, originFrame = 0) => window.FrameTimecode.formatFrameTimecode(frame, { rate: rate(), originFrame });
  function fillOptions(id, values, allLabel) {
    const select = element(id), selected = select.value;
    select.replaceChildren(); const all = make('option', '', allLabel); all.value = 'all'; select.append(all);
    for (const value of values) { const option = make('option', '', words(value)); option.value = value; select.append(option); }
    select.value = [...select.options].some(option => option.value === selected) ? selected : 'all';
    select.disabled = !state?.plan;
  }
  function groupLabel(item) {
    const context = contextFor(item);
    const group = element('resolve-group').value;
    if (group === 'none') return '';
    if (group === 'track') return context?.tracks?.join(' / ') || 'Timeline';
    if (group === 'status') return labels[item.status] || words(item.status);
    if (group === 'kind') return words(context?.kind || item.field);
    return context?.timelineName || item.context?.timelineName || item.timelineId;
  }
  function selectChanges(nextState, items) {
    state = nextState;
    contextIndex = new Map((state?.guidance?.changeContext?.records || []).map(value => [anchor(value), value]));
    riskIndex = new Map((state?.guidance?.riskPolicy?.decisions || []).map(value => [anchor(value), value]));
    fillOptions('resolve-track', [...new Set([...contextIndex.values()].flatMap(value => value.tracks))].sort(cmp), 'All observed tracks');
    fillOptions('resolve-kind', [...new Set([...contextIndex.values()].map(value => value.kind))].sort(cmp), 'All change types');
    const selected = Object.fromEntries(['resolve-timeline', 'resolve-field', 'resolve-filter', 'resolve-track', 'resolve-kind', 'resolve-group']
      .map(id => [id, element(id).value]));
    const chosenIds = new Set((state?.decisions || []).map(value => value.conflictId));
    const chosenAnchors = new Set((state?.review?.conflicts || []).filter(value => chosenIds.has(value.id)).map(anchor));
    const nextKey = JSON.stringify([state?.guidance?.guidanceHash || state?.sourceHashes, selected]);
    if (selectionKey !== nextKey) { selectionKey = nextKey; page = 0; }
    const rows = items.filter(item => {
      const context = contextFor(item), chosen = chosenAnchors.has(anchor(item));
      return (selected['resolve-timeline'] === 'all' || item.timelineId === selected['resolve-timeline'])
        && (selected['resolve-field'] === 'all' || item.field === selected['resolve-field'])
        && (selected['resolve-track'] === 'all' || context?.tracks.includes(selected['resolve-track']))
        && (selected['resolve-kind'] === 'all' || context?.kind === selected['resolve-kind'])
        && (selected['resolve-filter'] === 'all' || selected['resolve-filter'] === 'unresolved' && item.status === 'conflict' && !chosen
          || selected['resolve-filter'] === 'resolved' && chosen || item.status === selected['resolve-filter']);
    }).sort((a, b) => cmp(groupLabel(a), groupLabel(b)) || cmp(a.timelineId, b.timelineId)
      || cmp(a.itemId || '', b.itemId || '') || cmp(a.field, b.field));
    if (pendingTarget) {
      const index = rows.findIndex(row => anchor(row) === pendingTarget);
      if (index >= 0) page = Math.floor(index / PAGE_SIZE);
      pendingTarget = null;
    }
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / PAGE_SIZE) - 1));
    const start = page * PAGE_SIZE;
    element('resolve-changes-previous').disabled = start === 0;
    element('resolve-changes-next').disabled = start + PAGE_SIZE >= rows.length;
    element('resolve-changes-range').textContent = rows.length ? `Changes ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} matching (${items.length} classified).`
      : `No matching changes (${items.length} classified).`;
    return { rows: rows.slice(start, start + PAGE_SIZE), filteredCount: rows.length };
  }
  function roleContext(label, value) {
    const column = make('div', 'resolve-context-role'); column.append(make('h4', '', label));
    if (!value || !value.present) { column.append(make('p', '', 'Not present in this source.')); return column; }
    column.append(make('p', '', value.timelineName || 'Timeline name unavailable'));
    if (value.track) column.append(make('p', '', `${value.track.type} track ${value.track.index}${value.track.name ? ` · ${value.track.name}` : ''}`));
    if (value.itemName) column.append(make('p', '', value.itemName));
    if (value.startFrame !== null || value.endFrame !== null) {
      column.append(make('p', '', `In: ${time(value.startFrame, value.timelineOriginFrame)}`), make('p', '', `Out (exclusive): ${time(value.endFrame, value.timelineOriginFrame)}`));
    } else column.append(make('p', '', `Timeline origin: ${Number.isSafeInteger(value.timelineOriginFrame) ? `Frame ${value.timelineOriginFrame}` : 'not captured'}. Item frame interval unavailable.`));
    if (value.sourceStartFrame !== null || value.sourceEndFrame !== null) column.append(make('p', '', `Source frames: ${value.sourceStartFrame ?? 'unknown'}–${value.sourceEndFrame ?? 'unknown'}`));
    if (value.neighbors?.length) column.append(make('p', '', `Neighbor observations: ${value.neighbors.map(neighbor => `${neighbor.name || neighbor.id} [${neighbor.startFrame ?? '?'}, ${neighbor.endFrame ?? '?'})`).join(' · ')}`));
    return column;
  }
  function renderContext(detail, item) {
    const context = contextFor(item);
    if (context) {
      const section = make('section', 'resolve-change-context'); section.id = 'resolve-change-context';
      section.append(make('h3', '', 'Change context'));
      const columns = make('div', 'resolve-context-roles');
      for (const [role, label] of [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']]) columns.append(roleContext(label, context.roles[role]));
      section.append(columns); detail.append(section);
    }
    const policy = state?.guidance?.riskPolicy, risk = riskIndex.get(anchor(item));
    const section = make('section', 'resolve-complex-risk'); section.id = 'resolve-complex-risk';
    const title = make('h3', '', 'Complex edit checks');
    const summary = make('p', 'resolve-risk-summary', 'Automatic apply remains blocked. Review choices do not prove ripple, linked-clip, transition, nested-sequence, or timing safety.');
    summary.id = 'resolve-risk-summary'; section.append(title, summary);
    if (risk) {
      const descriptions = new Map((policy?.warnings || []).map(value => [value.code, value.description]));
      for (const code of risk.warningCodes) section.append(make('p', '', descriptions.get(code) || words(code)));
      if (!risk.context?.contextComplete) section.append(make('p', '', 'Context analysis is incomplete. Additional interactions may exist.'));
    } else section.append(make('p', '', 'Risk coverage is unavailable. No safety assumption can be made.'));
    detail.append(section);
  }
  function renderHistoryContext(row, change) {
    const section = make('div', 'resolve-history-frame-context'); section.dataset.frameContext = 'true';
    historyContexts.set(section, change); row.append(section); updateHistoryContext(section, change);
  }
  function updateHistoryContext(section, change) {
    section.replaceChildren();
    for (const [key, label] of [['beforeContext', 'Before'], ['afterContext', 'After']]) {
      if (change[key]) section.append(roleContext(label, change[key]));
    }
  }
  function rerender() { renderResolveState(state); }
  for (const id of ['resolve-track', 'resolve-kind', 'resolve-group']) element(id).addEventListener('change', rerender);
  for (const [id, delta] of [['resolve-changes-previous', -1], ['resolve-changes-next', 1]]) element(id).addEventListener('click', () => {
    page += delta; rerender(); element('resolve-changes-range').focus();
  });
  element('resolve-timecode-rate').addEventListener('change', () => {
    rerender();
    for (const section of document.querySelectorAll('[data-frame-context]')) updateHistoryContext(section, historyContexts.get(section));
  });
  window.FramelineComparison = { selectChanges, groupLabel, contextFor, renderContext, renderHistoryContext,
    revealChange(item) { pendingTarget = anchor(item); element('resolve-track').value = 'all'; element('resolve-kind').value = 'all'; } };
  renderResolveState(typeof resolveState === 'undefined' ? null : resolveState);
})();
