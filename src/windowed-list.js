function visibleRange(total, scrollTop, viewportHeight, rowHeight, overscan = 4) {
  if (![total, scrollTop, viewportHeight, rowHeight, overscan].every(Number.isFinite)
    || total < 0 || scrollTop < 0 || viewportHeight < 0 || rowHeight <= 0 || overscan < 0) throw new TypeError('Invalid window');
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, beforePx: start * rowHeight, afterPx: (total - end) * rowHeight };
}
if (typeof module !== 'undefined') module.exports = { visibleRange };
if (typeof window !== 'undefined') window.visibleRange = visibleRange;
