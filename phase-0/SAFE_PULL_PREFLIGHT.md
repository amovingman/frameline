# Safe-pull preflight foundations

These are ten local safety slices for the Free 21.1.2 experiment. They do not make a pull executable.

1. Stream media files through SHA-256 without loading them into memory.
2. Report local, missing, and unknown media; offline-volume, proxy-only, and excluded require explicit evidence.
3. Search a user-selected folder with limits and without following observed symlinks.
4. Verify candidate media by file size and SHA-256, not name alone.
5. Produce a path-free readiness report that requires verified originals for required media.
6. Reserve a noncolliding `.fcpxml` review-copy filename in a selected directory.
7. Make a byte-verified review copy while preserving ordinary mode and timestamps.
8. Confirm the source hash and file identity again before publishing the copy.
9. Remove incomplete temporary copies after a failed preparation.
10. Run a read-only apply preflight that reports missing plan, audit, media, source, restore-point, or adapter gates.

For local experiments, `check-media-readiness.js` reads an array of media entries containing opaque `id`, local `path`, and expected `{size, sha256}`. The report omits all paths. `prepare-review-copy.js` requires the current source hash and creates a byte-identical copy; it does not apply a plan:

```sh
node phase-0/check-media-readiness.js media-input.json
node phase-0/prepare-review-copy.js source.fcpxml copies Review.fcpxml EXPECTED_SHA256
```

The review-copy helper accepts regular `.fcpxml` files up to the scanner's 20 MB limit; bundles and symlink path components are refused. `checkApplyPreflight` is a main-process diagnostic only. The current Resolve API snapshots cannot authenticate a project file, media requirements are not bound to verified file paths, and the FCPXML adapter lacks safe apply and editor validation. It therefore always returns `safeToApply: false`. No project file is modified by these preflights.

## Native Resolve export and import probe (2026-11-17)

On the disposable `Frameline Lua Capture Fixture` in Resolve Free 21.1.2, `ProjectManager.ExportProject(projectName, filePath, false)` returned `true` and created a 66,084-byte `.drp`. Its SHA-256 is `d2d32919cf785eec4c7ecddf76d8741039f1ad54b63477f5fb69024ccc30af04`. ZIP integrity checks passed for `project.xml`, `MediaPool/Master/MpFolder.xml`, one `SeqContainer` XML member, and `Gallery.xml`. Resolve initially created the export with mode `0666`; the probe set it to `0600` before further inspection. Any backup service must create exports in a private directory and verify restrictive permissions before treating them as restore points.

`ProjectManager.ImportProject` was then invoked with the exported path and a distinct name, `Frameline Restore Probe`. Resolve created a separate local project at that name. Its `Project.db` passes SQLite `PRAGMA integrity_check`. The original project remains present. Opening the imported copy in Resolve showed `Frameline Capture Timeline` at `00:00:51:00`, with three clips on Video 1 and 49 clips on Audio 1, matching the track counts of the saved source capture. Media-pool thumbnails and the linked final video/audio clip were visible. Effect settings, every item property, and a post-import API snapshot were not compared; an apply/rollback transaction remains unproven.

`inspectResolveProjectExport` is a read-only verifier for private `.drp` files. It fingerprints the file before and after ZIP member and CRC checks, requires a project XML, media-pool XML, and at least one sequence XML, and rejects group/world-readable exports, symlinks, and changed files. Its result is evidence about an archive, not permission to write to an editor project.

## Compare captured recovery content

After capturing the source and reopened copy through the companion, run:

```sh
node phase-0/compare-resolve-recovery.js source-snapshot.json recovered-snapshot.json
```

The command binds its report to both exact input hashes and compares all schema-3 observed fields using the existing ID-based differ. It allows a distinct project ID/name for an imported copy, but requires original timeline/item IDs to match; regenerated IDs produce additions/deletions rather than guessed matches. Enumeration order is ignored. Track names, item names, timing, source bounds, media-pool IDs, links, and effect counts are compared. Exit status is `0` for matching observed fields, `2` for differences, and `1` for invalid inputs. Input paths are omitted from the report and error messages.

