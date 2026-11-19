'use strict';
const { assessResolveRiskGates, CATEGORIES } = require('./resolve-risk-gates');
const { validateResolveIdManifest } = require('./resolve-id-diff');
const { properties } = require('./resolve-property-contract.json');
const ROLES = ['base', 'local', 'incoming'];
const MAX_DECISIONS = 20000, MAX_CONTEXT_COMPARISONS = 50000, MAX_REPORT_BYTES = 8 * 1024 * 1024;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = (...parts) => JSON.stringify(parts);
const fail = () => { throw Object.assign(new Error('Invalid Resolve review risk policy.'), { code: 'invalid-resolve-review-risk-policy' }); };
const FIELDS = new Set(['type', 'name', 'startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame', 'mediaPoolId',
  'linkedItemIds', 'effectCounts.fusion', 'effectCounts.ofx', 'effectCounts.audio', 'existence', 'track', 'tracks']);
const DESCRIPTIONS = Object.freeze({
  'transition-coverage-unknown': 'Transition coverage is incomplete. A review choice cannot prove transition safety.',
  'nested-coverage-unknown': 'Nested and compound contents are not completely represented and remain blocked.',
  'ripple-semantics-unknown': 'Ripple behavior is unproven. No neighbor, gap, or downstream clip is moved automatically.',
  'linked-coverage-unknown': 'Link observations do not establish complete linked-media behavior.',
  'timing-ripple-review-required': 'Timing, source range, existence, or track changes need editor validation for interactions.',
  'linked-clips-review-required': 'Observed links or reciprocal links require joint review of the linked entities.',
  'transition-observed': 'A represented transition item is involved and cannot be applied automatically.',
  'unsupported-or-nested-item': 'An unsupported or potentially nested item is involved.',
  'unresolved-conflict': 'The represented sources disagree. A recorded choice remains review intent only.',
  'neighbor-interval-overlap': 'The affected clip overlaps a represented neighbor on an observed track.',
  'neighbor-boundary-adjacent': 'An adjacent clip shares a boundary; ripple and transition interactions remain unproven.',
  'transition-or-nested-neighbor': 'An adjacent or overlapping neighbor is a transition or unsupported item.',
  'context-analysis-incomplete': 'Unknown intervals or the bounded analysis limit leave additional interactions unverified.',
  'read-only-risk-assessment': 'Every result is blocked for editor apply, including after all conflicts are decided.'
});
function validField(field) {
  return FIELDS.has(field) || typeof field === 'string' && (
    field.startsWith('properties.') && Object.hasOwn(properties, field.slice(11))
    || /^effectSlots\.(fusion|ofx|audio)\.[1-9]\d{0,8}$/.test(field)
    || /^trackState\.(video|audio|subtitle)\.[1-9]\d{0,8}\.(enabled|locked)$/.test(field));
}
const known = item => Number.isSafeInteger(item.startFrame) && Number.isSafeInteger(item.endFrame)
  && item.endFrame > item.startFrame;
const unsupported = item => !['video', 'audio'].includes(item.type);
const trackKey = item => key(item.trackType, item.trackIndex);

