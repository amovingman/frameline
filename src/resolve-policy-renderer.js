(() => {
  const element = id => document.getElementById(id);
  const make = (tag, className, text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const words = value => String(value || '').replaceAll('-', ' ');
  const roles = [['base', 'Common base'], ['local', 'Local'], ['incoming', 'Incoming']];
  const statuses = { 'incoming-only': 'Incoming edit', 'local-only': 'Local edit', 'already-applied': 'Matching placement', conflict: 'Conflicting placement' };
  const PAGE_SIZE = 12;
  let page = 0, key = null, currentState = null;
  function placement(value) {
    if (value === null) return 'Not present';
    if (!value) return 'Not observed';
    const track = value.track ? `${value.track.type} track ${value.track.index}` : 'track unknown';
    return Number.isSafeInteger(value.startFrame) && Number.isSafeInteger(value.endFrame)
      ? `${track} · frames [${value.startFrame}, ${value.endFrame})` : `${track} · frame interval unknown`;
  }
  function render(state) {
    currentState = state;
    const guidance = state?.guidance, report = guidance?.placementPolicy, ready = state?.status === 'ready' && !!report;
    if (key !== guidance?.guidanceHash) { key = guidance?.guidanceHash; page = 0; }
    const entries = ready ? [...report.interactions.map(entry => ({ type: 'interaction', entry })),
      ...(report.timelineReviews || []).map(entry => ({ type: 'timeline', entry })),
      ...report.changes.map(entry => ({ type: 'change', entry }))] : [];
    const selector = element('resolve-placement-timeline'), selected = selector.value;
    selector.replaceChildren();
    const all = make('option', '', 'All timelines'); all.value = 'all'; selector.append(all);
    for (const timeline of [...new Set(entries.map(row => row.entry.timelineId))].sort()) {
      const option = make('option', '', timeline); option.value = timeline; selector.append(option);
    }
    selector.value = [...selector.options].some(option => option.value === selected) ? selected : 'all';
    selector.disabled = !ready;
    const filtered = entries.filter(row => selector.value === 'all' || row.entry.timelineId === selector.value);
    page = Math.max(0, Math.min(page, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    const start = page * PAGE_SIZE;
    element('resolve-placement-summary').textContent = !ready ? 'Choose sources to review additions and timeline moves.'
      : `${report.summary.totalChanges} placement changes · ${report.summary.observedInteractions} observed interactions · ${report.summary.changedTimelineCount || 0} timeline layout reviews. ${report.summary.analysisComplete
        ? 'Analysis finished for captured intervals; track identity and unobserved state remain unknown.'
        : 'Analysis is incomplete. Limits or unknown observations require additional manual review.'}${report.summary.truncatedChanges || report.summary.truncatedInteractions || report.summary.truncatedTimelineReviews
          ? ' Only bounded result rows are shown; additional observations are omitted from this list.' : ''}`;
    const rules = element('resolve-placement-rule-list'); rules.replaceChildren();
    for (const rule of report?.rules || []) rules.append(make('p', '', rule.description || words(rule.code)));
    if (ready) for (const warning of report.warnings || []) rules.append(make('p', '', typeof warning === 'string' ? warning : warning.description || words(warning.code)));
    const records = element('resolve-placement-records'); records.replaceChildren();
    for (const { type, entry } of filtered.slice(start, start + PAGE_SIZE)) {
      const row = make('article', 'resolve-placement-record');
      if (type === 'interaction') {
        const participants = (entry.itemIds || []).map((id, index) => `${entry.roles?.[index] === 'local' ? 'Local' : entry.roles?.[index] === 'incoming' ? 'Incoming' : 'Observed'} ${id}`);
        row.append(make('h3', '', words(entry.code)), make('p', '', `${entry.timelineId} · ${participants.join(' / ') || 'Timeline layout'}`),
          make('p', '', 'Review these placements together. No automatic order, offset, or neighbor shift is proposed.'));
        if (entry.interval && entry.track) row.append(make('p', '', `Overlapping frames [${entry.interval.startFrame}, ${entry.interval.endFrame}) on ${entry.track.type} track ${entry.track.index}.`));
      } else if (type === 'timeline') {
        row.append(make('h3', '', 'Timeline layout needs review'), make('p', '', `${entry.timelineId} · ${entry.reasons.map(words).join(' · ')}`));
        for (const [role, label] of roles) row.append(make('p', '', `${label}: ${entry[role] === null ? 'Timeline not present' : entry[role].map(track => `${track.type} track ${track.index}`).join(', ') || 'No observed tracks'}`));
        row.append(make('p', '', 'Verify track identity and timeline origin in the editor. Indexed tracks cannot be matched persistently.'));
      } else {
        row.append(make('h3', '', `${words(entry.kind)} · ${entry.itemId || 'Timeline'}`),
          make('p', '', `${entry.timelineId} · ${statuses[entry.status] || words(entry.status)} (placement observations only)`));
        const values = make('dl', 'resolve-placement-values');
        for (const [role, label] of roles) values.append(make('dt', '', label), make('dd', '', placement(entry[role])));
        row.append(values);
        if (entry.reasons?.length) row.append(make('p', '', entry.reasons.map(words).join(' · ')));
      }
      records.append(row);
    }
    if (!filtered.length) records.append(make('p', '', ready ? 'No placement changes or interactions reported for this selection. This does not establish complete editor equivalence.' : 'Placement review becomes available with verified sources.'));
    element('resolve-placement-previous').disabled = start === 0;
    element('resolve-placement-next').disabled = start + PAGE_SIZE >= filtered.length;
    element('resolve-placement-range').textContent = filtered.length ? `Records ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}${report.summary.analysisComplete ? '' : ' shown; analysis incomplete'}.`
      : 'No placement records to page.';
    element('resolve-placement-binding').textContent = ready ? `Guidance ${guidance.guidanceHash.slice(0, 16)} · Source fingerprints: ${roles.map(([role, label]) => `${label} ${guidance.sourceHashes[role].slice(0, 12)}`).join(' · ')}` : '';
  }
  element('resolve-placement-timeline').addEventListener('change', () => { page = 0; render(currentState); });
  for (const [id, direction] of [['resolve-placement-previous', -1], ['resolve-placement-next', 1]]) element(id).addEventListener('click', () => {
    page += direction; render(currentState); element('resolve-placement-range').focus();
  });
  window.renderResolvePlacementPolicy = render;
  render(typeof resolveState === 'undefined' ? null : resolveState);
})();
