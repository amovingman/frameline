# Frameline product roadmap

A dependency-first roadmap from the current Electron prototype to a safe, collaborative version-control workflow for video projects. The initial integration target is **DaVinci Resolve Free 21.1.2 on macOS with FCPXML 1.10**. Release support remains gated by complete read coverage, stable identity, and a recoverable write transaction.

## Product outcome

Editors can scan a local project, save immutable revisions, share a branch with a collaborator, review a three-way change plan, resolve conflicts, and apply safe edits to the original project or a review copy. Unchanged media is referenced by hash rather than recopied. The app remains useful offline and clearly reports whether media is local, synced, missing, or excluded.

## Roadmap overview

| Phase | Outcome | Exit gate |
|---|---|---|
| 0. Choose and prove the editor integration | Evidence that one real project can be read, identified, and safely written | A copied sample project round-trips and reopens in the editor |
| 1. Local project safety and history | Scan, manifest, local revisions, branches, and comparison | Revisions are durable; unrelated local work survives a test merge |
| 2. Safe pull MVP | Pull plan, field conflicts, backup, review copy, in-place apply, validation | One supported edit can be applied and recovered without losing local work |
| 3. Cloud history and collaboration | Accounts, permissions, immutable remote revisions, branches, sync | Two authorized users can exchange revisions and recover offline changes |
| 4. Media sync and team operations | Resumable content-addressed media, relinking, audit and retention | Required assets are verifiably available for a pull |
| 5. Broader product | Additional editors and advanced collaboration | Each new integration meets the same safety and compatibility gates |

Phases 0–2 create a useful local-first MVP. Cloud sharing is deliberately sequenced after the local project model and pull transaction have proven safe.

## Delivery workflow

After every completed feature, commit and push the change to GitHub. Verify the remote commit, keep its pull request updated when using a feature branch, and report the GitHub link and whether the change has been merged into `main`.

---

## Phase 0 — Editor choice and integration proof

### 0.1 Select the initial editor and format
- [ ] List likely first users and the editor/version they use most.
- [x] Research Free Resolve 21.1.2 timeline exchange feasibility: FCPXML timeline import/export is available in the installed build.
- [x] Narrow the initial integration target to the tested Free 21.1.2 build on macOS. Studio and other versions are outside this target.
- [x] Resolve 21.1.2 (build 21.1.20010) imported a disposable three-clip FCPXML fixture, exported it, and reimported a modified copy. See `phase-0/resolve-xml-proof/README.md`.
- [x] Compare FCPXML, Resolve scripting, and native project paths, licensing, and available fixtures in `phase-0/INTEGRATION_ASSESSMENT.md`; the final choice remains open.
- [ ] Confirm whether the integration can enumerate sequences, tracks, clips, transitions, effects, and linked audio/video.
- [x] Add a Free-only, read-only FCPXML diagnostic for serialized sequences, lanes/gaps, explicit audio, transitions, and effects. It preserves unresolved timing and link semantics and does not close the complete-enumeration gate. See `phase-0/READ_ONLY_INVENTORY.md`.
- [x] Confirm a supported API write path for limited clip edits: live Free-edition duplicate-timeline move, trim, and deletion plus documented methods; app-level safe apply remains unproven.
- [x] Document the experimental FCPXML 1.10/Resolve Free 21.1.2 boundary and unsupported constructs in `phase-0/SUPPORT_MATRIX.md`; no release-supported minimum is declared yet.
- [x] Record the initial Free/FCPXML target and current evidence in `PRODUCT.md` and `SYSTEM_DESIGN.md`; the write path remains open pending stable identity and broader timeline coverage.

### 0.2 Build a representative compatibility corpus
- [x] Create synthetic FCPXML fixtures covering common timeline structures in `phase-0/compatibility-corpus/`; editor-backed projects remain open.
- [x] Include synthetic trims, moves, insertions, deletions, connected audio, transitions, effects, and nested-clip placeholders; Resolve-backed coverage remains open.
- [x] Keep untouched synthetic originals and expected parsed manifests under a fixture policy; Resolve exports and broader structures remain to be added.
- [ ] Add projects saved from every editor version in the declared support range.

