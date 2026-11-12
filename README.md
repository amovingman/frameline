# Frameline

Frameline is an early desktop prototype for versioning video-editing decisions and safely bringing collaborator changes into an existing project.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm start
```

## Project status

The Electron interface can scan a selected `.fcpxml` file or `.fcpxmld` bundle read only, then rescan it after the timeline or media changes. Scan failures provide recovery steps for missing, inaccessible, busy, malformed, and unsupported exports. The resulting v2 scan manifest is validated before it reaches the interface. It shows the first sequence's top level picture clips, exact frame counts, referenced media names, and warnings for unsupported timeline elements. It checks whether referenced local files exist without loading their contents. External and unspecified sources remain unresolved. Local paths stay in the main process. Frameline assigns a durable local project ID in its backed-up metadata store and can save immutable scan revisions with messages on named local branches. History follows the selected branch, which persists across restarts. Revision backups can be exported and imported onto new local branches without replacing existing work. Frameline checks the source hash before saving and validates revision records when opening their details in History. Opening a revision also compares its sequence and media inventory with its verified parent; clip edits remain unpaired because identity is unresolved. Moving an export to a new path initially assigns a new ID; History offers an explicit relink when that export exactly matches a verified saved branch head and the new ID has no history. The sample review remains available until a file is selected. Clip-level comparison, merge, and pull are not yet implemented for scanned files.

DaVinci Resolve 21.1.2 has passed a basic FCPXML import, export, and edited-copy reimport proof using a synthetic three-still timeline. The scanner currently accepts FCPXML 1.10 only. Its project adapter exposes read-only scan and source verification; stable-ID mapping, apply, save, and editor validation remain unavailable. A synthetic compatibility corpus checks read-only scans of basic edits and warns when nested content or connected lanes are outside the scan. Stable clip identity and broader timeline support remain under investigation.

The desktop **Resolve preview** tab accepts three schema-3 Resolve API snapshot JSON files: a common base, the local observation, and the incoming observation. It classifies observed field changes, compares their values, shows conflicts and conservative warnings, and records review choices for conflicts. Timeline, field, status, and unresolved-conflict filters help inspect the result; source hashes and changed roles remain visible without exposing paths. Refresh re-reads the selected files; changed source bytes clear previous choices. A preview can be saved locally under a content hash and recovered only with the same source bytes. A separate review artifact preserves partial or complete conflict choices and verifies them on recovery against those exact source bytes. Neither artifact contains source files. The audit appears when every conflict has a choice, but it only records review intent. Applying changes to Resolve is unavailable.

An optional desktop comparison matches a schema-3 local Resolve snapshot against a selected FCPXML export. It reports exact hashes, candidate matches, collisions, and unmatched items for supported flat picture content, including the supported Resolve wrapper. Complex content fails closed. These are candidates rather than proof of persistent identity, and the comparison cannot authorize apply. A separate workflow creates an unchanged `.fcpxml` review copy at a user-selected destination and filename, checks for collisions, then verifies the copy by rescan, hashes, and source checks before displaying a sanitized result. No pull plan is applied; identity and safe apply remain unproven.

See [ROADMAP.md](ROADMAP.md), [PRODUCT.md](PRODUCT.md), and [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for scope and current plans. The [Phase 0 integration assessment](phase-0/INTEGRATION_ASSESSMENT.md) records edition, API, and write-path evidence. The disposable parser spike is in [phase-0/resolve-xml-proof](phase-0/resolve-xml-proof/README.md); fixture policy and expected scans are in [phase-0/compatibility-corpus](phase-0/compatibility-corpus/README.md).
