'use strict';

// Research reports only. Track membership is a witness, never a generated ID.
const { createHash } = require('node:crypto');
const { parseEffectObservation, compareEffectObservations } = require('./resolve-effect-observation');
const { properties } = require('./resolve-property-contract.json');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (...parts) => JSON.stringify(parts);
const sorted = values => [...values].sort();
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ordering = (a, b) => cmp(key(a.timelineId, a.type, a.index), key(b.timelineId, b.type, b.index));

function pair(beforeBytes, afterBytes) {
  const before = parseEffectObservation(beforeBytes), after = parseEffectObservation(afterBytes);
  if (before.snapshot.project_id !== after.snapshot.project_id) throw new Error('integration-project-mismatch');
  return { before, after, sourceHashes: { before: hash(beforeBytes), after: hash(afterBytes) } };
}

function snapshotInput(bytes) {
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > 24 * 1024 * 1024) throw new Error('integration-input-invalid');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.schema_version === 3) return { snapshot: validateResolveSnapshot(value), observation: null };
  const observation = parseEffectObservation(bytes);
  return { snapshot: observation.snapshot, observation };
}

function inventory(bytes) {
  const { snapshot, observation } = snapshotInput(bytes);
  const timelines = snapshot.timelines.map(timeline => {
    const items = new Map(timeline.items.map(item => [item.id, item]));
    const counts = Object.create(null), linkIssues = [];
    let reciprocalDirectedLinks = 0;
    for (const item of timeline.items) {
      counts[item.type] = (counts[item.type] || 0) + 1;
      for (const linkedId of item.linked_item_ids) {
        const linked = items.get(linkedId);
        if (!linked || !linked.linked_item_ids.includes(item.id) || linkedId === item.id) {
          linkIssues.push({ itemId: item.id, linkedId, reason: !linked ? 'target-unobserved' : linkedId === item.id ? 'self-link' : 'not-reciprocal' });
        } else reciprocalDirectedLinks++;
      }
    }
    return { timelineId: timeline.id, tracks: timeline.tracks.length, items: timeline.items.length,
      itemTypes: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => cmp(a, b))),
      reciprocalLinkEdges: reciprocalDirectedLinks / 2,
      linkIssues: linkIssues.sort((a, b) => cmp(key(a.itemId, a.linkedId), key(b.itemId, b.linkedId))),
      effectSlots: timeline.items.reduce((n, item) => n + Object.values(item.effect_counts).reduce((sum, count) => sum + count, 0), 0) };
  }).sort((a, b) => cmp(a.timelineId, b.timelineId));
  return { schemaVersion: 1, readOnly: true, safeToApply: false, sourceSha256: hash(bytes), timelines,
    completeEnumerationProven: false, effectMetadataObserved: observation !== null, propertyMetadataObserved: observation?.schemaVersion === 2,
    unobserved: ['nested-contents', 'general-effect-parameters', 'persistent-effect-instance-identity', 'persistent-track-identity'] };
}

function tracks(snapshot) {
  return snapshot.timelines.flatMap(timeline => {
    const members = new Map();
    for (const item of timeline.items) {
      const location = key(item.track_type, item.track_index);
      if (!members.has(location)) members.set(location, []);
      members.get(location).push(item.id);
    }
    return timeline.tracks.map(track => ({ timelineId: timeline.id, type: track.type, index: track.index,
      members: (members.get(key(track.type, track.index)) || []).sort() }));
  }).sort(ordering);
}

function inspectIdentity(beforeBytes, afterBytes) {
  const before = snapshotInput(beforeBytes), after = snapshotInput(afterBytes);
  if (before.snapshot.project_id !== after.snapshot.project_id) throw new Error('integration-project-mismatch');
  const sourceHashes = { before: hash(beforeBytes), after: hash(afterBytes) };
  const oldTimelines = new Map(before.snapshot.timelines.map(t => [t.id, t]));
  const newTimelines = new Map(after.snapshot.timelines.map(t => [t.id, t]));
  const timelineChanges = [];
  for (const id of sorted(new Set([...oldTimelines.keys(), ...newTimelines.keys()]))) {
    const a = oldTimelines.get(id), b = newTimelines.get(id);
    const oldIds = new Set(a?.items.map(item => item.id) || []), newIds = new Set(b?.items.map(item => item.id) || []);
    timelineChanges.push({ timelineId: id, status: a && b ? 'retained' : a ? 'removed' : 'added',
      retainedItemIds: sorted([...oldIds].filter(value => newIds.has(value))),
      removedItemIds: sorted([...oldIds].filter(value => !newIds.has(value))),
      addedItemIds: sorted([...newIds].filter(value => !oldIds.has(value))) });
  }
  const oldTracks = tracks(before.snapshot), newTracks = tracks(after.snapshot);
  const targetByMember = new Map();
  for (const track of newTracks) for (const member of track.members) targetByMember.set(key(track.timelineId, member), track);
  const witnesses = oldTracks.map(track => {
    const candidates = new Map();
    for (const id of track.members) {
      const target = targetByMember.get(key(track.timelineId, id));
      if (target) {
        const location = key(target.timelineId, target.type, target.index);
        if (!candidates.has(location)) candidates.set(location, { timelineId: target.timelineId, type: target.type, index: target.index, sharedItemIds: [] });
        candidates.get(location).sharedItemIds.push(id);
      }
    }
    const list = [...candidates.values()].sort(ordering);
    return { timelineId: track.timelineId, type: track.type, index: track.index,
      status: list.length > 1 ? 'split-membership' : list.length === 1 ? 'membership-witness-only' : 'unresolved',
      reason: track.members.length ? 'Items can move independently of their track.' : 'Empty tracks provide no item witness.',
      candidateCount: list.length, candidates: list.slice(0, 40), candidatesTruncated: list.length > 40 };
  });
  return { schemaVersion: 1, readOnly: true, safeToApply: false, sourceHashes, timelineChanges,
    trackWitnesses: witnesses, stableTrackIdentityProven: false, durableExportMappingProven: false };
}

