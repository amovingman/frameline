'use strict';
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { assessResolvePlan } = require('./resolve-plan-policy');
const ROLES = ['base', 'local', 'incoming'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = (...values) => JSON.stringify(values);
const display = value => typeof value === 'string' ? value.slice(0, 160) : null;
const trackLabel = track => track ? track.type === 'video' ? `V${track.index}` : track.type === 'audio' ? `A${track.index}` : `${track.type} ${track.index}` : null;
const invalid = () => Object.assign(new Error('Invalid Resolve change context.'), { code: 'invalid-resolve-change-context' });

function indexResolveSnapshotContext(snapshot) {
  validateResolveSnapshot(snapshot);
  const timelines = new Map(snapshot.timelines.map(timeline => [timeline.id, timeline]));
  const items = new Map(), neighbors = new Map();
  for (const timeline of snapshot.timelines) {
    const groups = new Map();
    for (const item of timeline.items) {
      items.set(key(timeline.id, item.id), item);
      const label = key(item.track_type, item.track_index);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => (a.start_frame ?? Number.MAX_SAFE_INTEGER) - (b.start_frame ?? Number.MAX_SAFE_INTEGER)
        || (a.end_frame ?? Number.MAX_SAFE_INTEGER) - (b.end_frame ?? Number.MAX_SAFE_INTEGER) || compare(a.id, b.id));
      group.forEach((item, index) => neighbors.set(key(timeline.id, item.id), [group[index - 1], group[index + 1]].filter(Boolean)
        .map(value => ({ id: value.id, name: display(value.name), startFrame: value.start_frame, endFrame: value.end_frame }))));
    }
  }
  return {
    context(timelineId, itemId, field = '') {
      const timeline = timelines.get(timelineId), item = itemId === null ? null : items.get(key(timelineId, itemId));
      const trackField = /^trackState\.([^.]+)\.(\d+)\./.exec(field);
      const track = timeline && (item ? timeline.tracks.find(value => value.type === item.track_type && value.index === item.track_index)
        : trackField ? timeline.tracks.find(value => value.type === trackField[1] && value.index === Number(trackField[2])) : null);
      return { present: Boolean(timeline && (itemId === null ? !trackField || track : item)), timelineName: timeline ? display(timeline.name) : null,
        timelineOriginFrame: timeline?.start_frame ?? null,
        track: track ? { type: track.type, index: track.index, name: display(track.name) } : null,
        itemName: item ? display(item.name) : null,
        startFrame: item?.start_frame ?? null, endFrame: item?.end_frame ?? null,
        sourceStartFrame: item?.source_start_frame ?? null, sourceEndFrame: item?.source_end_frame ?? null,
        neighbors: item ? neighbors.get(key(timelineId, itemId)).map(value => ({ ...value })) : [] };
    },
    trackLabels(timelineId) {
      return (timelines.get(timelineId)?.tracks || []).map(trackLabel);
    }
  };
}
function kindFor(decision) {
  const { field, itemId } = decision;
  if (field === 'existence') return `${itemId === null ? 'timeline' : 'clip'}-${decision.base === null ? 'addition' : 'deletion'}`;
  if (field.startsWith('properties.')) return 'property';
  if (field.startsWith('effectSlots.') || field.startsWith('effectCounts.')) return 'effect';
  if (field.startsWith('trackState.')) return 'track-state';
  if (['track', 'tracks'].includes(field)) return 'track';
  if (['startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame'].includes(field)) return 'timing';
  if (field === 'linkedItemIds') return 'links';
  if (field === 'mediaPoolId') return 'media';
  return itemId === null ? 'timeline-property' : 'clip-property';
}
function consequence(decision, role, kind) {
  const local = role === 'local', side = local ? 'local' : 'incoming', other = local ? 'incoming' : 'local';
  const noun = decision.itemId === null ? 'timeline and its represented contents' : 'clip';
  if (decision.field === 'existence') {
    if (decision[role] === null) return { action: 'record-deletion', description: `Record ${side} absence of this ${noun}. The ${other} represented entity and edits are not retained by this choice. No editor deletion is performed.` };
    return { action: decision[other] === null ? 'record-retention-or-restoration' : 'record-entity-version',
      description: `Record the ${side} ${noun} with its represented values${decision[other] === null ? ` instead of ${other} deletion` : ` instead of the ${other} version`}. No entity is created or restored in the editor.` };
  }
  const label = display(decision.field);
  const caution = kind === 'timing' || kind === 'track'
    ? ' Combining frame or track choices may create invalid intervals or overlaps. No ripple or neighbor movement is implied.'
    : kind === 'links' ? ' Linked audio/video synchronization remains unproven.'
      : kind === 'effect' ? ' Effect parameters and persistent effect-instance identity remain unproven.'
        : kind === 'track-state' ? ' This is an observed track index, not a persistent track identity.'
          : kind === 'media' ? ' A media-pool ID does not establish media availability or verified bytes.' : '';
  return { action: 'record-observed-value', description: `Record the ${side} observed value for ${label}; the divergent ${other} value is not selected.${caution} This records review intent without changing the editor.` };
}
function createResolveChangeContext(documents, classification) {
  try {
    if (!documents || Object.keys(documents).length !== 3 || !ROLES.every(role => documents[role]?.snapshot)) throw invalid();
    assessResolvePlan(classification);
    const snapshots = ROLES.map(role => documents[role].snapshot);
    for (const snapshot of snapshots) validateResolveSnapshot(snapshot);
    if (snapshots.some(snapshot => snapshot.project_id !== snapshots[0].project_id || snapshot.resolve_version !== snapshots[0].resolve_version)
      || classification.projectId !== snapshots[0].project_id || classification.resolveVersion !== snapshots[0].resolve_version) throw invalid();
    const indexes = Object.fromEntries(ROLES.map(role => [role, indexResolveSnapshotContext(documents[role].snapshot)]));
    const records = classification.decisions.map(decision => {
      const roles = Object.fromEntries(ROLES.map(role => [role, indexes[role].context(decision.timelineId, decision.itemId, decision.field)]));
      if (!ROLES.some(role => roles[role].present)) throw invalid();
      const contexts = ['local', 'incoming', 'base'].map(role => roles[role]), kind = kindFor(decision);
      return { timelineId: decision.timelineId, itemId: decision.itemId, field: decision.field, status: decision.status, kind,
        tracks: [...new Set(ROLES.flatMap(role => decision.itemId === null && ['tracks', 'existence'].includes(decision.field)
          ? indexes[role].trackLabels(decision.timelineId) : [trackLabel(roles[role].track)]).filter(Boolean))].sort(compare),
        timelineName: contexts.map(value => value.timelineName).find(Boolean) || display(decision.timelineId),
        itemName: contexts.map(value => value.itemName).find(Boolean) || null,
        roles, consequences: { 'keep-local': consequence(decision, 'local', kind), 'take-incoming': consequence(decision, 'incoming', kind) } };
    }).sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.itemId || '', b.itemId || '') || compare(a.field, b.field));
    return { schemaVersion: 1, readOnly: true, safeToApply: false, records,
      warnings: ['Context covers represented observations only. Display names may be shortened to 160 characters.',
        'Track indexes and neighboring observations do not establish persistent track identity or safe ripple behavior.',
        'Frame rate is not captured by schema-3 snapshots. Timecode requires an explicitly user-selected display rate.'] };
  } catch { throw invalid(); }
}
module.exports = { createResolveChangeContext, indexResolveSnapshotContext, kindFor };
