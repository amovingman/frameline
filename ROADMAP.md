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
- [ ] List likely first users and the editor/version they use most. The evidence audit records this as missing; a consented pilot cohort is needed before a release target can be chosen.
- [x] Research Free Resolve 21.1.2 timeline exchange feasibility: FCPXML timeline import/export is available in the installed build.
- [x] Narrow the initial integration target to the tested Free 21.1.2 build on macOS. Studio and other versions are outside this target.
- [x] Resolve 21.1.2 (build 21.1.20010) imported a disposable three-clip FCPXML fixture, exported it, and reimported a modified copy. See `phase-0/resolve-xml-proof/README.md`.
- [x] Compare FCPXML, Resolve scripting, and native project paths, licensing, and available fixtures in `phase-0/INTEGRATION_ASSESSMENT.md`; the final choice remains open.
- [ ] Confirm whether the integration can enumerate sequences, tracks, clips, transitions, effects, and linked audio/video. `phase-0/audit-first-editor.js` recomputes the observed two-API-audio versus one-XML-audio gap; complete coverage remains blocked.
- [x] Add a Free-only, read-only FCPXML diagnostic for serialized sequences, lanes/gaps, explicit audio, transitions, and effects. It preserves unresolved timing and link semantics and does not close the complete-enumeration gate. See `phase-0/READ_ONLY_INVENTORY.md`.
- [x] Reconcile the paired Free API observation with its untouched XML export by construct counts, without guessing item IDs or track mappings. The report confirms missing explicit audio and unobservable effect/link semantics; complete enumeration remains open.
- [x] Add an aggregate normalized API/XML coverage matrix with explicit omissions, unobservable constructs, source hashes, and no guessed track or clip mapping. Complete enumeration remains open.
- [x] Confirm a supported API write path for limited clip edits: live Free-edition duplicate-timeline move, trim, and deletion plus documented methods; app-level safe apply remains unproven.
- [x] Prototype a private, time-limited read-only request/response handoff for Resolve Free's internal Python console. The desktop app now installs bundled scripts, copies a command for the internal Console, validates a path-free response, and saves a verified snapshot for read-only preview; live console execution and installer validation remain open. See `phase-0/INTERNAL_COMPANION.md`.
- [x] Document the experimental FCPXML 1.10/Resolve Free 21.1.2 boundary and unsupported constructs in `phase-0/SUPPORT_MATRIX.md`; no release-supported minimum is declared yet.
- [x] Record the initial Free/FCPXML target and current evidence in `PRODUCT.md` and `SYSTEM_DESIGN.md`; the write path remains open pending stable identity and broader timeline coverage.

### 0.2 Build a representative compatibility corpus
- [x] Create synthetic FCPXML fixtures covering common timeline structures in `phase-0/compatibility-corpus/`; editor-backed projects remain open.
- [x] Include synthetic trims, moves, insertions, deletions, connected audio, transitions, effects, and nested-clip placeholders; Resolve-backed coverage remains open.
- [x] Keep untouched synthetic originals and expected parsed manifests under a fixture policy; Resolve exports and broader structures remain to be added.
- [ ] Add projects saved from every editor version in the declared support range. The audit reports that only the exact experimental Free build is editor-backed and no release range is declared.

