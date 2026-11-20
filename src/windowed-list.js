function visibleRange(total, scrollTop, viewportHeight, rowHeight, overscan = 4) {
  if (![total, scrollTop, viewportHeight, rowHeight, overscan].every(Number.isFinite)
    || total < 0 || scrollTop < 0 || viewportHeight < 0 || rowHeight <= 0 || overscan < 0) throw new TypeError('Invalid window');
  const start = Math.min(total, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, beforePx: start * rowHeight, afterPx: (total - end) * rowHeight };
}

// The complete dataset stays separate from its bounded DOM window. Stable source
// indexes survive filtering, and the focused viewport survives every redraw.
function createWindowedList({ viewport, searchInput, jumpInput, jumpButton, range,
  renderRow, searchText, onSelect = () => {}, rowHeight = 112, overscan = 3, emptyText = 'No rows.' }) {
  const document = viewport.ownerDocument;
  let items = [], corpus = [], indexes = [], selected = -1, scope, lastItems, frame = null, content, active = false;
  const ownerWindow = document.defaultView;
  const text = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
  function choose(position, { focus = false, reveal = true } = {}) {
    if (!indexes.length) return;
    selected = Math.max(0, Math.min(indexes.length - 1, position));
    if (reveal) {
      const top = selected * rowHeight, bottom = top + rowHeight, height = viewport.clientHeight || 448;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (bottom > viewport.scrollTop + height) viewport.scrollTop = Math.max(0, bottom - height);
    }
    draw();
    if (focus) viewport.focus({ preventScroll: true });
    onSelect(items[indexes[selected]], indexes[selected]);
  }
  function draw() {
    if (!active) return;
    const height = viewport.clientHeight || 448;
    const maximum = Math.max(0, indexes.length * rowHeight - height);
    if (viewport.scrollTop > maximum) viewport.scrollTop = maximum;
    const { start, end } = visibleRange(indexes.length, viewport.scrollTop, height, rowHeight, overscan);
    content ||= document.createElement('div'); content.className = 'scan-window-content'; content.setAttribute('role', 'presentation');
    content.style.height = `${indexes.length * rowHeight}px`;
    const positions = Array.from({ length: end - start }, (_, offset) => start + offset);
    // Keep one offscreen active option mounted so aria-activedescendant never
    // refers to a removed row while a pointer scrolls away from keyboard focus.
    if (selected >= 0 && !positions.includes(selected)) positions.push(selected);
    const nodes = positions.sort((a, b) => a - b).map(position => {
      const index = indexes[position], row = renderRow(items[index], index);
      row.id = `${viewport.id}-row-${index}`; row.dataset.scanIndex = String(index);
      row.dataset.scanPosition = String(position); row.classList.add('scan-window-row');
      row.style.top = `${position * rowHeight}px`; row.style.height = `${rowHeight}px`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-posinset', String(position + 1));
      row.setAttribute('aria-setsize', String(indexes.length)); row.setAttribute('aria-selected', String(position === selected));
      return row;
    });
    content.replaceChildren(...nodes); viewport.replaceChildren(content);
    if (!indexes.length) {
      const empty = document.createElement('p'); empty.className = 'scan-window-empty';
      empty.textContent = items.length ? 'No matches. Clear the search to browse every row.' : emptyText;
      content.style.height = 'auto'; content.append(empty); viewport.removeAttribute('aria-activedescendant');
    } else viewport.setAttribute('aria-activedescendant', `${viewport.id}-row-${indexes[selected]}`);
    range.textContent = !items.length ? '0 rows' : !indexes.length ? `0 matches of ${items.length.toLocaleString()} rows`
      : `${(Math.floor(viewport.scrollTop / rowHeight) + 1).toLocaleString()}–${Math.min(indexes.length, Math.ceil((viewport.scrollTop + height) / rowHeight)).toLocaleString()} of ${indexes.length.toLocaleString()}${indexes.length !== items.length ? ` matches · ${items.length.toLocaleString()} total` : ''}`;
    jumpInput.max = String(items.length); jumpInput.disabled = jumpButton.disabled = !items.length;
  }
  function filter({ preserve = false } = {}) {
    const sourceIndex = preserve && selected >= 0 ? indexes[selected] : -1, query = text(searchInput.value).trim();
    indexes = [];
    for (let index = 0; index < items.length; index++) if (!query || corpus[index].includes(query)) indexes.push(index);
    selected = indexes.length ? Math.max(0, indexes.indexOf(sourceIndex)) : -1;
    if (!preserve) viewport.scrollTop = 0;
    draw(); onSelect(selected < 0 ? null : items[indexes[selected]], selected < 0 ? -1 : indexes[selected]);
  }
  function jump() {
    const index = Number(jumpInput.value) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) {
      jumpInput.setCustomValidity(`Enter a row number from 1 to ${items.length.toLocaleString()}.`); jumpInput.reportValidity(); return false;
    }
    jumpInput.setCustomValidity('');
    if (!indexes.includes(index)) { searchInput.value = ''; filter(); }
    choose(indexes.indexOf(index), { focus: true }); return true;
  }
  searchInput.addEventListener('input', () => filter());
  jumpInput.addEventListener('input', () => jumpInput.setCustomValidity(''));
  jumpInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } });
  jumpButton.addEventListener('click', jump);
  viewport.addEventListener('click', event => {
    const row = event.target.closest('[data-scan-position]');
    if (row && viewport.contains(row)) choose(Number(row.dataset.scanPosition), { focus: true, reveal: false });
  });
  viewport.addEventListener('keydown', event => {
    const page = Math.max(1, Math.floor((viewport.clientHeight || 448) / rowHeight));
    const target = { ArrowDown: selected + 1, ArrowUp: selected - 1, Home: 0, End: indexes.length - 1,
      PageDown: selected + page, PageUp: selected - page }[event.key];
    if (target === undefined || event.altKey || event.metaKey || event.ctrlKey || !indexes.length) return;
    event.preventDefault(); choose(target);
  });
  viewport.addEventListener('scroll', () => {
    if (frame !== null) return;
    if (ownerWindow?.requestAnimationFrame) frame = ownerWindow.requestAnimationFrame(() => { frame = null; draw(); });
    else draw();
  }, { passive: true });
  const observer = ownerWindow?.ResizeObserver ? new ownerWindow.ResizeObserver(draw) : null; observer?.observe(viewport);
  return {
    setItems(next, key) {
      active = true;
      viewport.classList.add('scan-window-list'); viewport.setAttribute('role', 'listbox'); viewport.tabIndex = 0;
      if (lastItems === next && key === scope) { draw(); return; }
      const changed = key !== scope; scope = key; items = next; lastItems = next;
      corpus = items.map((item, index) => text(searchText(item, index)));
      if (changed) { searchInput.value = ''; jumpInput.value = ''; viewport.scrollTop = 0; selected = -1; }
      filter({ preserve: !changed });
    },
    refresh: draw,
    clear() {
      active = false; if (frame !== null) ownerWindow?.cancelAnimationFrame?.(frame); frame = null;
      items = []; indexes = []; selected = -1; lastItems = null; scope = undefined; corpus = [];
      viewport.replaceChildren(); viewport.classList.remove('scan-window-list');
      for (const name of ['role', 'tabindex', 'aria-activedescendant']) viewport.removeAttribute(name);
    }
  };
}
if (typeof module !== 'undefined') module.exports = { visibleRange, createWindowedList };
if (typeof window !== 'undefined') { window.visibleRange = visibleRange; window.createWindowedList = createWindowedList; }
