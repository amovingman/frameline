# Desktop media transfers

History's Project media panel connects explicit file transfers to the optional [self-hosted asset service](ASSET_NETWORK_SYNC.md). Choose a local project and link its branch to an existing service project first. History push/fetch still transfers revision metadata only. These media operations do not change editor references, apply revisions, or associate an asset with a canonical revision.

## Upload

Choose an asset class and a bandwidth limit, then choose a regular local file in the native picker. Frameline hashes it locally and asks the selected service whether that content ID already exists. This lookup discloses the content ID before confirmation; it does not send file bytes or the local filename/path. The panel states this beside the chooser.

The review shows the selected name, byte count, class, content ID, and estimated bytes to upload. Existing exact content estimates zero transfer bytes. Confirm Upload media to persist a private job and begin transferring. Preparation can be cancelled before a job exists. Viewers cannot prepare or confirm uploads.

Every start or resume rehashes the source against the reviewed identity. File-descriptor and named-file checks detect replacement and changes; symlinks are refused. A changed file cannot silently replace the reviewed asset. The server's acknowledged bitmap lets retry skip retained chunks. After transfer the source is checked again, and service-side whole-content verification must return a verified receipt before completion is shown.

Local hashing has byte progress. Service verification is indeterminate, with no early percentage or verified claim. Cancelling verification makes a bounded best-effort request to stop the shared service job. Cancellation cannot undo publication that already won the race; resuming the same identity safely discovers the resulting state.

## Download

Enter a published `sha256:` content ID and choose a destination with the native save dialog. The current account must have read access to that project. Viewers can download published assets but cannot inspect partial uploads or write media.

Downloads retain verified chunks and a checkpoint in the app's private working directory. Resume checks the checkpoint's project, content ID, size, and chunk geometry and hashes cached chunks before reuse. Final assembly streams the complete file hash, flushes a private temporary file in the destination directory, and publishes exclusively. A different existing file or a symlink is preserved. An identical existing destination can be verified and reused. Publication currently requires a destination filesystem that supports hard links; unsupported targets fail without replacing an existing file. An uncertain final flush is reported rather than treated as proof that nothing was written.

A corrupt or mismatched checkpoint fails closed and is retained. Starting a new download creates a separate job; it does not erase the damaged cache or overwrite a destination. Completed downloads and private cached chunks are retained; automatic cache collection remains separate work.

## Scope and restart

Jobs are bound to the service origin, account ID, local project and branch, and remote project and branch. Changing any of these stops active work and hides unrelated records. Current project permissions are checked before starting or resuming and by the server on every request. Same-project progress notifications do not interrupt a transfer.

The main-process connection manager supplies a generation-bound asset client. It shares credential refresh with metadata sync, saves rotated credentials before use, and aborts/drains private requests on sign-out or account replacement. Neither the renderer nor preload receives stored tokens or a credential getter.

The private transfer journal stores the source/destination paths required for explicit resume, with private directory/file permissions and atomic flushed replacement. A flushed initialization marker precedes the first job; a missing previously observed journal, or missing state with retained marker/work evidence, fails closed in current and reopened controllers. Lost jobs are never silently reset. Public state and events contain safe names, IDs, counts, stages, receipts, and error codes. Interrupted work is shown as paused. Restart does not read selected media or resume network operations automatically: restore the account, reselect the matching local project/binding, then choose Resume. A completed receipt retains its completion timestamp.

Quit aborts and drains file work and its controllers before disposing the service connection, so cancellation can still use the active account. Each transfer has cancellable byte pacing; the limit applies to new network chunks, not cached or already-present bytes. The UI offers unlimited, 1 MiB/s, and 5 MiB/s.

The journal is bounded to 100 retained jobs. The panel displays 20 at a time and can show older records. Hosted accounting, revision-selected media downloads, persistent class policies, preview workers, editor relinking, and job/cache retention controls remain open. A bandwidth setting is a local per-job limit, not a server billing policy.

## Validation

The [disposable live observation](phase-0/desktop-media-transfer-live-observation.json) records browser and native checks against an actual loopback HTTPS asset service using a 16 MiB + 31 byte synthetic file. Both upload reviews preceded any asset upload record or file bytes. The browser showed a full-size initial estimate and zero bytes for exact published content, uploaded successfully, cancelled a download after one verified chunk, then resumed it to the exact complete hash. Viewer upload controls were disabled; a separate viewer download matched the original bytes. Signing out or changing account hid unrelated jobs, and returning to the owner and reloading recovered its completed receipts.

Native macOS Electron used the real file and save dialogs. An upload was cancelled after an acknowledged chunk, resumed, and interrupted by quitting the app with two acknowledged chunks. The original process exited successfully before relaunch. The account restored through the OS-backed vault without retyping credentials; reselecting the same export recovered the binding and paused job. No new chunks appeared before explicit Resume, and the same upload completed with a verified receipt. A later quit during download preserved one cached chunk and no destination file; a third app process recovered and resumed it to the exact complete hash. The upload's completion timestamp survived this second restart.

The vault and final destination were mode `0600`, and raw fixture credentials were absent from vault bytes. The browser's injected encrypted provider is separate from native OS-vault evidence. All QA app processes were terminal before replacement. Test sign-ins and the fixture-owned native transfer/cache directory were removed, the disposable service stopped, the browser tab closed and viewport reset, and the ordinary desktop app reopened without the test CA override. System certificate trust was not changed.

Two bounded visual rounds checked 1440, 768, and 390 px layouts. Horizontal overflow was zero and visible phone controls measured at least 44 px. The incumbent graphite/Plex style was retained; the mechanical design check reported only existing palette advisories, with no suppressions. A full keyboard, screen-reader, and contrast audit remains a separate roadmap gate.

All 629 tests passed with no failures or skips, and packaging validation passed. File-engine checks cover source replacement/mutation/symlinks, cancellable pacing, checkpoint corruption, destination collisions including a publication race, full-content mismatch, and empty files. Controller/connection checks cover explicit confirmation, scope changes, offline visibility, private SDK generation and refresh, indeterminate verification, missing-journal refusal in fresh/current instances, dynamic shutdown draining, and real engine/store integration. The native interruptions were orderly quits; no mid-write crash, machine power loss, signed-release credential policy, public hosting, or large-project performance claim is made.
