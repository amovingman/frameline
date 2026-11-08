"""Make a copy-only FCPXML identity probe with the two repeated clips swapped."""

from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

from probe import inventory


HERE = Path(__file__).parent
SOURCE = HERE / "identity-repeated-after-trim.fcpxmld" / "Info.fcpxml"
OUTPUT = HERE / "identity-reordered-input.fcpxmld" / "Info.fcpxml"


def build(source=SOURCE, output=OUTPUT):
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing fixture: {output}")
    original = ET.parse(source).getroot()
    root = deepcopy(original)
    sequence = root.find(".//sequence")
    spine = sequence.find("spine")
    clips = list(spine)
    if len(clips) != 5 or [clips[3].get("ref"), clips[4].get("ref")] != ["r7", "r8"]:
        raise ValueError("Expected the five-clip Resolve identity fixture")
    if [clips[3].get("duration"), clips[4].get("duration")] != ["5/1s", "97/24s"]:
        raise ValueError("Expected full and trimmed repeated occurrences")

    # Move the trimmed occurrence before the full occurrence. The first three
    # clips and total sequence length remain untouched.
    spine.remove(clips[3])
    spine.remove(clips[4])
    clips[4].set("offset", "10/1s")
    clips[4].set("name", "Alps alternate")
    clips[3].set("offset", "337/24s")
    spine.extend([clips[4], clips[3]])

    before, after = inventory(original), inventory(root)
    assert before["sequence_duration_seconds"] == after["sequence_duration_seconds"] == "457/24"
    assert [clip["duration_frames"] for clip in after["clips"]] == [72, 96, 72, 97, 120]
    assert [clip["offset_frames"] for clip in after["clips"]] == [0, 72, 168, 240, 337]
    output.parent.mkdir(parents=True, exist_ok=True)
    xml = ET.tostring(root, encoding="unicode")
    output.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + xml + '\n')
    return output


if __name__ == "__main__":
    print(build())
