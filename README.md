# Frameline

Frameline is an early desktop prototype for versioning video-editing decisions and safely bringing collaborator changes into an existing project.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm start
```

## Project status

The Electron interface is a prototype with clearly labeled sample project data. DaVinci Resolve 21.1.2 has passed a basic FCPXML import, export, and edited-copy reimport proof using a synthetic three-still timeline. Stable clip identity and broader timeline support remain under investigation.

See [ROADMAP.md](ROADMAP.md), [PRODUCT.md](PRODUCT.md), and [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for scope and current plans. Phase 0 evidence and the disposable parser spike are in [phase-0/resolve-xml-proof](phase-0/resolve-xml-proof/README.md).