### 0.3 Prove safe read and write access
- [x] Implement a disposable FCPXML spike that scans timeline clips into a normalized, frame-aware inventory; it accepts fixture `<asset-clip>`, Resolve-exported `<video>`, and single-picture-source `<clip>` wrappers. The Free editor-backed thousand-clip export yields 1,001 primary picture clips; audio, effects, and additional tracks remain omitted with warnings.
- [ ] Identify stable clip and track IDs; test persistence after rename, move, and save. A source-bound candidate ledger now confirms five retained API IDs across paired live captures, including a changed XML spine position; durable export mapping, track identity, and relink remain unproven.
- [x] Locate Resolve 21.1.2's documented `TimelineItem.GetUniqueId()` API and add a read-only snapshot/comparison probe. A live Free-edition check found distinct IDs for repeated media and retained all five IDs through save/reopen and a full Resolve restart. IDs also survived rename, move, and trim on duplicate timelines; deletion removed only the deleted occurrence's ID. FCPXML exports still omit those IDs and leave repeated-media mapping ambiguous. Relink and safe API-to-export mapping remain open; this does not close the stable-ID gate.
- [x] Validate exact Free 21.1.2 schema-3 API snapshots, normalize them into path-free read-only manifests, compare retained items by API ID, summarize field changes, and expose a local comparison command. The paired live captures show one retained-ID position change. Track identity and API-to-FCPXML mapping remain unresolved; this diagnostic does not enable app clip diffs or apply. See `phase-0/RESOLVE_SNAPSHOT_COMPARE.md`.
- [x] Add a read-only API snapshot ↔ flat FCPXML timing matcher that returns candidates and rejects ambiguity; it always refuses to authorize apply and does not establish persistent IDs.
- [x] Extend the read-only matcher to flat single-picture-source Resolve `<clip>` wrappers, reject mixed/nested/gap-lane structures and timing collisions, and bind candidate reports to snapshot and export hashes. Full performance exports remain unsupported by this matcher.
- [x] Apply one isolated duration edit to a copy using exported FCPXML.
- [x] Reimport the modified copy in Resolve and verify the changed clip duration and 10-second resulting timeline; the other two clips remained in sequence.
- [ ] Measure scan, write, and reopen behavior on realistically sized projects. The benchmark now separates first-scan and cached-rescan timing on the pinned 1,001-picture-clip export; representative projects and app write/reopen remain open.
- [x] Repeat the read-only scanner benchmark ten times on the exact editor-backed 1,001-picture-clip export and assert its hash, byte count, clip count, frames, and warnings each run. This does not measure editor write/reopen or complete coverage.
- [ ] Stop or revisit editor choice if stable IDs and safe validation are not achievable. A dated outside-sandbox probe could not connect externally to the running Free build, triggering evaluation of an internal-script bridge or a different release target; complete enumeration, identity, and recovery remain open.

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
- [ ] Preserve editor-specific fields required for lossless round-trip writing. The first-editor audit now reports six unobservable construct/identity categories in paired coverage; a full round-trip field inventory is still required.
- [x] Define and use an adapter contract for scan, source verification, stable-ID mapping, apply, save, and editor validation; the FCPXML adapter explicitly refuses unproven operations.
- [x] Implement a read-only FCPXML adapter in the desktop app for the first top-level picture sequence, with unsupported-element warnings and no media-path exposure to the renderer.
- [x] Allow an explicit read-only rescan of the selected file to refresh timeline and media availability, including retry after scan failure.
- [ ] Persist generated IDs in supported project metadata or a robust sidecar mapping. The new source-bound candidate ledger can be serialized and reverified, but it refuses a persistent-ID or safe-apply claim when exports change or candidates collide.
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
- [x] Record a verified Resolve API capture as an immutable, read-only local observation revision keyed by its API project ID. Parent comparison ignores equivalent ordering; v2 transfers reject cross-project imports. The desktop can browse histories, create and switch branches, inspect bounded parent differences, and preview three verified revisions with a common ancestor after restart. Live Console capture and apply remain open.

### 1.4 Change detection and comparison
- [ ] Match objects using stable IDs, not names or timeline positions alone. The audit confirms five retained API IDs in one project; FCPXML pairing remains candidate-only.
- [ ] Compare additions, deletions, and property changes at the smallest safe level. A new read-only paired-export diagnostic joins API-ID field differences to exact-source XML candidate positions and drops those positions on ambiguity; unrepresented constructs and durable revision comparison remain open.
- [ ] Normalize equivalent values so unchanged edits do not appear as differences. The read-only Resolve observation history now treats reordered timelines, tracks, items, and links as unchanged; integrated project diffs across all supported values remain open.
- [ ] Present sequence, track, clip, timecode, property, and before/after values.
- [ ] Filter and group changes by sequence, track, status, and change type.
- [ ] Add tests for no-op, same change on both sides, independent edits, rename, and reorder.
- [x] Show read-only sequence and media-inventory differences between a revision and its verified parent, while keeping clip-level edit decisions explicitly unavailable.
- [x] Add a read-only JavaScript schema-3 Resolve snapshot ↔ selected FCPXML matcher for flat picture content. It reports exact source hashes, candidates, collisions, and unmatched items; supports the specified Resolve wrapper and fails closed on complex content. Candidate matching does not prove persistent identity or authorize apply.
- [x] Add optional desktop FCPXML comparison and refresh UI for those candidate results. It remains read-only and does not enable clip-level revision comparison or apply.

