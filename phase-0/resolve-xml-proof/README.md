# DaVinci Resolve FCPXML proof

The November 17 [native backup and recovery probe](../SAFE_PULL_PREFLIGHT.md#live-copied-project-capture-and-failure-recovery-2026-11-17) adds untouched post-import and rename/rollback schema-3 observations. The imported copy regenerates all captured object IDs. The saved rename changes exactly one observed field; intentional-failure rollback returns the exact before snapshot bytes. These observations do not establish a desktop apply transaction or preservation of uncaptured editor properties.

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

### Resolve-backed repeated-media check (2026-11-07)

In a **Save Project As** copy named `Frameline Identity Probe`, Resolve 21.1.2 imported two additional occurrences of `mountain-alps.jpg` into the existing test timeline. `identity-repeated-before.fcpxmld` is the untouched 20-second export with five clips. One of the two new occurrences was trimmed from 120 to 97 frames in Resolve, then the project was saved and exported as `identity-repeated-after-trim.fcpxmld`. Resolve displayed a `00:00:19:01` timeline, and the XML contains the expected `457/24s` sequence duration. A separate timeline imported that edited export and was exported again as `identity-reimport-export.fcpxmld`.

The three `mountain-alps.jpg` occurrences have no clip IDs or distinguishable media path/source-in values. Resolve assigned separate resource references (`r2`, `r7`, `r8`), and they remained the same across this trim and one reimport/export. This is evidence of persistence in this narrow case, **not** proof of stable occurrence identity: the references may be regenerated by export order, and no move or rename was validated. The read-only probe therefore reports all three occurrences as ambiguous. The original `codex test` project and prior exports were not edited.

### Reordered-copy import/export check

`make_reordered_fixture.py` made `identity-reordered-input.fcpxmld` from the edited export without changing the source. It moved the 97-frame repeated occurrence ahead of the 120-frame occurrence, updated their offsets, and gave the moved clip the name `Alps alternate`. Resolve imported that copy as a separate timeline, displayed the same `00:00:19:01` duration, and exported `identity-reordered-export.fcpxmld`.

The exported order, offsets, and durations match the input. **Resolve reassigned the two resource references by position:** the moved 97-frame occurrence entered with `ref="r8"` and returned with `ref="r7"`; the 120-frame occurrence changed from `r7` to `r8`. Resolve also replaced `Alps alternate` with `mountain-alps.jpg`. Resource refs and clip names therefore fail this identity test. The probe still reports the repeated-media occurrences as ambiguous, which is the correct conservative result. This was an XML copy edit followed by a real Resolve import/export, not a move performed inside the Resolve UI.

Next, evaluate a persistent sidecar mapping or a supported Resolve API that exposes occurrence IDs. Test it with repeated media, source trims, moves, deletions, and relinks before enabling automatic clip-level merges. Until then, repeated-media clips require manual identity resolution, and Phase 0's stable-ID gate remains open.

### Read-only Resolve API identity probe

The installed Resolve 21.1.2 scripting reference (`Developer/Scripting/DaVinciResolveScript.pyi`, last updated 2026-08-31) documents `Project.GetUniqueId()`, `Timeline.GetUniqueId()`, and `TimelineItem.GetUniqueId()`. These are separate from the unstable FCPXML resource references. `resolve_api_identity.py` captures project, timeline, and item IDs, track names and types, timeline start and item frame positions, media-pool IDs, linked item IDs, and effect counts without saving or changing the Resolve project. Snapshot schema 3 adds the track/link/effect/start fields; older snapshots cannot be compared with it. The probe rejects missing or duplicate timeline and item IDs during capture or comparison, refuses to overwrite an earlier snapshot, and rejects comparisons between different project IDs. Its mock tests pass. An API method named “unique” alone is not evidence that the value persists after every kind of edit, save/reopen, or import/export.

### Live schema-3 readout from the disposable relink project (2026-11-10)

[`live-relink-schema3.json`](live-relink-schema3.json) records a live Free 21.1.2 API readout from the named `Frameline API Relink Test` project. Its six timelines expose one video and one audio track each, named `Video 1` and `Audio 1`; there are 23 video items, no audio items, no linked item IDs, and zero Fusion, OFX, and audio effects. The sixth timeline, `Frameline API Trim Delete Test`, is empty in this imported project, confirming the earlier one-frame UI observation. All six timeline IDs and 23 item IDs are distinct. The five-item `Frameline API Identity Test` timeline still has the moved, renamed Alps item at frames 457–554.

This JSON was **transcribed from live Lua-console API output**, then checked for valid JSON and unique IDs. Resolve Free's external Python connection was unavailable, and the Lua console did not expose file I/O or `dofile`; this was not produced by the Python `capture_to` function. It is evidence for these specific API fields in this disposable copy, not a general enumeration claim for linked audio, transitions, effects, or nested sequences.

### Same-project API/export mapping on a copied timeline (2026-11-10)

Inside `Frameline API Relink Test`, the five-clip `Frameline API Identity Test` timeline was duplicated as `Frameline API Mapping Edit Copy` (ID `a00c8594-ea28-480e-bfd9-4d3ed64d62ee`). Its [before API readout](live-mapping-before-schema3.json) and [before FCPXML export](live-mapping-before.fcpxmld/Info.fcpxml) were captured. On that copy only, `SetPosition({startFrame=600})` moved the final Alps occurrence from frames 457–554 to 600–697. Its API item ID `8543c72f-9c48-4744-81b5-ccc620e7c9bb` persisted. The [after API readout](live-mapping-after-schema3.json) and [after export](live-mapping-after.fcpxmld/Info.fcpxml) show the same five IDs and an inserted 143-frame XML gap. The disposable project was saved after the edit; a restart/reopen check was not part of this pair.

Both readouts were transcribed from the live Lua console; Resolve's API produced both FCPXML exports directly. `api_export_mapping.py` returned five unique timing candidates before and after, with the moved occurrence at XML spine index 5 before and 6 after. It returned `safe_to_apply: false` for both. The exports still omit API item IDs, and the matching depends on exact timing in a known same-project pair. This does not establish persistent API-to-FCPXML identity for stale exports, collisions, or more complex timelines.

`api_export_mapping.py` compares one schema-3 API snapshot to a flat FCPXML 1.10 picture sequence using exact timeline offset, source-in, and duration frames. It reports unique timing matches as **candidates only**, rejects unsupported structures, and leaves collisions or mismatches unresolved. Its output includes the export SHA-256 and always sets `safe_to_apply` to false. It cannot prove that the API snapshot and export came from the same state, and it cannot turn timing into persistent clip IDs. Run it only as a read-only experiment:

The matcher now also reads a flat Resolve `<clip>` with exactly one asset-backed `<video>` child, using the wrapper's visible timing. It refuses mixed audio, multiple video sources, unknown nested content, gap-attached lanes, and timing collisions. Its canonical snapshot hash and exact export-byte hash make each candidate report repeatable, but they do not establish that the two observations came from one editor state. The full performance export contains additional unsupported constructs and remains outside this flat matcher.

```sh
python3 phase-0/resolve-xml-proof/api_export_mapping.py snapshot.json timeline.fcpxmld TIMELINE_ID
```

On 2026-11-08, the installed **Free** Resolve 21.1.2 internal Lua console returned a distinct API ID for each of the five clips in `Frameline Identity Probe`, including three uses of `mountain-alps.jpg`. The existing `Identity Reorder Import` timeline was duplicated as `Frameline API Identity Test`; its five clip IDs differed from the original timeline's IDs. On the duplicate, the 97-frame Alps occurrence retained ID `03bfe5cd-537d-4dcf-ae7f-cc3a04737fa4` after `SetName("Alps API rename")` and `SetPosition({startFrame=457})` returned true. Its start/end changed from 240/337 to 457/554. `SaveProject()` returned true. This shows that duplication creates new occurrence IDs while rename and move retained one ID within the session.

The saved project was then switched away from, reopened, and Resolve itself was fully quit and relaunched. After reopening `Frameline Identity Probe`, the project ID remained `bf825329-ae26-45ea-9a9a-73e9717df0be`, the duplicated timeline ID remained `b7e6a3b4-75dd-41cb-8079-764c7ff8361a`, and **all five clip IDs remained unchanged**. The renamed and moved Alps occurrence still had ID `03bfe5cd-537d-4dcf-ae7f-cc3a04737fa4` at frames 457–554. This is live evidence that these API IDs persisted across save/reopen and a full application restart in this disposable project. The duplicate test timeline remains in the saved disposable project; the original timeline was not changed by this experiment.

### API trim, deletion, and XML mapping check (2026-11-08)

The saved `Frameline API Identity Test` timeline was duplicated again as `Frameline API Trim Delete Test` (timeline ID `67801c2e-92ab-4073-8d49-a078f6648641`). Its repeated Alps occurrence had ID `93b4a8e3-143a-470a-b469-94c8b3abdb34` at frames 457–554. `SetRightOffset` increased the right offset by 10 frames, shortened that occurrence to frames 457–544, and **retained the same API ID**. `DeleteClips` then removed a different Alps occurrence (ID `fb4d3595-fd71-4218-9c26-51399e9407f3`) without ripple; that ID disappeared from `GetItemListInTrack`, while the four surviving IDs stayed the same. These checks were performed only on the duplicate timeline.

Resolve API exports of the before and after timelines are preserved in `api-identity-before.fcpxmld` and `api-trim-delete-after.fcpxmld`. The XML has the expected 97-to-87-frame trim and five-to-four-clip deletion, but **does not contain the API occurrence IDs**. The read-only XML matcher correctly reports the three repeated Alps occurrences before and two after as ambiguous. A sidecar cannot safely attach those API IDs to an arbitrary FCPXML export solely by resource ref, name, media path, or source-in. A same-session API-to-export mapping based on exact track/timing still needs separate validation, and would need to reject collisions and any stale export.

For a relink test, the project was exported as a `.drp` and imported under a different name, `Frameline API Relink Test`. The imported copy displayed the test timeline as empty/one frame in Resolve, so it was **not used for relinking**. The reason for that failed copy is not yet established. The original saved `Frameline Identity Probe` project and source media were not relinked. Use a verified isolated project copy before testing `MediaPool.RelinkClips`.

Use a disposable Resolve project and save each observation to a new file. With Resolve Studio external scripting enabled, run the bundled ResolvePython interpreter:

```sh
"/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolvePython" \
  phase-0/resolve-xml-proof/resolve_api_identity.py capture /private/tmp/resolve-before.json
```

Resolve Free's internal scripting console worked for the live API check. Select Python in that console to run the snapshot probe with the absolute script path, then call `capture_to` on its returned namespace:

```python
import runpy
probe = runpy.run_path('/absolute/path/to/resolve_api_identity.py')
probe['capture_to'](resolve, '/private/tmp/resolve-before.json')
```

Repeat after a relink and for additional timeline structures. Compare two observations with:

```sh
python3 phase-0/resolve-xml-proof/resolve_api_identity.py compare \
  /private/tmp/resolve-before.json /private/tmp/resolve-after.json
```

Keep each pair in the **same project**; the comparison rejects different project IDs. Confirm whether IDs survive each operation and whether a copied project or FCPXML import produces new IDs. Even if API IDs persist, using them for an FCPXML-based write still needs a proven mapping between API items and exported XML occurrences, or a supported API write path.

The initial UI automation attempts failed to navigate the file picker, but did not indicate a Resolve compatibility problem. The working method was the macOS Go to Folder shortcut (`super+shift+g`) in the import picker; the fixture path was already entered in the sheet, and pressing Return navigated to the selected file.

## Next checks

### Mixed internal-Console capture (2026-11-17)

[`live-mixed-audio-video-transition-schema3.json`](live-mixed-audio-video-transition-schema3.json) is an untouched JSON file saved by Frameline after validating a three-part Lua Console capture from the disposable `Frameline Lua Capture Fixture` project in Resolve Free 21.1.2.10. Its SHA-256 is `4f2b6420e03d0123cfeeff93ce8ed299ff27d0b9518be5ea22498c529f372b12`. The one timeline contains 48 one-second audio items, two picture items from the same still, and one Cross Dissolve transition. The two picture items have different API item IDs and share a media-pool ID. The transition has its own API item ID and a null source interval and media-pool ID. Frameline's desktop validator accepted all 51 items. This establishes readout of those constructs in this one project; effects, linked audio/video, nested content, and complete project coverage remain untested.

[`live-mixed-linked-effect-schema3.json`](live-mixed-linked-effect-schema3.json) is the next untouched capture of the same saved project, SHA-256 `21b11d8ffe6ec71635936e6b8fbffbbee2cc31486ceb42d026900a25da81a2b2`. A generated three-second video with tone was appended once. Resolve returned separate video and audio items, with reciprocal `GetLinkedItems()` IDs and one shared media-pool ID. A Gaussian Blur OFX was added to the first still; the snapshot reports its OFX count changing from zero to one. Frameline verified 53 items through three Console parts. A source-bound read-only preview of these two files reports two additions and one effect-count change. The schema records counts, so it cannot distinguish effect identities, settings, enabled state, or order. Those remain outside safe merge coverage.

Next, test stable identity strategies and broaden the fixture corpus to include moving footage, audio, trims, and multiple tracks. Confirm whether the same exchange path is available in the Free edition, then test across supported Resolve versions. Do not write to the original fixture or mountain images.

### Byte-identical media relocation and retained occurrence IDs

The later `Frameline Relink Identity Proof` project is a separate valid fixture from the older imported relink project above. `live-relink-identity-{baseline,relocated,reopened,restored}.json` retain the exact richer captures from five picture/audio occurrences, including repeated media. Three media-pool entries were relinked to identical files in another private folder, saved/reopened and restored/reopened. The represented captures are byte-identical. Path-free receipts bind the observed destination matches and external file fingerprints. `live-relink-identity-command-{forward,reverse}.json` record the reusable command results. See [the relink proof](../RESOLVE_RELINK_IDENTITY.md) for the method, source-bound audit and remaining limits. Stable track identity, export mapping, linked A/V relink and production recovery remain unproven.
