# DaVinci Resolve FCPXML proof

Resolve 21.1.2 is installed at `/Applications/DaVinci Resolve/DaVinci Resolve.app` (build 21.1.20010). The disposable fixture `resolve-import-test.fcpxml` references three local mountain JPEGs and defines a 24 fps, three-clip timeline with three-second durations. The existing empty “New Project” was used as the test target.

## Import result: passed

On 2026-11-03, the fixture was imported through **File → Import → Timeline**. Resolve opened its “Import a Timeline From File” options dialog, recognized the timeline as `Frameline Resolve Test`, and completed the import without an error. The resulting Resolve UI showed:

- A timeline named `Frameline Resolve Test` with duration `00:00:09:00`.
- Three consecutive video clips on V1, each labeled `03:00` (three seconds at 24 fps).
- All three referenced mountain stills in the Media Pool, with the first still visible in the viewer.

This confirms Resolve 21.1.2 can import this FCPXML fixture and resolve its local still-image references.

## Export and changed-copy reimport: passed

The imported timeline was exported through **File → Export → Timeline** to `resolve-roundtrip.fcpxmld`. Resolve wrote `Info.fcpxml` with the three stills in order and three-second durations. A changed copy was made in `resolve-roundtrip-modified.fcpxmld`: the second still was extended to four seconds, the third was shifted to start at seven seconds, and the sequence duration was set to ten seconds. Resolve imported that copy as `Frameline Modified Test`; the UI showed a 10-second timeline and clip durations of 3 and 4 seconds for the first two clips, with the third following them.

The interchange worked for this isolated duration change. Identity did not round-trip: the original fixture's `<asset-clip id="clip-…">` elements were exported as generic `<video>` elements without clip IDs. Resolve also emitted file paths and asset names, so the project-specific identity mapping remains an open technical risk. This is not yet proof of stable clip identity, native Resolve project editing, or safe merge behavior.

`probe.py` now inventories both fixture and Resolve-exported clip elements, keeps exact rational time values, reports frame counts when they align to the sequence frame duration, and marks ID-less export entries as unstable position keys. It remains a disposable spike, not a production adapter.

## Identity comparison experiment

`identity_probe.py` compares two exports without using timeline position, clip name, or duration as identity. It first matches clips whose media reference appears exactly once on each side. For repeated media, it only matches source-in points that are unique on both sides. Remaining same-media candidates are reported as ambiguous. Run it with:

```sh
python3 phase-0/resolve-xml-proof/identity_probe.py \
  phase-0/resolve-xml-proof/resolve-roundtrip.fcpxmld \
  phase-0/resolve-xml-proof/resolve-roundtrip-modified.fcpxmld
python3 -m unittest discover -s phase-0/resolve-xml-proof -p 'test_*.py' -v
```

The known original and duration-edited Resolve exports yield three candidate matches. Synthetic comparisons show that a rename, move, and duration change can retain a unique candidate when each media reference is used once. Repeated use of the same media at the same source-in point is ambiguous even when timeline positions differ. These matches are **heuristics, not stable IDs**: replacing a clip with a new use of the same media can look identical, and relinking or changing source-in can defeat matching. `candidate_matches_unambiguous` means only that this probe found no competing candidates; it does not authorize an automatic merge or write.

The next editor-backed experiment is to duplicate the same source clip twice in a disposable Resolve timeline, move one copy, rename it, save, export, then compare the two exports. Repeat with distinct source-in points and with an identical source-in point. Check whether any Resolve metadata survives that distinguishes the occurrences. Preserve both untouched exports and record the Resolve build and edition. Until that evidence exists, repeated-media clips require manual identity resolution, and Phase 0's stable-ID gate remains open.

The initial UI automation attempts failed to navigate the file picker, but did not indicate a Resolve compatibility problem. The working method was the macOS Go to Folder shortcut (`super+shift+g`) in the import picker; the fixture path was already entered in the sheet, and pressing Return navigated to the selected file.

## Next checks

Next, test stable identity strategies and broaden the fixture corpus to include moving footage, audio, trims, and multiple tracks. Confirm whether the same exchange path is available in the Free edition, then test across supported Resolve versions. Do not write to the original fixture or mountain images.