**Exit:** A real project can be scanned repeatedly; local commits are immutable and a useful diff can be inspected without writing to the project.

## Phase 2 — Safe pull MVP

### 2.1 Three-way pull planning
- [x] Add a Free-only, read-only three-way API snapshot preview: hash binding, ID-based field classification, conservative warnings, deterministic in-memory assembly, and a CLI with stale-source verification. It does not record a synced base or enable apply. See `phase-0/THREE_WAY_PREVIEW.md`.
- [x] Add schema-v4 local storage for a per-branch sync-base revision, with ancestry and expected-head checks. No current workflow claims a remote sync or sets the base automatically.
- [x] Strengthen the Free snapshot preview with addition/deletion and concurrent-edit classification coverage, deterministic proposed changes and conflicts, unknown media requirements, and verification of saved preview contents against matching source bytes. This remains a read-only diagnostic.
- [x] Add explicit stale-source refresh and immutable, content-addressed local preview recovery for the Free snapshot diagnostic. These do not implement an editor apply transaction.
- [x] Add read-only observed-field and entity conflict guidance, including deletion versus edit and canonical review order for concurrent additions and moves. No field has a proven safe app-level apply rule or automatic timeline placement.
- [x] Add conservative read-only risk gates for ripple/timing, linked clips, transitions, and nested/unknown constructs; conflict choices with context, completeness checks, and a source-bound audit record; plus standalone source-hash preflight and verified restore-point copy. These safety foundations do not enable apply. See `phase-0/THREE_WAY_PREVIEW.md`.
- [x] Ship a Resolve preview tab that accepts three schema-3 API snapshot files (base, local, incoming), classifies observed field changes, presents conflicts and warnings, and lets the user record conflict review choices. Refresh re-reads sources and clears choices when bytes change. Save/recover is content-addressed and requires matching source bytes; saved previews omit decisions. The completed-conflict audit records review intent only. This UI preview does not record a synced base or enable apply.
- [x] Add source-hash and changed-role status, timeline/field/unresolved filters, conflict navigation, and dedicated warning/media requirements inspection to the read-only Resolve preview.
- [x] Persist partial or complete Resolve conflict review choices in a separate content-addressed artifact. Recovery revalidates exact source bytes, recomputes the plan and audit, and rejects stale or corrupted artifacts. This is not a resulting revision or editor apply record.
- [ ] Record the last synced base manifest for each local branch.
- [ ] Compare the recorded common base, current local project state, and an incoming revision. The Resolve preview can compare immutable local API observations with a verified common ancestor, or use a current verified Console capture as its local side. It checks project ID and branch ancestry but cannot prove live edit provenance or bind remote incoming work.
- [ ] Classify each project change as incoming-only, local-only, already applied, or conflicting. The preview classifies observed snapshot fields; it is not an integrated project diff.
- [ ] Produce a deterministic executable pull plan with changes, media requirements, and validation warnings. The preview assembles a read-only proposal and warnings, not an executable plan.
- [ ] Bind each plan to hashes of the local project and incoming revision.
- [ ] Recalculate a stale plan if the project changes before apply.
- [ ] Persist enough plan state to recover from application interruption.

