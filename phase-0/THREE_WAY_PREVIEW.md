# Read-only three-way preview

For DaVinci Resolve **Free 21.1.2.10**, capture schema-3 API snapshots from named disposable Frameline project copies through Resolve's internal console. Select a common base, the current local state, and an incoming state, then preview changes:

```sh
node phase-0/preview-free-merge.js base.json local.json incoming.json
```

The command prints JSON. To keep a review artifact, redirect that output to a new file, then check whether any source changed:

```sh
node phase-0/preview-free-merge.js verify preview.json base.json local.json incoming.json
```

The preview compares API item IDs within the same Resolve project and Free build. Each changed field is classified as `incoming-only`, `local-only`, `already-applied`, or `conflict`. A local edit against an incoming deletion is a conflict. The policy warns about timing and possible ripple interactions, linked items, effects, unsupported item types, additions and deletions, and track identity based only on type/index. Exact SHA-256 hashes bind all three source snapshots; verify mode reports stale roles without changing them.

This is a diagnostic, not a pull plan. FCPXML exports lack API item IDs; track IDs and full linked/effect behavior are not proven; source media availability is not assessed here. The preview always reports `safeToApply: false` and cannot modify Resolve, a project, or a snapshot. The app's pull control remains disabled.
