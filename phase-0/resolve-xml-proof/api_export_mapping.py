"""Read-only API-item ↔ FCPXML candidate mapping for a flat picture timeline.

Exact timing can disambiguate one snapshot, but it is not persistent identity and
does not prove that the snapshot and export came from the same editor state.
The result must never authorize an automatic edit or merge.
"""

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
import xml.etree.ElementTree as ET

from probe import parse_time
from resolve_api_identity import SCHEMA_VERSION


def _frames(value, frame_duration):
    frame_count = parse_time(value) / frame_duration
    if frame_count.denominator != 1 or frame_count < 0:
        raise ValueError("Export contains non-frame-aligned timing")
    return int(frame_count)


def map_snapshot(snapshot, xml_bytes, timeline_id):
    if snapshot.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported API snapshot schema")
    timelines = [item for item in snapshot.get("timelines", []) if item.get("id") == timeline_id]
    if len(timelines) != 1:
        raise ValueError("Select one timeline ID present in the snapshot")
    timeline = timelines[0]
    if not isinstance(timeline.get("start_frame"), int):
        raise ValueError("Snapshot has no timeline start frame")
    item_ids = [item.get("id") for item in timeline.get("items", [])]
    if any(not isinstance(item_id, str) or not item_id for item_id in item_ids) or len(item_ids) != len(set(item_ids)):
        raise ValueError("Snapshot has missing or duplicate API item IDs")
    root = ET.fromstring(xml_bytes)
    if root.tag != "fcpxml" or root.get("version") != "1.10":
        raise ValueError("Export must be FCPXML 1.10")
    sequences = root.findall(".//sequence")
    if len(sequences) != 1:
        raise ValueError("Export must contain one sequence")
    sequence = sequences[0]
    resources = {node.get("id"): node for node in root.findall(".//resources/*")}
    fmt = resources.get(sequence.get("format"))
    if fmt is None or not fmt.get("frameDuration"):
        raise ValueError("Export has no frame duration")
    frame_duration = parse_time(fmt.get("frameDuration"))
    if frame_duration <= 0:
        raise ValueError("Export has invalid frame duration")
    spine = sequence.find("spine")
    if spine is None:
        raise ValueError("Export has no picture spine")

    xml_signatures = defaultdict(list)
    for index, clip in enumerate(spine):
        if clip.tag == "gap":
            continue
        if (clip.tag not in ("video", "asset-clip")
                or any(child.tag not in {"adjust-conform", "adjust-transform"} for child in clip)
                or clip.get("lane") not in (None, "0")):
            raise ValueError("Export has unsupported timeline content")
        signature = (
            _frames(clip.get("offset", "0s"), frame_duration),
            _frames(clip.get("start", "0s"), frame_duration),
            _frames(clip.get("duration", "0s"), frame_duration),
        )
        xml_signatures[signature].append(index)

    api_signatures = defaultdict(list)
    for item in timeline["items"]:
        if item["track_type"] != "video" or item["track_index"] != 1 or item["type"] != "video":
            raise ValueError("Snapshot has unsupported timeline content")
        start = item["start_frame"] - timeline["start_frame"]
        duration = item["end_frame"] - item["start_frame"]
        if any(not isinstance(value, int) or value < 0 for value in (start, duration, item["source_start_frame"])):
            raise ValueError("Snapshot has invalid frame timing")
        api_signatures[(start, item["source_start_frame"], duration)].append(item["id"])

    all_signatures = sorted(xml_signatures.keys() | api_signatures.keys())
    matches = []
    unresolved = []
    for signature in all_signatures:
        xml_indices = xml_signatures.get(signature, [])
        api_ids = api_signatures.get(signature, [])
        if len(xml_indices) == len(api_ids) == 1:
            matches.append({"api_item_id": api_ids[0], "xml_spine_index": xml_indices[0]})
        else:
            unresolved.append({"frames": list(signature), "api_item_ids": sorted(api_ids), "xml_spine_indices": xml_indices})
    return {
        "status": "candidates-only" if not unresolved else "unresolved",
        "export_sha256": hashlib.sha256(xml_bytes).hexdigest(),
        "project_id": snapshot["project_id"],
        "timeline_id": timeline_id,
        "matches": sorted(matches, key=lambda match: match["xml_spine_index"]),
        "unresolved": unresolved,
        "safe_to_apply": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot")
    parser.add_argument("export", help=".fcpxml or .fcpxmld bundle")
    parser.add_argument("timeline_id")
    args = parser.parse_args()
    source = Path(args.export)
    if source.suffix.lower() == ".fcpxmld":
        source = source / "Info.fcpxml"
    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    print(json.dumps(map_snapshot(snapshot, source.read_bytes(), args.timeline_id), indent=2))


if __name__ == "__main__":
    main()