### 2.2 Conflict rules and resolution
- [ ] Implement field-level conflicts with safe app-level apply rules for properties proven safe by the editor spike. The preview can review observed-field conflicts but cannot apply their choices.
- [ ] Treat local edit vs incoming deletion as a conflict.
- [ ] Define ordering rules for concurrent clip additions and timeline moves.
- [ ] Treat ripple edits, linked clips, transitions, nested sequences, and timing interactions conservatively until proven.
- [x] Offer conflict review choices in the Resolve preview, with affected values/context. These are review decisions only; supported manual field edits and apply are not implemented.
- [ ] Show the affected clip in context, field values, and the consequence of each choice.
- [x] Require a review choice for every conflict before showing the preview audit. Apply remains disabled.
- [ ] Preserve the user's conflict decisions in the resulting revision/audit record. The preview can now persist and recover review intent, but no resulting project revision or apply audit exists.

### 2.3 Backup, apply, and recover
- [x] Add a standalone main-process preflight that checks plan/audit/source/restore-point/adapter gates and always refuses apply while project-to-plan identity is unproven. See `phase-0/SAFE_PULL_PREFLIGHT.md`.
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
- [x] Add a bounded, byte-verified preparation copy for a regular FCPXML file in a selected destination, with noncolliding names and failed-copy cleanup. No pull plan is applied to this copy.
- [x] Let the user choose a destination and filename in the desktop copy workflow; enforce noncollision and verify the copy by rescan, hash, and source checks. The result is sanitized for display.
- [x] Audit the review copy as an unchanged byte-identical artifact; verify an existing copy again by hash, scan, and source checks before revealing it in Finder. A stale source invalidates the copy handoff.
- [ ] Copy required project metadata and apply the same resolved pull plan to the copy.
- [ ] Leave the original and its sync base unchanged.
- [ ] Decide how referenced media paths remain valid; offer explicit media collection when needed.
- [ ] Validate the copy, report its location, and provide an open-in-editor action.
- [ ] Clean up incomplete temporary copies safely after failed operations.

### 2.5 Local media inventory and relinking
- [x] Check referenced `file:` media paths for local availability in the read-only FCPXML scan, without loading media contents or exposing paths to the renderer; relinking and richer asset states remain open.
- [x] Add standalone streamed media fingerprints, evidence-based availability, bounded selected-folder search, size/hash candidate verification, and path-free readiness reporting. This does not relink a project or establish media requirements for an executable pull.
- [x] Add a selected-regular-FCPXML media audit with path-free local, missing, external, and unknown states and streamed fingerprints where available. This is an inventory only; it does not claim media identity or pull readiness.
- [x] Scan referenced asset paths with streamed fingerprints, without loading large media fully into memory.
- [x] Show available, missing, offline-volume, proxy-only, excluded, external, and unknown states in a path-free dependency report.
- [x] Resolve moved-file candidates from a user-selected folder into verified, ambiguous, filename-only, or not-found results. This produces a read-only resolution report; rewriting project references remains unavailable.
- [x] Verify relink candidates using file size and content hash when expected identity evidence exists; filename-only matches remain unverified.
- [x] List required media and produce an explicit ready, confirmation-required, or blocked gate. Apply remains disabled for the separate identity and adapter blockers.

**Exit:** The app safely applies one tested edit to a copy and in place, supports explicit conflict decisions, and can prove recovery from failure.

## Phase 3 — Cloud history and collaboration

### 3.1 Service and data model
- [ ] Select deployment and data-processing regions based on user needs.
- [x] Define versioned domain API contracts for users, teams, projects, members, branches, revisions, manifests, pull plans, and activity. Deployment and transport remain open.
- [x] Add an executable domain store for content-addressed immutable manifests, revision metadata, projects, and branch heads.
- [x] Use compare-and-swap branch-head updates with expected-head and revision-parent checks.
- [x] Define and test service-state migration, verified backup/restore, restore drills, and non-destructive retention reporting.
- [x] Add request IDs, exact-input idempotency keys, signed bounded pagination, and API version envelopes to the service foundation.

