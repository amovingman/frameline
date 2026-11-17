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

Recording a trial also saves its exact returned snapshot bytes privately as `result-snapshot.json`. `readRenameTrialResult` revalidates the prepared review, outcome, snapshot hash and expected state, and retained archive before returning the snapshot. `saveRenameTrialRevision` creates an immutable Resolve observation revision with the transaction ID and outcome in its message. A private `revision-link.json` associates the revision with the transaction's review/audit and resulting snapshot hashes. Newly saved reviewed outcomes include the portable audit described below; older immutable revisions retain their original format.

The caller must supply the selected branch and its expected head. The metadata store's compare-and-swap prevents overwriting intervening local revisions. Repeated saves return the existing verified link. If the app stops after saving the revision but before saving the link, retry finds the exact transaction message and verifies the revision's parent and content hash before creating the missing link. `recovery-required` outcomes cannot advance history. Changed result snapshots, damaged backups, and mismatched links are rejected.

The recorded live rollback was saved through this path into a disposable local metadata store. A second call returned the same revision ID, leaving two revisions total (baseline plus rollback observation). `trial-history-live-observation.json` records that path-free result. Tests additionally simulate the missing-link interruption, a competing branch writer, and changed snapshot bytes. The desktop integration described below subsequently connected these controls. These remain observation revisions, with full editor-property validation open.

### Portable trial audits

New reviewed outcome saves use Resolve observation manifest schema 2. Its `sourceHash` still hashes only the normalized snapshot, preserving preview compatibility. A separate `transactionAuditHash` hashes the complete canonical audit, and the immutable revision record protects the complete manifest. Exact base/local/incoming source strings, review decisions, issued-record metadata, returned snapshot bytes, optional effect supplements, and recovery inspection/retirement bindings travel together. Validation recomputes the review and derived rename, verifies the expected outcome and effect state, and checks recovery bindings. Recomputing an outer digest does not make inconsistent decisions or observations valid.

The audit identifies its provenance as copied Console observations. Hashes establish consistency, not authenticated editor provenance or coverage of uncaptured properties. Native backup bytes, executable commands, and transaction-directory paths are excluded. The issued backup reference retains its hash, size, mode, and verified-archive metadata; importing it does not establish that the native archive is available. Original source content can contain project, clip, and media information, so exported bundles are private files (mode `0600`). Counts-only trials remain counts-only evidence. Unreviewed or unresolved recovery outcomes cannot be exported as reviewed audits.

```sh
node phase-0/portable-resolve-audit.js export /absolute/private-trial /absolute/new-audit.json
node phase-0/portable-resolve-audit.js verify /absolute/new-audit.json
node phase-0/portable-resolve-audit.js import /absolute/local-metadata /absolute/new-audit.json
```

Export validates the retained trial and backup, publishes a complete file without replacing an existing destination, and leaves the original trial unchanged. Verify accepts bounded regular files and rejects symlink inputs. Import appends a read-only historical observation to the current branch using compare-and-swap; it preserves the project display name, branch selection, and sync base. Repeating the same transaction/audit returns the existing revision; a different audit for the same transaction is rejected. Import does not contact Resolve or restore a native backup. Existing immutable revisions and links are never retrofitted: export an old retained transaction separately, then explicitly import its audit if desired.

Revision-backup import remaps local project/revision IDs while preserving the audit payload and hash. The in-memory reference-transfer service fingerprints the complete manifest, keeping differing audits distinct even when their snapshots match. `portable-trial-audit-transfer-observation.json` records a transfer proof using two previously recorded disposable live trials: a reviewed rollback with one conflict decision and an interrupted rename restored with effect evidence. CLI export/verify/repeated import, revision-backup round trip, ancestry preview, and in-memory reference transfer all passed; original transaction files were unchanged. This proof used no new editor access and no network. Native startup UI verification remains pending separately.

## Opt-in desktop recovery drill

The development app now connects the reviewed rename trial to the desktop. Start it explicitly with `FRAMELINE_RENAME_DRILL=1 npm start`; packaged builds and ordinary development launches keep the experiment disabled. The Resolve preview displays a **Disposable rename recovery drill** section only when enabled. It requires a complete current review and explicit acknowledgment of a named disposable project. This desktop path always forces the tested rollback after the saved/reopened rename; it does not enable ordinary pull/apply.

The controls first copy a read-only effect capture command, then read its Console output and bind the full supplement to the reviewed local snapshot. Only then do they prepare/copy the backup command, verify the resulting private archive, copy the mutation/rollback command, read copied Console result parts, save the linked outcome observation, and reveal the reverified backup. Commands, source bytes, complete effect observations, and local recovery paths stay in the main process. The public state contains stages, opaque capture/transaction/revision IDs, hashes, backup byte counts, and outcome status. Current source bindings and the reviewed choice are rechecked before preparing the backup and issuing the command. Review mutation handlers are locked while a command is outstanding or a trial action is running. Capture preparation can be cancelled without a transaction; backup preparation cancellation retains its records. An issued mutation command must be completed or investigated through the retained records.

The session records a baseline observation when needed and pins its branch head for the outcome save. **Choose drill folder** uses a native directory picker restricted by validation to a direct child of the private trial root. It rechecks a completed result and backup before allowing the idempotent history save. New effect-guarded forced-rollback trials also support interrupted-command recovery through persistent command retirement, fresh inspection, guarded source verification or reverse rename, and a separately recorded recovery outcome. Both source-verification and interrupted-rename paths ran live after desktop restarts. See `RESOLVE_INTERRUPTION_RECOVERY.md` for records, CLI commands, evidence, and limits. Automatic startup discovery is implemented with native UI verification pending; general apply recovery remains open.

