# Early product decisions and evidence

These are working defaults for local experiments, not release or pricing decisions. The unresolved gates below require editor-backed tests and pilot input before a public promise.

| Decision | Current working position | Evidence still required |
|---|---|---|
| First editor and format | DaVinci Resolve **Free 21.1.2, build 21.1.20010**, on macOS; FCPXML 1.10 for read-only scanning. The exact target is encoded in `src/compatibility-contract.js`. | Complete timeline enumeration, persistent identity across API and export, safe write/reopen. |
| API read and write reliability | The Free build exposed some timeline objects and allowed limited edits to duplicate timelines in the internal console. The current desktop adapter refuses apply. | External app connection in Free, complete constructs, stable mapping, transactional copy/in-place apply, and reopen validation. |
| First release platform and version | No release support is declared. Use the exact macOS/Free build as the pilot boundary; evaluate any wider version or OS separately. | Intended-user compatibility corpus and release drills for each declared row. |
| Media storage offering | Start pilot planning with local/shared media and metadata-only revision exchange. Asset class sync defaults to none; no automatic media upload. A paid cloud media tier is undecided. | Team storage needs, rights, region and cost research, hosted transfer and recovery evidence. |
| Uploaded data and lifecycle | Revision transfer includes messages/authors, display names, availability, hashes and branch heads. It excludes project source files and media bytes; path-like labels and free-text paths are rejected. Media upload review names each asset class, action and byte count before explicit consent. | Hosted processing region, retention periods, account export and deletion semantics, data-subject needs and a user-reviewed disclosure in the desktop app. |

The upload disclosure in `src/upload-disclosure.js` is a review artifact only. Its fingerprint detects a changed estimate; a future executor must re-estimate authoritative assets after consent. The metadata disclosure in `src/metadata-disclosure.js` describes a validated revision bundle and does not start a transfer. Local and service retention reports are foundations; they do not establish a hosted deletion policy.