### 3.2 Accounts, authorization, and security
- [x] Add an executable identity foundation for sign-in, sign-out, rotating refresh tokens, generic account recovery, session revocation, and deletion. No hosted identity service or desktop sign-in UI is deployed.
- [x] Define teams, expiring invitations, owner/editor/viewer project roles, and explicit permission boundaries.
- [x] Enforce project-scoped authorization through a service wrapper before project, revision, branch, and asset operations.
- [x] Add a main-process-only Electron `safeStorage` credential vault with atomic encrypted persistence and rotation; preload exposes no credential or token API.
- [x] Require HTTPS service origins, add AES-256-GCM stored-record envelopes, and support key-ID rotation. Hosted TLS and managed keys remain deployment work.
- [x] Add per-principal/action rate limits, hash-chained audit events, session-revoking account deletion, and ownership-orphan refusal.
- [x] Threat-model malicious project files, archive traversal, symlinks, path disclosure, token theft, and unauthorized asset access in `SECURITY_MODEL.md`.

### 3.3 Push, fetch, and offline sync
- [x] Add an executable sync service that validates local revision bundles, uploads content-addressed manifests and immutable revisions idempotently, and advances remote branches by compare-and-swap.
- [x] Fetch a remote branch head, ordered revision history, and required manifests without fetching media.
- [x] Track in-sync, local-ahead, remote-ahead, and diverged states with explicit push, fetch, or reconciliation-branch actions.
- [x] Add a durable, exact-input-deduplicated push queue that pauses offline, applies bounded exponential retry to transient network failures, and relies on the sync service's stable idempotency keys when connectivity returns.
- [x] Detect branch-head races before and during push, preserve the concurrent remote head, and return explicit fetch/reconciliation actions without overwriting remote work.
- [x] Store fetched revision and manifest metadata in a content-addressed, integrity-checked local cache for offline browsing and pull-planning inputs; media remains excluded.
- [x] Expose durable revision-level sync progress, explicit retry and cancel controls, and recoverable network/conflict states in the desktop history view. Hosted transport remains unconfigured.

### 3.4 Sharing and team workflow
- [x] Add owner-only project invitations for editor/viewer roles, token-free member and pending-invite listings, and a desktop access panel. Invitations remain local until hosted delivery exists.
- [x] Show author, time, message, selected branch, and sync state in revision history, deriving local-only, local-ahead, and synced labels from each branch's recorded sync base.
- [ ] Copy a read-only share link with configurable expiration/permissions where appropriate. A service-only, owner-issued link now supports bounded expiration, read-only revision redemption, revocation, and a trusted clipboard callback; hosted redemption and desktop controls remain open.
- [ ] Notify users about incoming revisions and permission changes. Recipient-scoped local inbox records and read receipts now exist; delivery across devices and desktop notification remain open.
- [ ] Add activity history for commits, branch changes, pulls, and membership changes. Hash-linked local events cover commits/branches and membership hooks; a real pull transaction and durable hosted history remain open.
- [x] Define ownership transfer, member removal, and project deletion behavior. Access control now transfers to an existing member, revokes removed members immediately, and tombstones deleted projects while retaining immutable history. See `COLLABORATION_FOUNDATIONS.md`.

**Exit:** Two authorized accounts can share project history, work offline, reconnect without losing revisions, and cannot access projects outside their permissions.

## Phase 4 — Media sync and team operations

### 4.1 Content-addressed asset service
- [x] Define media asset identity using cryptographic hashes and metadata. A path-free SHA-256 content ID, byte count, asset class, and media type are defined in `src/media-asset-identity.js`; storage and transfer remain open.
- [x] Hash files incrementally using streaming I/O. `fingerprintFile` already streams SHA-256, checks file stability, and rejects symlinks; `identifyMediaFile` now uses that result as a path-free asset identity.
- [ ] Upload and download in resumable, integrity-checked chunks. A local reference service persists encrypted chunks and transfer state, verifies each chunk and the final content hash, and supports restart by chunk index; hosted transfer remains open.
- [ ] Deduplicate identical assets across revisions and projects within the chosen privacy boundary. The reference service deduplicates within an explicit namespace; team privacy boundaries and hosted storage policy remain open.
- [ ] Support cancellation, retry, bandwidth limits, and progress reporting. The reference service has AbortSignal cancellation, idempotent retry, byte pacing, and callbacks; network transfer controls and desktop progress remain open.
- [ ] Encrypt assets at rest and protect signed download/upload URLs. The reference service uses AES-256-GCM chunks and method-bound, expiring HMAC URLs; hosted key management and HTTP redemption remain open. See `ASSET_SERVICE_FOUNDATION.md`.

