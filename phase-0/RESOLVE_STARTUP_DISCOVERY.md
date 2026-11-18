# Retained drill discovery

The opt-in development recovery drill inspects retained records when its desktop state is first requested at startup. Automated, real-filesystem and native startup/list-selection checks pass. The live disposable flow also verified preparation cancellation, source inspection, save/reopen verification and outcome linkage. Ordinary pull/apply remains disabled.

## Startup and review

With `FRAMELINE_RENAME_DRILL=1 npm start`, the renderer requests drill state on load. Initialization checks the private trial root without loading review sources, reading the clipboard, copying a command, retiring a transaction, or interacting with Resolve. Disabled and packaged sessions do not scan.

When retained work is found, a workspace reminder links to **Retained drills** in Resolve preview. Rows show verified project names and dates, a shortened transaction ID, and one state-specific action:

| State | Action | Consequence |
| --- | --- | --- |
| Issued supported drill without a final result | Inspect live state | Revalidate the record/backup, retire its original command, and prepare a fresh read-only capture |
| Verified outcome without a verified history link | Open outcome | Revalidate the historical result before offering the linked observation save |
| Prepared transaction with no issued rename | Cancel preparation | Retain all files and write a cancellation marker; later rename issuance is refused |
| Older/unsupported issued transaction or unresolved recovery result | Reveal records | Open the verified private folder for manual inspection |
| Unreadable record | Reveal records when its private directory is valid | Show no unverified project name or record contents |

Saved outcomes with verified revision links and cancelled preparations are omitted. Missing, inconsistent, or corrupt history links cannot make a record disappear as completed. An active drill disables list actions that could switch or cancel transactions. A workspace reminder also lets the user return to an active drill after renderer reload. **Choose drill folder** retains the native-picker fallback.

The list refreshes explicitly; **Check older records** advances through pages of 20 candidates. The cursor is the last inspected folder name, kept only in the main process. Newer records appearing between pages do not duplicate or skip the older page; refreshing starts again at the newest records. The scanner bounds the root at 5,000 entries and fails visibly if that limit is exceeded. Counts refer to inspected records, not an unverified total of unfinished work.

## Verification boundaries

The scanner accepts only direct children matching the generated transaction-folder pattern. It rejects symlinked/private-mode violations, verifies folder/transaction identity, and revalidates the prepared review and represented sources. Issued records require a valid history target and a hash/CRC-verified private archive. Recovery-capable and legacy records retain distinct actions.

Completed outcomes also revalidate snapshot/effect bytes, expected state, audit bindings, recovery bindings when present, and backup. A history link must match the actual stored project and verified revision record, its expected parent, content hash, transaction message, audit, status, and pinned target. Discovery does not save a revision or create a project to repair a missing link.

Only a path-free list of opaque selection IDs, transaction IDs, names, dates, states, and actions crosses IPC. Private folder paths stay in a main-process map. Selecting a discovered entry revalidates its current records and archive; a stale row cannot authorize cancellation after issuance or recovery from a changed backup. Revealing records rechecks directory privacy and refuses symlink traversal. Errors exclude source contents and paths.

Cancelling an unissued preparation writes a private immutable marker and preserves the plan and any archive. The main-process issue function refuses cancelled preparations. Newly generated backup commands also check the marker before saving/exporting, so cancellation retires a previously copied backup preparation command. Issued rename commands cannot be cancelled through this path.

## Evidence and remaining check

The tests cover discovery classification, absence of clipboard/Resolve/review side effects, read-only selection, cancellation, stale rows, broken archives/history links, corrupt metadata, symlinks, paging with concurrent newer entries, missing roots, unsafe modes, and disabled sessions.

On November 17, the new main-process initializer inspected the real six-record trial root. It omitted the four completed linked outcomes and found the two newly created disposable preparations. Exact content/mode fingerprints of all retained trial files matched before and after inspection; no command was copied, no clipboard was read, no review was loaded, and no recovery barrier was created. `startup-drill-discovery-observation.json` records this filesystem evidence with `nativeUiVerified: false` and `liveResolveFlowVerified: false`.

The initial native attempt stopped when the Mac locked, so the earlier filesystem report correctly retains its false native-verification flags. After desktop access resumed on November 17, the first new fixture exported a verified private 69,372-byte backup and was issued without running its rename command. Frameline was quit and relaunched. The startup reminder showed two retained drills; its action opened the list with the prepared and issued records distinguished by transaction ID.

Only preparation `3b86a6635768cddbbb791fd773fe94e6` was cancelled, retaining its files and adding the immutable cancellation marker. Selecting issued fixture `9dfd5c07a2abf30daa35c2c18de672d9` from its row retired the original command and copied a fresh inspection. The capture matched the original state. **Verify saved source** saved and reopened the disposable Resolve project without renaming, returned `source-verified`, and saved revision `7f1d4309-02ea-40e1-b5e4-7f03f9957804` with parent `3044078a-f005-4d39-96bb-380e582b6683` and a portable audit. Snapshot/effect bytes, archive, immutable revision record and transaction link were read and verified.

The attention count fell to zero. After another complete Frameline restart, the list still reported no unfinished drills among six inspected records and no startup reminder appeared. `startup-drill-discovery-live-observation.json` records the native result with true UI/Resolve verification flags and the persisted completion check. The prior four completed trials were retained. General apply recovery, damaged-archive restoration and broader editor-property validation remain separate gates.
