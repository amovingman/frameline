# Native checkpoint pull planning

The native checkpoint review now prepares a retained, executable pull intention for **one existing video clip Name** on the owner's installed Resolve Free 21.1.2, build 21.1.20010, on macOS. The selected project must be closed, at the root of its uniquely configured local disk library. This uses the proven native Name transaction from [SAFE_APPLY.md](SAFE_APPLY.md), together with the authenticated checkpoint history from [NATIVE_CHECKPOINT_REVIEW.md](NATIVE_CHECKPOINT_REVIEW.md). The SQLite helpers require `python3`.

The five roadmap items addressed here are deterministic executable planning, exact local/incoming hash bindings, stale-plan recalculation, interrupted-plan recovery, and field conflicts with proven apply rules. The supported operation remains deliberately small: one existing `Sm2TiVideoClip` Name stored in `Sm2TiItem.Name`. Timing, additions/deletions, other properties, audio Names, multiple Name changes, relinking, and service-history Apply have no executable write rule.

## Prepare and review

In Resolve preview, capture related native checkpoints and select a common base and incoming checkpoint. Choose **Prepare pull plan** with Resolve exited. The host reads both authenticated historical checkpoints and captures the current local project itself. A renderer request supplies opaque checkpoint IDs; it supplies no local path, database bytes, identity claims, SQL, or validation proof.

The comparison classifies every represented persistent native field. Local-only changes remain local, and already-applied changes require no write. Each semantic conflict needs an explicit **Keep current local value** or **Use incoming value** choice. Keeping an unsupported conflicting field is permitted because that field remains unchanged. Taking an unsupported incoming change blocks the entire plan. Unsupported incoming-only fields also block. Physical SQLite storage differences are shown as warnings and receive no conflict choice or project write.

A ready plan identifies the exact existing clip through its native project/timeline/sequence/track/item UUID joins and retained application identity/generation. It records the one old/new Name pair, complete choices, comparison/audit hashes, media condition, and required closed-source/editor/post-close validations. It is deterministic over the authenticated inputs, full ancestry, choices, and media report. A plan with no accepted change is a no-op and cannot enter the writer.

The media requirement is **unchanged references on this Mac**. Existing missing or unknown observed references are reported. Opaque media records remain preserved but are not fully enumerated; media collection, relinking and portability remain unverified. Review the plan and acknowledge its requirements before Apply. Acknowledgment resets when the plan changes and after desktop restart.

## Bindings and stale review

The immutable intention retains base, freshly captured local and incoming checkpoint IDs; exact database/census hashes and byte lengths; record hashes; verified ancestry; persistent identity bindings; comparison identity; complete decisions; and the executable Name plan. The incoming checkpoint is historical. Only the local checkpoint is asserted current, with fresh offline/source/library/metadata checks.

Refresh, conflict choice, and Apply recapture and compare the local project. A changed source hash or comparison clears every earlier choice before making a fresh plan. The old choices and plan remain in earlier authenticated journal events. A disappearing conflict or an incoming value that is already applied also invalidates the old choice cleanly. No execution transaction is created from stale review. Changes to the reviewed media condition also require a newly reviewed plan before execution.

## Durable Apply and recovery

Private intent journals use fsynced, exclusive, sequenced events authenticated with a host key. Paths and full native plans stay in the main process. Public state contains only bounded safe values, opaque IDs, hashes, choices, classifications, warnings and status. Native names containing path separators or control characters are masked in public summaries; the trusted exact value remains retained for preservation checks.

Before creating a native transaction, the session records a preparation intention. Each intention has one execution context and one authenticated core transaction directory. A process dying after core preparation but before the session records its transaction ID is reconciled by intention ID at restart. Startup reads authenticated inventory passively, including while Resolve is open. It does not publish, replay an edit, admit a native check, or mark validation complete.

Prepared transactions may be explicitly resumed or cancelled. Once effects may have started, choices and refresh are locked. **Inspect recovery** observes current bytes without publishing. Candidate, original and divergent states remain distinct. A failed nonterminal transaction may be retired with **Cancel** only when a fresh authenticated recovery check proves the exact planned original source (`original-safe-replan`). Retirement preserves its transaction, failed state, plan ID, observed source hash and recovery classification. It does not delete artifacts, change the source, replay the failed transaction or claim successful rollback. Candidate, divergent and rollback-awaiting-validation states cannot be retired this way. A retired intention stays terminal across restart and later source changes: Recover cannot reactivate it, and it cannot publish, validate, prepare or admit a native check. An active newer review also blocks restoration through an older intention.