### 4.2 Media availability and storage policy
- [ ] Distinguish cloud-present, collaborator-only, local-only, missing, excluded, and archived media. A path-free local classifier now preserves explicit evidence; hosted state and desktop display remain open.
- [ ] Let projects configure which asset classes sync. A per-project policy model now defaults to no classes and validates authorized changes; durable hosted settings and desktop controls remain open.
- [ ] Download only assets required for a selected revision or pull. A reference executor rechecks authoritative revision assets, downloads required chunks only, and verifies final hashes; canonical manifest integration and hosted transfer remain open.
- [ ] Support proxies and relinking without confusing them with camera originals. Class- and hash-verified relink decisions now reject proxy substitution; editor project rewriting remains open.
- [ ] Explain storage use before upload and show per-project usage. A path-free estimate and local project usage report now count upload, reuse, exclusion, logical, and exclusive bytes; desktop presentation and hosted accounting remain open. See `MEDIA_POLICY_FOUNDATION.md`.
- [ ] Add retention, deletion, and garbage-collection rules that preserve assets referenced by retained revisions. The local asset service now records verified immutable revision references and refuses to collect retained or cross-project content; hosted retention and orphan cleanup remain open.
- [ ] Provide export and deletion reports for project owners. An owner-only path-free report now lists content IDs, revision references, shared status, and eligible bytes; hosted account export and deletion reporting remain open.

### 4.3 Background jobs and previews
- [ ] Create a job queue for hashing, thumbnails, proxies, and asset checks. A durable local queue now accepts these typed jobs plus timeline previews; worker hosting and desktop integration remain open.
- [ ] Make jobs observable, retryable, and safe to repeat. The local queue now deduplicates exact inputs, records status/progress/failure, retries explicitly, and requeues interrupted work; distributed worker leases remain open.
- [ ] Generate clip thumbnails and lightweight timeline previews where rights and editor APIs allow. Optional handlers now require rights confirmation and an injected renderer, validate bounded image output, and mark it noncanonical; no editor renderer is bundled. See `MEDIA_LIFECYCLE_JOBS.md`.
- [ ] Keep preview generation optional and separate from canonical edit data. A per-project opt-in now gates preview jobs, and preview output is marked noncanonical; hosted policy and desktop controls remain open.
- [ ] Monitor worker backlog, failures, storage costs, and processing time. The local queue now reports backlog, failures, processing duration, stored bytes, and estimated monthly cost; production worker and billing telemetry remain open.

**Exit:** Required assets can be located or transferred reliably, and the app clearly communicates storage and availability.

## Phase 5 — Hardening, release, and expansion

### 5.1 Product quality and support
- [ ] Add first-run onboarding for choosing an editor, project, and workspace. A first-run panel now records the experimental Resolve target and local workspace label, then opens the real project picker; choosing a storage location remains open.
- [ ] Add accessible keyboard navigation and screen-reader labels for dense timeline and conflict UI. Arrow navigation and labels were added to working lists; a full keyboard and assistive-technology audit remains open.
- [ ] Handle large projects with virtualized lists, incremental scans, caching, and cancellation. Revision history is windowed; FCPXML scans reuse hash-bound parsed inventory, refresh media in batches, and can be cancelled. Larger editor-backed performance evidence remains open.
- [ ] Add crash recovery and restartable scans/uploads/applies. A path-free recovery journal now describes reselect/rescan, verified chunk resume, and manual restore; automatic app integration and a safe apply transaction remain open.
- [ ] Create diagnostics export with explicit privacy review and path redaction. The desktop now previews a counts-and-codes-only report and saves only the reviewed hash; a broader production diagnostics package remains open.
- [x] Establish support process and compatibility issue templates. See `SUPPORT.md` and `.github/ISSUE_TEMPLATE/compatibility.yml`.

