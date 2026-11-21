'use strict';
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');
const { equivalentObservationValue } = require('./resolve-observation-values');
const MAX_BYTES = 2 * 1024 * 1024;
const fields = ['clipEnabled', 'speed', 'fades', 'outputBlanking', 'usesTimelineOutputBlanking', 'fusionCompCount', 'firstColorLayerNodeCount'];
const dictionary = {
  speed: { Percentage: 'decimal', PitchCorrection: 'boolean', StretchKeyframesToFit: 'boolean', RippleTimeline: 'boolean' },
  fades: { FadeIn: 'integer', FadeOut: 'integer' },
  outputBlanking: { Top: 'integer', Bottom: 'integer', Left: 'integer', Right: 'integer' }
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const key = item => JSON.stringify([item.timelineId, item.itemId]);
function fail() { throw new Error('invalid-item-state-observation'); }
function plain(value, depth = 0) {
  if (value === null || typeof value !== 'object') return;
  if (depth > 40 || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) fail();
  if (Array.isArray(value) && Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (const name of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && name !== 'length')) fail();
    plain(descriptor.value, depth + 1);
  }
}
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail();
}
function atom(value, type) {
  if (type === 'boolean') { if (typeof value !== 'boolean') fail(); return; }
  if (type === 'integer') { if (!Number.isSafeInteger(value)) fail(); return; }
  exact(value, ['decimal']);
  if (typeof value.decimal !== 'string' || !/^-?\d\.\d{16}e[+-]\d{2,3}$/.test(value.decimal)
    || !Number.isFinite(Number(value.decimal)) || (Number(value.decimal) === 0 && /[1-9]/.test(value.decimal.split('e')[0]))) fail();
}
function validateReadingContents(observation) {
  if (observation.colorGraphScope !== 'first-layer-count-only' || observation.colorGraphReadPolicy !== 'color-page-only'
    || ![null,'media','photo','cut','edit','fusion','color','fairlight','deliver'].includes(observation.capturePage)
    || !Array.isArray(observation.items) || observation.items.length > 200) fail();
  validateResolveSnapshot(observation.snapshot);
  if (observation.snapshot.timelines.length > 20 || observation.snapshot.timelines.reduce((n, timeline) => n + timeline.tracks.length, 0) > 200) fail();
  if (observation.activeTimelineId !== null && !observation.snapshot.timelines.some(t => t.id === observation.activeTimelineId)) fail();
  const expected = new Set(observation.snapshot.timelines.flatMap(t => t.items.map(item => JSON.stringify([t.id, item.id]))));
  if (expected.size !== observation.items.length) fail();
  for (const item of observation.items) {
    exact(item, ['timelineId', 'itemId', ...fields]);
    if (!expected.delete(key(item))) fail();
    for (const field of fields) {
      const read = item[field]; exact(read, ['status', 'value']);
      if (read.status === 'unavailable') { if (read.value !== null) fail(); continue; }
      if (read.status !== 'captured') fail();
      if (field === 'firstColorLayerNodeCount' && observation.capturePage !== 'color') fail();
      if (dictionary[field]) {
        if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) fail();
        for (const [name, value] of Object.entries(read.value)) {
          if (!Object.hasOwn(dictionary[field], name)) fail();
          atom(value, dictionary[field][name]);
        }
      } else if (field.endsWith('Count')) {
        if (!Number.isSafeInteger(read.value) || read.value < 0) fail();
      } else atom(read.value, 'boolean');
    }
  }
  return observation;
}
function validateItemStateObservation(observation) {
  plain(observation);
  exact(observation, ['schemaVersion', 'operation', 'readOnly', 'safeToApply', 'snapshot', 'activeTimelineId', 'items',
    'capturePasses', 'representedStateUnchangedAcrossReads', 'colorGraphScope', 'capturePage', 'colorGraphReadPolicy', 'readOrderPolicy']);
  if (observation.schemaVersion !== 1 || observation.operation !== 'resolve-item-state-observation' || observation.readOnly !== true
    || observation.safeToApply !== false || observation.capturePasses !== 2 || observation.representedStateUnchangedAcrossReads !== true
    || observation.readOrderPolicy !== 'color-graph-before-item-state') fail();
  return validateReadingContents(observation);
}
function validateItemStateReading(reading) {
  plain(reading);
  exact(reading, ['snapshot', 'activeTimelineId', 'items', 'colorGraphScope', 'capturePage', 'colorGraphReadPolicy']);
  return validateReadingContents(reading);
}
function parseItemStateObservation(bytes) {
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > MAX_BYTES) fail();
  return validateItemStateObservation(JSON.parse(bytes.toString('utf8')));
}
function describeItemStateCoverage(observation) {
  validateItemStateObservation(observation);
  return { itemCount: observation.items.length,
    reads: Object.fromEntries(fields.map(field => [field, {
      captured: observation.items.filter(item => item[field].status === 'captured').length,
      unavailable: observation.items.filter(item => item[field].status === 'unavailable').length,
      ...(dictionary[field] ? { returnedKeys: Object.fromEntries(Object.keys(dictionary[field]).map(name => [name,
        observation.items.filter(item => item[field].status === 'captured' && Object.hasOwn(item[field].value, name)).length])) } : {})
    }])), completeEditorStateObserved: false, colorGraphScope: observation.colorGraphScope,
    capturePage: observation.capturePage, colorGraphReadPolicy: observation.colorGraphReadPolicy, readOrderPolicy: observation.readOrderPolicy };
}
function itemStateDiff(oldItems, newItems) {
  const a = new Map(oldItems.map(item => [key(item), item])), b = new Map(newItems.map(item => [key(item), item]));
  const changes = [];
  for (const identity of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const old = a.get(identity), current = b.get(identity), reference = current || old;
    for (const field of fields) {
      if (!equivalentObservationValue(old?.[field] ?? null, current?.[field] ?? null)) changes.push({ timelineId: reference.timelineId,
        itemId: reference.itemId, field, before: old?.[field] ?? null, after: current?.[field] ?? null });
    }
  }
  return changes;
}
function compareItemStateReadings(before, after) {
  validateItemStateReading(before); validateItemStateReading(after);
  if (before.snapshot.project_id !== after.snapshot.project_id) throw new Error('item-state-project-mismatch');
  return { readOnly: true, safeToApply: false, stableObservationAccepted: false,
    itemStateChanges: itemStateDiff(before.items, after.items),
    snapshotChanges: compareResolveManifests(normalizeResolveSnapshot(before.snapshot), normalizeResolveSnapshot(after.snapshot)).changes,
    capturePageChange: before.capturePage === after.capturePage ? null : { before: before.capturePage, after: after.capturePage },
    activeTimelineChange: before.activeTimelineId === after.activeTimelineId ? null : { before: before.activeTimelineId, after: after.activeTimelineId } };
}
function compareItemStateObservations(beforeBytes, afterBytes) {
  const before = parseItemStateObservation(beforeBytes), after = parseItemStateObservation(afterBytes);
  if (before.snapshot.project_id !== after.snapshot.project_id) throw new Error('item-state-project-mismatch');
  const diff = compareResolveManifests(normalizeResolveSnapshot(before.snapshot), normalizeResolveSnapshot(after.snapshot));
  const changes = itemStateDiff(before.items, after.items);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, sourceHashes: { before: sha(beforeBytes), after: sha(afterBytes) },
    snapshotChanges: diff.changes, itemStateChanges: changes,
    activeTimelineChange: before.activeTimelineId === after.activeTimelineId ? null : { before: before.activeTimelineId, after: after.activeTimelineId },
    capturePageChange: before.capturePage === after.capturePage ? null : { before: before.capturePage, after: after.capturePage },
    beforeCoverage: describeItemStateCoverage(before), afterCoverage: describeItemStateCoverage(after), losslessRoundTripProven: false,
    limitations: ['Unreturned keys and unavailable reads are unobserved, with unknown applicability.',
      'Speed options do not enumerate variable-retime keyframes or complete retime semantics.',
      'The timeline output-blanking values used by an inheriting item remain unobserved.',
      'Composition and first-layer node counts do not enumerate graph contents or node identity.',
      'Native opaque fields, effect parameters and nested contents remain unobserved.'] };
}
module.exports = { validateItemStateObservation, parseItemStateObservation, describeItemStateCoverage, compareItemStateObservations,
  validateItemStateReading, compareItemStateReadings };