On November 17 the complete desktop path ran against `Frameline Restore Probe`: select the checked-in before snapshot as base/local and the applied snapshot as incoming; acknowledge the disposable project; copy/run backup; verify/copy/run drill; copy/read the returned Console output; save the outcome. Frameline displayed `rolled-back` and saved observation revision `5d873496-1495-4089-9851-3526566dd7fb` on `main`. The stored revision manifest, metadata record hash, transaction result, and retained archive were then read and verified. Source and final snapshot hashes match. `desktop-rename-drill-live-observation.json` preserves the path-free outcome. Reloading the renderer retained the main-process saved result. Session tests cover completed-record recovery, stale sources, disabled access, concurrency, and cancellation.

The visual check preserved the existing graphite/Plex design. A checkbox inherited the text-input flex rule; its specific selector now fixes its dimensions. The design detector reported only existing palette-documentation advisories; those were retained without suppression. Full editor-property validation, general apply recovery, the successful non-rollback pull path, and release support remain open.

The subsequent desktop effect-guard run completed the capture → guarded backup → forced rollback → outcome revision flow and verified matching effect bytes after save/reopen. `desktop-effect-guard-live-observation.json` records the new revision and source/result effect hashes. The interface rejects reading a result before matching Console output exists, supports command recopy/retry, and focuses the next available action as stages advance. Session tests cover incomplete/different-ID captures, snapshot mismatch, changed reviews, cancellation at both preparatory stages, main-process-only data, and verified completion/recovery. See `RESOLVE_EFFECT_OBSERVATIONS.md` for the remaining observation limits.

## Successful rename and native-content comparison

The guarded reviewed transaction also ran with `forceFailure: false` on the same disposable copy. Its Console result was `applied`, and the saved/reopened snapshot exactly matched the expected renamed state (`7655ea985e1033860f194f3e94b3e4f4c32147d71af4a98552d1cebf2021c9a9`). A second guarded transaction, with its own verified backup and reviewed sources, successfully reversed the name change. Its final observed snapshot matches the original (`654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`). Both applied outcomes were recorded as linked revisions in a disposable local metadata store. `successful-rename-live-observation.json` contains the path-free results and history linkage. This was the standalone main-process/Console path; the desktop continues to expose the forced-rollback drill only.

Resolve exported an additional native `.drp` after the successful forward rename. Comparing it with the transaction's before archive shows **three changed members**: project metadata, media-pool data, and the sequence. Gallery bytes are identical. The sequence contains the expected `Name` change, regenerated thumbnail identifiers, and a changed transition `FieldsBlob`. Project and media-pool serialization also contain changed `FieldsBlob`/`Body` data, save times, and other records. These native text members use C++-style tag names such as `ListMgt::LmPowerNodeList`, so they are not assumed to be standard XML. The opaque differences are unresolved; they are not evidence of lossless writing or known collateral damage.

`compare-native-resolve-exports.py` makes a bounded, read-only comparison of regular, non-symlink `.drp` archives. It verifies ZIP reads, limits compressed/expanded/member bytes and member counts, rejects duplicate/traversal names and nonregular source files, and emits archive/member hashes plus changed line-tag counts. Member names are hashed, values are omitted, and errors do not expose input paths. No extraction or native-byte patching occurs. All changed fields, including opaque blobs, remain in the report; `losslessValidated` and `safeToApply` always remain false.

```sh
python3 phase-0/compare-native-resolve-exports.py /absolute/before.drp /absolute/after.drp
```

`native-rename-difference-live-observation.json` pins the actual export hashes and changed-tag evidence. Automated tests cover bounds, traversal, duplicate members, symlinks, nonregular files, private-value omission, unchanged archives, and preservation of opaque differences. A no-edit save/reopen control and further editor-property evidence are still required to understand the serialization changes. Ordinary product apply remains disabled.

### No-edit save/reopen control

A subsequent internal Console probe on the same disposable copy saved and exported the current state, closed/reopened the project, saved/exported again, and asserted equality of the complete captured API snapshot before and after. The resulting snapshot SHA-256 remained `654bb87fdb3defb108a2ddd30af694f8868748b375cf5b5246453e0a9c506850`. No timeline edit API was invoked. The two native exports nevertheless have three changed members: project, media-pool, and sequence. `native-no-edit-control-live-observation.json` records their hashes and changed-tag counts; gallery bytes remained identical.

The control and rename both change project/media/sequence `FieldsBlob` data, media-pool `Body` data, and sequence thumbnail identifiers. Only the rename run changes the sequence `Name` tag. Other project metadata tags also differ between the runs. `native-rename-control-comparison-live-observation.json` preserves this comparison. A shared tag category does not establish that the same underlying property changed, and the control is not used to suppress or normalize away opaque data.

Passing four paths to the native comparison CLI produces the edit/control matrix:

```sh
python3 phase-0/compare-native-resolve-exports.py /absolute/edit-before.drp /absolute/edit-after.drp /absolute/control-before.drp /absolute/control-after.drp
```

The matrix retains both complete byte reports and lists common, edit-only, and control-only known line tags per hashed member name. Unknown tags remain counted as `other-tag`. `audit-first-editor.js` verifies the checked-in report hashes, recomputes change counts and tag overlap, and retains the blocked lossless-fields gate. The no-edit control shows that opaque serialization changes are not specific to a rename, but their meaning and full editor-property preservation remain unresolved.