### 5.2 Release engineering
- [ ] Sign and notarize desktop installers for supported operating systems. A fail-closed evidence checker and release procedure now exist; signing identity, installer, and notarization remain open.
- [ ] Add secure automatic updates with staged rollout and rollback. A signed-manifest policy verifier now checks HTTPS, hash, version, channel, and rollout eligibility; download, install, health check, and rollback remain open. See `RELEASE_SECURITY.md`.
- [ ] Establish release channels, version compatibility policy, and change notes. `RELEASE_POLICY.md`, `CHANGELOG.md`, and a strict version/schema planning gate now exist; signed channel releases and published compatibility evidence remain open.
- [x] Add CI for unit, integration, adapter-fixture, security, and packaging checks. `.github/workflows/ci.yml` runs the suite, corpus, migration, security, audit, and package-input checks; installer signing remains a separate gate.
- [ ] Test upgrade, downgrade prevention, interrupted update, and local database migration. Policy tests now cover downgrade and interrupted stage/activation recovery; local metadata and service migration tests are included in CI. A real installer upgrade/rollback drill remains open.
- [ ] Document incident response, backups, service recovery, and security disclosure. `INCIDENT_RESPONSE.md` records the local response and restore procedure; private intake, responders, and managed off-device backups remain open.

### 5.3 Add integrations only after the first is reliable
- [ ] Measure real usage and failure rates of the first adapter. The desktop now counts session-local scan outcomes and duration without paths and includes aggregate counts in reviewed diagnostics; consented pilot measurements remain open.
- [ ] Generalize the adapter contract only from proven shared behavior. A gate now returns no shared capabilities until two release-ready adapters demonstrate them; only one experimental adapter exists.
- [ ] Evaluate the next editor against the same identity, diff, write, and validation gates. `EDITOR_EXPANSION.md` and a fail-closed candidate gate define the evidence; selecting and testing a candidate waits on the first adapter's release readiness.
- [ ] Build one adapter at a time with its own compatibility corpus and release support matrix. The expansion gate requires a candidate corpus; no second adapter or supported matrix row exists yet.
- [x] Do not promise universal project-file compatibility. The README and support matrix now state the exact experimental boundary and rule out arbitrary project files and editors.

### 5.4 Later features (after MVP evidence)
- [ ] Review comments pinned to clips or timeline ranges. A private local store now supports authorized comments on verified immutable-revision clip IDs or frame ranges; stable FCPXML anchors, desktop UI, and hosted delivery remain open. See `REVIEW_COMMENTS.md`.
- [ ] Approval requests and protected branches. An authorized service path now checks independent, head-bound local approvals and rechecks reviewer access; durable hosted policy and audit remain open.
- [ ] Notifications and digest preferences. A local planner now defaults delivery off and supports immediate or daily UTC plans from the authorized inbox; scheduling and delivery remain open.
- [ ] Project templates and team presets. Team-scoped preset plans now validate branch and media-class choices without changing a project; durable storage and atomic application remain open.
- [ ] Storage integrations for studios and shared storage volumes. A selected-root verifier now confirms file size and hash without exposing locations; mount, permissions, and relink integration remain open.
- [ ] Advanced asset lifecycle controls. A local deletion planner now blocks retained, shared, and held assets; durable holds and transactional garbage collection remain open.
- [ ] Real-time co-editing only if editor APIs and user research support it. A fail-closed evidence gate now keeps the product disabled; identity, events, recovery, and research remain unproven.
- [ ] Cloud rendering only as a separately scoped product capability. A separate evidence gate now keeps the product disabled until consent, rights, processing region, costs, and provenance are proven. See `LATER_FEATURE_FOUNDATIONS.md`.

## Cross-cutting requirements

