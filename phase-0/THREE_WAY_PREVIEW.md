# Read-only three-way preview

For DaVinci Resolve **Free 21.1.2.10**, capture schema-3 API snapshots or complete schema-1/2 effect/property observations from named disposable Frameline project copies through Resolve's internal console. Select a common base, the current local state, and an incoming state, then preview changes:

```sh
node phase-0/preview-free-merge.js base.json local.json incoming.json
```

The command prints JSON. To keep a review artifact, redirect that output to a new file, then check whether any source changed:

```sh
node phase-0/preview-free-merge.js verify preview.json base.json local.json incoming.json
```

If a source changed, recompute the preview and inspect which roles were stale:

```sh
node phase-0/preview-free-merge.js refresh preview.json base.json local.json incoming.json
```

To keep a verified preview across an interruption, create an existing private directory and save an immutable artifact. Recovery requires the exact three source snapshots again:

```sh
node phase-0/preview-free-merge.js save preview-artifacts base.json local.json incoming.json
node phase-0/preview-free-merge.js recover preview-artifacts ARTIFACT_ID base.json local.json incoming.json
```

The preview compares API item IDs within the same Resolve project and Free build. Each changed field is classified as `incoming-only`, `local-only`, `already-applied`, or `conflict`. A local edit against an incoming deletion is a conflict. The assessment lists proposed incoming changes, conflicts, possible media requirements with unknown availability, and validation warnings. The policy warns about timing and possible ripple interactions, linked items, effects, unsupported item types, additions and deletions, and track identity based only on type/index. Exact SHA-256 hashes bind all three source snapshots; verify mode reports stale roles and rejects modified plan contents when the source bytes still match.

The preview also supplies observed-field conflict guidance. Deletion versus edit is an entity conflict. Concurrent additions have a stable review order based on IDs, but no automatic timeline placement; timing and move interactions require manual review. No field is currently proven safe for app-level apply.

The separate review command exposes risk gates, choices, and an audit record. It verifies the saved preview against all three source snapshots each time:

```sh
node phase-0/review-free-merge.js risk base.json local.json incoming.json
node phase-0/review-free-merge.js review preview.json base.json local.json incoming.json
node phase-0/review-free-merge.js audit preview.json decisions.json base.json local.json incoming.json
node phase-0/review-free-merge.js verify-audit audit.json preview.json base.json local.json incoming.json
```

`decisions.json` is an array of `{ "conflictId": "...", "choice": "keep-local" }` or `"take-incoming"` entries, one for every listed conflict. The audit records selected *observed* values and remains review-only. Manual values are unavailable because no field has a proven safe app-level write rule.

A standalone preflight can make a verified restore-point copy of a regular file in an existing caller-owned directory:

```sh
node phase-0/create-restore-point.js source.fcpxml restore-points EXPECTED_SHA256
```

It checks the source hash, streams a noncolliding copy, verifies its bytes, and leaves the source unchanged. It is not connected to a Resolve apply transaction.

This is a diagnostic, not an executable pull plan. FCPXML exports lack API item IDs; track IDs and full linked/effect behavior are not proven; media availability remains unknown. A recovered artifact holds the preview, not the source snapshots or a recoverable editor write transaction. Every result reports `safeToApply: false` and cannot modify Resolve, a project, or a snapshot. The app's pull control remains disabled.


## Richer capture review

The desktop three-file chooser and preview/review commands also accept validated complete `resolve-effect-observation` JSON. **Save capture JSON** produces this format from a verified Console capture. Native revision manifests and backup bundles are not accepted as capture files. History preview includes available supplements by default, using normal manifest-v3 observations or a validated older trial result; its checkbox selects snapshot-only compatibility when cleared. A current verified local capture is bound by its complete observation hash in richer mode. Source hashes cover the exact selected bytes, including whitespace, so a compact export and an older newline-terminated capture can represent the same values while having different fingerprints.

Any richer source produces preview plan schema 2. All-snapshot inputs retain the original schema-1 plan, classification, hashes and artifact semantics. Richer plans retain the same four observed-change statuses and include:

- Returned documented item properties, with exact decimal normalization that preserves represented precision.
- Effect metadata as whole category/index slots; the slot position is not a persistent effect-instance ID and parameters remain unobserved.
- Track enabled/locked state by type/index when all three track layouts match. A layout change carries the observed states in the whole track-collection decision to avoid overlapping choices.
- Available supplements inside whole item/timeline addition/deletion decisions, preventing an incoming deletion from hiding a local inspector edit.

A property field is classified only if every source returned that key successfully. Missing captures, unavailable reads and keys not returned remain separate coverage gaps with the available values on each side. They do not become zero, false, unchanged or selectable field conflicts. The desktop reports source coverage counts and pages through all gaps, twenty at a time. Missing coverage can conservatively cause whole-entity observations to differ. Capture context is not a mergeable edit; a context-difference warning requires known, different active-timeline observations.

Richer sources are limited to 20 MiB per role, 20,000 classified fields and 20,000 gaps, and a serialized plan below 31 MiB. Saved artifacts retain their 32 MiB limit. Saved review choices bind the full plan and source bytes; a property-only source change clears previous choices and prevents recovery of stale artifacts. Optional FCPXML matching extracts the validated snapshot component but keeps the complete role fingerprint for invalidation.

Richer plans remain read-only and are explicitly refused by the existing disposable rename experiment before command preparation. That experiment requires the separate snapshot-only format. No property, effect or track-state mutation workflow is enabled.

### Verification

`property-preview-live-observation.json` records native Electron verification using existing disposable Resolve captures: audited base `3b8b41dd…`, restored local `90be6d7d…`, and changed incoming `59796fa0…`. The richer preview showed exactly one incoming-only field, `properties.Pan`, with base/local 0 and incoming 13.25, and zero coverage gaps. Native preview/review saving and review recovery succeeded; snapshot-only mode showed zero changed snapshot fields. A new six-part read-only capture exported 45,777 bytes with private permissions and reopened through all three native file choosers, retaining the Pan comparison. No Resolve edits or history revisions were created by this verification.

A separate isolated browser fixture synthesized a Pan conflict (0 / 13.25 / 26.5) from the recorded capture to verify choice saving/recovery. Mixing a snapshot-only base with richer sides produced 448 explicit gaps. Paging retained keyboard focus and disclosure state. Desktop, tablet and narrow widths (1440/768/390) showed readable values without horizontal overflow. Synthetic conflict evidence does not claim a live concurrent editor edit.
