# Read-only three-way preview

For DaVinci Resolve **Free 21.1.2.10**, capture schema-3 API snapshots from named disposable Frameline project copies through Resolve's internal console. Select a common base, the current local state, and an incoming state, then preview changes:

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

This is a diagnostic, not an executable pull plan. FCPXML exports lack API item IDs; track IDs and full linked/effect behavior are not proven; media availability remains unknown. A recovered artifact holds the preview, not the source snapshots or a recoverable editor write transaction. Every result reports `safeToApply: false` and cannot modify Resolve, a project, or a snapshot. The app's pull control remains disabled.