- [ ] **Data safety:** immutable history, verified backups, atomic writes, and tested restore paths. Existing local/service restore tests remain in CI; protected writes and deletion planning now add explicit guards, while hosted recovery is open.
- [ ] **Correctness:** frame-accurate time values, stable IDs, deterministic manifests, and compatibility fixtures. Exact Resolve snapshot anchors and deterministic FCPXML scans are tested; stable cross-export clip identity remains open.
- [ ] **Honesty:** distinguish sample data, unknown values, unavailable media, and unsupported edits in the UI. The media headline now separates unchecked, unspecified, and uncheckable references; full workflow review remains open.
- [ ] **Privacy:** collect the least project metadata possible; make media upload explicit and inspectable. Revision transfer now rejects path-like labels and user-entered path text; metadata and asset-byte disclosures are path-free planning artifacts. Desktop review and hosted policy remain open.
- [ ] **Performance:** stream and hash large media; make long work cancellable and resumable. Streaming hashes and resumable local chunks exist; scan metrics now retain bounded recent p50/p95 timings. Real-project and hosted-transfer measurements remain open.
- [ ] **Accessibility:** keyboard operation, visible focus, clear status text, and readable contrast. Four main views now expose their keyboard shortcuts and focus the selected navigation button. A full keyboard, screen-reader and contrast audit remains open.
- [ ] **Observability:** useful errors and metrics without leaking media paths or credentials. Log redaction now covers embedded paths; reviewed diagnostics include bounded scan timing aggregates and safe error codes. Consented pilot telemetry remains open.
- [ ] **Compatibility:** publish exact editor, project-format, OS, and version support. An exact experimental version/build/OS/format contract now fails closed for writes and release claims; a supported release row remains open.

## Key decisions to resolve early

1. Which editor and project format are first? The working experimental choice is Resolve Free 21.1.2/build 21.1.20010 on macOS with FCPXML 1.10 read-only scan. See `EARLY_DECISIONS.md`; safe write remains unproven.
2. Can its supported API reliably enumerate and write the timeline objects needed for clip-level changes? Limited internal-console evidence exists; external Free access, complete enumeration, stable mapping and recoverable apply remain open.
3. Which platforms and editor versions must the first release support? No release row is declared. The exact tested macOS/Free build is a pilot boundary pending intended-user corpus and release drills.
4. Is cloud media storage part of the first paid offering, or should teams begin with local/shared storage and cloud manifests? Pilot planning uses local/shared media and metadata-only history; pricing and hosted media remain research decisions.
5. What project metadata and media are uploaded, and what privacy, retention, and deletion controls do users require? A validated bundle and explicit asset-byte review describe the proposed transfer; hosted region, retention and deletion policy remain open.
6. What constitutes a safe automatic merge for ripple edits, linked media, transitions, and nested sequences? None is currently proven; `EARLY_DECISIONS.md` records the per-construct evidence needed before an automatic rule can be enabled.

## Current status

The repository contains an Electron UI prototype with synthetic local revision review and a Resolve preview tab for three schema-3 API snapshots. The preview classifies observed field changes, presents conflicts and warnings, captures per-conflict review choices, reports source hashes and changed roles, and supports timeline/field filtering and unresolved-conflict navigation. Its source-bound preview and review artifacts can be recovered against the exact source bytes; review choices persist, while the audit remains review intent and apply is disabled. The desktop app also offers optional read-only comparison of a schema-3 local snapshot with a selected FCPXML file using candidate matching, plus a review-copy workflow for unchanged FCPXML. The matcher reports hashes, collisions, and unmatched items and fails closed on complex content; it does not establish persistent identity or enable apply. For a selected regular FCPXML source, the path-free media audit reports local, missing, external, or unknown references and streamed fingerprints where available, without claiming media identity or pull readiness. Copy preparation and audit verify an identical artifact; an existing copy is rechecked by hash, scan, and source checks before Finder reveal, and source staleness invalidates the handoff. The app also supports file selection, a read-only FCPXML timeline manifest, local media availability checks, immutable local scan revisions, branches, revision backup transfer, parent comparison of sequence/media inventory, and matching-export ID relink for a narrow top-level picture sequence. Stable API-ID to project mapping, media relinking/identity, integrated clip-level revision comparison, collaboration, media sync, and a safe pull transaction remain unimplemented. Standalone diagnostic risk gates and preflight utilities do not close those product gates.
