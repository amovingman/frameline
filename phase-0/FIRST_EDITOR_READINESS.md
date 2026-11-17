# First editor evidence audit

Run `node phase-0/audit-first-editor.js` to recompute ten Phase 0 and early Phase 1 gates from the checked-in, disposable Resolve captures. The report is deterministic and path-free. Its source hashes bind the paired API snapshots, their FCPXML exports, and the separate structure export. It does not contact Resolve or modify a project.

On November 17, 2026, `python3 phase-0/probe-external-resolve.py` returned `connected: false` while the Free build was running with a disposable project, both inside and outside the workspace sandbox. `external-api-observation.json` records the outside-sandbox run. This is an observation of the installed configuration, not a claim about every Free installation. The internal Resolve console still works, but the Electron app has no proven live API connection to Free.

The paired capture retains five API item IDs across an edit. One corresponding FCPXML spine position changes from 5 to 6. `src/resolve-candidate-ledger.js` records those observations and verifies a saved ledger against all four exact source byte streams. A collision makes its result unresolved and suppresses retained-ID claims. The ledger is **candidate evidence**, not a persistent clip/track sidecar or an API-to-FCPXML identity proof.

The read-only `phase-0/compare-bound-exports.js` diagnostic combines that candidate context with an API-ID field diff. Run it with `before-snapshot.json before.fcpxmld after-snapshot.json after.fcpxmld TIMELINE_ID`. On the paired capture it reports one retained item with changed start/end frames and XML spine candidates 5 → 6. Ambiguous signatures leave the API differences visible but remove their XML candidate positions. The report never claims XML identity or enables apply.

The structure capture still shows two API audio items versus one explicit XML audio entry. The paired coverage report leaves effect parameters, linked identity, nested contents, and Resolve track-to-XML lane mapping unobservable. The API field diff reports two observed item-field changes; it cannot compare fields the snapshot does not contain. Those facts keep complete enumeration, lossless round trip, and safe write blocked.

| Gate | Current result | Evidence to close it |
|---|---|---|
| First users | Open | A consented pilot cohort with actual editor edition, build, OS, and project types. |
| Complete enumeration | Blocked | Paired API/export inventory of sequences, tracks, clips, transitions, effects, links, and nested content with no unexplained omissions. |
| Release version corpus | Open | Saved projects from every proposed edition/build/OS row; no range is declared yet. |
| Stable clip and track identity | Blocked | IDs through rename, move, trim, delete, relink, save/reopen, plus an unambiguous project/export mapping and stable track identity. |
| Representative performance | Partial | Disposable rename/save/reopen and rollback are verified; intended-user sized projects and measured scan, write, recovery, and memory behavior remain required. |
| Stop or revisit choice | Blocked | External access is unavailable on this installation. Evaluate a supported internal-script bridge or a different release target, then prove complete enumeration, identity, and recoverable write. |
| Lossless editor fields | Blocked | A round-trip field inventory showing every relevant construct preserved or explicitly unsupported. |
| Durable sidecar IDs | Blocked | A sidecar mapping that survives export changes and relink without guessing by name or position. |
| Stable-ID matching | Partial | API IDs can match within this one project; project-to-export identity remains unresolved. |
| Smallest safe diff | Partial | Observed API fields can be compared; full project constructs and side effects are not represented. |

The editor choice is an experimental target. The app's apply path stays disabled until the same representative project can be scanned, edited on a verified copy, reopened in Resolve, checked for collateral changes, and recovered after failure. The evidence audit cannot close that gate by itself.

The audit also verifies the later desktop rollback-drill observation and the native no-edit control. Its recovery section distinguishes `desktopRollbackDrillVerified: true` from `fullProjectApplyVerified: false`. A no-edit save/close/reopen/save retains the exact original API snapshot hash but changes three native archive members. The rename and control share opaque `FieldsBlob` changes in project, media-pool, and sequence data, as well as media-pool `Body` and sequence thumbnail changes. The sequence `Name` tag changes only in the rename run. These categories are recomputed from hash-pinned path-free reports; common tags are not interpreted as semantic equivalence, and no native field is ignored. This keeps the lossless-fields gate blocked while providing a repeatable baseline for further investigation.
