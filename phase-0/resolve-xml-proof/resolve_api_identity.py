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


# Keep the historical proof CLI on the same capture contract shipped with the
# internal companion. The path is resolved from this source file, not cwd.
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "companion"))
from resolve_snapshot import SCHEMA_VERSION, capture


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
