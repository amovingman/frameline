# First five integration gates

The November 20, 2026 work addresses the first five unchecked roadmap items: complete enumeration, editor-version corpus, stable clip/track identity, scan/write/reopen performance, and lossless editor fields. **The scan/write/reopen measurement checkbox is now completed for the defined personal scope.** The other four remain blocked or deferred. The current audit extends the retained historical decision without enabling ordinary editor writes.

The target remains the installed DaVinci Resolve Free 21.1.2/build 21.1.20010 on macOS, with FCPXML 1.10. The API reports `21.1.2.10`. Public release coverage remains outside the personal scope. No broader version range has been declared.

## Results

| Roadmap item | Added evidence and checks | Remaining gap |
|---|---|---|
| Enumerate sequences, tracks, clips, transitions, effects and links | A source-bound inventory recomputes per-timeline item types, effect slots, reciprocal link edges and asymmetric links. The existing mixed capture has 3 picture, 49 audio and 1 transition item, 1 effect slot and 1 reciprocal linked pair. A fresh menu capture independently reads all 10,550 picture items across the three existing size fixtures. A pinned installed-SDK inventory distinguishes documented methods from runtime evidence. | Nested contents, general effect parameters, persistent effect-instance identity and complete construct coverage remain unobserved. |
| Projects from every supported editor version | A checked corpus catalog verifies both stored and decompressed hashes, exact source bytes, parsed counts, duration and warnings for 4 untouched editor exports. Their provenance documents are included by hash in the report. New controlled proofs retain private native backups for this same build. | The export catalog and same-build native backups do not declare a supported release range or a per-version native corpus. The release-version item remains deferred under the personal scope. |
| Stable clip and track IDs | Paired observations retain clip IDs. A new bounded native archive graph reader finds matching project/timeline/item UUIDs and native track UUIDs. A controlled name challenge binds all five tracks, including four empty tracks with duplicate names, and retains UUIDs through save/reopen/restoration. Append/index-shift/recreation controls retain surviving IDs and detect a fresh recreated ID. A subsequent challenge-free read/export/read interval rebinds the unchanged graph against 21 independent calibrations. | The SDK still has no track-ID accessor. The new read-only join requires the exact calibrated identity graph; it does not independently identify identical empty tracks in a new or changed graph. Experimental clip writes use API UUIDs; XML occurrence mapping remains a separate open requirement for any future XML write path. |
| Scan, write and reopen behavior — completed for personal scope | A fresh 50-item fixture links the original input, native backup, rich API baseline and editor export. Three same-fixture scan/cache pairs accompany actual guarded backup and rename/save/close/reopen/rollback timings, exact represented restoration and 84 sampled Resolve RSS readings. Existing larger scan/cancel evidence remains separate. | Native wall timing uses a one-second nonmonotonic clock; reported windows assume no realtime-clock adjustment. CPU and RSS are process-wide; RSS is sampled rather than a true peak. These are measurements of supported experimental operations, not a performance or preservation guarantee. |
| Lossless fields | Per-item coverage and exact expected-rename comparison remain conservative. A separate typed supplement captures seven additional field families on all 50 fixture items. A new opt-in rename guard now verifies those families alongside rich data before/after setter, save, reopen and export, with an independently backed rollback and exact restoration. Color-node slot reads add color/cache metadata; raw native-field controls localize selected opaque record differences. | Returned dictionary keys retain unknown applicability. All 50 documented color-tool-list getters were unavailable; counts and slot annotations do not cover graph contents. Native records differ even during read-only exports. Effect parameters, retime keyframes, nested contents and opaque semantics remain unproven. |

The checked-in [gate observation](phase-0/integration-gates-observation.json) keeps recomputed historical captures separate from the fresh read-only `nativeMenuInventory`; `newLiveEditorRun` refers to that read, with no editor writes. The audit decompresses the untouched native result, verifies its pinned hash and full snapshot schema, and recomputes its counts. The [benchmark observation](phase-0/integration-benchmark-observation.json) records a new local worker run. On that run, the 50-clip export took 26.3–29.0 ms for a fresh worker scan and 1.12–1.27 ms for cache replay. Timings describe this machine and these files, without a performance guarantee. Existing media references were checked as stored; media was not regenerated.

