"""Synthetic identity cases; these do not claim Resolve has retained IDs."""

import unittest
from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

from identity_probe import compare, scan


FIXTURE = Path(__file__).with_name("resolve-roundtrip.fcpxmld")
REPEATED_BEFORE = Path(__file__).with_name("identity-repeated-before.fcpxmld")
REPEATED_AFTER = Path(__file__).with_name("identity-repeated-after-trim.fcpxmld")
REORDERED_INPUT = Path(__file__).with_name("identity-reordered-input.fcpxmld")
REORDERED_EXPORT = Path(__file__).with_name("identity-reordered-export.fcpxmld")


def clip_elements(bundle):
    return list(ET.parse(bundle / "Info.fcpxml").getroot().find(".//sequence/spine"))


class IdentityProbeTests(unittest.TestCase):
    def setUp(self):
        self.before = scan(FIXTURE)

    def test_move_rename_and_duration_change_match_by_unique_media(self):
        after = deepcopy(self.before)
        after["clips"][1]["name"] = "Renamed clip"
        after["clips"][1]["offset_seconds"] = "7"
        after["clips"][1]["duration_seconds"] = "4"
        after["clips"] = [after["clips"][2], after["clips"][0], after["clips"][1]]
        result = compare(self.before, after)
        self.assertEqual([(m["before"], m["after"]) for m in result["matches"]],
                         [(0, 1), (1, 2), (2, 0)])
        self.assertTrue(result["candidate_matches_unambiguous"])

    def test_repeated_media_with_distinct_source_in_can_match(self):
        before = deepcopy(self.before)
        duplicate = deepcopy(before["clips"][0])
        duplicate["source_in_seconds"] = "2"
        before["clips"].append(duplicate)
        after = deepcopy(before)
        after["clips"][0], after["clips"][3] = after["clips"][3], after["clips"][0]
        result = compare(before, after)
        self.assertEqual([(m["before"], m["after"]) for m in result["matches"]],
                         [(0, 3), (1, 1), (2, 2), (3, 0)])
        self.assertTrue(result["candidate_matches_unambiguous"])

    def test_identical_repeated_media_is_ambiguous_after_move(self):
        before = deepcopy(self.before)
        before["clips"].append(deepcopy(before["clips"][0]))
        after = deepcopy(before)
        after["clips"][0], after["clips"][3] = after["clips"][3], after["clips"][0]
        result = compare(before, after)
        self.assertFalse(result["candidate_matches_unambiguous"])
        self.assertEqual(result["ambiguous"][0]["before"], [0, 3])
        self.assertEqual(result["ambiguous"][0]["after"], [0, 3])

    def test_known_modified_resolve_export_matches_all_three(self):
        modified = scan(Path(__file__).with_name("resolve-roundtrip-modified.fcpxmld"))
        result = compare(self.before, modified)
        self.assertEqual(len(result["matches"]), 3)
        self.assertEqual(result["ambiguous"], [])

    def test_real_resolve_repeated_media_trim_is_ambiguous(self):
        before, after = scan(REPEATED_BEFORE), scan(REPEATED_AFTER)
        self.assertEqual([clip["duration_frames"] for clip in before["clips"]], [72, 96, 72, 120, 120])
        self.assertEqual([clip["duration_frames"] for clip in after["clips"]], [72, 96, 72, 120, 97])
        result = compare(before, after)
        self.assertEqual(result["ambiguous"], [{
            "before": [0, 3, 4], "after": [0, 3, 4], "reason": "same-media-candidates"
        }])
        self.assertFalse(result["candidate_matches_unambiguous"])

    def test_resolve_reassigns_resource_refs_and_discards_clip_rename_on_reorder(self):
        sent, returned = clip_elements(REORDERED_INPUT), clip_elements(REORDERED_EXPORT)
        self.assertEqual([clip.get("duration") for clip in sent],
                         [clip.get("duration") for clip in returned])
        self.assertEqual([clip.get("offset") for clip in sent],
                         [clip.get("offset") for clip in returned])
        self.assertEqual([clip.get("ref") for clip in sent[3:]], ["r8", "r7"])
        self.assertEqual([clip.get("ref") for clip in returned[3:]], ["r7", "r8"])
        self.assertEqual(sent[3].get("name"), "Alps alternate")
        self.assertEqual(returned[3].get("name"), "mountain-alps.jpg")
        self.assertFalse(compare(scan(REPEATED_AFTER), scan(REORDERED_EXPORT))[
            "candidate_matches_unambiguous"])


if __name__ == "__main__":
    unittest.main()
