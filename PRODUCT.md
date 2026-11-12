# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron hosts a local HTML/CSS/JavaScript interface on desktop. The interface is designed for pointer and keyboard input.

## Users

Video editors working with project files and collaborators' edits. They need to inspect incoming changes and protect their current work.

## Product Purpose

Version editing decisions, compare project revisions, and pull clip-level changes into an existing project. Two pull modes are planned: update the current file after creating a restore point, or create a separate review copy.

## Operating Context

DaVinci Resolve Free 21.1.2 on macOS is the initial integration target, using FCPXML 1.10 for read-only timeline exchange while safe write access is researched. A local synthetic proof has confirmed import, export, and a changed-copy reimport for a simple three-still timeline. A Free editor-backed thousand-clip export can now be scanned for its primary picture clips. This does not yet establish release support for native Resolve project files or complex timeline constructs. Project files and media are local during the first prototype; cloud history and sharing are later parts of the system design.

## Capabilities and Constraints

The current app is an Electron UI prototype. It can scan and rescan the first top-level picture sequence in an FCPXML file or bundle read only, show exact frame counts, and check referenced local media files for availability without exposing their paths to the renderer. It can save immutable local scan revisions on named branches after verifying the export has not changed since scanning. History follows the selected branch, opens validated revision details, and compares sequence and media inventory with a revision's verified parent; the review examples remain synthetic and labeled as such.

The Resolve preview tab accepts three schema-3 Resolve API snapshot files (common base, local observation, incoming observation). It classifies observed field changes, compares values, displays conflicts and conservative warnings, and lets users record a review choice for each conflict. Timeline and field filters, unresolved-conflict navigation, source-hash status, media requirements, and warning categories support inspection. Refresh re-reads the sources and clears choices when source bytes change. Preview data can be saved and recovered locally by content hash against the same source bytes; a separate content-addressed review artifact preserves partial or complete choices and verifies them on recovery. Neither artifact stores source files. Once all conflicts have choices, the preview shows a source-bound audit of review intent. This read-only workflow does not establish the branch sync base, map API IDs to an editable project, or apply changes. The pull action remains disabled.

## Evidence on Hand

`SYSTEM_DESIGN.md` contains the architecture and MVP requirements. The current interface is in `src/`.

## Product Principles

- Make the affected edit visible before changing a project file.
- Explain overlapping edits and preserve local work.
- Keep review copy and in-place pull as separate, clear choices.
- State honestly when content is sample data or a feature is unavailable.