The new [external probe](phase-0/integration-external-probe.json) again reports `connected: false`; the vendor-bundled ResolvePython probe also failed to connect. Resolve was open on the existing disposable large-scan project. Repeated Console menu activation through the current native UI session did not expose a Console window. This does not establish that Console is unavailable through every access path.

A subsequent [native Scripts-menu probe](phase-0/RESOLVE_MENU_RUNTIME_PROBE.md) **did** return a verified result through Fusion IOClass. It read the exact installed version, the disposable project API ID and 3 timelines, then wrote and reread a nonce-bound result and completion marker. Standard Lua I/O remained unavailable. The [new observation](phase-0/resolve-menu-runtime-live-observation.json) preserves that narrow result separately from the historical fixture audit. This proves a bounded menu-runtime file handoff, without establishing complete enumeration or editor-write support. No project save/load/mutation call was made; the existing edited project was preserved.

The subsequent [full read-only menu inventory](phase-0/RESOLVE_MENU_INVENTORY.md) also completed. Its 3,558,671-byte result contains the 50-, 500- and 10,000-item timelines, including six observed tracks and their empty audio tracks. Two complete schema-3 reads matched exactly before the result was published and reread. The first host check happened while capture was still running; an absent result at that point was not a failed editor read. A separate stage diagnostic completed another two reads with the same canonical snapshot hash, making long-running capture distinguishable from a verified failure. All disposable menu scripts were verified and removed afterward. This remains a research transport, separate from the desktop's normal Console workflow, with all native-field and write-safety gaps retained.

## Continued live proof on the personal fixture

The existing edited large-scan project was first preserved through Save Project As to a separate local project. All new write experiments use a fresh, explicitly named `Frameline Integration Gate Fixture 20261120`, with 50 generated picture items, three video tracks and two audio tracks. All five tracks deliberately share a name; four are empty. Native archives and rendered commands remain private. Published observations retain IDs, hashes and represented synthetic values; the retained input/export XML includes generated temporary media URLs.

The [operation measurement audit](phase-0/audit-operation-performance.js) recomputes raw timing hashes, the existing portable reviewed-trial audit, source/command bindings, exact rich restoration, scan receipts and process samples. The existing guarded rename command was embedded unchanged and independently acknowledged as **rolled-back** after both close/reopen cycles. All 50 item IDs, 1,600 returned property values and five represented track states matched the baseline. The issued cycle sampled 2.350 seconds of process CPU and three coarse wall ticks, giving a conditional **[2, 4 seconds)** window. Fresh scans took 27.35–41.77 ms and cache replays 1.17–1.51 ms. All 50 exported image-sequence references remain reported missing, and the nested-content warning is retained; no media-readiness claim is made. See [full measurements](phase-0/RESOLVE_OPERATION_MEASUREMENTS.md).

`npm run audit:integration` now recomputes a [current proof report](phase-0/integration-proof-progress.js) that closes only the measurement gate and includes the unchanged earlier audit. The checked-in [current summary observation](phase-0/integration-proof-progress-observation.json) is compared against that recomputation in tests; it retains the full historical audit digest without duplicating the earlier per-item coverage tables. `npm run audit:integration:prior` exposes that historical report, including its then-open timing gap. The earlier editor-choice decision and source hashes remain unchanged. Native track and additional-field research have their own [identity](phase-0/RESOLVE_NATIVE_TRACK_IDENTITY.md) and [item-state](phase-0/RESOLVE_ITEM_STATE_OBSERVATIONS.md) records. The track chain removes only known empty tracks, preserves all 50 picture items, and ends with the original five-track layout and duplicate names; the intended recreated track has a new native UUID. The separate enabled-state phases then disable and restore one exact clip UUID through save/reopen. The older rich observation stays byte-identical while disabled, exposing an actual guard blind spot; the new supplement detects exactly one `clipEnabled` change and returns byte-for-byte to its baseline after restoration. Restoration uses a fresh, independently verified native backup of the disabled state. The existing general rename guard is not extended by this separate field experiment. Private native archives and machine-bound receipts are also retained in the ignored `phase-0/private-integration-proof/` directory with private permissions. Those copies are audit material, not replayable commands.

## Challenge-free reads and expanded guards

