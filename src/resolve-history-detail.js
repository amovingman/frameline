'use strict';
const { compareResolveRevisionManifests } = require('./resolve-revision-comparison');

const FILTERS = ['timelineId', 'track', 'status', 'kind'];
function invalid() { const error = new Error('resolve-history-filter-invalid'); error.code = 'resolve-history-filter-invalid'; throw error; }
function trackLabel(type, index) {
  return type && Number.isSafeInteger(index) ? type === 'video' ? `V${index}`
    : type === 'audio' ? `A${index}` : `${type} ${index}` : null;
}
function context(manifest) {
  const timelines = new Map();
  const items = new Map();
  for (const timeline of manifest.snapshot.timelines) {
    timelines.set(timeline.id, timeline.name);
    for (const item of timeline.items) items.set(`${timeline.id}\0${item.id}`, item);
  }
  return { timelines, items };
}
function describeResolveHistoryChanges(before, after, selected = {}) {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)
    || Object.keys(selected).some(key => !FILTERS.includes(key))
    || FILTERS.some(key => selected[key] !== undefined &&
      (typeof selected[key] !== 'string' || selected[key].length > 160))) invalid();
  const comparison = compareResolveRevisionManifests(before, after);
  const oldContext = context(before), newContext = context(after);
  const changes = comparison.changes.map(change => {
    const oldItem = change.itemId && oldContext.items.get(`${change.timelineId}\0${change.itemId}`);
    const newItem = change.itemId && newContext.items.get(`${change.timelineId}\0${change.itemId}`);
    const tracks = new Set();
    for (const item of [oldItem, newItem]) {
      const label = item && trackLabel(item.track_type, item.track_index);
      if (label) tracks.add(label);
    }
    if (change.kind.startsWith('track-')) {
      const track = change.after || change.before;
      const label = trackLabel(change.trackType || track?.type, change.trackIndex || track?.index);
      if (label) tracks.add(label);
    }
    return { ...change, timelineName: newContext.timelines.get(change.timelineId)
      || oldContext.timelines.get(change.timelineId) || change.timelineId,
    itemName: newItem?.name || oldItem?.name || null,
    tracks: [...tracks], status: change.kind.endsWith('-added') ? 'added'
      : change.kind.endsWith('-deleted') ? 'deleted' : 'changed' };
  });
  const timelines = new Map(changes.map(change => [change.timelineId, change.timelineName]));
  const options = {
    timelines: [...timelines].map(([value, label]) => ({ value, label })),
    tracks: [...new Set(changes.flatMap(change => change.tracks))].sort(),
    statuses: [...new Set(changes.map(change => change.status))].sort(),
    kinds: [...new Set(changes.map(change => change.kind))].sort()
  };
  const filtered = changes.filter(change =>
    (!selected.timelineId || change.timelineId === selected.timelineId)
    && (!selected.track || change.tracks.includes(selected.track))
    && (!selected.status || change.status === selected.status)
    && (!selected.kind || change.kind === selected.kind));
  return { changeCount: changes.length, filteredCount: filtered.length,
    changes: filtered.slice(0, 100), options };
}
module.exports = { describeResolveHistoryChanges };
