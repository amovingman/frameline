# First five integration gates

The November 20, 2026 work addresses the first five unchecked roadmap items: complete enumeration, editor-version corpus, stable clip/track identity, scan/write/reopen performance, and lossless editor fields. **None of those five checkboxes is newly completed.** The new commands make their evidence repeatable and expose missing information without enabling editor writes.

The target remains the installed DaVinci Resolve Free 21.1.2/build 21.1.20010 on macOS, with FCPXML 1.10. The API reports `21.1.2.10`. Public release coverage remains outside the personal scope. No broader version range has been declared.

## Results

| Roadmap item | Added evidence and checks | Remaining gap |
|---|---|---|
| Enumerate sequences, tracks, clips, transitions, effects and links | A source-bound inventory recomputes per-timeline item types, effect slots, reciprocal link edges and asymmetric links. The existing mixed capture has 3 picture, 49 audio and 1 transition item, 1 effect slot and 1 reciprocal linked pair. A fresh menu capture independently reads all 10,550 picture items across the three existing size fixtures. A pinned installed-SDK inventory distinguishes documented methods from runtime evidence. | Nested contents, general effect parameters, persistent effect-instance identity and complete construct coverage remain unobserved. |
| Projects from every supported editor version | A checked corpus catalog verifies both stored and decompressed hashes, exact source bytes, parsed counts, duration and warnings for 4 untouched editor exports. Their provenance documents are included by hash in the report. | These are exports from one experimental build, not a collection of native project archives or a supported release range. The release-version item remains deferred under the personal scope. |
| Stable clip and track IDs | A paired-observation report matches item IDs within each timeline and traces shared item membership across observed tracks. Duplicate names, changed indexes, empty tracks, split membership and item IDs reused in different timelines have explicit tests. | Membership is a witness only: clips can move independently, and empty tracks have no witness. The pinned SDK has no documented track-ID accessor. No sidecar or durable API/export identity is inferred. |
| Scan, write and reopen behavior | A small-fixture worker benchmark verifies fresh scans and cache replays, source hashes, counts, warnings, process CPU and sampled RSS. Three fresh/cache pairs run on each of the mixed-structure and 50-clip exports. Cancellation is tested. The fresh full API inventory measures 33.156233 seconds of process CPU across two reads and encoding. | This is CPU time, including any other active editor threads, not wall-clock latency. Fresh editor write/reopen/recovery timing and editor memory measurements remain unavailable. |
| Lossless fields | Per-item coverage lists returned and unobserved documented keys. The exact-name experiment allowlist excludes only one verified rename; unrelated project, item, effect, property, track and context changes remain visible. The recorded Pan edit fails preservation, and its restoration matches represented state. | A union of 43 returned keys across 53 items is not complete per-item coverage of the 51 documented keys. Key applicability is unknown when unreturned. General effect parameters, nested contents and opaque native state remain outside this comparison. |

The checked-in [gate observation](phase-0/integration-gates-observation.json) keeps recomputed historical captures separate from the fresh read-only `nativeMenuInventory`; `newLiveEditorRun` refers to that read, with no editor writes. The audit decompresses the untouched native result, verifies its pinned hash and full snapshot schema, and recomputes its counts. The [benchmark observation](phase-0/integration-benchmark-observation.json) records a new local worker run. On that run, the 50-clip export took 26.3–29.0 ms for a fresh worker scan and 1.12–1.27 ms for cache replay. Timings describe this machine and these files, without a performance guarantee. Existing media references were checked as stored; media was not regenerated.

The new [external probe](phase-0/integration-external-probe.json) again reports `connected: false`; the vendor-bundled ResolvePython probe also failed to connect. Resolve was open on the existing disposable large-scan project. Repeated Console menu activation through the current native UI session did not expose a Console window. This does not establish that Console is unavailable through every access path.

A subsequent [native Scripts-menu probe](phase-0/RESOLVE_MENU_RUNTIME_PROBE.md) **did** return a verified result through Fusion IOClass. It read the exact installed version, the disposable project API ID and 3 timelines, then wrote and reread a nonce-bound result and completion marker. Standard Lua I/O remained unavailable. The [new observation](phase-0/resolve-menu-runtime-live-observation.json) preserves that narrow result separately from the historical fixture audit. This proves a bounded menu-runtime file handoff, without establishing complete enumeration or editor-write support. No project save/load/mutation call was made; the existing edited project was preserved.

