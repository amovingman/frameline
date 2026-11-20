# Read-only Resolve menu inventory

The successful [Fusion IOClass menu-runtime probe](RESOLVE_MENU_RUNTIME_PROBE.md) supports this separate read-only experiment: capture the complete **represented schema-3 observation** of the currently open synthetic project through the Scripts menu. It does not claim complete native editor coverage.

The only accepted project name is `Frameline Large Scan Proof 20261119 corpus01`, on API version `21.1.2.10`. Its existing small/typical/large timelines can be read without saving, closing, loading, creating or selecting a timeline. The source calls no editor mutation API. The script embeds `src/companion/resolve-internal.lua` exactly, changing only the module's exported function table to expose its existing `capture` and `encode` functions.

## Prepare, invoke and verify

```sh
node phase-0/prepare-menu-inventory.js prepare --install
node phase-0/prepare-menu-inventory.js read /absolute/private/temporary/preparation.json
node phase-0/prepare-menu-inventory.js snapshot /absolute/private/temporary/preparation.json
```

Preparation creates a fresh mode-0700 temporary directory, private bound source/record and uniquely named Utility script. Installation uses exclusive creation and does not replace an existing script. It may require sandbox approval because the user script directory is outside the repository. Invoke the returned Utility menu item once while the exact existing disposable project is open. Preparation alone performs no editor capture.

The Lua script captures and encodes schema-3 state twice and requires byte-identical results before publishing. Each snapshot contains project/timeline/item IDs, observed type/index/name tracks, exact frame fields, media-pool IDs, linked item IDs and effect counts. A mismatch aborts without a completed result. Snapshots and the final envelope are bounded to 20 MiB. The private result is written, flushed, closed, reread and compared exactly through Fusion IOClass; a separate matching completion marker is written only afterward. Existing outputs stop a second invocation. Fusion does not provide a proven atomic exclusive-create primitive.

The host reader uses nonblocking, no-follow bounded regular-file reads. It requires a private current-user directory, owned singly linked outputs, the exact reconstructed source and recorded hashes, nonce/operation/version/project bindings, the existing strict schema-3 validator and the exact completion marker. It tightens owned outputs to mode 0600 before acceptance. It derives timeline/track/item/media/effect/link counts and both result-byte and canonical-snapshot hashes itself. The `read` command prints only this bounded summary; `snapshot` prints the full validated snapshot for explicit local retention or compression.

If `os.clock()` is available, `cpuMicros` samples process CPU across the two API captures and their snapshot encodings. It may include work by other editor threads during that interval. It is explicitly **not elapsed wall time**, editor save/write/reopen time, or media transfer latency. Missing CPU access stays unavailable. A snapshot equality check observes only represented fields and does not establish an atomic view of unrepresented properties.

## Scope and tests

`node --test tests/resolve-menu-inventory.test.js` executes the actual embedded source in the installed vendor Lua library against a mock API/virtual IOClass. It verifies two successful reads, wrong-project refusal, concurrent-change rejection, corrupt-readback refusal, replay protection, private preparation and exact host validation. It also verifies hardlink rejection preserves unrelated file permissions and that a changed prepared source cannot be accepted merely by changing its recorded hash.

General effect parameters, Fusion graphs, full inspector properties and nested internals are absent from schema 3. Tracks remain observed type/index/name locations. Retained API item IDs within this capture do not establish persistence across edits, save/reopen, relink or export. Copied local files are not authenticated editor provenance. Ordinary apply and release support remain unavailable.

## November 20 native observation

The actual Scripts menu captured all three existing timelines and **10,550 picture items**: 50, 500 and 10,000 respectively. Each timeline contained observed Video 1 and Audio 1 tracks; the audio tracks were empty. The returned media-pool ID counts were 50, 500 and 1. Both schema-3 reads matched exactly. The [native observation](resolve-menu-inventory-live-observation.json) binds the untouched [gzip-compressed result](resolve-menu-inventory-live-result.json.gz), original result digest, canonical snapshot digest, exact generated source, template and embedded capture source. Raw result bytes and the public template, base-capture and host-reader source hashes are recomputed by the focused test. The exact rendered source remains in private preparation records and is represented publicly by its observed hash; full result data stays path-free.

The CPU sample was 33,156,233 microseconds across both captures and encodings, with the process/thread caveat above. No elapsed wall-clock duration was measured. The capture initially had no completed output after the first wait; it later completed successfully. This was slow work, not a demonstrated failure.

A separately prepared [stage diagnostic](resolve-menu-inventory-diagnostic-live-observation.json) also completed both reads, encoding, result write/readback and completion marker. Its canonical snapshot digest exactly matches the first capture, with no raw error. The diagnostic retains bounded stage files and any raw error only inside its private temporary directory; its public reader exposes only allowlisted status/error codes and a private-error digest. The first raw result is committed once, while the second private raw result is represented by its verified digest and matching-snapshot summary. Both exact installed test scripts were verified and removed after completion; private preparation/result evidence remains retained.

This newly proves a bounded larger manual menu handoff and repeated read stability for these existing synthetic fixtures. It does not prove persistent identity after edits/save/reopen, effect parameters, complete nested/native coverage or editor-write performance.
