# Frameline

Frameline is an early desktop prototype for versioning video-editing decisions and safely bringing collaborator changes into an existing project.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm start
```

## Project status

The Electron interface can scan a selected `.fcpxml` file or `.fcpxmld` bundle read only, then rescan it after the timeline or media changes. Scan failures provide recovery steps for missing, inaccessible, busy, malformed, and unsupported exports. The resulting v2 scan manifest is validated before it reaches the interface. It shows the first sequence's top level picture clips, exact frame counts, referenced media names, and warnings for unsupported timeline elements. It checks whether referenced local files exist without loading their contents. External and unspecified sources remain unresolved. Local paths stay in the main process. Frameline assigns a durable local project ID in its backed-up metadata store and can save immutable scan revisions with messages. It checks the source hash before saving. Moving an export to a new path currently assigns a new ID. The sample review remains available until a file is selected. Clip identity, revision comparison, merge, and pull are not yet implemented for scanned files.

DaVinci Resolve 21.1.2 has passed a basic FCPXML import, export, and edited-copy reimport proof using a synthetic three-still timeline. Stable clip identity and broader timeline support remain under investigation.

See [ROADMAP.md](ROADMAP.md), [PRODUCT.md](PRODUCT.md), and [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for scope and current plans. Phase 0 evidence and the disposable parser spike are in [phase-0/resolve-xml-proof](phase-0/resolve-xml-proof/README.md).
