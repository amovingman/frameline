"""Read-only schema-3 Resolve API capture shared by the internal companion."""

SCHEMA_VERSION = 3
TRACK_TYPES = ("video", "audio", "subtitle")
EFFECT_CATEGORIES = ("fusion", "ofx", "audio")


def capture(resolve):
    project = resolve.GetProjectManager().GetCurrentProject()
    if project is None:
        raise RuntimeError("Open a disposable Resolve project before capturing")

    timelines = []
    seen_timeline_ids = set()
    for timeline_index in range(1, project.GetTimelineCount() + 1):
        timeline = project.GetTimelineByIndex(timeline_index)
        if timeline is None:
            raise RuntimeError(f"Timeline {timeline_index} could not be read")
        timeline_id = timeline.GetUniqueId()
        if not timeline_id or timeline_id in seen_timeline_ids:
            raise RuntimeError(f"Timeline {timeline_index} has a missing or duplicate API unique ID")
        seen_timeline_ids.add(timeline_id)
        items = []
        tracks = []
        seen_ids = set()
        for track_type in TRACK_TYPES:
            for track_index in range(1, timeline.GetTrackCount(track_type) + 1):
                tracks.append({
                    "type": track_type,
                    "index": track_index,
                    "name": timeline.GetTrackName(track_type, track_index),
                })
                for item in timeline.GetItemListInTrack(track_type, track_index) or []:
                    item_id = item.GetUniqueId()
                    if not item_id or item_id in seen_ids:
                        raise RuntimeError(f"Missing or duplicate item ID in timeline {timeline_index}")
                    seen_ids.add(item_id)
                    media = item.GetMediaPoolItem()
                    linked_ids = sorted(link.GetUniqueId() for link in item.GetLinkedItems() or [])
                    if any(not link_id for link_id in linked_ids):
                        raise RuntimeError(f"Linked item has no ID in timeline {timeline_index}")
                    items.append({
                        "id": item_id,
                        "track_type": track_type,
                        "track_index": track_index,
                        "type": item.GetType(),
                        "name": item.GetName(),
                        "start_frame": item.GetStart(),
                        "end_frame": item.GetEnd(),
                        "source_start_frame": item.GetSourceStartFrame(),
                        "source_end_frame": item.GetSourceEndFrame(),
                        "media_pool_id": media.GetUniqueId() if media else None,
                        "linked_item_ids": linked_ids,
                        "effect_counts": {category: len(item.GetEffects(category) or []) for category in EFFECT_CATEGORIES},
                    })
        timelines.append({
            "id": timeline_id,
            "name": timeline.GetName(),
            "start_frame": timeline.GetStartFrame(),
            "tracks": tracks,
            "items": items,
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "resolve_version": resolve.GetVersionString(),
        "project_id": project.GetUniqueId(),
        "project_name": project.GetName(),
        "timelines": timelines,
    }
