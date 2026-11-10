# Synthetic scanner benchmark

Run on 2026-11-09 with `node phase-0/benchmark-scan.js N` on the local macOS development host. Each run generated a temporary FCPXML 1.10 file with one repeated asset and N consecutive one-second picture clips, scanned it once in a fresh Node process, checked the result, and removed the file. The tool reports elapsed wall time and heap before/after the scan; these are observations, not thresholds.

| Clips | XML bytes | Scan time | Heap before → after |
|---:|---:|---:|---:|
| 1,000 | 65,067 | 22 ms | 6 → 7 MiB |
| 5,000 | 333,067 | 40 ms | 5 → 10 MiB |
| 10,000 | 668,069 | 67 ms | 6 → 14 MiB |

A later repeat of 5,000 clips took 68 ms, showing run-to-run variation. The benchmark excludes editor export, native project reopening, media contents, large asset tables, effects, and nested structures. It is not a realistic-project performance gate; a consented or representative Resolve project and a write/reopen test are still needed. The current scanner reads the full XML into memory and has a 20 MB size cap.