function fieldCoverage(bytes) {
  const observation = parseEffectObservation(bytes);
  if (observation.schemaVersion !== 2) return { status: 'unobserved', items: [], keys: [], unobservedTrackStates: null };
  const types = new Map(observation.snapshot.timelines.flatMap(t => t.items.map(item => [key(t.id, item.id), item.type])));
  const rows = observation.items.map(item => ({ timelineId: item.timelineId, itemId: item.itemId,
    itemType: types.get(key(item.timelineId, item.itemId)), readStatus: item.propertyReadStatus,
    returnedKeys: Object.keys(item.properties).sort(),
    unobservedDocumentedKeys: Object.keys(properties).filter(name => !Object.hasOwn(item.properties, name)).sort() }))
    .sort((a, b) => cmp(key(a.timelineId, a.itemId), key(b.timelineId, b.itemId)));
  const keys = Object.keys(properties).sort().map(name => ({ name, observedItems: rows.filter(item => item.returnedKeys.includes(name)).length,
    unobservedItems: rows.filter(item => !item.returnedKeys.includes(name)).length, activeTimelineOnly: properties[name].activeTimelineOnly === true }));
  return { status: 'returned-keys-only', items: rows, keys,
    unobservedTrackStates: observation.tracks.reduce((n, track) => n + Number(track.enabled === null) + Number(track.locked === null), 0) };
}

// An exact allowlist describes an experiment, not a permission to write.
// Currently only one represented item-name change is understood by this report.
function inspectPreservation(beforeBytes, afterBytes, { expectedRename = null } = {}) {
  const { before, after, sourceHashes } = pair(beforeBytes, afterBytes);
  if (expectedRename !== null && (!expectedRename || Object.keys(expectedRename).sort().join(',') !== 'after,before,itemId,timelineId'
    || Object.values(expectedRename).some(value => typeof value !== 'string' || !value || /[\\/\x00-\x1f\x7f]/.test(value))
    || expectedRename.before === expectedRename.after)) throw new Error('integration-invalid-expected-rename');
  if (expectedRename) {
    const find = observation => observation.snapshot.timelines.find(t => t.id === expectedRename.timelineId)?.items.find(item => item.id === expectedRename.itemId);
    if (find(before)?.name !== expectedRename.before || find(after)?.name !== expectedRename.after) throw new Error('integration-expected-rename-mismatch');
  }
  const diff = compareEffectObservations(beforeBytes, afterBytes);
  const projectChanges = before.snapshot.project_name === after.snapshot.project_name ? []
    : [{ field: 'projectName', before: before.snapshot.project_name, after: after.snapshot.project_name }];
  const expectedChanges = [], unexpectedSnapshotChanges = [];
  for (const change of diff.snapshotChanges) {
    if (expectedRename && change.kind === 'item-changed' && change.field === 'name'
      && change.timelineId === expectedRename.timelineId && change.itemId === expectedRename.itemId
      && change.before === expectedRename.before && change.after === expectedRename.after) expectedChanges.push(change);
    else unexpectedSnapshotChanges.push(change);
  }
  if (expectedRename && expectedChanges.length !== 1) throw new Error('integration-expected-rename-mismatch');
  const beforeCoverage = fieldCoverage(beforeBytes), afterCoverage = fieldCoverage(afterBytes);
  const representedStateMatches = projectChanges.length === 0 && unexpectedSnapshotChanges.length === 0 && diff.effectChanges.length === 0
    && Array.isArray(diff.propertyChanges) && diff.propertyChanges.length === 0
    && Array.isArray(diff.trackStateChanges) && diff.trackStateChanges.length === 0 && diff.activeTimelineChange === null;
  const readsAvailable = observation => observation.schemaVersion === 2
    && observation.items.every(item => item.propertyReadStatus === 'captured' && Object.keys(item.properties).length > 0)
    && observation.tracks.every(track => track.enabled !== null && track.locked !== null);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, sourceHashes,
    expectedChanges, projectChanges, unexpectedSnapshotChanges, effectChanges: diff.effectChanges, propertyChanges: diff.propertyChanges,
    trackStateChanges: diff.trackStateChanges, activeTimelineChange: diff.activeTimelineChange,
    representedStateMatches, representedReadsAvailable: readsAvailable(before) && readsAvailable(after),
    beforeCoverage, afterCoverage, losslessRoundTripProven: false,
    limitations: ['Unreturned documented keys have unknown applicability; they are not defaults.',
      'General effect parameters, nested contents and opaque native state are not compared.',
      'Matching observations do not establish lossless preservation or stable track identity.'] };
}

module.exports = { inventory, inspectIdentity, fieldCoverage, inspectPreservation };
