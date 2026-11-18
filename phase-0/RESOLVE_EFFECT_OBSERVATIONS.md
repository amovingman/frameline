# Resolve effect observations

Schema 1 of the read-only effect supplement captures effect type IDs, display names, enabled states, and 1-based indices through the installed Free 21.1.2.10 API. It includes a schema-3 snapshot and an effect list for every enumerated item. Schema 2 adds documented item properties and track state as described below. Both preserve the underlying schema-3 snapshot contract. New desktop recovery drills request schema 2; the standalone `prepare` command retains schema 1 unless `prepare-properties` is selected.

The installed `DaVinciResolveScript.pyi` documents `TimelineItem.GetEffects`, `Effect.GetInfo`, `GetIsEnabled`, and `GetIndex`. `GetInfo().id` identifies an effect catalogue entry, not an applied instance. Category/index is an observation location and can change after insertion or reordering. It is never treated as persistent effect identity.

## Capture and compare

```sh
node phase-0/capture-resolve-effects.js prepare 'Exact disposable project name'
node phase-0/capture-resolve-effects.js read CAPTURE_ID copied-console-output.txt > observation.json
node phase-0/capture-resolve-effects.js compare before.json after.json
```

Run the returned `command` in Resolve's Lua Console, then copy the Console output into a local text file. Each capture has an opaque ID and bounded ordered parts. The reader rejects missing, duplicate, reordered, different-ID, failed, or oversized transfers. The ID prevents accidental mixing; copied Console text is not authenticated editor provenance.

The Lua supplement enumerates every item and effect category, checks the catalogue category and available enabled/index values, and rejects sparse effect lists. It captures the base snapshot again to detect changes to the represented schema-3 fields during enumeration. The Node validator requires exactly one record per snapshot item, unique category/index slots, contiguous indices, and counts equal to the snapshot's effect counts. Unknown keys, missing items, unsupported versions, malformed values, and accessor properties are rejected.

Snapshots and display names retain their path restrictions. Slash-containing type IDs are allowed only under the known `Resolve FX/`, `Fusion/`, and `Audio FX/` catalogue prefixes; absolute paths, traversal segments, backslashes, and URL forms are rejected. The capture contains display metadata and opaque IDs, stays local, and does not collect media paths or effect parameters.

## Live Free evidence

On November 17 the supplement captured all 53 items in `Frameline Restore Probe`. It found one enabled OFX effect named `Gaussian Blur` at index 1 with catalogue ID `Resolve FX/Resolve FX Blur/Gaussian Blur`. The Console transferred four parts, which the Node reader validated. The untouched result is `resolve-xml-proof/live-effects-enabled.json`, SHA-256 `696ee1b32e09ff410f54ed4905c2423cc228437654511117f86d31ad4070f585`.

On this disposable copy only, a guarded Console command checked the exact project, item, and effect type, disabled the effect through `SetIsEnabled(false)`, saved, and closed/reopened the project. The disabled state persisted. `live-effects-disabled.json` hashes to `7b5cbe4ebe91f915e58b060f86a6f4eacf3daeb7750f3e9a78ce3a0e50b4728d`. The standard schema-3 snapshots are identical, including all effect counts. The supplement comparison detects exactly one `enabled: true → false` change.

A second guarded command restored the enabled state, saved, and closed/reopened again. `live-effects-restored.json` is byte-identical to the original enabled supplement. The original observed project state and enabled effect are restored. Tests pin the fixture bytes and recompute the difference and restoration. The first-editor audit also verifies these results.

## Guarded rename experiment

The standalone rename trial accepts the supplement as an additional source guard:

```sh
node phase-0/rename-resolve-trial.js prepare-effects BEFORE.json AFTER.json PRIVATE_DIR 'Frameline disposable project' EFFECTS.json
node phase-0/rename-resolve-trial.js prepare-reviewed-effects BASE.json LOCAL.json INCOMING.json AUDIT.json PRIVATE_DIR 'Frameline disposable project' EFFECTS.json
```

The supplement must represent exactly the trial's current schema-3 snapshot. Its exact bytes and hash are retained in the private prepared record. The backup command checks all represented effect metadata before and after export. The mutation command repeats this check before consuming the command or calling `SetName`, then verifies the expected clip name and unchanged effect metadata after save/reopen and after any rollback. A mismatched effect during rollback produces `recovery-required`; the trial cannot repair arbitrary effect changes.

