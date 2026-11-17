# Frameline support and compatibility reports

Frameline is an experimental local prototype. The tested integration target is DaVinci Resolve Free 21.1.2 on macOS with FCPXML 1.10. Applying timeline edits and hosted media transfer are unavailable.

## Report an issue

1. Confirm the exact Resolve edition/build, macOS version, and whether the input is `.fcpxml` or `.fcpxmld`.
2. Reproduce with a disposable export when possible. Do not upload an original project or media unless you explicitly intend to share it.
3. In the app, use **Diagnostics → Review report**. Inspect every field before exporting. The report contains status codes and counts only; it excludes paths, media names, source bytes, credentials, and clip details.
4. Open a compatibility issue using the repository template. Include the steps, expected outcome, actual outcome, and only the diagnostic fields you choose to share.

Do not include invitation tokens, credentials, private media URLs, source files, or proprietary timeline details in a public issue. A maintainable report should identify a reproducible construct and its failure code without exposing creative material.

## Triage

Classify incoming reports as malformed input, unsupported construct, scan failure, identity ambiguity, media availability, revision recovery, or UI defect. Reproduce against a disposable fixture. Record the exact build and format in the compatibility corpus before changing a support claim. A release-support claim requires editor-backed read, write, reopen, and recovery evidence.
