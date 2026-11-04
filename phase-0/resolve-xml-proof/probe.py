"""Small, read-only FCPXML inventory probe for the Resolve compatibility spike."""
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
from urllib.parse import unquote, urlparse
import argparse
import json
import xml.etree.ElementTree as ET


def parse_time(value: str) -> Fraction:
    """Parse FCPXML rational seconds without rounding."""
    if value.endswith("s"):
        value = value[:-1]
    return Fraction(value)


def local_path(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    return unquote(parsed.path) if parsed.scheme == "file" else url


def inventory(root):
    sequence = root.find(".//sequence")
    if sequence is None:
        raise ValueError("FCPXML has no sequence")

    resources = {item.get("id"): item for item in root.findall(".//resources/*")}
    fmt = resources.get(sequence.get("format"))
    frame_duration = parse_time(fmt.get("frameDuration")) if fmt is not None and fmt.get("frameDuration") else None
    if frame_duration is None or frame_duration <= 0:
        raise ValueError("Sequence format does not declare a valid frameDuration")

    spine = sequence.find("spine")
    if spine is None:
        raise ValueError("FCPXML sequence has no spine")

    clips = []
    for index, clip in enumerate(list(spine)):
        if clip.tag not in {"asset-clip", "video"}:
            continue
        asset = resources.get(clip.get("ref"))
        rep = asset.find("media-rep") if asset is not None else None
        source_url = (rep.get("src") if rep is not None else None) or (asset.get("src") if asset is not None else None)
        offset = parse_time(clip.get("offset", "0s"))
        source_in = parse_time(clip.get("start", "0s"))
        duration = parse_time(clip.get("duration", "0s"))
        clips.append({
            # Resolve's export currently omits clip IDs; presence alone does not prove stability.
            "id": clip.get("id"),
            "scan_key": clip.get("id") or f"position-{index + 1}",
            "id_present": clip.get("id") is not None,
            "name": clip.get("name") or (asset.get("name") if asset is not None else None),
            "asset": asset.get("name") if asset is not None else None,
            "media_path": local_path(source_url),
            "offset_seconds": str(offset),
            "source_in_seconds": str(source_in),
            "duration_seconds": str(duration),
            "offset_frames": int(offset / frame_duration) if (offset / frame_duration).denominator == 1 else None,
            "source_in_frames": int(source_in / frame_duration) if (source_in / frame_duration).denominator == 1 else None,
            "duration_frames": int(duration / frame_duration) if (duration / frame_duration).denominator == 1 else None,
            "enabled": clip.get("enabled", "1") != "0",
            "element": clip.tag,
        })

    return {
        "format": "fcpxml",
        "fcpxml_version": root.get("version"),
        "frame_duration_seconds": str(frame_duration),
        "sequence_duration_seconds": str(parse_time(sequence.get("duration", "0s"))),
        "clip_count": len(clips),
        "clips": clips,
    }


def edit_fixture_copy(source: Path, output: Path):
    """Exercise a reversible, copy-only edit against our synthetic fixture."""
    tree = ET.parse(source)
    root = tree.getroot()
    original = inventory(root)
    copied = deepcopy(root)
    target = next((c for c in copied.iter("asset-clip") if c.get("id") == "clip-1"), None)
    if target is None:
        raise ValueError("Copy-only edit requires fixture clip-1")
    target.set("duration", "7/1s")
    output.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(copied).write(output, encoding="utf-8", xml_declaration=True)
    updated = inventory(ET.parse(output).getroot())
    assert updated["clips"][0]["duration_seconds"] == "7"
    assert updated["clips"][1:] == original["clips"][1:]
    print(f"PASS: wrote isolated edit to copy; source is unchanged: {output}")


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("source", nargs="?", default=str(Path(__file__).with_name("sample.fcpxml")))
    cli.add_argument("--out", help="Write a test edit to a separate output file (fixture format)")
    cli.add_argument("--json", action="store_true", help="Print a normalized JSON inventory")
    args = cli.parse_args()
    source = Path(args.source)
    manifest = inventory(ET.parse(source).getroot())
    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        for clip in manifest["clips"]:
            identity = clip["id"] or f"{clip['scan_key']} (unstable)"
            print(f"{identity} | {clip['name']} | {clip['asset']} | "
                  f"timeline={clip['offset_seconds']}s source-in={clip['source_in_seconds']}s "
                  f"duration={clip['duration_seconds']}s")
    if args.out:
        edit_fixture_copy(source, Path(args.out))


if __name__ == "__main__":
    main()
