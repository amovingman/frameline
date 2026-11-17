# Resolve effect observations

The read-only effect supplement captures effect type IDs, display names, enabled states, and 1-based indices through the installed Free 21.1.2.10 API. It includes a schema-3 snapshot and an effect list for every enumerated item. This preserves the existing schema-3 contract; ordinary desktop captures and revision manifests remain unchanged.

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

`record-console` reads the full returned supplement, validates it against the expected state, and retains it privately as `result-effects.json` with source/result hashes in `result.json`. It separately stores the schema-3 snapshot for ordinary observation history. Reloading or saving the result to history revalidates the supplement, including semantic equality rather than only its digest. These private transaction artifacts are not part of an exported revision backup. The manual `record` command accepts an optional fourth argument for the effect-result file. Legacy counts-only trials remain readable; the current desktop drill still prepares those trials and does not collect this supplement.

The live guarded trial on November 17 exported and verified its backup, then rejected its issued command after the Gaussian Blur effect was disabled and saved/reopened. The clip name was unchanged and the command remained unconsumed. A separate supplement capture confirmed exactly the same schema-3 fields and one enabled-state change. After the effect was restored and saved/reopened, the same issued command ran its intentional failure and rollback. The resulting schema-3 snapshot and full effect supplement matched the original hashes exactly. The path-free record is `effect-guard-rename-live-observation.json`; its archived backup and private transaction records remain local.

## Remaining validation

The comparison reports changes by project/timeline/item ID and effect category/index, with both exact source hashes. It always returns `safeToApply: false`. Effect parameter values, Fusion graph contents, nested content, automation, and persistent effect-instance IDs remain unobserved. Complete effect preservation cannot be inferred from one matched catalogue ID or enabled state. The capture rechecks schema-3 fields around enumeration; it cannot guarantee an atomic view of effect metadata during concurrent editor changes. Binding richer observations into desktop/product apply remains required. Ordinary apply remains disabled.
