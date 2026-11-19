# Frameline support and compatibility reports

Frameline is an experimental local prototype. The tested integration target is DaVinci Resolve Free 21.1.2 on macOS with FCPXML 1.10. Applying timeline edits and hosted media transfer are unavailable.

## Report an issue

1. Confirm the exact Resolve edition/build, macOS version, and whether the input is `.fcpxml` or `.fcpxmld`.
2. Reproduce with a disposable export when possible. Do not upload an original project or media unless you explicitly intend to share it.
3. In the app, choose the optional details under **Diagnostics**, then use **Review report**. Inspect the exact JSON and check the approval box before exporting. App/runtime versions, connection status, and queue counts are included; project counts and scan performance are optional. Paths, filenames, media, account details, credentials, arbitrary messages, and logs are excluded. Nothing is uploaded. Changed app state requires a new review; cancelling the save dialog preserves the review.
4. Open a compatibility issue using the repository template. Include the steps, expected outcome, actual outcome, and only the diagnostic fields you choose to share.

Do not include invitation tokens, credentials, private media URLs, source files, or proprietary timeline details in a public issue. A maintainable report should identify a reproducible construct and its failure code without exposing creative material.

For first-run storage selection, missing workspace recovery, and export guarantees, see [Workspace setup and reviewed diagnostics](WORKSPACE_SETUP_AND_DIAGNOSTICS.md). If custom revision storage is unavailable, reconnect the original folder at its saved location before choosing the project again; do not replace it with an empty folder.

## Triage

Classify incoming reports as malformed input, unsupported construct, scan failure, identity ambiguity, media availability, revision recovery, or UI defect. Reproduce against a disposable fixture. Record the exact build and format in the compatibility corpus before changing a support claim. A release-support claim requires editor-backed read, write, reopen, and recovery evidence.