### 0.3 Prove safe read and write access
- [x] Implement a disposable FCPXML spike that scans timeline clips into a normalized, frame-aware inventory; it accepts fixture `<asset-clip>`, Resolve-exported `<video>`, and single-picture-source `<clip>` wrappers. The Free editor-backed thousand-clip export yields 1,001 primary picture clips; audio, effects, and additional tracks remain omitted with warnings.
- [ ] Identify stable clip and track IDs; test persistence after rename, move, and save. The repeated-media Resolve import/export proof shows resource refs and clip names are unstable; a sidecar mapping or supported API identity is still required.
- [x] Locate Resolve 21.1.2's documented `TimelineItem.GetUniqueId()` API and add a read-only snapshot/comparison probe. A live Free-edition check found distinct IDs for repeated media and retained all five IDs through save/reopen and a full Resolve restart. IDs also survived rename, move, and trim on duplicate timelines; deletion removed only the deleted occurrence's ID. FCPXML exports still omit those IDs and leave repeated-media mapping ambiguous. Relink and safe API-to-export mapping remain open; this does not close the stable-ID gate.
- [x] Add a read-only API snapshot ↔ flat FCPXML timing matcher that returns candidates and rejects ambiguity; it always refuses to authorize apply and does not establish persistent IDs.
- [x] Apply one isolated duration edit to a copy using exported FCPXML.
- [x] Reimport the modified copy in Resolve and verify the changed clip duration and 10-second resulting timeline; the other two clips remained in sequence.
- [ ] Measure scan, write, and reopen behavior on realistically sized projects. A synthetic 1k–10k-clip scanner baseline is recorded in `phase-0/SCAN_BENCHMARK.md`; real projects and write/reopen remain open.
- [ ] Stop or revisit editor choice if stable IDs and safe validation are not achievable.

**Exit:** A repeatable test demonstrates scan → normalized manifest → one edit to a copy → editor reopen, with no collateral changes.

## Phase 1 — Local-first project foundation

### 1.1 Replace the demo-only shell with an application foundation
- [x] Define the supported project file picker for `.fcpxml` and `.fcpxmld`, validate extensions in the main process, and avoid exposing local paths to the renderer.
- [x] Add a main-process application state model for selected project, scan status, current branch, and selection errors.
- [x] Keep the Electron renderer isolated; expose only narrow, validated preload methods.
- [x] Add structured logging with local paths and sensitive values redacted.
- [x] Design the versioned local metadata store, atomic write, backup/restore, and downgrade refusal behavior; document the future migration gate in `LOCAL_METADATA.md`.

### 1.2 Project adapter and normalized manifest
- [x] Define the first version of a read-only timeline scan manifest with exact frame counts and unresolved identity; expand it before durable revisions.
- [ ] Preserve editor-specific fields required for lossless round-trip writing.
- [x] Define and use an adapter contract for scan, source verification, stable-ID mapping, apply, save, and editor validation; the FCPXML adapter explicitly refuses unproven operations.
- [x] Implement a read-only FCPXML adapter in the desktop app for the first top-level picture sequence, with unsupported-element warnings and no media-path exposure to the renderer.
- [x] Allow an explicit read-only rescan of the selected file to refresh timeline and media availability, including retry after scan failure.
- [ ] Persist generated IDs in supported project metadata or a robust sidecar mapping.
- [x] Represent scanned timeline timing as integer frames and exact rational frame duration.
- [x] Give clear recovery instructions for malformed, unsupported, missing, permission-denied, and busy FCPXML exports; rescan retries after the underlying issue is fixed. An open Resolve project cannot be detected from an exported FCPXML file.
- [x] Validate the read-only v2 scan manifest against the current FCPXML compatibility corpus; reject unknown versions and extra fields before handing scan data to the interface.
- [x] Migrate v1 local metadata to v2 for revision storage and v2 to v3 for branches, preserving project IDs and history while testing downgrade refusal.

