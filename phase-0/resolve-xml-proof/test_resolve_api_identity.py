"""Contract tests for the read-only Resolve identity capture."""

import tempfile
import unittest
from pathlib import Path

from resolve_api_identity import capture, capture_to, compare


class FakeItem:
    def __init__(self, item_id, start):
        self.item_id = item_id
        self.start = start

    def GetUniqueId(self): return self.item_id
    def GetMediaPoolItem(self): return None
    def GetName(self): return "Repeated still"
    def GetStart(self): return self.start
    def GetEnd(self): return self.start + 24
    def GetSourceStartFrame(self): return 0


class FakeTimeline:
    def __init__(self, items): self.items = items
    def GetUniqueId(self): return "timeline-1"
    def GetName(self): return "Identity test"
    def GetTrackCount(self, kind): return 1 if kind == "video" else 0
    def GetItemListInTrack(self, kind, index): return self.items


class FakeProject:
    def __init__(self, items): self.timeline = FakeTimeline(items)
    def GetTimelineCount(self): return 1
    def GetTimelineByIndex(self, index): return self.timeline
    def GetName(self): return "Disposable project"


class FakeResolve:
    def __init__(self, items): self.project = FakeProject(items)
    def GetProjectManager(self): return self
    def GetCurrentProject(self): return self.project
    def GetVersionString(self): return "21.1.2"


class ResolveApiIdentityTests(unittest.TestCase):
    def test_repeated_media_move_is_matched_by_api_id(self):
        before = capture(FakeResolve([FakeItem("a", 0), FakeItem("b", 24)]))
        after = capture(FakeResolve([FakeItem("b", 0), FakeItem("a", 24)]))
        result = compare(before, after)["matched_timelines"][0]
        self.assertEqual(result["retained_ids"], ["a", "b"])
        self.assertEqual(len(result["changed"]), 2)

    def test_missing_or_duplicate_ids_stop_capture(self):
        for ids in (("",), ("a", "a")):
            with self.subTest(ids=ids), self.assertRaises(RuntimeError):
                capture(FakeResolve([FakeItem(item_id, index * 24)
                                     for index, item_id in enumerate(ids)]))

    def test_snapshots_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "snapshot.json"
            capture_to(FakeResolve([FakeItem("a", 0)]), output)
            with self.assertRaises(FileExistsError):
                capture_to(FakeResolve([FakeItem("b", 0)]), output)


if __name__ == "__main__":
    unittest.main()