`record-console` reads the full returned supplement, validates it against the expected state, and retains it privately as `result-effects.json` with source/result hashes in `result.json`. It separately stores the schema-3 snapshot for ordinary observation history. Reloading or saving the result to history revalidates the supplement, including semantic equality rather than only its digest. Newly saved reviewed outcomes include exact source/result supplements in the portable revision audit; revision backups preserve them. Existing immutable revisions remain unchanged, and their retained transaction records can be exported separately. Native backups and local recovery paths remain private. The manual `record` command accepts an optional fourth argument for the effect-result file. Legacy counts-only trials remain readable and do not gain an effect-preservation claim.

The live guarded trial on November 17 exported and verified its backup, then rejected its issued command after the Gaussian Blur effect was disabled and saved/reopened. The clip name was unchanged and the command remained unconsumed. A separate supplement capture confirmed exactly the same schema-3 fields and one enabled-state change. After the effect was restored and saved/reopened, the same issued command ran its intentional failure and rollback. The resulting schema-3 snapshot and full effect supplement matched the original hashes exactly. The path-free record is `effect-guard-rename-live-observation.json`; its archived backup and private transaction records remain local.

## Desktop recovery drill

The opt-in desktop drill requires the richer schema-2 supplement for every new transaction. **Copy state capture** prepares a read-only Console command for the named reviewed project. **Read state capture** verifies ordered, matching-ID output, nonempty property reads for every item, available enabled/locked track reads, and the exact represented local snapshot before creating the backup preparation or history baseline. Legacy schema-1 replies and unavailable/empty reads stop preparation. This does not require all 51 documented keys: keys not returned by Resolve remain unobserved. Accepted captures automatically copy the guarded backup command. Review actions stay locked until preparation is cancelled or the issued drill is resolved. Failed reads preserve the request for retry; cancellation before backup preparation leaves no transaction or baseline.

The remaining controls verify/copy the drill, read its full returned observation, and save the outcome revision. The interface shows the bound hash, returned-property/item/track counts, unavailable-read counts, and the limits of the observation. Commands, property values, complete observations and paths remain in the main process. Reopening a completed outcome reconstructs coverage from the revalidated retained source. Legacy schema-1 drills report that inspector properties and track states were not captured; counts-only drills do not gain an effect claim.

The earlier schema-1 desktop flow ran against the disposable project on November 17. It captured the enabled effect, verified a private 69,299-byte archive, rejected a result read without a valid result marker, then ran and verified forced rollback. Snapshot and effect hashes matched the originals. The outcome was saved as revision `e2cfdeab-c16b-4543-97f3-e12046836d6f`; its manifest, metadata record hash, transaction link, effect supplement, and backup were read and verified from disk. `desktop-effect-guard-live-observation.json` retains that evidence.

The subsequent schema-2 desktop flow selected the checked-in before snapshot as base/local and the applied snapshot as incoming, captured the current disposable project, and verified 43 returned property keys with 443 values across 53 items, one effect and two tracks. No reads were unavailable. Its private archive is 69,366 bytes. The copied drill completed forced rename/save/reopen/rollback/save/reopen, and Frameline verified byte-identical richer observations before saving revision `d727d131-573a-4161-9a12-c131a1b093df` with the full portable audit. After a complete app restart, the retained-folder picker reopened that completed outcome without reselecting review files, reconstructed the same coverage, and returned the same revision on save. Trial file bytes/modes and the 13-record project history remained unchanged by reopening/repeated save. `desktop-property-guard-live-observation.json` records this native evidence. That report covers completed-outcome recovery. A subsequent injected schema-2 interruption also passed native desktop recovery: a saved Pan divergence blocked restoration, a fresh inspection after supported property restoration allowed the reverse rename, and the complete richer observation matched afterward. The linked audit and idempotent completed-outcome reopen survived another restart. See `rich-interruption-recovery-live-observation.json` and `RESOLVE_INTERRUPTION_RECOVERY.md`. Ordinary apply remains disabled.

## Item properties and track state

The installed scripting reference documents `TimelineItem.GetProperties()`, `Timeline.GetIsTrackEnabled()` and `GetIsTrackLocked()`. `src/resolve-property-contract.json` pins that reference's hash and its 51 documented item-property keys: transform, crop, composite/opacity, scaling/retime options, audio inspector properties and transition metadata. These are distinct from OFX effect parameters; the installed effect API does not expose general OFX parameter reads.

