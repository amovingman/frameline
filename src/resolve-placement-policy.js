'use strict';
// Deterministic review guidance over represented placements. This is never a
// merged timeline, an execution order, or authority to alter editor state.
const { validateResolveIdManifest } = require('./resolve-id-diff');
const ROLES = ['base', 'local', 'incoming'];
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tuple = value => JSON.stringify(value);
const invalid = () => { throw Object.assign(new Error('Invalid placement policy input.'), { code: 'invalid-resolve-placement-policy' }); };
const RULES = Object.freeze([
  ['preserve-observed-placement', 'Review each source’s absolute frame interval and observed track index. No source is silently shifted or rippled.'],
  ['half-open-frame-intervals', 'Intervals include the start frame and exclude the end frame. Adjacent intervals do not overlap.'],
  ['no-arbitrary-tie-break', 'Same-position additions and overlapping placements require review. Item IDs sort the report, never decide timeline placement.'],
  ['same-item-divergence', 'Different concurrent placements of the same retained item require a source choice; field choices do not prove a safe combined interval.'],
  ['indexed-tracks-only', 'Track indexes are observations, not persistent identities. Changed track layouts require manual verification.'],
  ['independent-is-review-only', 'Nonoverlapping concurrent placements remain separate observations. Their apparent independence does not authorize an automatic merge.'],
  ['no-ripple-or-neighbor-edit', 'Ordering guidance never moves neighbors, adjusts gaps, changes linked media, or infers transition or nested-sequence behavior.']
]);
function placement(item) {
  if (!item) return null;
  return { track: { type: item.trackType, index: item.trackIndex }, startFrame: item.startFrame, endFrame: item.endFrame,
    known: Number.isSafeInteger(item.startFrame) && Number.isSafeInteger(item.endFrame) && item.startFrame >= 0 && item.endFrame > item.startFrame };
}
function layout(timeline) {
  return timeline ? timeline.tracks.map(track => ({ type: track.type, index: track.index }))
    .sort((a, b) => cmp(a.type, b.type) || a.index - b.index) : null;
}
function status(b, l, i) {
  return same(l, i) ? 'already-applied' : same(b, l) ? 'incoming-only' : same(b, i) ? 'local-only' : 'conflict';
}
// Min-heap expiration avoids rescanning long active intervals at every event.
function heap() {
  const values = [];
  const before = (a, b) => a.endFrame - b.endFrame || cmp(a.id, b.id);
  return {
    add(value) {
      values.push(value); let index = values.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (before(values[parent], value) <= 0) break;
        values[index] = values[parent]; index = parent;
      }
      values[index] = value;
    },
    expire(frame, active) {
      while (values.length && values[0].endFrame <= frame) {
        active.delete(values[0].id);
        const last = values.pop(); if (!values.length) break;
        let index = 0;
        while (index * 2 + 1 < values.length) {
          let child = index * 2 + 1;
          if (child + 1 < values.length && before(values[child + 1], values[child]) < 0) child++;
          if (before(last, values[child]) <= 0) break;
          values[index] = values[child]; index = child;
        }
        values[index] = last;
      }
    }
  };
}

