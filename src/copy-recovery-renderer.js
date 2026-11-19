(() => {
  const element = id => document.getElementById(id);
  let state = null, busy = false, notice = '';
  const descriptions = {
    'published-unvalidated': 'A published copy needs verification. It was preserved.',
    'copy-changed': 'A copy changed after preparation. It was preserved.',
    'ownership-unverified': 'File ownership could not be verified. It was preserved.',
    'source-changed': 'The source changed or is unavailable. Its recovery copy was preserved.',
    'recovery-unavailable': 'Copy recovery could not verify its journal. Files were preserved.'
  };
  function render() {
    if (!state) return;
    const unavailable = state.status === 'unavailable';
    const entries = state.entries || [];
    element('copy-recovery-details').hidden = !entries.length && !state.preservedCount;
    element('copy-recovery-summary').textContent = `Review ${state.preservedCount || 0} retained copies`;
    element('copy-recovery-panel').hidden = !unavailable && !state.removedCount && !state.preservedCount && !state.pendingCount && !entries.length;
    element('copy-recovery-refresh').disabled = busy;
    element('copy-recovery-status').textContent = notice || (unavailable
      ? 'Recovery could not complete. Unverified files are kept. Check app storage permissions and reopen Frameline.'
      : `${state.removedCount || 0} owned temporary files removed. ${state.preservedCount || 0} retained copies need review.${state.pendingCount ? ` ${state.pendingCount} preparations are still owned by an active process; wait or close the other instance before rechecking.` : ''}${entries.length ? ` Showing ${state.offset + 1}–${state.offset + entries.length} of ${state.totalEntries}.` : ''}`);
    const list = element('copy-recovery-entries'); list.replaceChildren();
    for (const [index, entry] of entries.entries()) {
      const row = document.createElement('div'); row.className = 'copy-recovery-entry';
      const text = document.createElement('p'); text.id = `copy-recovery-entry-${entry.id}`; text.textContent = descriptions[entry.code] || 'An incomplete or uncertain copy was preserved for review.'; row.append(text);
      if (entry.canReveal) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Reveal retained copy'; button.disabled = busy;
        button.setAttribute('aria-label', `Reveal retained copy ${state.offset + index + 1} of ${state.totalEntries}`);
        button.setAttribute('aria-describedby', text.id);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await window.desktop.revealRetainedCopy(entry.id);
            if (!result?.revealed) element('copy-recovery-status').textContent = 'The retained file changed or is unavailable. Recheck incomplete copies.';
          } catch { element('copy-recovery-status').textContent = 'Could not reveal the retained copy. Recheck incomplete copies.'; }
          finally { button.disabled = false; }
        }); row.append(button);
      }
      list.append(row);
    }
    element('copy-recovery-previous').hidden = state.previousOffset === null || state.previousOffset === undefined;
    element('copy-recovery-previous').disabled = busy;
    element('copy-recovery-more').hidden = state.nextOffset === null || state.nextOffset === undefined;
    element('copy-recovery-more').disabled = busy;
  }
  async function refresh(recheck = false, options = {}) {
    if (busy || !window.desktop?.getCopyRecovery) return;
    busy = true; render();
    try {
      const result = await (recheck ? window.desktop.refreshCopyRecovery() : window.desktop.getCopyRecovery(options));
      if (result?.error === 'review-copy-busy') notice = 'A copy is being prepared. Recheck after it finishes.';
      else if (result?.error) notice = 'Could not load this recovery page. Recheck incomplete copies and try again.';
      else { state = result; notice = ''; }
    } catch { state = { status: 'unavailable' }; }
    finally { busy = false; render(); }
  }
  element('copy-recovery-refresh').addEventListener('click', () => refresh(true));
  element('copy-recovery-more').addEventListener('click', async () => { await refresh(false, { offset: state.nextOffset }); element('copy-recovery-status').focus(); });
  element('copy-recovery-previous').addEventListener('click', async () => { await refresh(false, { offset: state.previousOffset }); element('copy-recovery-status').focus(); });
  window.addEventListener('frameline:copy-finished', () => refresh());
  refresh();
})();
