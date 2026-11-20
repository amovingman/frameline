(() => {
  'use strict';
  const GROUPS = new Map([
    ['video-track', 'Timeline clips'], ['change-queue', 'Sample changes'], ['compact-queue', 'Sample changes'],
    ['resolve-queue', 'Resolve changes'], ['resolve-history-list', 'Resolve revision history']
  ]);
  const visible = node => !!node && !node.hidden && !node.closest('[hidden]') && node.getClientRects().length > 0;
  const buttons = group => [...group.querySelectorAll('button')].filter(node => visible(node) && !node.disabled);
  // Virtual scan lists own their listbox semantics and all-row navigation. The
  // legacy button groups below must not overwrite them after a DOM redraw.
  const legacyGroup = group => group && GROUPS.has(group.id) && !group.classList.contains('scan-window-list');
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const identity = button => button.dataset.resolveAnchor || button.dataset.revisionId || button.dataset.clipId || button.dataset.changeId || [button.querySelector('strong')?.textContent,
    button.querySelector('small')?.textContent, button.querySelector('.queue-kind')?.textContent].map(clean).filter(Boolean).join('|') || clean(button.textContent);
  const sourceKey = () => {
    try { return JSON.stringify([typeof resolveState === 'undefined' ? null : resolveState?.sourceHashes || null,
      typeof currentAppState === 'undefined' ? null : currentAppState?.selectedProject?.id || null,
      typeof currentAppState === 'undefined' ? null : currentAppState?.scan?.sourceHash || null,
      typeof serviceState === 'undefined' ? null : [serviceState?.origin, serviceState?.account?.id, serviceState?.binding?.remoteProjectId, serviceState?.binding?.remoteBranch]]); }
    catch { return ''; }
  };
  let focused = null, queued = false;
  const live = document.createElement('p');
  live.id = 'accessibility-status'; live.className = 'a11y-only'; live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true'); document.body.append(live);
  const help = document.createElement('p'); help.id = 'accessibility-queue-help'; help.className = 'a11y-only';
  help.textContent = 'Use arrow keys, Home, or End to move through this group. Press Enter or Space to activate a button.'; document.body.append(help);
  const skip = document.createElement('a'); skip.className = 'a11y-skip-link'; skip.href = '#app-main'; skip.textContent = 'Skip to main content';
  document.body.prepend(skip);
  const main = document.querySelector('main');
  if (main) { main.id = 'app-main'; main.tabIndex = -1; }
  skip.addEventListener('click', () => main?.focus());
  function announce(text) { if (live.textContent !== text) live.textContent = text; }
  function apply() {
    queued = false;
    for (const [id, label] of GROUPS) {
      const group = document.getElementById(id); if (!legacyGroup(group)) continue;
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
      group.setAttribute('aria-describedby', help.id);
      const rows = buttons(group);
      let tabStop = rows.find(node => node === document.activeElement) || rows.find(node => node.getAttribute('aria-pressed') === 'true') || rows[0];
      for (const [index, row] of rows.entries()) {
        row.tabIndex = row === tabStop ? 0 : -1;
        const name = clean(row.textContent);
        const ranged = id === 'resolve-queue' ? clean(document.getElementById('resolve-changes-range')?.textContent) : '';
        const accessible = `${name}. ${label}: item ${index + 1} of ${rows.length} on this page.${ranged ? ` ${ranged}` : ''}`;
        if (row.getAttribute('aria-label') !== accessible) row.setAttribute('aria-label', accessible);
      }
      if (focused?.group === id && !focused.node.isConnected && sourceKey() === focused.source
        && document.activeElement === document.body && visible(group)) {
        const candidate = rows.find(row => identity(row) === focused.identity);
        if (candidate) candidate.focus({ preventScroll: true });
      }
    }
    for (const status of document.querySelectorAll('[role="status"]')) status.setAttribute('aria-atomic', 'true');
    for (const region of document.querySelectorAll('.resolve-values pre, .resolve-inspection pre, #resolve-detail pre')) {
      region.tabIndex = 0;
      const heading = region.parentElement?.querySelector('h3,h4');
      if (heading && !region.getAttribute('aria-label')) region.setAttribute('aria-label', `${clean(heading.textContent)} value`);
    }
    for (const column of document.querySelectorAll('.value-grid > div,.resolve-values > div')) {
      const heading = column.querySelector('h3,h4,span');
      if (heading) { column.setAttribute('role', 'group'); column.setAttribute('aria-label', clean(heading.textContent)); }
    }
    // Native values and state are exposed by their native elements. Keep purely
    // decorative waveform bars out of the accessibility tree.
    for (const decorative of document.querySelectorAll('.waveform,.connection-dot,.branch-dot,.project-monogram,.brand-mark')) decorative.setAttribute('aria-hidden', 'true');
    if (focused?.control && !focused.node.isConnected && sourceKey() === focused.source && document.activeElement === document.body) {
      const candidate = focused.control === 'decision'
        ? [...document.querySelectorAll('#resolve-detail .resolve-decisions button')].find(button => clean(button.textContent) === focused.identity)
        : document.getElementById(focused.control);
      if (candidate && !candidate.disabled && visible(candidate) && clean(candidate.textContent) === focused.identity) candidate.focus({ preventScroll: true });
    }
  }
  function schedule() { if (!queued) { queued = true; queueMicrotask(apply); } }
  document.addEventListener('focusin', event => {
    const button = event.target.closest?.('button');
    const group = button?.closest('[role="group"]');
    if (!button || !legacyGroup(group)) {
      focused = button && (button.id || button.closest('#resolve-detail .resolve-decisions'))
        ? { node: button, control: button.id || 'decision', identity: clean(button.textContent), source: sourceKey() } : null;
      return;
    }
    focused = { node: button, group: group.id, identity: identity(button), source: sourceKey() };
    for (const row of buttons(group)) row.tabIndex = row === button ? 0 : -1;
  });
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const group = event.target.closest?.('[role="group"]');
    if (!legacyGroup(group) || event.target.tagName !== 'BUTTON') return;
    const rows = buttons(group), index = rows.indexOf(event.target); if (index < 0 || !rows.length) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + rows.length) % rows.length;
    event.preventDefault(); event.stopImmediatePropagation(); rows[next].focus();
    announce(`${GROUPS.get(group.id)}. ${clean(rows[next].textContent)}. Item ${next + 1} of ${rows.length} on this page.`);
  }, true);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button'), group = button?.closest('[role="group"]');
    if (legacyGroup(group)) schedule();
  }, true);
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== live && !live.contains(record.target))) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  apply();
  window.FramelineAccessibility = Object.freeze({ refresh: apply });
})();
