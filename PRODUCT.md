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

DaVinci Resolve 21.1.2 is the first integration candidate, using FCPXML for timeline exchange. A local synthetic proof has confirmed import, export, and a changed-copy reimport for a simple three-still timeline. This does not yet establish support for native Resolve project files or complex timeline constructs. Project files and media are local during the first prototype; cloud history and sharing are later parts of the system design.

## Capabilities and Constraints

The current app is an Electron UI prototype. It can scan and rescan the first top-level picture sequence in an FCPXML file or bundle read only, show exact frame counts, and check referenced local media files for availability without exposing their paths to the renderer. It can save immutable local scan revisions after verifying the export has not changed since scanning. History uses saved records and opens their validated details for selected files; the review examples remain synthetic and labeled as such. Stable clip mapping, revision comparison, merging, and pulling are not implemented, so the pull action stays disabled.

## Evidence on Hand

`SYSTEM_DESIGN.md` contains the architecture and MVP requirements. The current interface is in `src/`.

## Product Principles

- Make the affected edit visible before changing a project file.
- Explain overlapping edits and preserve local work.
- Keep review copy and in-place pull as separate, clear choices.
- State honestly when content is sample data or a feature is unavailable.
