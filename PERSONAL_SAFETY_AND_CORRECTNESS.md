# Personal data safety and correctness

The owner workflow targets the installed Resolve Free 21.1.2/build 21.1.20010 on macOS. Safety and correctness claims apply to the supported operations below. They do not declare a public release range, hosted disaster recovery, unsaved native identity, cross-export FCPXML occurrence identity, arbitrary native edits or exclusion of an unrelated external writer.

In History, **Verify local records** checks the selected real FCPXML export and its immutable revision graph, together with retained native checkpoint pull records. It reads private source records in the main process, reports only counts and controlled status, and never repairs a file, opens Resolve or authorizes Apply. An empty store is reported as empty. A failed or changing source remains unverified.

The verifier validates every retained checkpoint's authenticated record, database and census hashes, complete native graph and exact typed census. It recomputes a complete no-op comparison twice and requires the same deterministic report hash. Known UUIDs retain application IDs and comparison tokens across edits; observed deletion and recreation require a new generation and fresh IDs. Forked copies retain explicit verified ancestry and separate application IDs. Parent relationships and project IDs are checked independently of UI labels. Work is bounded to 100 checkpoints/intents, 200,000 represented identity entries, 200,000 cumulative derived identity/tombstone entries and two million comparison coordinates, with a yield between checkpoints.

For each retained native pull transaction, the verifier authenticates its journal and checks its plan binding, streams the retained backup/candidate through SHA-256, rejects links and paths outside its private artifact store, and independently recomputes the complete native field-preservation proof. Validated outcomes also pass the native result-audit reconstruction, including exact decisions and source bindings. These are historical integrity checks: the current editor project and backup availability at the time of a later restore require fresh checks. The writer independently rechecks all required conditions before publication.

## Supported boundaries

| Operation | Correctness boundary | Safety boundary |
|---|---|---|
| FCPXML 1.10 picture scan | Exact rational-to-integer frame arithmetic; scan-position keys explicitly unresolved; unsupported/nested content warned | Read only; source identity/hash verified; no source path in renderer manifest |
| Immutable local history | Source-bound manifests, complete parent graph, branch heads, record hashes and strict schemas | Exclusive records, atomic metadata/backup behavior, checked restore/import and compare-and-swap heads |
| Saved native checkpoint comparison | Complete typed fields/schema/pragmas, stable-key joins and explicit atomic unknown structures; physical storage separate | Authenticated private snapshots and sidecars, verified ancestry, no write authority from comparison |
| Existing video clip Name pull | One UUID-bound field, explicit complete choices and unchanged-reference media requirements | Verified backup, stale-source checks, all-other-field comparison, metadata-preserving atomic publication, actual editor-file admission, post-close validation and exact restoration |
| Media relink review copy | Exact class/hash/size identity; only reviewed XML src values change; original/proxy roles remain distinct | Exclusive new copy; original XML/media unchanged; a derived editor project has its own explicit one-use import/validation boundary |

The derived media review has a separate read-only closed-output check. Resolve creates its new database with mode `0666`; the check requires an owned private access boundary, exact generated path, all three native admissions, unchanged closed hash/metadata and native project identity. It never changes database permissions and grants no native write authority. The existing Name writer retains its stricter permission guard. SDK import/save is a new representation and is not claimed to preserve arbitrary native fields losslessly.

## Concrete correctness fixes

Duplicate XML resource IDs now refuse scanning instead of allowing a later resource to silently replace an earlier asset or format. Conflicting original-media declarations also refuse. A proxy-only representation never establishes camera-original availability. The original is selected independently of declaration order; missing original evidence remains unknown with a specific warning.

Timeline and source interval endpoints must stay within safe exact integers, including imported manifests. Fractional frame rates use integer rational arithmetic rather than rounded seconds. Independent checks cover 120 frame-count/rate combinations, malformed resources and zero rational denominators, original/proxy ambiguity, UUID deletion/recreation, corrupted checkpoint bytes, corrupted backups/candidates, changed selections and private artifact confinement. Existing editor-backed compatibility fixtures remain readable. FCPXML scan positions are never promoted to persistent native IDs.

## Acceptance evidence

- [Local integrity desktop proof](phase-0/local-integrity-desktop/verification.json): two shipped Electron processes verify an immutable two-revision history, native identity/checkpoint graph, authenticated transaction, retained backup/candidate and both resulting audits. Restart reproduces the same report digest. Independent backup/candidate corruption and a corrupt metadata primary with a healthy backup fail without repair, recovery, migration, renaming, added files or canonical source/history mutation. Desktop and narrow layouts have no overflow or renderer errors.
- [Proxy-safe relinking](MEDIA_RELINK.md): an actual 50-occurrence review copy retains distinct original/proxy paths and exact frame coordinates through save/reopen, two actual-open-file admissions and separate closed-file validation. Original XML, media and the existing native fixture remain unchanged.
- [Integrated crash recovery](CRASH_RECOVERY.md): actual process termination during scanning, acknowledged HTTPS upload and atomic Apply; explicit restart/resume/reconciliation preserves acknowledged work and restores exact native original bytes. Machine power loss is not claimed.
- [Resulting conflict decisions](NATIVE_RESULT_AUDIT.md): canonical historical decision reconstruction and path-free portable audit exports. A portable hash is integrity evidence, not local authentication or write authority.
- [Native pull proof](NATIVE_PULL.md) and [safe Apply](SAFE_APPLY.md): independently retained actual editor readback and closed-file preservation/restoration evidence. Original and incoming native files are retained unchanged after the proof cycles.

The repository test suite also retains metadata/service backup/restore, immutable revision transfer, schema migration, downgrade refusal, atomic publication and metadata-preservation checks. Optional self-hosted service tests use disposable accounts and certificate-verified loopback HTTPS; they do not establish managed production durability or hosted recovery.

Final validation passed **2,364 repository tests with zero failures or skips**, package input/archive checks, and all three fresh native evidence audits. The separate desktop proofs exercised real process restarts and the supported controls; the native import/Apply/restore proofs used Resolve itself.
