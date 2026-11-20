# Early product decisions and evidence

This is a personal project for the owner, targeting the installed Resolve version and small disposable synthetic fixtures. Additional users, customer projects and pilot research are not prerequisites. Public distribution and hosted operations are optional future scope; see `PROJECT_SCOPE.md`. Technical editor safety still requires evidence.

The [November 19 integration reassessment](EDITOR_INTEGRATION_DECISION.md) records an explicit release No-Go while retaining the exact read-only experiment. It closes the stop/revisit decision process, with source-bound evidence and reopening criteria; it does not close the identity, coverage, validation or write gates below.

| Decision | Current working position | Evidence still required |
|---|---|---|
| First editor and format | DaVinci Resolve **Free 21.1.2, build 21.1.20010**, on macOS; FCPXML 1.10 for read-only scanning. The exact target is encoded in `src/compatibility-contract.js`. | Complete timeline enumeration, persistent identity across API and export, safe write/reopen. |
| API read and write reliability | The Free build exposed some timeline objects and allowed limited edits to duplicate timelines in the internal console. A dated external connection probe returned unavailable; the user chose to retain Free and explore an internal-script companion. The desktop adapter still refuses apply. | Live companion handoff, complete constructs, stable mapping, transactional copy/in-place apply, and reopen validation. |
| First release platform and version | No release support is declared. Public distribution is deferred. Use only the installed macOS/Free build for local development. | Small operation-specific fixtures for the installed build; release drills only if distribution is later requested. |
| Media storage offering | Local/shared media and optional metadata-only revision exchange suit the personal scope. Asset class sync defaults to none; no automatic media upload. A paid cloud media tier is undecided. | Team storage needs, rights, region and cost research, hosted transfer and recovery evidence. |
| Uploaded data and lifecycle | Revision transfer includes messages/authors, display names, availability, hashes and branch heads. It excludes project source files and media bytes; path-like labels and free-text paths are rejected. Media upload review names each asset class, action and byte count before explicit consent. | Hosted processing region, retention periods, account export and deletion semantics, data-subject needs and a user-reviewed disclosure in the desktop app. |

The upload disclosure in `src/upload-disclosure.js` is a review artifact only. Its fingerprint detects a changed estimate; a future executor must re-estimate authoritative assets after consent. The metadata disclosure in `src/metadata-disclosure.js` describes a validated revision bundle and does not start a transfer. Local and service retention reports are foundations; they do not establish a hosted deletion policy.

## Automatic merge boundary

For ripple edits, linked clips, transitions, and nested sequences, no automatic merge is currently safe to claim. The read-only Resolve risk gate marks observed timing or link interactions as blocked and keeps unobserved construct coverage unknown. A merge can become automatic only for an individually proven field rule after complete enumeration, stable identity, editor-backed write/reopen validation, and recovery tests for that construct. Conflict review choices record intent; they do not authorize an apply.
