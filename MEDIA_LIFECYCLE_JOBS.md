# Asset lifecycle and background jobs

The next five Phase 4 items now have local reference implementations. They are not connected to hosted storage, a production worker, an editor renderer, or the desktop interface.

## Retention and owner reports

`createContentAssetService` can record immutable asset references for a retained revision. The caller must provide `verifyRevision`, which confirms that the exact project, revision, and asset ID list are authoritative. Garbage collection requires project-owner authorization. It refuses any asset referenced by a retained revision, releases only the specified project's reference, and removes encrypted chunks only when no project still references the content. The index is updated before physical deletion, so an interrupted cleanup can leave orphaned bytes but cannot erase an indexed retained asset. A future maintenance job should identify and clean orphaned directories after a verified backup.

`exportProjectReport` returns a path-free owner report with revision count, content IDs, byte counts, retained-revision references, shared status, and deletion eligibility. `deletableBytes` counts exclusive, unreferenced content only. It is not an account-data export or legal deletion report, and it does not include media bytes.

## Jobs and previews

`createMediaJobQueue` persists exact-input-deduplicated jobs for hashing, thumbnails, proxies, asset checks, and timeline previews. A fresh process requeues interrupted running jobs. Workers report 0–100 progress, bounded results, and coded failures. Failed jobs can be retried up to a configured limit; queued or failed jobs can be cancelled. The queue is single-process and stores opaque source IDs rather than file paths.

`createMediaPreviewHandlers` provides optional thumbnail and lightweight timeline-preview jobs. It requires a positive rights confirmation, an editor or licensed rendering provider, and a storage callback. It validates bounded PNG/JPEG output and marks previews `canonical: false`. No renderer is bundled, so a job fails with `preview-provider-unavailable` when none is configured. Preview artifacts never become timeline edit data.

Cross-process worker leases, hosted job transport, real media rendering, user-facing progress, quotas, retention windows, project deletion, and production garbage collection remain open.