function createResolveReviewRiskPolicy(classification, manifests) {
  try {
    if (!manifests || Object.keys(manifests).length !== 3 || !ROLES.every(role => Object.hasOwn(manifests, role))) fail();
    for (const role of ROLES) validateResolveIdManifest(manifests[role]);
    if (ROLES.some(role => manifests[role].projectId !== manifests.base.projectId
      || manifests[role].resolveVersion !== manifests.base.resolveVersion)
      || classification?.projectId !== manifests.base.projectId || classification?.resolveVersion !== manifests.base.resolveVersion
      || !Array.isArray(classification.decisions) || classification.decisions.length > MAX_DECISIONS) fail();
    const baseline = assessResolveRiskGates(classification);
    const indexes = Object.fromEntries(ROLES.map(role => [role, new Map(manifests[role].timelines.map(timeline => {
      const items = new Map(timeline.items.map(item => [item.id, item]));
      const links = new Map(), intervals = new Map(), unknownTracks = new Set();
      const link = (a, b) => { if (!links.has(a)) links.set(a, new Set()); links.get(a).add(b); };
      for (const item of timeline.items) {
        if (item.id.length > 2048 || timeline.id.length > 2048) fail();
        for (const id of item.linkedItemIds) { link(item.id, id); link(id, item.id); }
        const track = trackKey(item);
        if (!known(item)) unknownTracks.add(track);
        else { if (!intervals.has(track)) intervals.set(track, []); intervals.get(track).push(item); }
      }
      for (const values of intervals.values()) values.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame || cmp(a.id, b.id));
      return [timeline.id, { items, links, intervals, unknownTracks }];
    }))]));
    let comparisons = 0, limitReached = false;
    const cache = new Map();
    function context(timelineId, itemId) {
      const anchor = key(timelineId, itemId); if (cache.has(anchor)) return cache.get(anchor);
      const links = new Set(), overlaps = new Set(), adjacent = new Set(), risky = new Set();
      let complete = true;
      const transitions = new Set(), nested = new Set();
      for (const role of ROLES) {
        const timeline = indexes[role].get(timelineId); if (!timeline) continue;
        if (itemId === null) {
          for (const id of timeline.links.keys()) links.add(id);
          for (const value of timeline.items.values()) {
            if (/transition/i.test(value.type)) transitions.add(value.id);
            if (unsupported(value)) nested.add(value.id);
          }
          complete = false; // A whole timeline cannot establish complete ripple/nested semantics.
          continue;
        }
        const item = timeline.items.get(itemId); if (!item) continue;
        for (const id of timeline.links.get(itemId) || []) links.add(id);
        if (/transition/i.test(item.type)) transitions.add(item.id);
        if (unsupported(item)) nested.add(item.id);
        const track = trackKey(item);
        if (!known(item) || timeline.unknownTracks.has(track)) complete = false;
        if (!known(item)) continue;
        for (const neighbor of timeline.intervals.get(track) || []) {
          if (neighbor.startFrame > item.endFrame) break;
          if (neighbor.id === itemId) continue;
          if (comparisons >= MAX_CONTEXT_COMPARISONS) { limitReached = true; complete = false; break; }
          comparisons++;
          const overlapsItem = neighbor.startFrame < item.endFrame && neighbor.endFrame > item.startFrame;
          const touchesItem = neighbor.startFrame === item.endFrame || neighbor.endFrame === item.startFrame;
          if (overlapsItem) overlaps.add(neighbor.id);
          if (touchesItem) adjacent.add(neighbor.id);
          if ((overlapsItem || touchesItem) && unsupported(neighbor)) risky.add(neighbor.id);
        }
      }
      const result = { linkedItemCount: links.size, overlappingNeighborCount: overlaps.size, adjacentNeighborCount: adjacent.size,
        transitionOrNestedNeighborCount: risky.size, transitionItemCount: transitions.size, unsupportedItemCount: nested.size, contextComplete: complete };
      cache.set(anchor, result); return result;
    }
    const records = baseline.decisions.map(decision => {
      if (!validField(decision.field) || !ROLES.some(role => {
        const timeline = indexes[role].get(decision.timelineId);
        return timeline && (decision.itemId === null || timeline.items.has(decision.itemId));
      })) fail();
      const observed = context(decision.timelineId, decision.itemId);
      const codes = new Set(decision.warningCodes), blocked = new Set(decision.riskCategories.filter(row => row.status === 'blocked').map(row => row.category));
      if (observed.linkedItemCount) { codes.add('linked-clips-review-required'); blocked.add('linked-clips'); }
      if (observed.overlappingNeighborCount) { codes.add('neighbor-interval-overlap'); blocked.add('timing-ripple'); }
      if (observed.adjacentNeighborCount) { codes.add('neighbor-boundary-adjacent'); blocked.add('timing-ripple'); }
      if (observed.transitionOrNestedNeighborCount) { codes.add('transition-or-nested-neighbor'); blocked.add('transitions'); blocked.add('nested-unknown'); }
      if (observed.transitionItemCount) { codes.add('transition-observed'); blocked.add('transitions'); }
      if (observed.unsupportedItemCount) { codes.add('unsupported-or-nested-item'); blocked.add('nested-unknown'); }
      if (!observed.contextComplete) codes.add('context-analysis-incomplete');
      return { timelineId: decision.timelineId, itemId: decision.itemId, field: decision.field, status: decision.status,
        gate: 'blocked', riskCategories: CATEGORIES.map(category => ({ category, status: blocked.has(category) ? 'blocked' : 'unknown' })),
        warningCodes: [...codes].sort(cmp), context: observed };
    });
    const codes = [...new Set([...baseline.warningCodes, ...records.flatMap(record => record.warningCodes)])].sort(cmp);
    const result = { schemaVersion: 1, readOnly: true, safeToApply: false, gate: 'blocked', coverage: 'observed-fields-only',
      warnings: codes.map(code => ({ code, description: DESCRIPTIONS[code] || DESCRIPTIONS['read-only-risk-assessment'] })), decisions: records,
      summary: { decisionCount: records.length, contextComplete: records.every(record => record.context.contextComplete),
        comparisons, comparisonLimitReached: limitReached }, limits: { maxDecisions: MAX_DECISIONS, maxContextComparisons: MAX_CONTEXT_COMPARISONS, maxReportBytes: MAX_REPORT_BYTES } };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_REPORT_BYTES) fail();
    return JSON.parse(JSON.stringify(result));
  } catch { fail(); }
}
module.exports = { createResolveReviewRiskPolicy, MAX_DECISIONS, MAX_CONTEXT_COMPARISONS, MAX_REPORT_BYTES };
