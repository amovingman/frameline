# Interrupted Resolve drill recovery

The opt-in desktop drill can recover an issued, effect-guarded forced-rollback transaction after Frameline restarts. This is a disposable-project experiment, with observed-field validation only. Ordinary pull/apply remains disabled.

## Recover through the desktop

Start the development app with `FRAMELINE_RENAME_DRILL=1 npm start`. In Resolve preview, **Choose drill folder** opens the retained transaction directory picker. The native picker starts at the private trial root. The main process requires a direct child of that root and validates its prepared review, issued record, history target, and backup. Original review files do not need to be reselected: their exact bytes and audit are revalidated from the prepared record. Startup discovery and direct list selection are now implemented; their native UI check remains pending. See `RESOLVE_STARTUP_DISCOVERY.md`.

Completed transactions reopen their verified outcome as before. For an unfinished supported transaction, recovery proceeds as follows:

1. Frameline permanently retires the original copied command and copies a fresh read-only effect capture. Run it in Resolve's Lua Console and copy all output.
2. **Read recovery capture** compares the full observation to both expected states. An exact original state offers **Verify saved source**. An exact renamed state offers **Restore original name**. Any other represented change, including an effect enabled-state change or different project ID, requires manual inspection and retains the backup.
3. The chosen action copies a guarded recovery command. It rechecks the full captured state before making changes. Source verification saves and closes/reopens the project without renaming. Name restoration calls the supported `SetName` API for the original clip name, then saves and closes/reopens. Both must match the original full observation afterward.
4. Copy/read the returned Console result. A verified result can be saved as a linked observation revision on the pinned branch head. `source-verified` records a verified original state without claiming the initial command ran. `restored` records the reverse-name operation. A failed recovery cannot advance history.

**Inspect again** retires earlier recovery attempts and prepares a new read-only capture. Use it after manual inspection or if a recovery action was interrupted. Recovery never replays the original forward rename. Review mutation controls remain locked while recovery is active. The current project name remains visible, and renderer reload rehydrates the active recovery context.

## Durable records and guards

New issued records include `recoveryVersion: 1`. Their generated Lua commands check for `recovery-started.json` before consuming the trial or calling `SetName`. The main process writes that private, immutable barrier before issuing a recovery capture; it binds the exact issued-record bytes and verified archive hash. The barrier survives desktop and Resolve restarts. Normal result recording is also refused once recovery starts.

Each private `recovery/<attempt-id>/` contains a request bound to the barrier, the exact inspected effect observation, its classification/hash receipt, and the selected action binding. New inspections create `retired.json` in earlier attempt directories. Generated recovery commands check retirement, completion, the expected live observation, and the retained backup. An in-memory Lua guard additionally prevents duplicate execution in the same editor session. There are at most 128 capture attempts per transaction.

Successful recovery stores `recovery-result.json`, `recovery-result-snapshot.json`, and `recovery-result-effects.json` separately from original result artifacts. A partially written original snapshot is retained rather than overwritten. Loading or saving a recovered outcome revalidates its barrier, request, inspection, issued action, expected state, effect hashes, review audit, and backup. A conflicting normal and recovery result is rejected. A failed recovery retains its observation under the attempt directory and permits a new inspection, without creating a final outcome or revision.

The history save retains the existing compare-and-swap branch-head protection and duplicate-link reconciliation. Newly saved reviewed outcomes also carry a portable transaction audit in their observation revision, including exact review sources, decisions, outcome, effect observations when captured, and recovery inspection/retirement bindings when applicable. Revision backups preserve this audit. Native archives, executable commands, and local recovery paths remain private. Existing immutable revisions are not rewritten; their audits can be exported separately from retained transaction records. See the portable-audit workflow in `SAFE_PULL_PREFLIGHT.md`.

## Console CLI

```sh
node phase-0/rename-resolve-trial.js prepare-recovery TRANSACTION_DIRECTORY
node phase-0/rename-resolve-trial.js read-recovery TRANSACTION_DIRECTORY ATTEMPT_ID copied-console-output.txt
node phase-0/rename-resolve-trial.js issue-recovery TRANSACTION_DIRECTORY ATTEMPT_ID
node phase-0/rename-resolve-trial.js record-recovery TRANSACTION_DIRECTORY ATTEMPT_ID copied-console-output.txt
```

Preparation and issuance return the command to run in Resolve. Recovery accepts only ordered, matching-attempt Console parts followed by exactly one result. Copied Console text is unauthenticated observation evidence; it is not proof against an adversarial editor or forged clipboard.

## Live evidence

On November 17, a main-process trial fixture for `Frameline Restore Probe` exported and verified its native backup. A failure-injection command used the issued command's guarded prefix, performed the rename, saved/reopened, and stopped before rollback or result emission. Frameline was quit and relaunched. **Recover a drill** revalidated the retained records without loading the review files. Clearing the experimental Lua replay table and attempting the original command still produced the persistent-retirement rejection, with the clip remaining in its renamed state. This probe exercised the disk guard without restarting Resolve itself.

The fresh capture matched the expected renamed state with one name change and no effect-metadata changes. The desktop restore command returned `restored`; the original snapshot and full effect supplement matched exactly after save/reopen. Saving the outcome created revision `08584a2d-fd8f-417f-864c-58370c42a2be`. Its record hash, manifest, parent, transaction/audit link, branch head, recovery bindings, supplement, and backup were read and verified. `interrupted-rename-recovery-live-observation.json` records the path-free result.

A second fixture was issued but its rename command was never run. After another desktop restart, a fresh inspection matched the original state. **Verify saved source** saved/reopened without renaming and returned `source-verified`. Renderer reload during this recovery retained the main-process stage and locked review controls. The linked revision is `3044078a-f005-4d39-96bb-380e582b6683`; the same disk checks passed. `unrun-rename-recovery-live-observation.json` records that case. Both fixtures retained private native backups and left the disposable project at its original observed state with Gaussian Blur enabled.

## Limits

Older issued commands without the persistent-retirement capability, counts-only trials, and non-forced standalone apply trials do not enter this automatic reverse-name path. Completed legacy outcomes remain readable. Startup discovery and safe cancellation of unissued preparations are implemented and tested, with native UI verification still pending. Unavailable/damaged backups, divergent represented edits, interrupted full-archive import recovery, and general project apply need further work. Recovery requires an explicit selection; Frameline does not silently change an open project on launch.

The effect supplement does not observe parameters, nested content, automation, or persistent effect-instance identity. Matching observations do not establish native semantic equivalence or lossless writing. The native edit/no-edit export differences remain unresolved. See `RESOLVE_EFFECT_OBSERVATIONS.md` and `SAFE_PULL_PREFLIGHT.md`.
