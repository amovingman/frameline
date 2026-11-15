# Frameline project summary

## What it is

Frameline is an early desktop prototype for versioning video-editing decisions, inspecting collaborator changes, and protecting a local edit before any future pull workflow. Its first integration target is **DaVinci Resolve Free 21.1.2 on macOS**, using **FCPXML 1.10** for read-only timeline exchange.

Today, the desktop app can safely scan selected FCPXML files or bundles, maintain immutable local revision history on named branches, compare safe inventory details, audit media availability without exposing paths to the renderer, and create byte-verified review copies. Its Resolve preview compares three API snapshots, presents conflicts and warnings, and records review intent. Applying edits to a project remains deliberately disabled until stable identity and a safe editor write path are proven.

The repository also contains an executable, in-process foundation for collaboration: immutable content-addressed history, compare-and-swap branch heads, authenticated roles, encrypted credentials and records, audit trails, metadata-only sync, offline retry, concurrent-update protection, and cached metadata. It is **not** a deployed cloud service.

## Languages, frameworks, and formats

| Area | Technology | Use |
|---|---|---|
| Desktop application | Electron 41 | Hosts the isolated desktop main process and renderer |
| Application logic | JavaScript / Node.js, CommonJS | Timeline scans, local history, sync, security, and desktop orchestration |
| User interface | HTML and CSS | Local desktop interface; no React, Vue, or other UI framework |
| XML parsing | `fast-xml-parser` 5.12 | Read-only parsing of supported FCPXML exports |
| Proof tooling | Python 3 standard library | Resolve XML/API mapping proof and tests |
| Project interchange | FCPXML 1.10, JSON | Timeline export, scan manifests, API snapshots, and revision artifacts |

## Developer tools and libraries

| Tool or library | Role |
|---|---|
| npm | Dependency installation and scripts |
| `node --test` | JavaScript unit and integration test runner |
| Python `unittest` | Tests for the Resolve proof tooling |
| Git and GitHub | Source history, review, and branch publishing |
| Electron `safeStorage` | Main-process operating-system-protected credential storage |
| `fast-xml-parser` | Bounded, validated FCPXML parsing |
| `@fontsource/anton`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono` | Bundled interface typography |

## Current project metrics

| Metric | Current value | Meaning |
|---|---:|---|
| Roadmap completion | 88 / 188 tasks (46.8%) | Checked items in `ROADMAP.md`; this includes proofs and foundations, not only production features |
| Node test suite | 219 passing | Automated JavaScript coverage across desktop, parsing, history, review, security, and sync modules |
| Python proof tests | 24 passing | Automated coverage for the Resolve XML/API proof tooling |
| Initial scan scope | 1 top-level picture sequence | Supported FCPXML read path; complex/nested content is warned about or rejected rather than guessed |
| Supported initial target | Resolve Free 21.1.2 + FCPXML 1.10 | Evidence-backed initial integration boundary, not a general compatibility promise |
| Cloud deployment | 0 deployed services | Collaboration code is an executable local foundation only |

## Productivity and time-saved measurement

No production usage telemetry has been collected, so Frameline does **not** claim a measured time-saving result yet. Its expected benefit is reducing repetitive, manual work around revision inspection, source verification, media readiness checks, review-copy preparation, and recovery after unsafe changes.

Use this model after pilot usage begins:

```text
Weekly time saved (hours) =
  reviews per week × (manual review minutes − Frameline review minutes) / 60
```

For example, if a team completes 10 review cycles per week and Frameline removes an observed 15 minutes from each cycle, the estimated benefit is **2.5 hours per week**. That example is illustrative; it is not a measured product result.

Recommended pilot metrics:

- Median time from export selection to a completed review decision
- Manual media-location checks avoided per review
- Review copies verified without a collision or stale-source failure
- Conflicts reviewed and recovered from without editing the original project
- Sync retries completed without duplicate remote revisions
- Failed, blocked, and reconciled sync operations by cause

## Important boundaries

- Frameline does not currently apply edits, merge timelines, or modify Resolve project data.
- Stable identity between Resolve API items and editable exports is not yet proven.
- The app does not have a hosted API, cloud database, desktop account flow, or user-facing sync controls.
- Media is not uploaded or placed in the offline metadata cache.
- Unsupported or ambiguous input is designed to fail closed rather than produce a guessed result.

For detailed scope and evidence, see `README.md`, `PRODUCT.md`, `SYSTEM_DESIGN.md`, `SERVICE_FOUNDATION.md`, `SECURITY_MODEL.md`, and `ROADMAP.md`.
