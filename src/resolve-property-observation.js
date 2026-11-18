'use strict';
const contract = require('./resolve-property-contract.json');
const specs = contract.properties;
const decimal = /^-?\d\.\d{16}e[+-]\d{2,3}$/;
function invalid() { throw new Error('invalid-property-observation'); }
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...names].sort().join('|')) invalid();
}
function validatePropertySections(observation) {
  const timelineIds = new Set(observation.snapshot.timelines.map(timeline => timeline.id));
  if (observation.activeTimelineId !== null && !timelineIds.has(observation.activeTimelineId)) invalid();
  for (const item of observation.items) {
    if (!['captured', 'unavailable'].includes(item.propertyReadStatus)) invalid();
    if (!item.properties || typeof item.properties !== 'object' || Array.isArray(item.properties)) invalid();
    if (item.propertyReadStatus === 'unavailable' && Object.keys(item.properties).length) invalid();
    for (const [key, value] of Object.entries(item.properties)) {
      if (!Object.hasOwn(specs, key)) invalid();
      const spec = specs[key];
      if (spec.activeTimelineOnly && item.timelineId !== observation.activeTimelineId) invalid();
      if (spec.type === 'boolean' && typeof value !== 'boolean') invalid();
      if (spec.type === 'text' && (typeof value !== 'string' || !value.trim() || value.length > 160
        || /[\\/\x00-\x1f\x7f]/.test(value) || /^[a-z]:/i.test(value)
        || (spec.values && !spec.values.includes(value)))) invalid();
      if (spec.type === 'decimal') {
        exact(value, ['decimal']);
        if (typeof value.decimal !== 'string' || !decimal.test(value.decimal) || !Number.isFinite(Number(value.decimal))
          || (Number(value.decimal) === 0 && /[1-9]/.test(value.decimal.split('e')[0]))) invalid();
      }
    }
  }
  if (!Array.isArray(observation.tracks)) invalid();
  const expected = new Set(observation.snapshot.timelines.flatMap(timeline => timeline.tracks
    .map(track => JSON.stringify([timeline.id, track.type, track.index]))));
  if (expected.size !== observation.tracks.length) invalid();
  for (const track of observation.tracks) {
    exact(track, ['timelineId', 'type', 'index', 'enabled', 'locked']);
    const key = JSON.stringify([track.timelineId, track.type, track.index]);
    if (!expected.delete(key) || ![true, false, null].includes(track.enabled) || ![true, false, null].includes(track.locked)) invalid();
  }
}
function propertyCaptureConfig() {
  const entry = ([key, spec]) => `[${JSON.stringify(key)}]=${JSON.stringify(spec.type)}`;
  return `{types={${Object.entries(specs).map(entry).join(',')}},activeOnly={${Object.entries(specs)
    .filter(([, spec]) => spec.activeTimelineOnly).map(([key]) => `[${JSON.stringify(key)}]=true`).join(',')}}}`;
}
function comparePropertySections(before, after) {
  if (before.schemaVersion !== 2 || after.schemaVersion !== 2) return {
    propertyCoverage: before.schemaVersion === after.schemaVersion ? 'unobserved' : 'not-comparable',
    propertyChanges: null, trackStateChanges: null, activeTimelineChange: null };
  const list = observation => new Map(observation.items.map(item => [JSON.stringify([item.timelineId, item.itemId]), item]));
  const old = list(before), current = list(after), propertyChanges = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const a = old.get(key), b = current.get(key), reference = b || a;
    const anchor = { timelineId: reference.timelineId, itemId: reference.itemId };
    if (!a || !b) propertyChanges.push({ ...anchor, field: 'item', before: a ? 'observed' : null, after: b ? 'observed' : null });
    if (a && b && a.propertyReadStatus !== b.propertyReadStatus) propertyChanges.push({ ...anchor, field: 'propertyReadStatus', before: a.propertyReadStatus, after: b.propertyReadStatus });
    for (const field of [...new Set([...Object.keys(a?.properties || {}), ...Object.keys(b?.properties || {})])].sort()) {
      const av = a?.properties[field] ?? null, bv = b?.properties[field] ?? null;
      if (JSON.stringify(av) !== JSON.stringify(bv)) propertyChanges.push({ ...anchor, field, before: av, after: bv });
    }
  }
  const tracks = observation => new Map(observation.tracks.map(track => [JSON.stringify([track.timelineId, track.type, track.index]), track]));
  const oldTracks = tracks(before), newTracks = tracks(after), trackStateChanges = [];
  for (const key of [...new Set([...oldTracks.keys(), ...newTracks.keys()])].sort()) {
    const a = oldTracks.get(key), b = newTracks.get(key), reference = b || a;
    for (const field of ['enabled', 'locked']) {
      const av = a?.[field] ?? null, bv = b?.[field] ?? null;
      if (av !== bv) trackStateChanges.push({ timelineId: reference.timelineId, type: reference.type, index: reference.index, field, before: av, after: bv });
    }
  }
  return { propertyCoverage: 'returned-documented-properties-only', propertyChanges, trackStateChanges,
    activeTimelineChange: before.activeTimelineId === after.activeTimelineId ? null : { before: before.activeTimelineId, after: after.activeTimelineId } };
}
module.exports = { validatePropertySections, propertyCaptureConfig, comparePropertySections };