```sh
node phase-0/capture-resolve-effects.js prepare-properties 'Frameline disposable project'
node phase-0/capture-resolve-effects.js read CAPTURE_ID copied-console-output.txt > properties.json
node phase-0/capture-resolve-effects.js compare before-properties.json after-properties.json
```

The explicitly requested richer command returns supplement schema 2. Each enumerated item has `propertyReadStatus` and a dictionary of returned documented properties. Missing keys remain unobserved. A nil/failed property read is marked `unavailable` with an empty dictionary, rather than replaced by defaults. Unknown domain keys and invalid types fail capture/validation. The bridge's non-domain `__flags` entry is omitted. Active-timeline-only properties are collected only from the captured active timeline; changing that timeline during capture rejects the result. Every observed track has enabled/locked booleans or explicit nulls when a read is unavailable. Track type/index remains an observation location, not persistent identity.

Numeric item properties use a `{ "decimal": "1.3250000000000000e+01" }` wrapper containing the Lua runtime's 17-significant-digit scientific representation. Retaining that text avoids a Lua/JavaScript JSON formatting difference invalidating an otherwise unchanged guard. Validators reject malformed, infinite and underflow-to-zero representations. Booleans remain booleans; transition strings are restricted and path-free. Comparison separately reports property changes, property-read availability, track state and active-timeline context. Comparing schema 1 with schema 2 marks property coverage `not-comparable`; it does not infer missing values.

The reviewed rename trial accepts schema-2 supplements through the existing `prepare-reviewed-effects` path. Backup, mutation, rollback and recovery commands retain the original supplement version and compare its complete represented state. Result recording and portable revision audits preserve and revalidate the richer bytes. Existing schema-1 preparations, commands and historical outcomes remain compatible. New desktop drills use schema 2; standalone capture requests opt in through `prepare-properties`.

On November 17, a live schema-2 capture read all 53 items and two tracks in `Frameline Restore Probe`. All item property reads succeeded and returned 43 distinct documented keys. `live-properties-enabled.json` hashes to `903af23882b20e93beb42532b7ac101917d045d7d06d749352b080f9e7d66e21`. Its schema-1 projection exactly matches the earlier enabled effect fixture. A guarded, supported `SetProperties` call changed the first disposable clip's Pan from 0 to 13.25, saved and closed/reopened the project. The independent richer capture detects exactly that property change; schema-3 fields, effect metadata and track state are unchanged. `live-properties-pan-changed.json` hashes to `d181b2cc1c2cd4fd06b97bc388ec245dafcbc7b05ceee085e6c532613f42d7fd`.

An issued rename trial with a verified 69,403-byte native backup rejected that saved property change as a stale source before renaming. Restoring Pan through the supported API and saving/reopening allowed the same unconsumed command to complete its forced rename/rollback. The complete richer result is byte-identical to the original and is retained as `live-properties-restored.json`. The outcome saved observation revision `27a7ade3-7e7b-4847-8347-32901e915685` in a disposable metadata store with the complete portable audit. A final capture after another save/reopen for the startup recovery test still matched the original bytes. `property-guard-rename-live-observation.json` records this evidence; tests and the first-editor audit recompute it.

The test harness also executes the actual supplement source in the installed vendor Lua library against a mock API, without connecting to Resolve. It checks decimal serialization, unavailable reads, unknown-key rejection, active-timeline changes and byte-compatible legacy capture. This mock runtime check is optional on hosts without a compatible library; JavaScript validation, guard/recovery and pinned live-evidence tests run normally.

## Remaining validation

The comparison reports changes by project/timeline/item ID and effect category/index, with both exact source hashes. It always returns `safeToApply: false`. Effect parameter values, Fusion graph contents, nested content, automation, and persistent effect-instance IDs remain unobserved. Returned inspector properties do not establish complete property coverage or effect preservation. The capture rechecks schema-3 fields and active-timeline context around enumeration; it cannot guarantee an atomic view of property/effect metadata during concurrent editor changes. Interrupted guarded forced-rollback drills retain their supplement version during fresh inspection and final verification; see `RESOLVE_INTERRUPTION_RECOVERY.md`. Ordinary product apply, general recovery, and full validation remain open.
