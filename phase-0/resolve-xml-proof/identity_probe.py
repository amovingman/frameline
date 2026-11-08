"""Conservative, read-only clip matching experiment for Resolve FCPXML exports.

This is a compatibility probe, not a persistent identity implementation. It
deliberately refuses to guess when two clips could exchange identities.
"""

import argparse
import json
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

from probe import inventory


def _group(clips, indices, key):
    groups = defaultdict(list)
    for index in indices:
        value = key(clips[index])
        if value is not None:
            groups[value].append(index)
    return groups


def compare(before, after):
    """Match only unique media references, then unique source-in points.

    Timeline position, display name, and duration are intentionally excluded:
    those are ordinary editable properties. A media relink or changed source-in
    may still prevent a match, and a unique match is not proof of editor IDs.
    """
    old = before["clips"]
    new = after["clips"]
    unmatched_old = set(range(len(old)))
    unmatched_new = set(range(len(new)))
    matches = []

    for rule, key in (
        ("unique-media", lambda clip: clip["media_path"]),
        ("unique-media-and-source-in", lambda clip: (
            clip["media_path"], clip["source_in_seconds"]
        ) if clip["media_path"] else None),
    ):
        old_groups = _group(old, unmatched_old, key)
        new_groups = _group(new, unmatched_new, key)
        for value in old_groups.keys() & new_groups.keys():
            old_indices, new_indices = old_groups[value], new_groups[value]
            if len(old_indices) == len(new_indices) == 1:
                left, right = old_indices[0], new_indices[0]
                matches.append({"before": left, "after": right, "rule": rule})
                unmatched_old.remove(left)
                unmatched_new.remove(right)

    # Remaining clips on both sides that reference the same media are unsafe
    # to call an insertion or deletion; their identity is unresolved.
    old_media = _group(old, unmatched_old, lambda clip: clip["media_path"])
    new_media = _group(new, unmatched_new, lambda clip: clip["media_path"])
    ambiguous = []
    for media in old_media.keys() & new_media.keys():
        ambiguous.append({
            "before": sorted(old_media[media]),
            "after": sorted(new_media[media]),
            "reason": "same-media-candidates",
        })
        unmatched_old.difference_update(old_media[media])
        unmatched_new.difference_update(new_media[media])

    return {
        "matches": sorted(matches, key=lambda match: match["before"]),
        "ambiguous": sorted(ambiguous, key=lambda group: group["before"]),
        "removed_candidates": sorted(unmatched_old),
        "added_candidates": sorted(unmatched_new),
        "candidate_matches_unambiguous": not ambiguous,
    }


def scan(path):
    source = Path(path)
    if source.is_dir() and source.suffix.lower() == ".fcpxmld":
        source = source / "Info.fcpxml"
    return inventory(ET.parse(source).getroot())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", help="FCPXML file or .fcpxmld bundle")
    parser.add_argument("after", help="FCPXML file or .fcpxmld bundle")
    args = parser.parse_args()
    print(json.dumps(compare(scan(args.before), scan(args.after)), indent=2))


if __name__ == "__main__":
    main()
