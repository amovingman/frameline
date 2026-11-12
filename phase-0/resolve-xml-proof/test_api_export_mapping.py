"""Candidate mapping rejects ambiguous and unsupported flat-timeline cases."""

from copy import deepcopy
import json
from pathlib import Path
import unittest

from api_export_mapping import map_snapshot
from resolve_api_identity import capture, compare
from test_resolve_api_identity import FakeItem, FakeResolve


FIXTURE = Path(__file__).with_name("resolve-roundtrip.fcpxmld") / "Info.fcpxml"


class ApiExportMappingTests(unittest.TestCase):
    def snapshot(self):
        return capture(FakeResolve([FakeItem("a", 0), FakeItem("b", 72), FakeItem("c", 144)]))

    def test_exact_flat_timeline_returns_candidates_only(self):
        snapshot = self.snapshot()
        # The fake items are 24 frames long; align their ends to this export.
        for item in snapshot["timelines"][0]["items"]:
            item["end_frame"] = item["start_frame"] + 72
        snapshot["timelines"][0]["items"][1]["end_frame"] = 144
        snapshot["timelines"][0]["items"][2]["end_frame"] = 216
        result = map_snapshot(snapshot, FIXTURE.read_bytes(), "timeline-1")
        self.assertEqual(result["status"], "candidates-only")
        self.assertEqual([item["api_item_id"] for item in result["matches"]], ["a", "b", "c"])
        self.assertFalse(result["safe_to_apply"])

    def test_timing_collision_is_unresolved(self):
        snapshot = self.snapshot()
        xml = b'''<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/></resources><library><event><project><sequence format="f"><spine><video offset="0s" start="0s" duration="1s"/><video offset="0s" start="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>'''
        items = snapshot["timelines"][0]["items"]
        items[1] = deepcopy(items[0])
        items[1]["id"] = "b"
        snapshot["timelines"][0]["items"] = items[:2]
        items[0]["end_frame"] = items[1]["end_frame"] = 24
        result = map_snapshot(snapshot, xml, "timeline-1")
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(len(result["unresolved"][0]["xml_spine_indices"]), 2)
        self.assertFalse(result["safe_to_apply"])

    def test_timeline_start_frame_is_removed_before_matching(self):
        snapshot = self.snapshot()
        timeline = snapshot["timelines"][0]
        timeline["items"] = timeline["items"][:1]
        timeline["start_frame"] = 100
        timeline["items"][0]["start_frame"] = 100
        timeline["items"][0]["end_frame"] = 124
        xml = b'''<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/></resources><library><event><project><sequence format="f"><spine><video offset="0s" start="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>'''
        result = map_snapshot(snapshot, xml, "timeline-1")
        self.assertEqual(result["status"], "candidates-only")
        self.assertEqual(result["matches"], [{"api_item_id": "a", "xml_spine_index": 0}])

    def test_rejects_nested_content_and_stale_schema(self):
        snapshot = self.snapshot()
        xml = FIXTURE.read_bytes().replace(b"</video>", b"<audio/></video>", 1)
        with self.assertRaisesRegex(ValueError, "unsupported timeline content"):
            map_snapshot(snapshot, xml, "timeline-1")
        old = deepcopy(snapshot)
        old["schema_version"] = 2
        with self.assertRaisesRegex(ValueError, "schema"):
            map_snapshot(old, FIXTURE.read_bytes(), "timeline-1")

    def test_rejects_duplicate_api_item_ids(self):
        snapshot = self.snapshot()
        snapshot["timelines"][0]["items"][1]["id"] = "a"
        with self.assertRaisesRegex(ValueError, "duplicate API item IDs"):
            map_snapshot(snapshot, FIXTURE.read_bytes(), "timeline-1")

    def test_rejects_other_fcpxml_versions(self):
        xml = FIXTURE.read_bytes().replace(b'version="1.10"', b'version="1.11"', 1)
        with self.assertRaisesRegex(ValueError, "FCPXML 1.10"):
            map_snapshot(self.snapshot(), xml, "timeline-1")

    def test_live_copied_timeline_move_keeps_candidate_only_mapping(self):
        root = Path(__file__).parent
        timeline_id = "a00c8594-ea28-480e-bfd9-4d3ed64d62ee"
        snapshots = {}
        results = {}
        for phase in ("before", "after"):
            snapshots[phase] = json.loads((root / f"live-mapping-{phase}-schema3.json").read_text())
            xml = (root / f"live-mapping-{phase}.fcpxmld" / "Info.fcpxml").read_bytes()
            results[phase] = map_snapshot(snapshots[phase], xml, timeline_id)
            self.assertEqual(results[phase]["status"], "candidates-only")
            self.assertEqual(len(results[phase]["matches"]), 5)
            self.assertFalse(results[phase]["safe_to_apply"])
        change = compare(snapshots["before"], snapshots["after"])["matched_timelines"][0]
        self.assertEqual(change["added_ids"], [])
        self.assertEqual(change["removed_ids"], [])
        self.assertEqual(len(change["changed"]), 1)
        moved_id = "8543c72f-9c48-4744-81b5-ccc620e7c9bb"
        self.assertEqual(change["changed"][0]["id"], moved_id)
        self.assertEqual(change["changed"][0]["after"]["start_frame"], 600)
        self.assertEqual(next(m["xml_spine_index"] for m in results["before"]["matches"] if m["api_item_id"] == moved_id), 5)
        self.assertEqual(next(m["xml_spine_index"] for m in results["after"]["matches"] if m["api_item_id"] == moved_id), 6)


if __name__ == "__main__":
    unittest.main()
