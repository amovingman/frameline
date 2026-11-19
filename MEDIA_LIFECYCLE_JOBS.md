# Asset lifecycle and background jobs

Phase 4 has local reference implementations for retention, owner reports, background jobs and optional preview handlers. The desktop media-audit path uses the durable local job queue. A separate [ten-feature self-hosted verification queue](ASSET_VERIFICATION_JOBS.md) now uses fenced leases and a standalone-host worker to rehash published media. The later [desktop background-job delivery](DESKTOP_MEDIA_JOBS.md) adds a bundled Apple media renderer, durable consent and actual thumbnail/proxy/storyboard workers. Managed hosting and production-scale scheduling remain separate work.

## Retention and owner reports

`createContentAssetService` can record immutable asset references for a retained revision. The caller must provide `verifyRevision`, which confirms that the exact project, revision, and asset ID list are authoritative. Garbage collection requires project-owner authorization. It refuses any asset referenced by a retained revision, releases only the specified project's reference, and removes encrypted chunks only when no project still references the content. The index is updated before physical deletion, so an interrupted cleanup can leave orphaned bytes but cannot erase an indexed retained asset. A future maintenance job should identify and clean orphaned directories after a verified backup.

`exportProjectReport` returns a path-free owner report with revision count, content IDs, byte counts, retained-revision references, shared status, and deletion eligibility. `deletableBytes` counts exclusive, unreferenced content only. It is not an account-data export or legal deletion report, and it does not include media bytes.

## Jobs and previews

`createMediaJobQueue` persists exact-input-deduplicated jobs for hashing, thumbnails, proxies, asset checks, and timeline previews. A fresh process requeues interrupted running jobs. Workers report 0–100 progress, bounded results, and coded failures. Failed jobs can be retried up to a configured limit; a separate explicit new run resets the attempt budget. Journal updates are serialized independently of the worker, allowing another queued job to be cancelled while a large file is being hashed. The queue runs one worker in a process and stores opaque source IDs, a sanitized display label and bounded options rather than file paths.

`createMediaPreviewHandlers` provides optional thumbnail and lightweight timeline-preview jobs. It requires a positive rights confirmation, an editor or licensed rendering provider, and a storage callback. It validates bounded PNG/JPEG output and marks previews `canonical: false`. These injectable reference handlers still fail with `preview-provider-unavailable` when none is configured; the desktop now uses its separate bundled native provider. Preview artifacts never become timeline edit data.

## Desktop media audits

The media audit for a selected regular FCPXML export or verified review copy runs as an `asset-check` job. Availability checks and streamed SHA-256 reads report progress while the interface remains available. The desktop controls expose cancellation, retry, restart of interrupted checks and a new audit after a completed or cancelled run. These checks read local media; they do not upload, copy, relink or edit it. The separate [desktop media worker](DESKTOP_MEDIA_JOBS.md) now supplies thumbnails, proxies and timeline storyboards; it has its own job journal and cache.

An interrupted job waits for the same local project ID and export hash to be selected again. A review-copy job also needs its copy to be verified again. Reselecting equal bytes under a different local project ID does not bind the old job. Restarting rereads the media files from the beginning; no partial hash state or byte offset is resumed. Selecting another source pauses current work, and quitting the app stops the worker before shutdown when possible.

Completed reports are stored privately by content hash. They preserve the export hash, dependency names, availability, byte counts and observed media fingerprints. Before reuse, the report hash, schema, counts and source binding are checked. A missing or altered report is withheld; a new audit can recreate the result. Queue records describe the current run, while report files are retained separately. They are not an immutable history of every audit attempt, and automatic report retention or garbage collection is not implemented.

The renderer receives status, progress, source fingerprints, availability counts, display names, byte sizes and whether media fingerprints are available. Media locations and media fingerprint hashes remain in the main process. Results describe the last completed check, not live file monitoring. Matching an earlier audit's media fingerprint establishes matching observed bytes; it does not establish camera-original identity, proxy equivalence or pull readiness.

## Verification

The current automated run passes 431 tests with no failures or skips, and packaging checks pass. Native Electron verification exercised Cancel during a streamed check of an 8 GiB sparse fixture. An orderly quit while another check was at 17% persisted a queued job and exited successfully. On relaunch, that job was unbound and could not restart until the matching export was reselected. Restart then began reading file 1 again from the beginning.

After the restarted check completed, a second quit/relaunch and matching-export selection restored the same completed job and report without rehashing. The completion timestamp and run ID stayed unchanged; the report still contained three dependencies, two local files, one missing file and two fingerprints. Its stored content hash was verified. The path-free [milestone evidence](phase-0/media-audit-jobs-live-observation.json) records these checks.

The sparse fixture establishes this local streaming/control flow and completed-report recovery. It is not representative editor-project performance evidence or proof of restartable uploads or applies.

The self-hosted verification queue now has cooperative cross-process leases, HTTPS job transport, cancellation/retry, metrics, and full-content hashing; see its separate scope above. Desktop media rendering is delivered separately. Production-scale scheduling, quotas, retention windows, project deletion and production garbage collection remain open. Local audit progress does not provide upload progress or restartable editor apply.
