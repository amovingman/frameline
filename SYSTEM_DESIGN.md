# System Design: Git for Video Editing

## 1. Goal

Let editors version their projects, share changes, and pull updates into a project they already have. A pull can use either of two modes:

- **Apply in place:** update the existing project file with incoming, non-conflicting edits.
- **Create review copy:** create a separate project file with incoming changes applied, leaving the current project untouched.

Both modes use the same change comparison and conflict detection. They differ in where the result is written.

## 2. Scope and assumptions

The first release should support **one video editor and its project format**. Selective updates require a format parser, an editor API, or a plugin that can reliably identify and modify timeline objects. The system should not attempt to patch arbitrary project-file bytes.

The system versions **edit decisions and project metadata**. Source footage, audio, graphics, and renders are stored separately as large media assets. This avoids copying entire media libraries for every revision.

For the initial release, target a local desktop project with cloud history and sharing. Offline editing should remain possible; users can sync changes when they reconnect.

### Current integration evidence (2026-11-03)

DaVinci Resolve Free 21.1.2 (build 21.1.20010) on macOS is the initial editor target. A synthetic FCPXML 1.10 timeline with three still-image clips imported successfully; Resolve exported it as an FCPXML bundle, and a separate copy with one clip extended by one second reimported as a 10-second timeline. A later Free editor-backed export contains 1,001 primary picture clips that the read-only scanner enumerates. The detailed procedure and artifacts are in `phase-0/resolve-xml-proof/README.md` and `phase-0/SCAN_BENCHMARK.md`.

This only proves basic still-image timeline exchange. Resolve's export converted `<asset-clip>` elements to generic `<video>` elements and omitted the fixture's clip IDs. A repeated-media reorder test also showed that Resolve reassigns FCPXML resource references by position and discards a custom clip name. Neither field can serve as a stable clip ID. Before committing to FCPXML as the write format, the spike must prove a reliable sidecar mapping or supported API identity across moves, trims, deletions, and relinks, then cover moving footage, audio, and track layout. Do not treat FCPXML interchange as native Resolve project-file support.

## 3. Architecture

```text
┌───────────────────────────┐
│ Desktop app or NLE plugin │
│ Project scan, pull UI,    │
│ backup, apply, validation │
└─────────────┬─────────────┘
              │ HTTPS
┌─────────────▼─────────────┐
│ Project API               │
│ Auth, history, branches,  │
│ commits, pull planning    │
└──────┬───────────┬────────┘
       │           │
┌──────▼──────┐ ┌──▼────────────────┐
│ Metadata DB │ │ Object storage    │
│ revisions,  │ │ media, proxies,   │
│ manifests,  │ │ thumbnails        │
│ permissions │ └───────────────────┘
└─────────────┘
       │
┌──────▼────────────────────┐
│ Background workers         │
│ media hashing, previews,   │
│ asset checks, validation  │
└───────────────────────────┘
```

The **desktop app or plugin** reads the local project, builds a structured representation, shows pull plans and conflicts, and applies the result. It should make a recoverable backup before any in-place update.

The **project API** handles users, access control, branches, commits, revision comparison, and pull-plan creation. It should not need to upload or download unchanged media for every revision.

The **metadata database** stores project and revision records, manifests, branch heads, permissions, and activity. **Object storage** stores media assets by hash. Background workers handle slower jobs such as hashing large media, generating proxies, and checking asset availability.

## 4. Project and revision model

Each project has a stable project ID and a manifest for each revision. A manifest describes editing data in a normalized, editor-independent form, while retaining any editor-specific data required to write the project file back correctly.

A simplified manifest could look like:

```json
{
  "projectId": "project-id",
  "revisionId": "revision-id",
  "editor": "supported-editor",
  "sequence": {
    "width": 3840,
    "height": 2160,
    "frameRate": "24/1"
  },
  "assets": [
    {
      "assetId": "asset-id",
      "contentHash": "sha256:...",
      "path": "Media/scene-01.mov"
    }
  ],
  "clips": [
    {
      "clipId": "clip-id",
      "assetId": "asset-id",
      "trackId": "video-1",
      "sourceIn": 120,
      "sourceOut": 360,
      "timelineStart": 240,
      "effects": []
    }
  ]
}
```

Clips, tracks, effects, and other timeline objects need stable IDs across revisions. If the editor’s project format does not provide IDs, the integration must generate and persist them using a reliable mapping strategy. Clip names or timeline positions alone are not reliable identities.

Each revision stores a parent revision, author, timestamp, message, and manifest reference. A commit records a new project state; branches point to revisions. Media assets are referenced by content hash so identical files can be reused.

## 5. Pull flow

A pull starts by identifying:

- The local project’s last synced revision
- The current local project state
- The incoming branch or revision

The client fetches the common base revision and incoming manifest, then compares both with the current local state. The result is a **pull plan** containing proposed changes, conflicts, required media, and validation issues.

### Apply in place

1. Create a timestamped backup or restore point.
2. Confirm the project file has not changed since the pull plan was generated.
3. Apply non-conflicting incoming changes through the editor API or a format-specific writer.
4. Preserve local changes to unrelated timeline objects.
5. For conflicts, let the user choose a version or resolve the affected fields.
6. Save and reopen or validate the project through the editor integration.
7. Record the resulting revision and update the local sync base.

If the project changes between planning and application, discard the stale plan and recalculate it. Do not overwrite unexamined edits.

### Create review copy

