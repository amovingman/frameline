"""Read-only Resolve API identity probe. Never saves or edits a Resolve project.

Run with Resolve's bundled Python interpreter while Resolve is open:
    ResolvePython resolve_api_identity.py capture snapshot.json
    ResolvePython resolve_api_identity.py compare before.json after.json

External scripting must be enabled in Resolve Studio. The same capture function
can also be called from Resolve's internal Python console in the Free edition:
    exec(open('/path/to/resolve_api_identity.py').read())
    capture_to(resolve, '/path/to/new-snapshot.json')
"""

import argparse
import json
from pathlib import Path


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


def capture_to(resolve, output):
    """Write a new snapshot without ever overwriting an earlier observation."""
    snapshot = capture(resolve)
    with Path(output).open("x", encoding="utf-8") as file:
        json.dump(snapshot, file, indent=2)
        file.write("\n")
    return snapshot


def compare(before, after):
    if before.get("schema_version") != SCHEMA_VERSION or after.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported snapshot schema")
    if not before.get("project_id") or before["project_id"] != after.get("project_id"):
        raise ValueError("Snapshots come from different or unidentified projects")

    for label, snapshot in (("before", before), ("after", after)):
        timeline_ids = [timeline.get("id") for timeline in snapshot.get("timelines", [])]
        if any(not isinstance(timeline_id, str) or not timeline_id for timeline_id in timeline_ids) or len(timeline_ids) != len(set(timeline_ids)):
            raise ValueError(f"{label} snapshot has missing or duplicate timeline IDs")
        for timeline in snapshot["timelines"]:
            item_ids = [item.get("id") for item in timeline.get("items", [])]
            if any(not isinstance(item_id, str) or not item_id for item_id in item_ids) or len(item_ids) != len(set(item_ids)):
                raise ValueError(f"{label} snapshot has missing or duplicate item IDs")

    old_timelines = {timeline["id"]: timeline for timeline in before["timelines"]}
    new_timelines = {timeline["id"]: timeline for timeline in after["timelines"]}
    results = []
    for timeline_id in sorted(old_timelines.keys() & new_timelines.keys()):
        old = {item["id"]: item for item in old_timelines[timeline_id]["items"]}
        new = {item["id"]: item for item in new_timelines[timeline_id]["items"]}
        results.append({
            "timeline_id": timeline_id,
            "retained_ids": sorted(old.keys() & new.keys()),
            "removed_ids": sorted(old.keys() - new.keys()),
            "added_ids": sorted(new.keys() - old.keys()),
            "changed": [
                {"id": item_id, "before": old[item_id], "after": new[item_id]}
                for item_id in sorted(old.keys() & new.keys()) if old[item_id] != new[item_id]
            ],
        })
    return {
        "matched_timelines": results,
        "removed_timeline_ids": sorted(old_timelines.keys() - new_timelines.keys()),
        "added_timeline_ids": sorted(new_timelines.keys() - old_timelines.keys()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture_command = commands.add_parser("capture")
    capture_command.add_argument("output")
    compare_command = commands.add_parser("compare")
    compare_command.add_argument("before")
    compare_command.add_argument("after")
    args = parser.parse_args()

    if args.command == "capture":
        import DaVinciResolveScript as dvr_script
        resolve = dvr_script.scriptapp("Resolve")
        if resolve is None:
            raise RuntimeError("Could not connect to Resolve; check that it is open and external scripting is enabled")
        capture_to(resolve, args.output)
    else:
        with open(args.before, encoding="utf-8") as file:
            before = json.load(file)
        with open(args.after, encoding="utf-8") as file:
            after = json.load(file)
        print(json.dumps(compare(before, after), indent=2))


if __name__ == "__main__":
    main()