### 1.3 Local revisions and branches
- [x] Assign durable local project IDs for exports selected at the same path, without storing or exposing that path.
- [x] Store immutable local scan revision records for exports selected at the same path.
- [x] Add an explicit ID relink workflow for a moved export whose content matches a verified saved branch head; refuse destinations with existing history and changed source files.
- [x] Store parent revision, author label, timestamp, message, editor version as explicitly unknown, manifest version, and content hash.
- [x] Implement local branch creation, naming, switching, and branch-head updates for read-only scan revisions.
- [x] Add a revision message and save flow for the current read-only scan; reject it if the FCPXML source changed since scanning.
- [x] Detect concurrent local writes and prevent silent branch-head replacement.
- [x] Show local revision history backed by saved records for the selected export.
- [x] Open revision details backed by saved manifests, with record integrity checks and recovery errors.
- [x] Provide local revision export/import for backup and transfer before cloud sync exists.

### 1.4 Change detection and comparison
- [ ] Match objects using stable IDs, not names or timeline positions alone.
- [ ] Compare additions, deletions, and property changes at the smallest safe level.
- [ ] Normalize equivalent values so unchanged edits do not appear as differences.
- [ ] Present sequence, track, clip, timecode, property, and before/after values.
- [ ] Filter and group changes by sequence, track, status, and change type.
- [ ] Add tests for no-op, same change on both sides, independent edits, rename, and reorder.
- [x] Show read-only sequence and media-inventory differences between a revision and its verified parent, while keeping clip-level edit decisions explicitly unavailable.

**Exit:** A real project can be scanned repeatedly; local commits are immutable and a useful diff can be inspected without writing to the project.

## Phase 2 — Safe pull MVP

### 2.1 Three-way pull planning
- [ ] Record the last synced base manifest for each local branch.
- [ ] Compare common base, current local state, and incoming revision.
- [ ] Classify each change as incoming-only, local-only, already applied, or conflicting.
- [ ] Produce a deterministic pull plan with changes, conflicts, media requirements, and validation warnings.
- [ ] Bind each plan to hashes of the local project and incoming revision.
- [ ] Recalculate a stale plan if the project changes before apply.
- [ ] Persist enough plan state to recover from application interruption.

### 2.2 Conflict rules and resolution
- [ ] Implement field-level conflicts for properties proven safe by the editor spike.
- [ ] Treat local edit vs incoming deletion as a conflict.
- [ ] Define ordering rules for concurrent clip additions and timeline moves.
- [ ] Treat ripple edits, linked clips, transitions, nested sequences, and timing interactions conservatively until proven.
- [ ] Offer explicit choices: keep local, take incoming, or manually choose supported field values.
- [ ] Show the affected clip in context, field values, and the consequence of each choice.
- [ ] Require a decision for every unresolved conflict before enabling apply.
- [ ] Preserve the user's conflict decisions in the resulting revision/audit record.

### 2.3 Backup, apply, and recover
- [ ] Build a transactional apply service outside the renderer.
- [ ] Create and verify a timestamped restore point before in-place changes.
- [ ] Check that the file still matches the plan's source hash before writing.
- [ ] Apply changes through the supported editor API/adapter; never patch arbitrary bytes.
- [ ] Write atomically where supported and preserve permissions/metadata.
- [ ] Reopen or validate the resulting project with the target editor integration.
- [ ] Keep the backup until validation succeeds and the user can recover it.
- [ ] On any failure, restore or retain the original and report the exact recovery path.
- [ ] Record success, failure, chosen resolutions, and resulting revision.

### 2.4 Review-copy mode
- [ ] Let the user choose a destination and a non-colliding filename.
- [ ] Copy required project metadata and apply the same resolved pull plan to the copy.
- [ ] Leave the original and its sync base unchanged.
- [ ] Decide how referenced media paths remain valid; offer explicit media collection when needed.
- [ ] Validate the copy, report its location, and provide an open-in-editor action.
- [ ] Clean up incomplete temporary copies safely after failed operations.

