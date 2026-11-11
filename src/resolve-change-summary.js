// Summarize a validated, ID-based Resolve diff without producing an edit plan.
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function summarizeResolveChanges(diff) {
  if (!diff || diff.schemaVersion !== 1 || diff.readOnly !== true || diff.safeToApply !== false
    || diff.trackIdentityStatus !== 'index-only' || !Array.isArray(diff.changes)) {
    throw new Error('invalid-resolve-diff');
  }
  const items = new Map();
  const otherChanges = [];
  for (const change of diff.changes) {
    if (typeof change.timelineId !== 'string' || typeof change.kind !== 'string') throw new Error('invalid-resolve-diff');
    if (change.itemId === undefined) { otherChanges.push(change); continue; }
    if (typeof change.itemId !== 'string') throw new Error('invalid-resolve-diff');
    const key = `${change.timelineId}\u0000${change.itemId}`;
    if (!items.has(key)) items.set(key, { timelineId: change.timelineId, itemId: change.itemId, changes: [] });
    items.get(key).changes.push(change);
  }
  const itemSummaries = [...items.values()].sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.itemId, b.itemId))
    .map(group => {
      const kinds = new Set();
      const fields = new Map(group.changes.filter(change => change.kind === 'item-changed').map(change => [change.field, change]));
      if (group.changes.some(change => change.kind === 'item-added')) kinds.add('added');
      if (group.changes.some(change => change.kind === 'item-deleted')) kinds.add('deleted');
      if (group.changes.some(change => change.kind === 'item-moved')) kinds.add('track-move');
      const oldStart = fields.get('startFrame')?.before;
      const newStart = fields.get('startFrame')?.after;
      const oldEnd = fields.get('endFrame')?.before;
      const newEnd = fields.get('endFrame')?.after;
      if (fields.has('startFrame') && oldStart !== newStart) kinds.add('position-change');
      if (fields.has('startFrame') || fields.has('endFrame')) {
        const startDelta = fields.has('startFrame') ? newStart - oldStart : 0;
        const endDelta = fields.has('endFrame') ? newEnd - oldEnd : 0;
        if (startDelta !== endDelta) kinds.add('duration-change');
      }
      if (fields.has('sourceStartFrame') || fields.has('sourceEndFrame')) kinds.add('source-range-change');
      if (fields.has('name')) kinds.add('rename');
      if (fields.has('type')) kinds.add('type-change');
      if (fields.has('mediaPoolId')) kinds.add('media-change');
      if (group.changes.some(change => change.kind === 'links-changed')) kinds.add('link-change');
      if (group.changes.some(change => change.kind === 'effects-changed')) kinds.add('effect-count-change');
      return { timelineId: group.timelineId, itemId: group.itemId, classifications: [...kinds].sort(compare), changes: group.changes };
    });
  return {
    schemaVersion: 1,
    readOnly: true,
    safeToApply: false,
    trackIdentityStatus: 'index-only',
    itemCount: itemSummaries.length,
    otherChangeCount: otherChanges.length,
    itemSummaries,
    otherChanges
  };
}

module.exports = { summarizeResolveChanges };
