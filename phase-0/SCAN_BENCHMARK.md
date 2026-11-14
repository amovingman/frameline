# Synthetic scanner benchmark

Run on 2026-11-09 with `node phase-0/benchmark-scan.js N` on the local macOS development host. Each run generated a temporary FCPXML 1.10 file with one repeated asset and N consecutive one-second picture clips, scanned it once in a fresh Node process, checked the result, and removed the file. The tool reports elapsed wall time and heap before/after the scan; these are observations, not thresholds.

| Clips | XML bytes | Scan time | Heap before → after |
|---:|---:|---:|---:|
| 1,000 | 65,067 | 22 ms | 6 → 7 MiB |
| 5,000 | 333,067 | 40 ms | 5 → 10 MiB |
| 10,000 | 668,069 | 67 ms | 6 → 14 MiB |

A later repeat of 5,000 clips took 68 ms, showing run-to-run variation. The benchmark excludes editor export, native project reopening, media contents, large asset tables, effects, and nested structures. It is not a realistic-project performance gate; a consented or representative Resolve project and a write/reopen test are still needed. The current scanner reads the full XML into memory and has a 20 MB size cap.

## Editor-backed thousand-clip copy

On November 11, 2026, in DaVinci Resolve Free 21.1.2.10, a disposable `Frameline Performance Copy` timeline was duplicated inside the named `Frameline API Relink Test` project. It retained the linked audio, transition, effect, multiple tracks, and compound clip from the live structure fixture. The internal Lua API appended 1,000 one-second video-only clips, all using the same generated moving-media source, at frames 241–24,240 on V1. `AppendToTimeline` returned 1,000 items, and the API then enumerated 1,001 V1 items and an end frame of 24,240. The API call used 17.068 seconds of Lua `os.clock()` CPU time. This is a realistic clip count but has much less media variety than a working editor project.

`Timeline.Export` produced an 822,382-byte FCPXML 1.10 bundle and used 0.374 seconds of Lua CPU time. Its XML SHA-256 was `8ba263fc39c71ad92f5b7e46c8273a8e1ac6bb31d1e3a4bc331a124f6ced00b5`. The production scanner completed in 49.2 ms in one process and 60.9 ms in a second process (`node phase-0/benchmark-editor-scan.js phase-0/performance-live.fcpxmld`). These are single runs, not a latency distribution. **It enumerated only one clip**, despite the editor's 1,001 V1 items, and warned about nested content, gap-attached tracks, and unsupported `<clip>` elements. The scan's speed therefore does not establish usable large-project coverage.

`SaveProject` reported success and 0.007 seconds of Lua CPU time. `ProjectManager.ExportProject` wrote a 432,877-byte `.drp` project copy at `/private/tmp/frameline-performance-copy.drp` and used 0.570 seconds of Lua CPU time. Its SHA-256 was `44538250545f84236088c5359b4949e9f7aec08161e696dbdc7876d43611422a`. The copied project's sequence XML contains 1,004 video-clip records (1,001 on V1 plus the original V2/V3 items), two audio-clip records, and one transition record. The project was imported as `Frameline API Relink Test Performance Reopen Copy`; Resolve's Project Manager displayed it with 10 timelines. Opening that copy took about 3.6 seconds in the UI automation call. The Edit page showed the reopened `Frameline Performance Copy` at 00:16:50:00, matching the 24,240-frame end at 24 fps, with clips visible in its Edit Index. A post-reopen API item count remains to be verified.

This test does not validate an apply transaction. The source is a repeated synthetic clip, the initial scanner lost most primary clips, and API-to-FCPXML item identity has not been proven. Keep write/apply disabled until a representative project, identity mapping, verified backup, post-write validation, and recovery test all pass.

## Scanner coverage follow-up

The Free-only scanner update recognizes a top-level Resolve `<clip>` containing exactly one asset-backed `<video>` child. Rerunning `node phase-0/benchmark-editor-scan.js phase-0/performance-live.fcpxmld` against the same 822,382-byte export and SHA-256 above took 142.5 ms and enumerated 1,001 primary picture clips across 24,240 sequence frames. It still warned that nested audio/effects and gap-attached additional tracks are omitted. This single run measures the expanded read-only scan; it does not revise the earlier measurements or prove full timeline coverage.

## Repeated read-only scan observation

On November 12, 2026, on this macOS development host, `node phase-0/benchmark-editor-scan.js phase-0/performance-live.fcpxmld 10` ran ten scans sequentially in one Node process. Wall-clock scan times were 58.33, 52.06, 45.77, 53.52, 38.77, 32.30, 37.69, 38.70, 32.69, and 33.70 ms: minimum **32.30 ms**, median **38.73 ms**, maximum **58.33 ms**. These are host-specific observations, not a performance threshold; later runs may benefit from process and filesystem warm-up. The initial independent fixture read and hash check are outside the timed scans. Each timed scan includes the production scanner's file read and parsing.

The benchmark independently checks the XML byte count and SHA-256 against the known export before timing, then asserts the scanner's source hash, 24,240 sequence frames, and 1,001 scanned clips on every run. It requires identical warning lists across runs and reports them in full:

- `Nested clip content, including audio and effects, is not scanned`
- `Content attached to a gap, including additional tracks, is not scanned`

The count is the expected primary picture-clip count for this export, not proof of full timeline coverage. Nested content and additional tracks remain omitted. These scanner timings do not include export, project reopen, media handling, or any write/apply transaction; the earlier editor reopen observation is a separate UI measurement. The benchmark only reads the existing export and does not interact with the editor.