### 2.5 Local media inventory and relinking
- [x] Check referenced `file:` media paths for local availability in the read-only FCPXML scan, without loading media contents or exposing paths to the renderer; relinking and richer asset states remain open.
- [ ] Scan referenced asset paths without reading large media fully into memory.
- [ ] Show available, missing, offline-volume, proxy-only, and excluded states.
- [ ] Resolve moved files by user-selected folder and metadata hints.
- [ ] Verify relink candidates using file size and content hash where appropriate.
- [ ] List required media before apply; block or request confirmation when dependencies are unresolved.

**Exit:** The app safely applies one tested edit to a copy and in place, supports explicit conflict decisions, and can prove recovery from failure.

## Phase 3 — Cloud history and collaboration

### 3.1 Service and data model
- [ ] Select deployment and data-processing regions based on user needs.
- [ ] Define API contracts for users, teams, projects, members, branches, revisions, manifests, pull plans, and activity.
- [ ] Store immutable manifests and revision metadata; index project and branch heads.
- [ ] Use atomic compare-and-swap updates for branch heads.
- [ ] Define service migrations, backups, restore drills, and data retention.
- [ ] Add request IDs, idempotency keys, pagination, and API versioning.

### 3.2 Accounts, authorization, and security
- [ ] Add sign-in, sign-out, token refresh, and account recovery.
- [ ] Define teams, invitations, project roles, and permission boundaries.
- [ ] Enforce authorization on every project, revision, branch, and asset request.
- [ ] Store secrets in the operating system credential store; never expose tokens to page scripts.
- [ ] Encrypt traffic and stored data; rotate service credentials.
- [ ] Add abuse controls, rate limits, audit trails, and account deletion flows.
- [ ] Threat-model malicious project files, archive traversal, symlinks, path disclosure, and unauthorized asset access.

### 3.3 Push, fetch, and offline sync
- [ ] Push immutable local revisions and manifests to a remote project.
- [ ] Fetch branch heads, history, and required manifests without fetching media unnecessarily.
- [ ] Track local/remote divergence and present an explicit reconciliation path.
- [ ] Queue sync while offline and retry idempotently when connectivity returns.
- [ ] Handle concurrent branch updates without overwriting remote work.
- [ ] Cache revisions and manifests locally for offline browsing and pull planning.
- [ ] Expose sync progress, retry, cancel, and recoverable error states.

### 3.4 Sharing and team workflow
- [ ] Invite collaborators to a project with role-based access.
- [ ] Show author, time, message, branch, and sync state in revision history.
- [ ] Copy a read-only share link with configurable expiration/permissions where appropriate.
- [ ] Notify users about incoming revisions and permission changes.
- [ ] Add activity history for commits, branch changes, pulls, and membership changes.
- [ ] Define ownership transfer, member removal, and project deletion behavior.

**Exit:** Two authorized accounts can share project history, work offline, reconnect without losing revisions, and cannot access projects outside their permissions.

## Phase 4 — Media sync and team operations

### 4.1 Content-addressed asset service
- [ ] Define media asset identity using cryptographic hashes and metadata.
- [ ] Hash files incrementally using streaming I/O.
- [ ] Upload and download in resumable, integrity-checked chunks.
- [ ] Deduplicate identical assets across revisions and projects within the chosen privacy boundary.
- [ ] Support cancellation, retry, bandwidth limits, and progress reporting.
- [ ] Encrypt assets at rest and protect signed download/upload URLs.

### 4.2 Media availability and storage policy
- [ ] Distinguish cloud-present, collaborator-only, local-only, missing, excluded, and archived media.
- [ ] Let projects configure which asset classes sync.
- [ ] Download only assets required for a selected revision or pull.
- [ ] Support proxies and relinking without confusing them with camera originals.
- [ ] Explain storage use before upload and show per-project usage.
- [ ] Add retention, deletion, and garbage-collection rules that preserve assets referenced by retained revisions.
- [ ] Provide export and deletion reports for project owners.

### 4.3 Background jobs and previews
- [ ] Create a job queue for hashing, thumbnails, proxies, and asset checks.
- [ ] Make jobs observable, retryable, and safe to repeat.
- [ ] Generate clip thumbnails and lightweight timeline previews where rights and editor APIs allow.
- [ ] Keep preview generation optional and separate from canonical edit data.
- [ ] Monitor worker backlog, failures, storage costs, and processing time.

