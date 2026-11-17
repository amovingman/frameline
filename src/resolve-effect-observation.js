'use strict';
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');
const LIMIT = 20 * 1024 * 1024;
const CATEGORIES = ['fusion', 'ofx', 'audio'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail() { throw new Error('invalid-effect-observation'); }
function plain(value) {
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (Array.isArray(value) && Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    if ((!Array.isArray(value) || key !== 'length') && !descriptor.enumerable) fail();
    plain(descriptor.value);
  }
}
function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).sort().join('|') !== [...names].sort().join('|')) fail();
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\\/\x00-\x1f\x7f]/.test(value) || /^[a-z]:/i.test(value)) fail();
}
function catalogueId(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.includes('://') || value.startsWith('/') || value.split('/').includes('..') || /^[a-z]:/i.test(value)) fail();
  if (value.includes('/') && !['Resolve FX/', 'Fusion/', 'Audio FX/'].some(prefix => value.startsWith(prefix))) fail();
}
function validateEffectObservation(observation) {
  plain(observation);
  keys(observation, ['schemaVersion', 'operation', 'readOnly', 'safeToApply', 'snapshot', 'items']);
  if (observation.schemaVersion !== 1 || observation.operation !== 'resolve-effect-observation'
    || observation.readOnly !== true || observation.safeToApply !== false || !Array.isArray(observation.items)) fail();
  validateResolveSnapshot(observation.snapshot);
  const expected = new Map(observation.snapshot.timelines.flatMap(timeline => timeline.items
    .map(item => [JSON.stringify([timeline.id, item.id]), item.effect_counts])));
  if (observation.items.length !== expected.size) fail();
  const seen = new Set();
  for (const item of observation.items) {
    keys(item, ['timelineId', 'itemId', 'effects']);
    text(item.timelineId); text(item.itemId);
    const key = JSON.stringify([item.timelineId, item.itemId]);
    if (!expected.has(key) || seen.has(key) || !Array.isArray(item.effects)) fail();
    seen.add(key);
    const slots = new Set();
    for (const effect of item.effects) {
      keys(effect, ['category', 'index', 'typeId', 'name', 'enabled']);
      if (!CATEGORIES.includes(effect.category) || !Number.isSafeInteger(effect.index) || effect.index < 1
        || typeof effect.enabled !== 'boolean') fail();
      catalogueId(effect.typeId); text(effect.name);
      const slot = `${effect.category}:${effect.index}`;
      if (slots.has(slot)) fail();
      slots.add(slot);
    }
    for (const category of CATEGORIES) {
      const count = expected.get(key)[category];
      if (item.effects.filter(effect => effect.category === category).length !== count) fail();
      for (let index = 1; index <= count; index++) if (!slots.has(`${category}:${index}`)) fail();
    }
  }
  return observation;
}
function parseEffectObservation(bytes) {
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > LIMIT) fail();
  return validateEffectObservation(JSON.parse(bytes.toString('utf8')));
}
function compareEffectObservations(beforeBytes, afterBytes) {
  const before = parseEffectObservation(beforeBytes), after = parseEffectObservation(afterBytes);
  const snapshot = compareResolveManifests(normalizeResolveSnapshot(before.snapshot), normalizeResolveSnapshot(after.snapshot));
  const list = value => new Map(value.items.flatMap(item => item.effects.map(effect =>
    [JSON.stringify([item.timelineId, item.itemId, effect.category, effect.index]), { ...item, effect }])));
  const old = list(before), current = list(after), changes = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const a = old.get(key), b = current.get(key), reference = b || a;
    const anchor = { timelineId: reference.timelineId, itemId: reference.itemId,
      category: reference.effect.category, index: reference.effect.index };
    if (!a || !b) changes.push({ ...anchor, kind: a ? 'slot-removed' : 'slot-added', before: a?.effect || null, after: b?.effect || null });
    else for (const field of ['typeId', 'name', 'enabled']) if (a.effect[field] !== b.effect[field]) {
      changes.push({ ...anchor, kind: 'slot-field-changed', field, before: a.effect[field], after: b.effect[field] });
    }
  }
  return { schemaVersion: 1, readOnly: true, safeToApply: false, effectIdentity: 'category-index-only',
    sourceHashes: { before: hash(beforeBytes), after: hash(afterBytes) }, snapshotChanges: snapshot.changes, effectChanges: changes,
    limitations: ['Effect parameters and nested contents are unobserved.', 'Catalogue IDs identify effect types; category/index is not persistent instance identity.'] };
}

module.exports = { validateEffectObservation, parseEffectObservation, compareEffectObservations };
