# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron hosts a local HTML/CSS/JavaScript interface on desktop. The interface is designed for pointer and keyboard input.

## Users

The project owner is the sole intended user. This is a personal project using the installed Resolve Free 21.1.2/build 21.1.20010 on macOS. Development uses small disposable synthetic projects; no additional users or customer-project research are required. See `PROJECT_SCOPE.md`.

## Product Purpose

Version editing decisions, compare project revisions, and pull clip-level changes into an existing project. Two pull modes are planned: update the current file after creating a restore point, or create a separate review copy.

## Operating Context

DaVinci Resolve Free 21.1.2 on macOS is the initial integration target, using FCPXML 1.10 for read-only timeline exchange while safe write access is researched. A local synthetic proof has confirmed import, export, and a changed-copy reimport for a simple three-still timeline. A Free editor-backed thousand-clip export can now be scanned for its primary picture clips. This does not yet establish release support for native Resolve project files or complex timeline constructs. Project files and media are local during the first prototype; cloud history and sharing are later parts of the system design.

## Capabilities and Constraints

The current app is an Electron UI prototype. It can scan and rescan the first top-level picture sequence in an FCPXML file or bundle read only, show exact frame counts, and check referenced local media files for availability without exposing their paths to the renderer. It can save immutable local scan revisions on named branches after verifying the export has not changed since scanning. History follows the selected branch, opens validated revision details, and compares sequence and media inventory with a revision's verified parent; the review examples remain synthetic and labeled as such.

The Resolve preview tab accepts three schema-3 Resolve API snapshot files (common base, local observation, incoming observation). It classifies observed field changes, compares values, displays conflicts and conservative warnings, and lets users record a review choice for each conflict. Timeline and field filters, unresolved-conflict navigation, source-hash status, media requirements, and warning categories support inspection. Refresh re-reads the sources and clears choices when source bytes change. Preview data can be saved and recovered locally by content hash against the same source bytes; a separate content-addressed review artifact preserves partial or complete choices and verifies them on recovery. Neither artifact stores source files. Once all conflicts have choices, the preview shows a source-bound audit of review intent. This read-only workflow does not establish the branch sync base, map API IDs to an editable project, or apply changes. The pull action remains disabled.

The desktop also has an optional read-only comparison between a schema-3 local Resolve API snapshot and a selected FCPXML export. Its JavaScript matcher reports exact hashes, candidate matches, collisions, and unmatched items for supported flat picture content, including the supported Resolve wrapper. It rejects complex content rather than guessing. Candidate results are not persistent identity, and the comparison UI cannot authorize apply. For a selected regular FCPXML source, a separate media audit reports path-free local, missing, offline-volume, proxy-only, excluded, external, or unknown references and streamed fingerprints where available. A selected-folder search classifies moved-media candidates without exposing paths or editing the export. A separate requirement gate reports ready, confirmation-required, or blocked; it does not make project apply safe.

The repository includes an executable local project-service foundation for versioned API contracts, immutable manifests and revisions, compare-and-swap branch heads, idempotency, pagination, migrations, backup/restore drills, and retention reporting. No cloud service is deployed, and accounts, authorization, regions, transport, and durable hosted storage remain future work.

The service foundation also includes local proofs for rotating sessions and recovery, team invitations and project roles, mandatory project-resource authorization, protected credential storage, encrypted service records, rate limits, audit events, account deletion safeguards, metadata-only revision push/fetch/divergence, durable offline retry, concurrent-head preservation, and an integrity-checked offline metadata cache. These proofs do not add a desktop account flow, user-facing sync controls, or a deployed collaboration service.

A separate review-copy workflow lets the user choose a destination and filename for an unchanged `.fcpxml` copy, checks for name collisions, and verifies the result by rescan, hashes, and source checks before showing a sanitized result. The copy audit confirms the artifact is identical. An existing copy is re-verified before it can be revealed in Finder, and a stale source invalidates that handoff. No pull plan is applied. Stable project identity and safe apply remain unproven; the pull action stays disabled.

## Evidence on Hand

`SYSTEM_DESIGN.md` contains the architecture and MVP requirements. The current interface is in `src/`.

## Product Principles

- Make the affected edit visible before changing a project file.
- Explain overlapping edits and preserve local work.
- Keep review copy and in-place pull as separate, clear choices.
- State honestly when content is sample data or a feature is unavailable.