**Exit:** Required assets can be located or transferred reliably, and the app clearly communicates storage and availability.

## Phase 5 — Hardening, release, and expansion

### 5.1 Product quality and support
- [ ] Add first-run onboarding for choosing an editor, project, and workspace.
- [ ] Add accessible keyboard navigation and screen-reader labels for dense timeline and conflict UI.
- [ ] Handle large projects with virtualized lists, incremental scans, caching, and cancellation.
- [ ] Add crash recovery and restartable scans/uploads/applies.
- [ ] Create diagnostics export with explicit privacy review and path redaction.
- [ ] Establish support process and compatibility issue templates.

### 5.2 Release engineering
- [ ] Sign and notarize desktop installers for supported operating systems.
- [ ] Add secure automatic updates with staged rollout and rollback.
- [ ] Establish release channels, version compatibility policy, and change notes.
- [ ] Add CI for unit, integration, adapter-fixture, security, and packaging checks.
- [ ] Test upgrade, downgrade prevention, interrupted update, and local database migration.
- [ ] Document incident response, backups, service recovery, and security disclosure.

### 5.3 Add integrations only after the first is reliable
- [ ] Measure real usage and failure rates of the first adapter.
- [ ] Generalize the adapter contract only from proven shared behavior.
- [ ] Evaluate the next editor against the same identity, diff, write, and validation gates.
- [ ] Build one adapter at a time with its own compatibility corpus and release support matrix.
- [ ] Do not promise universal project-file compatibility.

### 5.4 Later features (after MVP evidence)
- [ ] Review comments pinned to clips or timeline ranges.
- [ ] Approval requests and protected branches.
- [ ] Notifications and digest preferences.
- [ ] Project templates and team presets.
- [ ] Storage integrations for studios and shared storage volumes.
- [ ] Advanced asset lifecycle controls.
- [ ] Real-time co-editing only if editor APIs and user research support it.
- [ ] Cloud rendering only as a separately scoped product capability.

## Cross-cutting requirements

- [ ] **Data safety:** immutable history, verified backups, atomic writes, and tested restore paths.
- [ ] **Correctness:** frame-accurate time values, stable IDs, deterministic manifests, and compatibility fixtures.
- [ ] **Honesty:** distinguish sample data, unknown values, unavailable media, and unsupported edits in the UI.
- [ ] **Privacy:** collect the least project metadata possible; make media upload explicit and inspectable.
- [ ] **Performance:** stream and hash large media; make long work cancellable and resumable.
- [ ] **Accessibility:** keyboard operation, visible focus, clear status text, and readable contrast.
- [ ] **Observability:** useful errors and metrics without leaking media paths or credentials.
- [ ] **Compatibility:** publish exact editor, project-format, OS, and version support.

## Key decisions to resolve early

1. Which editor and project format are first? The Resolve FCPXML probe under `phase-0/resolve-xml-proof/` includes synthetic and Resolve-exported evidence, while safe write support remains unproven.
2. Can its supported API reliably enumerate and write the timeline objects needed for clip-level changes?
3. Which platforms and editor versions must the first release support?
4. Is cloud media storage part of the first paid offering, or should teams begin with local/shared storage and cloud manifests?
5. What project metadata and media are uploaded, and what privacy, retention, and deletion controls do users require?
6. What constitutes a safe automatic merge for ripple edits, linked media, transitions, and nested sequences?

## Current status

The repository contains an Electron UI prototype with synthetic revision review. File selection, a read-only FCPXML timeline manifest, local media availability checks, immutable local scan revisions, branches, revision backup transfer, parent comparison of sequence/media inventory, and an explicit matching-export ID relink work for a narrow top-level picture sequence. A synthetic compatibility corpus records expected scans and warns about unsupported nested content and connected lanes. Stable clip mapping, clip-level revision comparison, collaboration, media sync, conflict resolution, and pull are not implemented. This roadmap places safe editor identity and write validation before those features.
