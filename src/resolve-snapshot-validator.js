'use strict';

const TRACK_TYPES = new Set(['video', 'audio', 'subtitle']);
const TOP = ['schema_version', 'resolve_version', 'project_id', 'project_name', 'timelines'];
const TIMELINE = ['id', 'name', 'start_frame', 'tracks', 'items'];
const TRACK = ['type', 'index', 'name'];
const ITEM = ['id', 'track_type', 'track_index', 'type', 'name', 'start_frame', 'end_frame', 'source_start_frame', 'source_end_frame', 'media_pool_id', 'linked_item_ids', 'effect_counts'];

function requireValid(condition) {
  if (!condition) throw new Error('Invalid snapshot');
}

// Inspect data properties only: imported JSON must not execute getters.
function shape(value, fields) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValid([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireValid(keys.length === fields.length && keys.every(key => fields.includes(key)));
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValid(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}

function text(value, nonempty = false) {
  requireValid(typeof value === 'string' && (!nonempty || value.trim().length > 0));
  // Snapshot metadata contains display names and opaque IDs, never file paths/URLs.
  requireValid(!/[\\/\u0000-\u001f\u007f]/u.test(value) && !/^[a-z]:/iu.test(value));
}

function integer(value, minimum = 0) {
  requireValid(Number.isSafeInteger(value) && value >= minimum);
}

function array(value) {
  requireValid(Array.isArray(value));
  requireValid(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValid(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}

/** Validate the read-only schema-3 capture contract; return the input unchanged.
 * IDs are opaque. Item IDs are unique within a timeline, as in the Python probe.
 * Source end may equal source start (the observed still-image API convention).
 */
function validateResolveSnapshot(snapshot) {
  try {
    shape(snapshot, TOP);
    requireValid(snapshot.schema_version === 3 && snapshot.resolve_version === '21.1.2.10');
    text(snapshot.project_id, true);
    text(snapshot.project_name);
    array(snapshot.timelines);
    const timelineIds = new Set();
    for (const timeline of snapshot.timelines) {
      shape(timeline, TIMELINE);
      text(timeline.id, true);
      requireValid(!timelineIds.has(timeline.id));
      timelineIds.add(timeline.id);
      text(timeline.name);
      integer(timeline.start_frame);
      array(timeline.tracks);
      array(timeline.items);
      const tracks = new Set();
      for (const track of timeline.tracks) {
        shape(track, TRACK);
        requireValid(TRACK_TYPES.has(track.type));
        integer(track.index, 1);
        text(track.name);
        const key = `${track.type}:${track.index}`;
        requireValid(!tracks.has(key));
        tracks.add(key);
      }
      const itemIds = new Set();
      for (const item of timeline.items) {
        shape(item, ITEM);
        text(item.id, true);
        requireValid(!itemIds.has(item.id));
        itemIds.add(item.id);
        integer(item.track_index, 1);
        requireValid(TRACK_TYPES.has(item.track_type) && tracks.has(`${item.track_type}:${item.track_index}`));
        requireValid(item.type === item.track_type || (item.type === 'transition' && item.track_type !== 'subtitle'));
        text(item.name);
        integer(item.start_frame, timeline.start_frame);
        integer(item.end_frame);
        requireValid(item.end_frame > item.start_frame);
        if (item.type === 'transition' && item.source_start_frame === null && item.source_end_frame === null) {
          // Resolve transitions may have no source-media interval.
        } else {
          integer(item.source_start_frame);
          integer(item.source_end_frame, item.source_start_frame);
        }
        if (item.media_pool_id !== null) text(item.media_pool_id, true);
        array(item.linked_item_ids);
        const links = new Set();
        for (const link of item.linked_item_ids) {
          text(link, true);
          requireValid(link !== item.id && !links.has(link));
          links.add(link);
        }
        shape(item.effect_counts, ['fusion', 'ofx', 'audio']);
        for (const count of Object.values(item.effect_counts)) integer(count);
      }
      for (const item of timeline.items) {
        requireValid(item.linked_item_ids.every(id => itemIds.has(id)));
      }
    }
    return snapshot;
  } catch {
    // Never include input values, field names, or underlying exception messages.
    const error = new Error('Invalid or unsupported Resolve API snapshot.');
    error.code = 'INVALID_RESOLVE_SNAPSHOT';
    throw error;
  }
}

module.exports = { validateResolveSnapshot };
