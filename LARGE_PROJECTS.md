# Large-project scanning and navigation

Frameline keeps production FCPXML reads, SHA-256, XML validation/parsing and inventory construction outside the Electron main thread. The scanner's source limit remains 20 MiB. Exact rational frame timing, source hashes, v2 manifests, conservative warnings and the experimental Resolve boundary are unchanged.

A worker owns a four-entry least-recently-used inventory cache with a 64 MiB estimated JSON budget. A cache hit still streams and hashes the export again and refreshes every media reference in batches of at most 64. Bounded reads and file/descriptor/named-path identity checks refuse a source changed during scanning. The final export and bundle cannot be symlinks. Relative filesystem paths remain supported by the public library and benchmark commands.

Cancel terminates the active worker, including during synchronous XML parsing, and drains it before starting a replacement. Its cache is discarded. Cancelling a queued request never starts it; a late callback from an older request cannot stop the replacement worker. Idle workers do not keep Node processes alive, and app shutdown drains its scanner. Progress reports contain phase, byte/reference counts and cache status, without paths. Worker failures have explicit recovery text.

The scanned picture inventory and media inventory now mount a bounded window of rows while retaining the complete dataset. Search covers every item. **Go** uses the original one-based row number and clears a filter when necessary to reach that item. The selected detail shows the complete name, exact offset/source-in/duration and gap/overlap information. Arrows, Home/End and Page Up/Down traverse every result. The viewport keeps keyboard focus and a valid active descendant while rows are recycled; accessible positions and counts describe the full filtered list. A changed project/source resets the scope. Refreshed media state for the same export preserves the current query and selection.

## Validation and limits

The [native proof](phase-0/large-projects/verification.json) uses the shipped main, preload, renderer and worker with untouched FCPXML bundles imported, saved and exported by the installed DaVinci Resolve Free 21.1.2, build 21.1.20010:

| Case | Picture clips | Referenced media | Timeline duration at 24 fps |
| --- | ---: | ---: | ---: |
| Small | 50 | 50 | 2,400 frames / 1m 40s |
| Typical test | 500 | 500 | 24,000 frames / 16m 40s |
| Clip stress | 10,000 | 1 | 120,000 frames / 1h 23m 20s |

These are disposable synthetic still-image/image-sequence timelines, not observed customer projects. Resolve consolidated the repeated source media in the clip stress export; it does not prove handling of 10,000 unique media files inside Resolve. The separate 500-reference export exercises media batching, list navigation and cancellation. An initial 10,000-source import did not produce a completed export and required stopping its isolated test session; it is retained as a failed attempt, not promoted to passing evidence. The saved 50/500-clip project survived reopening. No crash report was submitted.

The [corpus manifest](phase-0/large-projects/editor-corpus.json) records source hashes and exact counts. Compressed originals are retained in [the corpus](phase-0/large-projects/corpus). Resolve’s exported image-sequence resource locations are reported missing by the ordinary file-existence check; these measurements do not claim media readiness. Replaying the unchanged XML may also report missing disposable media; replay does not rewrite source locations or recreate embedded paths. `node scripts/prepare-large-project-fixtures.cjs <new-absolute-directory>` defaults to a small 50-clip fixture, following the user’s preference for small tests. `--include-typical` adds the 500-clip case; `--include-stress` explicitly adds a repeated-source 10,000-clip case. Larger editor imports are not automatic. Preparation alone is not an editor-backed result.

The final full suite passed **1,565 tests** without failures or skips, and package-input validation passed. The recorded original-corpus native run measured a 523 ms cold scan and 171 ms cache replay for the 6,136,857-byte clip-stress export; these are individual local observations, not performance guarantees.

Focused worker tests cover cancellation during a real 70,000-clip parse, main-loop responsiveness, cache eviction/invalidation, source growth/replacement, private errors and request races. Component checks use 20,001 synthetic clips/assets. Those larger tests validate app behavior, not Resolve's ability to open every such timeline. Normal editor apply, complete native-project equivalence, representative user-project measurements and release support remain gated separately.

Run `npm run test:large-projects`, `npm test` and `npm run package:check`. Run `npm run verify:large-projects` for the native app proof; an explicit `FRAMELINE_LARGE_PROOF_CORPUS` can select newly collected editor exports. Native evidence includes actual scan/cache timings, event-loop heartbeats, cancellation/recovery, bounded DOM, keyboard/accessibility checks and 360–1440 px layouts. It makes no VoiceOver speech claim.
