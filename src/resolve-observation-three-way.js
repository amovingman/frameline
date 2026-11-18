'use strict';
const { classifyResolveThreeWay } = require('./resolve-three-way-classifier');
const { equivalentObservationValue: same } = require('./resolve-observation-values');
const ROLES = ['base', 'local', 'incoming'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = (...parts) => JSON.stringify(parts);
const MAX_FIELDS = 20000;

function classifyResolveObservations(documents) {
  const classification = classifyResolveThreeWay(...ROLES.map(role => documents[role].normalized));
  if (!ROLES.some(role => documents[role].observation)) return classification;
  const indexes = Object.fromEntries(ROLES.map(role => {
    const { snapshot, observation } = documents[role];
    return [role, { timelines: new Map(snapshot.timelines.map(t => [t.id, t])),
      snapshotItems: new Map(snapshot.timelines.flatMap(t => t.items.map(item => [key(t.id, item.id), item]))),
      items: new Map((observation?.items || []).map(item => [key(item.timelineId, item.itemId), item])),
      tracks: new Map((observation?.tracks || []).map(track => [key(track.timelineId, track.type, track.index), track])) }];
  }));
  const context = (timelineId, itemId) => {
    const timelines = ['local', 'incoming', 'base'].map(role => indexes[role].timelines.get(timelineId));
    const item = ['local', 'incoming', 'base'].map(role => indexes[role].snapshotItems.get(key(timelineId, itemId))).find(Boolean);
    return { timelineName: timelines.find(Boolean)?.name || timelineId, itemName: item?.name || null,
      track: item ? `${item.track_type === 'video' ? 'V' : item.track_type === 'audio' ? 'A' : item.track_type}${item.track_index}` : null };
  };
  const status = (b, l, i) => same(l, i) ? 'already-applied' : same(b, l) ? 'incoming-only' : same(b, i) ? 'local-only' : 'conflict';
  function supplement(role, timelineId, itemId) {
    const record = indexes[role].items.get(key(timelineId, itemId));
    if (!record) return { captured: false };
    return { captured: true, effects: [...record.effects].sort((a, b) => compare(a.category, b.category) || a.index - b.index),
      propertyReadStatus: record.propertyReadStatus || 'not-captured', properties: record.properties || null };
  }
  function trackValue(role, timelineId, type, index, field) {
    const record = indexes[role].tracks.get(key(timelineId, type, index));
    return record && typeof record[field] === 'boolean' ? { observed: true, value: record[field] }
      : { observed: false, value: null, reason: record ? 'read-unavailable' : 'not-captured' };
  }
  function fullTrack(role, timelineId, track) {
    return { ...track, observations: { enabled: trackValue(role, timelineId, track.type, track.index, 'enabled'),
      locked: trackValue(role, timelineId, track.type, track.index, 'locked') } };
  }
  function entity(role, timelineId, value, itemId) {
    if (value === null) return null;
    return itemId ? { ...value, observations: supplement(role, timelineId, itemId) }
      : { ...value, tracks: value.tracks.map(track => fullTrack(role, timelineId, track)),
        items: value.items.map(item => ({ ...item, observations: supplement(role, timelineId, item.id) })) };
  }
  const layoutChanged = timelineId => {
    const layouts = ROLES.map(role => (indexes[role].timelines.get(timelineId)?.tracks || [])
      .map(t => key(t.type, t.index)).sort());
    return !same(layouts[0], layouts[1]) || !same(layouts[0], layouts[2]);
  };
  const decisions = classification.decisions.map(decision => {
    let values;
    if (decision.field === 'existence') values = ROLES.map(role => entity(role, decision.timelineId, decision[role], decision.itemId));
    if (decision.field === 'tracks' && layoutChanged(decision.timelineId)) values = ROLES.map(role =>
      decision[role].map(track => fullTrack(role, decision.timelineId, track)));
    return { ...decision, ...(values ? { base: values[0], local: values[1], incoming: values[2], status: status(...values) } : {}),
      context: context(decision.timelineId, decision.itemId) };
  });
  if (decisions.length > MAX_FIELDS) throw new Error('resolve-property-preview-too-large');
  const gaps = [];
  function field(timelineId, itemId, name, observations) {
    const anchor = { timelineId, itemId, field: name, context: context(timelineId, itemId) };
    if (observations.some(value => !value.observed)) {
      gaps.push({ ...anchor, ...Object.fromEntries(ROLES.map((role, index) => [role, observations[index]])) });
    } else {
      const [b, l, i] = observations.map(value => value.value);
      if (!same(b, l) || !same(b, i)) decisions.push({ ...anchor, base: b, local: l, incoming: i, status: status(b, l, i) });
    }
    if (gaps.length > MAX_FIELDS || decisions.length > MAX_FIELDS) throw new Error('resolve-property-preview-too-large');
  }
  for (const timeline of documents.base.snapshot.timelines) {
    const timelines = ROLES.map(role => indexes[role].timelines.get(timeline.id));
    if (timelines.some(value => !value)) continue; // Whole-entity decisions retain their supplements.
    for (const item of timeline.items) {
      if (ROLES.some(role => !indexes[role].snapshotItems.has(key(timeline.id, item.id)))) continue;
      const records = ROLES.map(role => indexes[role].items.get(key(timeline.id, item.id)));
      const properties = [...new Set(records.flatMap(record => Object.keys(record?.properties || {})))].sort();
      for (const property of properties) field(timeline.id, item.id, `properties.${property}`, records.map(record =>
        record?.propertyReadStatus === 'captured' && Object.hasOwn(record.properties, property)
          ? { observed: true, value: record.properties[property] }
          : { observed: false, value: null, reason: !record?.propertyReadStatus ? 'not-captured'
            : record.propertyReadStatus === 'unavailable' ? 'read-unavailable' : 'key-not-returned' }));
      const slots = [...new Set(records.flatMap(record => (record?.effects || []).map(effect => key(effect.category, effect.index))))].sort();
      for (const slot of slots) {
        const [category, index] = JSON.parse(slot);
        field(timeline.id, item.id, `effectSlots.${category}.${index}`, records.map(record => record
          ? { observed: true, value: record.effects.find(effect => effect.category === category && effect.index === index) || null }
          : { observed: false, value: null, reason: 'not-captured' }));
      }
    }
    if (!layoutChanged(timeline.id)) for (const track of timeline.tracks) for (const property of ['enabled', 'locked']) {
      field(timeline.id, null, `trackState.${track.type}.${track.index}.${property}`,
        ROLES.map(role => trackValue(role, timeline.id, track.type, track.index, property)));
    }
  }
  const order = (a, b) => compare(a.timelineId, b.timelineId) || compare(a.itemId || '', b.itemId || '') || compare(a.field, b.field);
  decisions.sort(order); gaps.sort(order);
  return { ...classification, decisions,
    warnings: [...classification.warnings, 'Returned properties are compared only when all three sources observed the value; gaps do not establish unchanged values.',
      'Effect slots and track indexes are observed positions, not persistent instance identities. Their review does not authorize apply.'],
    observationCoverage: { roles: Object.fromEntries(ROLES.map(role => [role, documents[role].coverage])), gaps,
      capturedContextDiffers: new Set(ROLES.filter(role => documents[role].observation?.schemaVersion === 2)
        .map(role => documents[role].observation.activeTimelineId)).size > 1,
      fullNativePropertiesObserved: false } };
}
module.exports = { classifyResolveObservations, MAX_FIELDS };
