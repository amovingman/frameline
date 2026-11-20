# Desktop asset lifecycle review

History → **Asset lifecycle** connects project owners to the existing self-hosted lifecycle API. It works without selecting or linking a local editor project. The interface keeps the existing graphite/Plex History design and uses the main-process service connection; bearer credentials never enter renderer state.

## Ten delivered features

1. [x] Select an owned service project and explicitly refresh the owner project catalog.
2. [x] Load lifecycle reports in pages of 100, refusing pages from changed service state.
3. [x] Search content IDs and filter loaded media by class, hold, archive, shared-content, or archive-check status, with bounded result display.
4. [x] Inspect exact content ID, class/size, archive time, waiting-period end, shared-copy evidence, hold version/deadline, and blockers.
5. [x] Review and submit a manual, contractual, or investigation hold, optionally with an expiration selected in local time.
6. [x] Review and release a hold at its observed version, preserving the service's release tombstone and retry semantics.
7. [x] Review and save a project archive waiting period from zero through 3,650 days at its observed policy version.
8. [x] Select up to 100 loaded assets and review a source-state-bound cleanup plan with candidate bytes and every blocker.
9. [x] Review report or plan export scope/hash, then save the exact path-free JSON artifact through a native save picker after a fresh service-state check.
10. [x] Recover a private, account-scoped pending mutation after restart; explicitly retry the same request or dismiss it after checking saved state.

The panel now completes the [advanced lifecycle roadmap item](OWNER_OPERATIONS.md) for the personal/self-hosted scope. It uses authoritative schema-2 reports/plans and explicit reference-aware collection. The original schema-1 blocked-plan API remains available to legacy clients. Editor writes remain outside this workflow.

## Workflow

Sign in using Service history, then select an owned project and choose **Load report**. A separate local project selection is unnecessary. A **Refresh owned projects** action discovers newly owned projects or changed permissions. Editors and viewers have no lifecycle owner controls, and the API rechecks authority independently of cached project roles.

The table shows only loaded assets. Filters search those rows, not the whole service catalog. **Load next 100** requests the next page; **Show more loaded results** expands the visible matching rows. Paging requires the same project-wide state hash and total asset count. A changed hold, retention policy, archive state, media membership, or shared-content status invalidates the combined result and requires a new report.

Inspect a content ID to see its full observed state. Hold changes, releases, and waiting-period changes first open an inline review naming the affected content/project and observed version. Confirmation sends precisely those values. New scopes discard open reviews. Draft fields survive ordinary progress events. Expiration entry uses the computer's local time zone and is sent as epoch milliseconds; an empty expiration means no deadline. Reports retain their observation time, so passage of time alone can change a later plan's blockers.

Successful mutations display their verified receipt and invalidate the previous report. Load a new report to observe current service state. A historical retry receipt may describe an older successful change; it does not replace a later service hold/release or policy change.

Plan selection stays explicit even when filters hide selected rows. The UI displays the full selection count and limits it to 100. Plans list every retained revision and blocker. Complete reference coverage, archive age, no active holds and no active verification are required for an executable plan. Explicit confirmation sends the exact reviewed plan. Unknown legacy coverage remains blocked.

## Retry recovery and privacy

Before sending a mutation, the main process records its exact project, asset/collection selection, reviewed version/state/plan, desired settings, and generated idempotency key in `userData/asset-lifecycle-intents/lifecycle-intents.json`. Schema 2 preserves earlier pending requests and stores the matching account's last verified collection receipt. The journal uses a `0700` directory, `0600` files, cooperative locking, atomic replacement, file/directory flushes, and a missing-state marker. It stores no passwords, access tokens, media paths, or byte content. Pending records are partitioned by a hash of service origin/account ID and contain only path-free request metadata. The renderer sees the reviewed settings and pending record ID, never the idempotency key.

Only one pending lifecycle mutation per account may exist. A lost response blocks replacement requests until the original is recovered. Startup/sign-in reads the matching journal locally and never automatically retries a service mutation. Account changes hide former records and discard old report/detail/plan/export state; later sign-in to the original account can recover its pending request. Loss of owner access prevents retrying that project's mutation.

A first definite service rejection clears a newly created intent. An older ambiguous request remains even when a retry is rejected, because a previous attempt may have committed. **Dismiss local retry** requires the explicit saved-state acknowledgment and only removes the local record; it cannot undo a service change. Invalid or uncertain local journal writes fail closed and require inspection/restart rather than silently replacing evidence.

## Reviewed exports

Reports export the individually validated loaded pages and a `complete` flag. Partial reports explicitly state that more pages remain. Plans export the exact validated plan. Receipts export the verified historical deletion outcome, including after restart without reloading a report. All three artifacts include a format version, kind, project ID, and reviewed content. They contain no service credentials, local paths, or private retry keys.

The renderer reviews the artifact's hash, kind, asset count, and completeness before opening the native picker. After the picker returns, the main process rechecks the same scope and a fresh service state hash. Changed state, sign-out, changed selection, symlinked parent folders, and existing destinations prevent a stale or overwriting export. Files are created with `0600` permissions. The snapshot remains evidence of its recorded time; a completed export does not claim current media readiness or authorize deletion.

## Validation

Controller/journal tests cover reviewed versions, exact retries after restart and later release, stale project/account scopes, permission changes, report paging, blocked plans, reviewed exports, destination collisions, and private journal validation. Renderer tests cover explicit confirmation, literal labels, preserved drafts, filters and result bounds, pending acknowledgment, stale event versions, and the reference gate.

The current [desktop evidence](phase-0/owner-operations-desktop/verification.json) comes from `scripts/verify-owner-operations-desktop.cjs` using the shipped main/preload/controller and real HTTPS sign-in. It verifies retained protection, reviewed collection, a lost committed acknowledgment, full app restart, historical retry and receipt export, alongside both metadata publication reviews. Captures cover 390, 768 and 1440 pixels. The earlier [schema-1 evidence](phase-0/asset-lifecycle-desktop/verification.json) remains historical evidence for holds, waiting periods, filters and blocked-plan exports.

The current proof includes full application restart and disposable real service sign-in. It does not test OS power loss, physical cross-device operation, assistive-technology software, real studio mounts or managed operations. Those claims remain outside this personal owner workflow.

The completed batch passed all 1,335 full-suite tests without skips, including 15 new desktop/controller/renderer tests, plus packaging validation and changed-UI source lint. The desktop HTTPS fixture made 12 requests. Screenshot review retained the existing graphite/Plex styling; the mechanical design detector reported no lifecycle findings and only existing advisory palette findings elsewhere.
