'use strict';

const { validateResolveSnapshot } = require('./resolve-snapshot-validator');

/** Convert a validated Resolve Free schema-3 observation to the stable, read-only manifest. */
function normalizeResolveSnapshot(snapshot) {
  validateResolveSnapshot(snapshot);

  return {
    schemaVersion: 1,
    readOnly: true,
    projectId: snapshot.project_id,
    resolveVersion: snapshot.resolve_version,
    timelines: snapshot.timelines.map(timeline => ({
      id: timeline.id,
      name: timeline.name,
      startFrame: timeline.start_frame,
      tracks: timeline.tracks
        .map(track => ({ type: track.type, index: track.index, name: track.name }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.index - b.index || a.name.localeCompare(b.name)),
      items: timeline.items
        .map(item => ({
          id: item.id,
          trackType: item.track_type,
          trackIndex: item.track_index,
          type: item.type,
          name: item.name,
          startFrame: item.start_frame,
          endFrame: item.end_frame,
          sourceStartFrame: item.source_start_frame,
          sourceEndFrame: item.source_end_frame,
          mediaPoolId: item.media_pool_id,
          linkedItemIds: [...item.linked_item_ids].sort(),
          effectCounts: {
            fusion: item.effect_counts.fusion,
            ofx: item.effect_counts.ofx,
            audio: item.effect_counts.audio
          }
        }))
        .sort((a, b) => a.trackType.localeCompare(b.trackType)
          || a.trackIndex - b.trackIndex
          || a.startFrame - b.startFrame
          || a.endFrame - b.endFrame
          || a.id.localeCompare(b.id))
    })).sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  };
}

module.exports = { normalizeResolveSnapshot };