The subsequent [full read-only menu inventory](phase-0/RESOLVE_MENU_INVENTORY.md) also completed. Its 3,558,671-byte result contains the 50-, 500- and 10,000-item timelines, including six observed tracks and their empty audio tracks. Two complete schema-3 reads matched exactly before the result was published and reread. The first host check happened while capture was still running; an absent result at that point was not a failed editor read. A separate stage diagnostic completed another two reads with the same canonical snapshot hash, making long-running capture distinguishable from a verified failure. All disposable menu scripts were verified and removed afterward. This remains a research transport, separate from the desktop's normal Console workflow, with all native-field and write-safety gaps retained.

## Commands

Run from the repository root:

```sh
npm run audit:integration --silent
npm run test:integration
npm run benchmark:integration --silent
```

The audit verifies all four catalog exports, including the already-recorded larger fixtures. The benchmark defaults to the small fixtures only. Explicit `--include-large` adds the existing 500- and 10,000-clip exports when a concrete scale check is needed; it does not create new editor projects.

Inspect independently captured observations. Inventory and identity also accept validated schema-3 snapshots, without inferring supplementary effect metadata or properties. Preservation requires the richer observation format:

```sh
node phase-0/integration-gates.js inventory observation.json
node phase-0/integration-gates.js identity before.json after.json
node phase-0/integration-gates.js preservation before.json after.json
node phase-0/integration-gates.js corpus
```

An optional third preservation input describes exactly one expected item rename:

```json
{
  "timelineId": "captured-timeline-id",
  "itemId": "captured-item-id",
  "before": "Original clip name",
  "after": "Reviewed clip name"
}
```

```sh
node phase-0/integration-gates.js preservation before.json after.json expected-rename.json
```

The report checks that the named item exists on both sides with exactly those names. An absent or incorrect expected change is rejected. The allowlist is an experiment description and never authorizes a write. `representedStateMatches` only describes the compared observation; `representedReadsAvailable` separately rejects missing reads. `losslessRoundTripProven` and `safeToApply` always remain false, even when both represented checks pass. Legacy effect-only captures retain unobserved property coverage.

Inputs are bounded regular files, with final-component symlinks rejected and size/time checks around reads. Invalid CLI inputs return a generic error without printing their paths or contents. The reports retain path-free IDs and source hashes. Their input captures are local diagnostic data, not authenticated live-editor provenance.

`node phase-0/inspect-resolve-api.js` recomputes the capability inventory from the locally installed primary SDK reference. It refuses a reference whose hash differs from the existing property contract. The checked-in inventory remains usable on machines without that SDK. No runtime support is inferred from documentation alone.

## Next live evidence

Use a fresh small disposable project on the exact installed build. Collect richer captures before and after each supported operation with the existing [property capture](phase-0/RESOLVE_EFFECT_OBSERVATIONS.md) workflow, retaining untouched native backups and exports. Run rename, move, trim, save/reopen and restoration as separate observations. Include duplicate track names, at least two empty tracks, repeated media and track insertion/reordering; shared clip membership must never be promoted to track identity.

For write/reopen measurements, use the existing separately opted-in [guarded rename/recovery experiment](phase-0/SAFE_PULL_PREFLIGHT.md), rather than an unguarded timing script. Retain the exact backup, command, source/result observations and recovery result. Measure each operation in the editor runtime with an explicitly identified clock; report CPU time separately from wall time and include clock resolution. An unavailable connection or timer must remain unavailable in the report.

No fresh live write/reopen timing is claimed by this work. Complete construct coverage, native semantic preservation and stable track/export identity still require technical evidence before any ordinary Apply operation can be enabled.

## Validation reliability

The default full and security test commands now run four files concurrently, matching the verified full-suite configuration. The unrestricted run exposed a local HTTPS workflow timeout under contention; the same workflow passed in isolation and in the bounded full suite. A separate existing media-job test race was fixed only in its test harness: pending journal writes are drained before simulated failure, and its delayed mock is always released before cleanup. The deterministic race reproduction and the isolated media-job suite both pass; production media-job behavior is unchanged.

Final verification: all **1,677 full-suite tests** and **42 focused integration checks** passed with no skips. Universal-helper packaging and package archive checks passed. The independent final review found no remaining material issue. No roadmap checkbox was newly completed, and no project save, load, selection change or mutation was performed by the native probes.
