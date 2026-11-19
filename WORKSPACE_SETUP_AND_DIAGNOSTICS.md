# Workspace setup and reviewed diagnostics

These complete the two Phase 5.1 roadmap items for the current experimental desktop integration: first-run editor/project/workspace selection, and diagnostics export with explicit privacy review and path redaction.

## First run

Choose the experimental **Resolve Free 21.1.2 on macOS** integration, name the workspace, and either keep app storage or choose a folder in the native directory picker. A chosen folder receives a private `Frameline revisions` subfolder. The displayed location is the actual store used for project identities, revision manifests, branches, and their metadata backups. Project exports and media remain where they are; service credentials, queues, caches, and app settings remain in the app profile.

**Choose project** saves the workspace choices and opens the native FCPXML picker. A successful read-only scan completes onboarding. Cancelling or failing the picker preserves the choices and leaves setup incomplete, including after app restart. **Skip for now** hides the panel for this session without marking it complete. The workspace name appears in the sidebar; its tooltip shows the saved storage location.

Storage selection is available before a project operation begins. Once a project opens, the location is fixed so history and background consumers cannot switch stores mid-operation. Existing completed version-1 setups retain their current app storage and project identities. This flow selects a workspace; it does not migrate an existing workspace or provide live workspace switching.

Custom storage has a private identity marker, bound to the durable private onboarding settings. Store operations verify the original canonical folder and marker. A missing, moved, replaced, or symlinked workspace fails closed: reconnect the original folder at its saved location and choose the project again. Frameline neither recreates a missing configured workspace nor silently falls back to empty app storage. Preserve the whole workspace, including its marker, when backing it up. Explicitly choosing a folder during initial setup can open an existing valid Frameline revision store.

## Diagnostics privacy review

**Diagnostics → Review report** builds a new allowlisted JSON report. App/runtime versions, supported platform/architecture names, connection status, and queue counts are included. Project/scan counts and session scan performance are independently optional. Changing an option invalidates the previous review.

The report excludes absolute and relative paths, filenames, media names and bytes, source exports, project/account identifiers, workspace names, server URLs, credentials, arbitrary error strings, and raw logs. Only recognized error codes and nonnegative safe integer aggregates are accepted. Redaction happens by excluding unapproved fields and values before serialization, rather than attempting to scrub arbitrary log text afterward. Session scan metrics stay local and reset when the app exits.

The preview displays the exact JSON bytes to be saved and their SHA-256. Export remains disabled until the user checks the explicit approval box. The main process requires the current review token, hash, and approval, and checks the included app state before and after the save dialog and before publishing the file. Changed state requires another review. Cancelling preserves the review; successful export consumes it. No report is uploaded or sent automatically.

Output is staged with private permissions, fully written and synced, then published without replacing an existing file or symlink. Failed staging leaves no partial destination. An existing filename must be changed or removed by the user before retrying. Share the saved JSON only after reviewing it, using the process in [SUPPORT.md](SUPPORT.md).

## Verification

- `npm run test:setup-support`: real filesystem history/restart, legacy settings preservation, corrupt/unavailable storage, configuration races, nested privacy attacks, consent, stale review, cancellation, concurrency, exact bytes, and filesystem failures.
- `npm run verify:setup-support`: two real Electron processes running the shipped main process, preload, and renderer against a disposable profile. The OS picker results are supplied by the harness. It scans a fixture, saves revisions to custom storage, restores the same project/history after process restart, exercises review/consent/export and cancellation, compares displayed/exported bytes, and checks source preservation.
- Native layout checks cover 1440, 768, 390, and 360 CSS pixels. Screenshots and the machine-readable observation are in [phase-0/setup-support-desktop](phase-0/setup-support-desktop/verification.json).

These checks prove the current local desktop workflows. The experimental editor support boundary, general timeline apply, installer signing, and other roadmap items retain their separate gates.