The result always retains `recoveryValidated: false`: snapshot provenance, effect identity/settings, nested content, media bytes, and other uncaptured properties remain unverified. Automated tests use the pinned mixed live source capture and deliberately changed copies.

## Live copied-project capture and failure recovery (2026-11-17)

The Console was behind Resolve's main window; minimizing the main window exposed it to UI automation. The existing schema-3 Lua capture implementation then read the open `Frameline Restore Probe`. Three individually marked Console parts were assembled without editing their JSON into `resolve-xml-proof/live-restored-mixed-schema3.json` (SHA-256 `654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`). This was a direct Console observation, without the desktop's request-bound capture loop.

The restored snapshot contains 53 items. Import regenerated the project ID, timeline ID, all item IDs, and all non-null media-pool IDs. The ID-based recovery comparison correctly reports a deleted and added timeline. A fixture-specific comparison by the API's enumeration positions confirms equality of all remaining captured values, link edges, and media-sharing groups. That positional comparison is evidence for this known pair, not a persistent ID mapping. Plans and revision bindings from the original project must not be applied to the imported copy.

On this disposable copy only, the Console checked the exact project name and first video item's ID and name, captured the before state, called `SetName('Frameline disposable rename')`, checked the resulting name, and required `SaveProject()` to return true. It captured the applied state, raised an intentional error inside `pcall`, then restored `mountain-alps.jpg` through `SetName`, saved again, and captured the rollback state. The Console reported the intentional failure and successful completion of rollback.

The three untouched observations are `live-rename-before-schema3.json`, `live-rename-applied-schema3.json`, and `live-rename-rolled-back-schema3.json`. The before and rollback bytes both hash to `654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`; the applied snapshot hashes to `7655ea985e1033860f194f3e94b3e4f4c32147d71af4a98552d1cebf2021c9a9`. The existing differ reports exactly one name-field change in the applied state and no observed differences after rollback. Tests pin those bytes and results. This establishes saved, reversible rename behavior for this fixture; it does not prove crash recovery, unobserved property preservation, reopen after mutation, or an app-level pull transaction.

### Save and reopen validation

A subsequent Console probe checked the exact imported project ID and target item ID, repeated the rename, saved, closed the project with `ProjectManager.CloseProject`, and loaded it again with `LoadProject`. The target name remained `Frameline disposable rename`. It captured `live-rename-reopened-applied-schema3.json`, then restored the original name, saved, closed/reopened again, and captured `live-rename-reopened-rolled-back-schema3.json`. Both probe stages returned success. The applied reopen snapshot is byte-identical to the earlier applied capture (`7655ea985e1033860f194f3e94b3e4f4c32147d71af4a98552d1cebf2021c9a9`), and the reopened rollback is byte-identical to the original imported snapshot (`654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`). All 53 item IDs and other captured values persisted through these project close/reopens.

`audit-first-editor.js` verifies the fixture hashes and recomputes the single name change and exact rollback match. The representative scan/write/reopen gate now has partial evidence. This was an internal Console probe on one disposable project; the desktop transaction, process-crash behavior, complete property validation, and representative-user projects remain open.

## Executable guarded rename trial

`src/resolve-rename-trial.js` now orchestrates the experiment from the main-process side. It requires validated before/incoming captures from the exact same named disposable project, permits exactly one clip-name change, and creates a noncolliding private transaction directory. Immutable, synced `prepared.json`, `issued.json`, and `result.json` records retain the source/incoming hashes, change, backup fingerprint, and observed result. The native backup is retained for every outcome. There is no renderer or IPC entry point yet.