Apply uses the existing full-cell preservation transaction: exact private backup, a separate stale-checked candidate, complete typed-cell/schema/pragma comparison, metadata-preserving atomic publication, and a retained native editor check. Run the named script in the matching Resolve project/library, read its check in Frameline, quit Resolve without saving, then finish validation. The host admits the check only after matching the actual open database and exact native targets. Restore-original uses a separately validated direction. Opening the editor or reading a script does not complete validation. Actual process-death tests stop immediately after atomic replacement and before the publication receipt, in both directions. A fresh closed-source recovery classifies those raw publishing phases before preparing a check; the explicit read uses its authenticated prepared request while Resolve is open, without replaying publication.

Frameline serializes its own native planning and effect workflows. The owner-controlled offline scope does not prove exclusion of an unrelated external writer starting after the final observation. The recorded shared sync base is not advanced by planning or by these local native transactions.

## Verification

Run the focused code checks with:

```sh
npm run test:native-pull
npm run verify:native-pull
```

The tests use real SQLite checkpoint/census inputs and cover deterministic planning, complete conflict choices, preserved unsupported fields, stale and vanished conflicts, raw/census/report/identity/media tampering, journal authentication, an actual process death after intent commit, orphan prepared-transaction recovery, passive startup with Resolve open, native admission, separate Apply/restore checks, retained script authentication, safe retirement and renderer/main-process boundaries.

[Desktop evidence](phase-0/native-pull-desktop/verification.json) records two real Electron processes using shipped main/preload/renderer and production checkpoint/intent/planner code with disposable synthetic hardware/library observations. It exercises conflict review, required acknowledgment, exact plan/choice recovery, stale recalculation, safe cancellation, unchanged project bytes during review, path-free state, and desktop/narrow layouts. It is not a live Resolve publication proof.

[Native proof](phase-0/native-pull-live-proof.json) records the production checkpoint plan `6db0e2ea…` and transaction `9e75115b-f3b3-434a-a7bb-01895dbd46e3`. Its base/local project and verified incoming copy share 77 persistent identities. The complete comparison covers 11,673 stored coordinates: one incoming-only Name and 11,672 unchanged. The candidate is byte-identical to the reviewed incoming copy. The full-cell check preserves every other application value, schema object and application pragma. Resolve independently opened and read the exact published file and expected Name; closed-project validation recorded the native revision. A separately prepared check observed the restored original file and Name, then post-close validation recorded the reverse revision. The fixture finished at its original SHA-256 `fa99fea8…`; the incoming copy stayed at `481d4b8d…`.

The first native attempt was refused before publication because canonical checkpoint metadata used a different object-key order from live metadata. Its exact original bytes were verified, and its intention was retired with the failed core transaction retained. The new adapter compares metadata semantically and passes its freshly verified live representation to the unchanged publisher. A regression now exercises the actual production publisher through staging, rename, Apply validation and restoration. That failed attempt is evidence of refusal and recovery, not a successful Apply.

Changing the selected library after publication may change only Resolve's active-library marker. The new execution context retains the original configuration bytes and requires every library name/root and every other configuration byte to remain exact. A fresh native check is prepared only after selecting the intended library and quitting Resolve; its admission binds the exact new configuration hash. No library-map change is accepted, and historical checkpoint/plan hashes remain unchanged.

The native run has no conflicting field: the desktop and real SQLite tests exercise the explicit conflict rules and durable choices. Those synthetic checks and the native publication proof are distinct. Audit the retained authenticated records without replaying publication with `npm run audit:native-pull-live` (on this Mac, with Resolve closed). Full native database files, host keys and Lua receipts remain in the ignored private retention directory; the committed receipt contains IDs, hashes, scope and verification results.

The final repository suite passed **2,239 tests with no failures or skips**. The final review also passed 60 focused planner/session/execution/controller/renderer checks and seven native evidence checks.
