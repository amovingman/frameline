'use strict';
const { compareResolveRevisionManifests } = require('./resolve-revision-comparison');
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const { createResolvePreviewPlan } = require('./resolve-preview-plan');
const { createResolveConflictReview } = require('./resolve-review-decisions');
const { indexResolveSnapshotContext } = require('./resolve-change-context');

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
  const oldFrames = indexResolveSnapshotContext(before.snapshot), newFrames = indexResolveSnapshotContext(after.snapshot);
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
    const observedTrack = change.after || change.before;
    const type = change.trackType || observedTrack?.type, index = change.trackIndex || observedTrack?.index;
    const contextField = change.kind.startsWith('track-') && type && Number.isSafeInteger(index)
      ? `trackState.${type}.${index}.${change.field || 'existence'}` : change.field || '';
    return { ...change, beforeContext: oldFrames.context(change.timelineId, change.itemId ?? null, contextField),
      afterContext: newFrames.context(change.timelineId, change.itemId ?? null, contextField),
      timelineName: newContext.timelines.get(change.timelineId)
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
    changes: filtered.slice(0, 100), options, coverage: comparison.coverage };
}
function describeResolveHistoryAudit(manifest, offset = 0) {
  validateResolveRevisionManifest(manifest);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid();
  const audit = manifest.transactionAudit;
  if (!audit) {
    if (offset !== 0) invalid();
    return { available: false, readOnly: true, safeToApply: false };
  }
  if (offset > Math.max(0, audit.review.choices.length - 1)) invalid();
  const plan = createResolvePreviewPlan(audit.sources);
  const conflicts = new Map(createResolveConflictReview(plan, audit.sources).conflicts.map(item => [item.id, item]));
  const contexts = ['local', 'incoming', 'base'].map(role => context({ snapshot: JSON.parse(audit.sources[role]) }));
  const present = value => {
    const text = value === undefined ? 'Not present' : JSON.stringify(value, null, 2);
    return { text: text.slice(0, 1200), truncated: text.length > 1200, characterCount: text.length };
  };
  const choices = audit.review.choices.slice(offset, offset + 20).map(choice => {
    const conflict = conflicts.get(choice.conflictId);
    const timelineName = contexts.map(source => source.timelines.get(choice.timelineId)).find(Boolean);
    const item = contexts.map(source => source.items.get(`${choice.timelineId}\0${choice.itemId}`)).find(Boolean);
    return { conflictId: choice.conflictId, timelineId: choice.timelineId, timelineName: timelineName || choice.timelineId,
      itemId: choice.itemId, itemName: item?.name || null, track: item ? trackLabel(item.track_type, item.track_index) : null,
      field: choice.field, choice: choice.choice, base: present(conflict.base), local: present(conflict.local),
      incoming: present(conflict.incoming), selected: present(choice.selectedValue) };
  });
  const effectItems = audit.effects ? JSON.parse(audit.effects.after).items : null;
  return { available: true, transactionId: audit.transactionId, auditHash: manifest.transactionAuditHash,
    status: audit.outcome.status, recordedAt: audit.outcome.recordedAt, provenance: audit.provenance,
    choiceCount: audit.review.choices.length, offset, choices,
    previousOffset: offset ? Math.max(0, offset - 20) : null,
    nextOffset: offset + choices.length < audit.review.choices.length ? offset + choices.length : null,
    sourceHashes: structuredClone(audit.review.binding.hashes),
    resultSnapshotHash: audit.outcome.resultingSnapshotSha256,
    backup: { sha256: JSON.parse(audit.issuedRecord).backup.sha256, availability: 'not-checked', included: false },
    effects: effectItems ? { itemCount: effectItems.length, effectCount: effectItems.reduce((sum, item) => sum + item.effects.length, 0),
      sourceHash: audit.outcome.effectObservation.sourceSha256, resultHash: audit.outcome.effectObservation.resultingSha256 } : null,
    recovery: audit.recovery ? { attemptId: audit.recovery.binding.attemptId, operation: audit.recovery.binding.operation,
      inspectionHash: audit.recovery.binding.inspectionSha256 } : null,
    readOnly: true, safeToApply: false };
}
module.exports = { describeResolveHistoryChanges, describeResolveHistoryAudit };