The preparation command compares the complete current captured state before saving/exporting a `.drp` and again after export. Node then narrows the exported file to mode `0600` and verifies its archive before issuing the mutation command. That command checks the exact captured source again, checks backup existence, refuses same-session transaction replay, finds the target through project/timeline/item IDs, renames, saves, closes/reopens, and compares all captured values to the expected result. On failure it attempts a rename rollback, saves/reopens, and compares to the before state. It reports `applied`, `rolled-back`, or `recovery-required`. Recording a successful outcome requires an exactly matching returned snapshot and rechecks the retained archive hash.

The standalone CLI supports the manual Console flow:

```sh
node phase-0/rename-resolve-trial.js prepare before.json incoming.json PRIVATE_DIRECTORY 'Frameline Disposable Project'
node phase-0/rename-resolve-trial.js issue TRANSACTION_DIRECTORY --force-failure
node phase-0/rename-resolve-trial.js record TRANSACTION_DIRECTORY rolled-back returned-snapshot.json
```

Run each returned `command` in Resolve's Lua Console before continuing to the next phase. `PRIVATE_DIRECTORY` must already exist with mode `0700`. The named project must be a disposable fixture whose name starts with `Frameline `. Console status and snapshot parts must be checked together when recording. Command output and transaction records contain local recovery paths and stay in the main process/CLI.

The live forced-failure run on `Frameline Restore Probe` produced a verified 69,264-byte backup, saved/reopened the rename, forced an error, then saved/reopened the rollback. Its final snapshot hash is the exact before hash. `rename-trial-live-observation.json` records the path-free outcome and executed command hash. The retained `.drp` hash is `da775f18991c53c612be04969fb281d52a38c48ae9d64e481c45dfb1784ae6e7`.

This trial validates observed schema-3 fields only. Manual Console output is not authenticated editor provenance, and snapshot hashes cannot bind uncaptured native project properties. The command checks backup existence but cannot rehash the archive inside this Free Lua runtime after Node issues it. Process interruption, recovery after a failed reopen, complete property coverage, immutable transaction trust, and desktop conflict/revision integration remain required before enabling product apply. The trial is not wired into `checkApplyPreflight`; the product remains disabled.

### Bind the trial to conflict review

`prepareReviewedRenameTrial` now verifies the exact three-way plan and complete decision audit against their source bytes. It derives the desired state from the current local snapshot, preserving independent local edits. Incoming-only changes and selected `take-incoming` choices must resolve to exactly one clip-name update. `keep-local` choices preserve the local values. Unsupported selected incoming operations and no-op reviews are rejected before any transaction directory is created.

The private prepared record retains the base/local/incoming bytes, preview, and audit. Issuing the command and recording its result both reverify those artifacts, derive the expected rename again, and check the transaction's before/after binding. The result records all three source hashes, plan and audit hashes, and the exact conflict choices. The low-level trial's `incomingSha256` refers to its derived desired snapshot; `review.sourceBindings.hashes.incoming` retains the original incoming revision bytes.

```sh
node phase-0/rename-resolve-trial.js prepare-reviewed base.json local.json incoming.json audit.json PRIVATE_DIRECTORY 'Frameline Disposable Project'
node phase-0/rename-resolve-trial.js issue TRANSACTION_DIRECTORY --force-failure
node phase-0/rename-resolve-trial.js record-console TRANSACTION_DIRECTORY copied-console-output.txt
```

`audit.json` is the complete result of `createResolveDecisionAudit`, checked against the recomputed preview. The `record-console` operation accepts ordered snapshot parts followed by exactly one matching transaction result marker; missing, duplicate, out-of-order, and different-transaction parts are rejected. It then performs the existing snapshot and backup checks. This reduces manual recording mistakes; Console text remains unauthenticated observation evidence.

A live reviewed trial on the disposable `Frameline Restore Probe` exercised one name conflict resolved with `take-incoming`. It verified the backup, ran the generated rename/save/reopen command with forced failure, rolled back/save/reopened, and recorded the Console output through the new reader. The result in `reviewed-rename-live-observation.json` retains the exact choice and recomputable plan/audit/source bindings. The source and final snapshot hashes both equal `654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`. Its private backup is 69,220 bytes with SHA-256 `28719b60f7f61a163c5d4742eab535b2a6e34e6c775a2baa2783f6468a989219`. Desktop workflow, resulting revision creation, and full property validation remain open.