function createResolvePlacementPolicy(manifests, options = {}) {
  if (!manifests || Object.keys(manifests).length !== 3 || !ROLES.every(role => Object.hasOwn(manifests, role))) invalid();
  for (const role of ROLES) validateResolveIdManifest(manifests[role]);
  if (ROLES.some(role => manifests[role].projectId !== manifests.base.projectId
    || manifests[role].resolveVersion !== manifests.base.resolveVersion)) invalid();
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['maxChanges', 'maxInteractions', 'maxComparisons'].includes(key))) invalid();
  const limits = { maxChanges: 500, maxInteractions: 500, maxComparisons: 100000, ...options };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)
    || limits.maxChanges > 5000 || limits.maxInteractions > 5000 || limits.maxComparisons > 1000000) invalid();
  const timelines = Object.fromEntries(ROLES.map(role => [role, new Map(manifests[role].timelines.map(timeline => [timeline.id, timeline]))]));
  const timelineIds = [...new Set(ROLES.flatMap(role => [...timelines[role].keys()]))].sort(cmp);
  const changes = [], interactions = [], timelineReviews = [];
  let totalChanges = 0, observedInteractions = 0, comparisons = 0, analysisComplete = true;
  let changedTimelineCount = 0, unknownPlacementCount = 0;
  const concurrentPlacements = { local: 0, incoming: 0 };
  let rowBytes = 4096, outputByteLimitReached = false;
  function storeRow(rows, value, maximum) {
    if (outputByteLimitReached || rows.length >= maximum) return;
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (rowBytes + size > MAX_REPORT_BYTES) { outputByteLimitReached = true; return; }
    rowBytes += size; rows.push(value);
  }
  const addInteraction = value => { observedInteractions++; storeRow(interactions, value, limits.maxInteractions); };
  for (const timelineId of timelineIds) {
    const sourceTimelines = Object.fromEntries(ROLES.map(role => [role, timelines[role].get(timelineId)]));
    const layouts = ROLES.map(role => layout(sourceTimelines[role]));
    const layoutChanged = !same(layouts[0], layouts[1]) || !same(layouts[0], layouts[2]);
    const originChanged = sourceTimelines.base && ['local', 'incoming'].some(role => sourceTimelines[role]
      && sourceTimelines[role].startFrame !== sourceTimelines.base.startFrame);
    if (layoutChanged || originChanged) {
      changedTimelineCount++;
      storeRow(timelineReviews, { timelineId,
        reasons: [layoutChanged && 'track-layout-changed', originChanged && 'timeline-origin-changed'].filter(Boolean),
        base: layouts[0], local: layouts[1], incoming: layouts[2], requiresManualReview: true }, limits.maxChanges);
    }
    const items = Object.fromEntries(ROLES.map(role => [role, new Map((sourceTimelines[role]?.items || []).map(item => [item.id, item]))]));
    const ids = [...new Set(ROLES.flatMap(role => [...items[role].keys()]))].sort(cmp);
    const records = ids.map(id => {
      const values = Object.fromEntries(ROLES.map(role => [role, placement(items[role].get(id))]));
      return { id, ...values, localChanged: !same(values.base, values.local), incomingChanged: !same(values.base, values.incoming) };
    });
    const contextualRisks = record => {
      const represented = ROLES.map(role => items[role].get(record.id)).filter(Boolean);
      return [layoutChanged && 'track-layout-changed', originChanged && 'timeline-origin-changed',
        represented.some(item => item.linkedItemIds.length > 0) && 'linked-items-require-review',
        represented.some(item => !['video', 'audio'].includes(item.type)) && 'unsupported-item-type',
        represented.some(item => Object.values(item.effectCounts).some(value => value === null || value > 0)) && 'effects-or-unknown-effects-require-review'].filter(Boolean);
    };
    for (const record of records) {
      const unknown = ROLES.some(role => record[role] && !record[role].known);
      if (unknown) unknownPlacementCount++;
      if (record.localChanged) concurrentPlacements.local++;
      if (record.incomingChanged) concurrentPlacements.incoming++;
      if (!record.localChanged && !record.incomingChanged) continue;
      const reasons = contextualRisks(record);
      if (unknown) reasons.push('unknown-or-invalid-interval');
      if (record.localChanged && record.incomingChanged && !same(record.local, record.incoming)) reasons.push('same-item-divergent-placement');
      const kind = record.base === null ? 'addition' : record.local === null || record.incoming === null ? 'deletion'
        : !same(record.base.track, record.local.track) || !same(record.base.track, record.incoming.track)
          || record.base.startFrame !== record.local.startFrame || record.base.startFrame !== record.incoming.startFrame ? 'move' : 'trim';
      totalChanges++;
      storeRow(changes, { timelineId, itemId: record.id, kind,
        status: status(record.base, record.local, record.incoming), base: record.base, local: record.local, incoming: record.incoming,
        reasons, requiresManualReview: true, safeToApply: false }, limits.maxChanges);
    }
    // Sweep changed-local against all incoming, then changed-incoming against
    // unchanged-local. Existing neighbors participate, but unchanged pairs never
    // cause quadratic work. Each overlap candidate consumes a bounded budget.
    const groups = new Map();
    for (const record of records) for (const role of ['local', 'incoming']) {
      const value = record[role]; if (!value?.known) continue;
      const groupKey = tuple([value.track.type, value.track.index]);
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ ...value, id: record.id, role, changed: record[`${role}Changed`], added: record.base === null });
    }
    for (const [, group] of [...groups].sort(([a], [b]) => cmp(a, b))) {
      if (!analysisComplete) break;
      for (const pass of [0, 1]) {
        const events = group.filter(value => pass === 0 ? value.role === 'incoming' || value.changed
          : value.role === 'incoming' ? value.changed : !value.changed)
          .sort((a, b) => a.startFrame - b.startFrame || cmp(a.role, b.role) || cmp(a.id, b.id));
        const active = { local: new Map(), incoming: new Map() }, expiry = { local: heap(), incoming: heap() };
        for (const value of events) {
          expiry.local.expire(value.startFrame, active.local); expiry.incoming.expire(value.startFrame, active.incoming);
          const otherRole = value.role === 'local' ? 'incoming' : 'local';
          for (const other of active[otherRole].values()) {
            if (other.id === value.id) continue;
            if (comparisons >= limits.maxComparisons) { analysisComplete = false; break; }
            comparisons++;
            const pair = [value, other].sort((a, b) => cmp(a.id, b.id));
            const bothChanged = value.changed && other.changed;
            addInteraction({ timelineId, itemIds: pair.map(item => item.id), roles: pair.map(item => item.role),
              code: bothChanged && value.added && other.added && value.startFrame === other.startFrame ? 'same-position-concurrent-additions'
                : bothChanged ? 'cross-branch-placement-overlap' : 'existing-placement-overlap',
              track: value.track, interval: { startFrame: Math.max(value.startFrame, other.startFrame), endFrame: Math.min(value.endFrame, other.endFrame) },
              requiresManualReview: true, safeToApply: false });
          }
          if (!analysisComplete) break;
          active[value.role].set(value.id, value); expiry[value.role].add(value);
        }
        if (!analysisComplete) break;
      }
    }
  }
  interactions.sort((a, b) => cmp(a.timelineId, b.timelineId) || cmp(tuple(a.itemIds), tuple(b.itemIds))
    || cmp(tuple(a.roles), tuple(b.roles)) || cmp(a.code, b.code));
  return JSON.parse(JSON.stringify({ schemaVersion: 1, readOnly: true, safeToApply: false, automaticTimelineOrdering: false,
    intervalConvention: '[startFrame,endFrame)', displayOrdering: 'timeline-id/item-id', statusScope: 'observed-placement-only',
    analysisScope: 'known-absolute-intervals-on-observed-track-indexes', limits,
    rules: RULES.map(([code, description]) => ({ code, description })), changes, interactions, timelineReviews,
    summary: { totalChanges, shownChanges: changes.length, observedInteractions, shownInteractions: interactions.length,
      changedTimelineCount, shownTimelineReviews: timelineReviews.length, unknownPlacementCount,
      analysisComplete: analysisComplete && unknownPlacementCount === 0, comparisonLimitReached: !analysisComplete, comparisons,
      outputByteLimitReached,
      truncatedChanges: totalChanges - changes.length, truncatedInteractions: observedInteractions - interactions.length,
      truncatedTimelineReviews: changedTimelineCount - timelineReviews.length,
      concurrentPlacements,
      independence: !analysisComplete ? 'unverified-analysis-limit' : unknownPlacementCount || changedTimelineCount ? 'unverified-placement-context'
        : observedInteractions ? 'overlap-requires-review' : 'no-cross-source-overlap-observed' },
    warnings: ['This report compares captured placements only; no complete editor-equivalence or safe-apply claim is made.',
      'Report order is not timeline execution order. Track indexes do not establish persistent identity.',
      ...(unknownPlacementCount ? ['Unknown or invalid intervals are excluded from overlap analysis; unlisted interactions may exist.'] : []),
      ...(!analysisComplete ? ['Overlap analysis reached its comparison limit. Interaction counts are lower bounds; unlisted conflicts may exist.'] : []),
      ...(outputByteLimitReached || totalChanges > changes.length || observedInteractions > interactions.length || changedTimelineCount > timelineReviews.length
        ? ['Only bounded result rows are shown. Summary counts describe the analyzed observations, not a complete displayed list.'] : [])]
  }));
}
module.exports = { createResolvePlacementPolicy };