The next live read-only interval completed three equal rich captures around two native exports. Its [calibrated join](phase-0/RESOLVE_NATIVE_TRACK_READONLY_JOIN.md) rebinds five tracks, including four empty duplicate-name tracks, using all 21 independently challenged associations. It made no track-name, save, load or project-mutation call. It deliberately requires the exact unchanged native identity graph, so it narrows a specific rebinding gap without closing the broad stable-ID checkbox.

The [identity authority decision](RESOLVE_IDENTITY_AUTHORITY.md) now explicitly uses live project/timeline/item API UUIDs for experimental clip writes. FCPXML remains read-only and never supplies a write target. This separates direct API experiments from the still-ambiguous XML occurrence/import path.

A fresh [seven-field rename guard](phase-0/ITEM_STATE_RENAME_PROOF.md) completed a supported rename and separately prepared rollback. It rechecks the complete rich and seven-field source after its started barrier, before the setter, and after setter/save/reopen/export. Rollback requires the successful predecessor's actual observations and fresh exported native backup. All original represented bytes were restored. This closes the demonstrated enabled-state blind spot for this separate guarded contract; the historical desktop rename generator remains unchanged.

The [node-slot reader](phase-0/RESOLVE_COLOR_NODE_OBSERVATIONS.md) captured 50 first-layer slots: color and cache mode were available, while every documented tool-list read was unavailable. A separate cosmetic node annotation experiment detects a changed node color despite unchanged node count; annotation color is not an image-grading parameter. No persistent node identity or complete graph coverage is inferred.

The [opaque native-field control](phase-0/RESOLVE_NATIVE_FIELD_OBSERVATIONS.md) retains 430 selected records per read-only export. It reports 150 added records, 150 removed records and one paired parsed-payload difference while the API state matches. The unpaired records are not guessed to be equivalent replacements. These differences are not discarded as harmless save noise. All broad identity, enumeration and lossless-field blockers remain in force; no additional roadmap checkbox is completed by this continuation.

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

## Remaining live evidence

The next identity proof needs an independently justified read-only binding for new or changed empty-track graphs, beyond the exact calibration ledger. The current synchronized join covers the unchanged owned fixture only. Repeated-media FCPXML occurrence mapping remains necessary for any future XML import/rewrite path; it is not used as a locator in the API-only rename experiment.

Enumeration and preservation still need complete effect parameters and instance identity, nested contents, variable-retime details, and Fusion/color graph contents. Equal represented captures and native UUID retention do not establish equivalence of opaque native fields. These technical gaps keep ordinary Apply disabled. Broader native-version corpus work remains deferred under the personal scope; no release range has been declared.

Higher-resolution native wall timing or additional operation measurements can be collected when useful. The completed measurement gate retains the actual coarse-clock and sampled-memory limits rather than inferring precision from CPU time.

## Validation reliability

The default full and security test commands now run four files concurrently, matching the verified full-suite configuration. The unrestricted run exposed a local HTTPS workflow timeout under contention; the same workflow passed in isolation and in the bounded full suite. A separate existing media-job test race was fixed only in its test harness: pending journal writes are drained before simulated failure, and its delayed mock is always released before cleanup. The deterministic race reproduction and the isolated media-job suite both pass; production media-job behavior is unchanged.

Earlier read-only milestone verification: all **1,677 full-suite tests** and **42 focused integration checks** passed with no skips. Universal-helper packaging and package archive checks passed. The independent final review found no remaining material issue. At that earlier milestone no roadmap checkbox was newly completed, and its native read-only probes performed no project save, load, selection change or mutation. The continued guarded experiments above are separate evidence.

The continued suite exposed a separate mock transport failure: a sampled Python test child was blocked in stdin reads before loading the vendor Lua library (847 of 847 stack samples, no CPU work). Large synchronous input pipes could fail to deliver EOF under concurrent execution. The affected mock calls now use a private regular file descriptor for the same bounded Python input, preserving exact generated Lua, assertions and time limits. This is test transport repair, not a successful native operation inferred from a retry.

Continued-proof final validation: **1,768 full-suite tests** and **133 focused integration checks** pass with no skips. The final saved-summary comparison also passes. Universal-helper packaging and package archive inputs pass. Independent reviews retain the original technical write blockers; only the personal-scope performance checkbox is completed.