### Link outcomes to local observation history

Recording a trial now also saves its exact returned snapshot bytes privately as `result-snapshot.json`. `readRenameTrialResult` revalidates the prepared review, outcome, snapshot hash and expected state, and retained archive before returning the snapshot. `saveRenameTrialRevision` uses that result to create an ordinary immutable Resolve observation revision with the transaction ID and outcome in its message. A private `revision-link.json` associates the revision with the transaction's review/audit and resulting snapshot hashes. The full review and recovery path remain in the transaction directory; they are not included in current revision-backup exports.

The caller must supply the selected branch and its expected head. The metadata store's compare-and-swap prevents overwriting intervening local revisions. Repeated saves return the existing verified link. If the app stops after saving the revision but before saving the link, retry finds the exact transaction message and verifies the revision's parent and content hash before creating the missing link. `recovery-required` outcomes cannot advance history. Changed result snapshots, damaged backups, and mismatched links are rejected.

The recorded live rollback was saved through this path into a disposable local metadata store. A second call returned the same revision ID, leaving two revisions total (baseline plus rollback observation). `trial-history-live-observation.json` records that path-free result. Tests additionally simulate the missing-link interruption, a competing branch writer, and changed snapshot bytes. Desktop controls remain to be connected; these are observation revisions, with full editor-property validation still open.

## Opt-in desktop recovery drill

The development app now connects the reviewed rename trial to the desktop. Start it explicitly with `FRAMELINE_RENAME_DRILL=1 npm start`; packaged builds and ordinary development launches keep the experiment disabled. The Resolve preview displays a **Disposable rename recovery drill** section only when enabled. It requires a complete current review and explicit acknowledgment of a named disposable project. This desktop path always forces the tested rollback after the saved/reopened rename; it does not enable ordinary pull/apply.

The controls prepare and copy the backup command, verify the resulting private archive, copy the mutation/rollback command, read copied Console result parts, save the linked outcome observation, and reveal the reverified backup. Commands, source bytes, and local recovery paths stay in the main process. The public state contains stages, opaque transaction/revision IDs, hashes, backup byte counts, and outcome status. Current source bindings and the reviewed choice are rechecked before issuing the command. Review mutation handlers are locked while a command is outstanding. Backup preparation can be cancelled while retaining its records; an issued mutation command must be completed or investigated through the retained records.

The session records a baseline observation when needed and pins its branch head for the outcome save. **Recover completed drill** uses a native directory picker restricted by validation to a direct child of the private trial root. It rechecks the completed result and backup before allowing the idempotent history save. Automatic recovery of an interrupted editor command is still unimplemented.

On November 17 the complete desktop path ran against `Frameline Restore Probe`: select the checked-in before snapshot as base/local and the applied snapshot as incoming; acknowledge the disposable project; copy/run backup; verify/copy/run drill; copy/read the returned Console output; save the outcome. Frameline displayed `rolled-back` and saved observation revision `5d873496-1495-4089-9851-3526566dd7fb` on `main`. The stored revision manifest, metadata record hash, transaction result, and retained archive were then read and verified. Source and final snapshot hashes match. `desktop-rename-drill-live-observation.json` preserves the path-free outcome. Reloading the renderer retained the main-process saved result. Session tests cover completed-record recovery, stale sources, disabled access, concurrency, and cancellation.

The visual check preserved the existing graphite/Plex design. A checkbox inherited the text-input flex rule; its specific selector now fixes its dimensions. The design detector reported only existing palette-documentation advisories; those were retained without suppression. Full editor-property validation, interrupted-command recovery, the successful non-rollback pull path, and release support remain open.