1. Copy the project file and its required project metadata to a new location.
2. Apply the incoming changes to the copy using the same pull plan and conflict choices.
3. Keep the original project and its sync base unchanged.
4. Report the copy’s location and any unresolved conflicts.
5. Let the editor open the copy for review.

The copy can reference the same local media when paths remain valid. If media must be collected into the copy, the client should make that explicit and copy only required assets.

## 6. Change detection and conflict rules

The comparison engine identifies additions, deletions, and modifications to timeline objects and properties.

For each object, compare:

- **Base:** the common revision
- **Local:** the current project
- **Incoming:** the pulled revision

A change is generally safe to apply when only the incoming side changed that object or property. If both sides changed the same property differently, it is a conflict. If both sides made the same change, it can be treated as already applied.

Examples:

- Incoming change to clip A’s effect; local change to clip B’s trim: usually mergeable.
- Incoming and local changes to the same clip’s in-point: conflict.
- Incoming deletion of a clip that was locally modified: conflict.
- Both sides add clips at the same timeline location: likely conflict or requires a defined ordering rule.

Conflict detection should work at the smallest reliable level, such as a clip property, rather than treating the entire project as one indivisible file. However, a field should only merge automatically when the editor format’s behavior is understood. Timeline ordering, ripple edits, linked audio/video, nested sequences, and transitions may require broader conflict rules.

The UI should show the affected clip, property, local value, incoming value, and available resolution choices. Never silently discard a user’s local edit.

## 7. Media storage and sync

Media uploads should be chunked, resumable, and verified with a cryptographic hash. The client hashes files incrementally so it does not need to load large media into memory. Storage should deduplicate identical assets by content hash.

A project revision may reference assets that are:

- Already present in cloud storage
- Available only on a collaborator’s machine
- Missing locally
- Excluded from sync by project policy

Before applying a pull, the client checks whether required assets are available and whether paths can be resolved. It should offer relinking or download options for missing media. The system should distinguish an unavailable media file from a missing edit instruction.

## 8. Data model

A relational database can store:

- `users`, `teams`, and `memberships`
- `projects` and `project_permissions`
- `branches` with the current revision pointer
- `revisions` with parent revision and manifest reference
- `assets` with hash, size, type, and storage location
- `revision_assets` linking revisions to required assets
- `pull_plans` and conflict-resolution records, if plans need to be resumed
- `activity_events` for audit and history

Manifests can be stored as versioned JSON documents or normalized records. For an MVP, storing immutable manifest blobs with indexed project/revision metadata is simpler; normalize further if queries or comparisons demand it.

### Executable service foundation

The local domain prototype in `src/project-api-contracts.js`, `src/cloud-history-store.js`, and `src/service-maintenance.js` exercises the first service invariants before deployment: versioned contracts, content-addressed immutable manifests, immutable revisions, compare-and-swap branch heads, exact-input idempotency, signed pagination, state migration, verified backup/restore, restore drills, and non-destructive retention reports. It has no network listener, hosted database, object store, or selected deployment region. Those remain deployment gates rather than implied capabilities.

The next local layer adds rotating sessions and recovery, team invitations and project roles, authenticated authorization before project-resource operations, an Electron `safeStorage` credential vault, encrypted service records, rate limits, hash-chained audit events, and account deletion safeguards. The revision-sync proof validates immutable local bundles before push, fetches metadata without media, classifies divergence, persists exact-input offline work with bounded retry, preserves concurrent remote heads, and keeps an integrity-checked metadata cache. `SECURITY_MODEL.md` documents its trust boundaries. A real network boundary, durable hosted enforcement, user-facing sync controls, hosted key management, and region selection remain open.

## 9. Reliability, security, and performance

- Use immutable revisions so history cannot be accidentally rewritten.
- Use atomic branch-head updates to prevent concurrent pushes from silently replacing one another.
- Verify media hashes on upload and download.
- Make uploads resumable and safe to retry.
- Keep local backups until a pull has been applied and validated successfully.
- Use encryption in transit and at rest, project-level access controls, and audit history.
- Avoid storing credentials or media paths in public logs.
- Use incremental hashing and streaming I/O for large media.
- Cache manifests and media locally so opening and editing does not depend on a live connection.
- Apply retention and deletion policies that account for assets still referenced by revisions.

## 10. MVP requirements

### Must have

- One supported editor and project format
- Local project scanning and normalized manifests
- Stable timeline object IDs
- Commit history, branches, push, and pull
- Media hashing, resumable transfer, and missing-media detection
- Pull plan with changed objects and conflicts
- Apply in place with backup and recovery
- Create review copy
- Manual conflict resolution
- Project access controls and revision attribution
- Validation that the edited project can be opened by the supported editor

### Defer until later

- Real-time co-editing
- Automatic merging of complex ripple edits
- Multiple editor integrations
- Collaborative review comments and approvals
- Cloud rendering
- Advanced asset lifecycle and studio storage integrations

## 11. Main technical risks

The largest risk is **project-format integration**. The chosen editor must expose enough structure to identify clips and write changes safely. The next risk is **timeline merge semantics**: edits can affect neighboring clips, transitions, linked media, and timing in ways that are not obvious from isolated fields. Media storage cost and transfer time are also significant, especially when projects involve many terabytes of footage.

A useful first milestone is a prototype for one editor that can scan a project, show a structured diff, and apply a change to one clip while preserving unrelated local edits. Once that works reliably, add revision history and cloud sync around it.
