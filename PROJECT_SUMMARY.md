# Frameline — full project overview

## Project description

Frameline is a local-first collaboration and version-control product for video-editing projects. Its purpose is to let editors preserve a trustworthy history of editing decisions, review incoming changes before they affect a working timeline, resolve conflicts deliberately, and eventually share projects and media with collaborators without losing local work.

The product is intentionally being built from safety evidence outward. It starts by proving what an editor integration can read, identify, validate, and write safely; it does not promise universal project-file compatibility or enable automatic timeline changes until those conditions are met. The initial integration target is **DaVinci Resolve Free 21.1.2 on macOS**, using **FCPXML 1.10** for read-only interchange and Resolve API snapshots for additional diagnostic evidence.

## Product vision

Frameline is intended to give video teams a workflow analogous to source control while respecting the differences of timeline-based creative work:

- Create immutable, understandable project revisions on named branches.
- Show what changed before changing an editor project.
- Preserve local edits when an incoming revision overlaps them.
- Make media availability, missing assets, and relink confidence visible.
- Offer safe review-copy and eventual transactional in-place pull workflows.
- Support teams, permissions, history, sharing, cloud sync, and reliable recovery.

The desired outcome is a collaboration workflow where editors can move quickly without relying on opaque file overwrites, manual folder comparisons, or unverified project copies.

## Full project scope

| Product area | Intended outcome |
|---|---|
| Editor research and compatibility | Select integrations only after proving timeline enumeration, stable identity, safe validation, and a supported write path. Maintain compatibility fixtures and explicit support boundaries. |
| Local project foundation | Scan project exports safely, normalize them into deterministic manifests, store immutable revisions, create branches, recover from corruption, and export/import history. |
| Change review and safe pull | Compare a common base, local state, and incoming revision; identify conflicts; create an executable pull plan; back up, apply, validate, and recover transactionally. |
| Media intelligence | Inventory referenced media, identify availability and relink candidates, fingerprint files, explain requirements, and later sync media assets intentionally. |
| Cloud collaboration | Maintain versioned project history, identities, team roles, branch protection, invitations, activity history, sharing, push/fetch, offline operation, and reconciliation. |
| Asset services | Add content-addressed media storage, resumable transfers, deduplication, storage policies, proxies, retention, previews, and observable background jobs. |
| Release and expansion | Provide onboarding, accessibility, performance for large projects, diagnostics, packaging, updates, CI, incident response, and one proven editor adapter at a time. |

## Current delivery position

The project currently has a working Electron prototype and executable local service foundations. It can safely read supported FCPXML input, maintain local revision history, create verified review copies, audit media availability, preview Resolve API snapshot differences, and test collaboration invariants locally.

Features intentionally still open include project-write/apply support, universal clip identity, production cloud deployment, user-facing sync controls, media upload/download, team-sharing interface, installer release engineering, and additional editor integrations. This is an evidence-based prototype, not a release-ready collaboration service.

## Languages, frameworks, and developer tools

| Area | Current technology | Role or planned direction |
|---|---|---|
| Desktop application | Electron 41 | Local desktop host with isolated main and renderer processes |
| Application logic | JavaScript / Node.js, CommonJS | Scanning, revision history, sync, security, local workflow orchestration |
| User interface | HTML and CSS | Desktop interface; no React, Vue, or other UI framework is currently used |
| XML parsing | `fast-xml-parser` 5.12 | Read-only, validated parsing of supported FCPXML exports |
| Proof tooling | Python 3 standard library | Resolve XML/API mapping proof and tests |
| Interchange and artifacts | FCPXML 1.10 and JSON | Editor exports, scan manifests, API snapshots, revision and review artifacts |
| Testing | `node --test` and Python `unittest` | Unit, integration, fixture, safety, and proof coverage |
| Security primitives | Electron `safeStorage`, Node `crypto` | Protected local credentials, hashing, authenticated encryption, and audit-chain primitives |
| Source control and delivery | Git, GitHub, npm | Version history, publishing, dependencies, and scripts |
| Cloud infrastructure | Not selected | Deployment region, hosted database/object store, transport, key management, monitoring, and disaster recovery remain explicit product decisions |

The visual interface uses bundled Anton and IBM Plex font packages. The project does not currently rely on a database ORM, cloud provider SDK, TypeScript, or frontend component framework.

## Project metrics

### Verified engineering metrics

| Metric | Current value | Interpretation |
|---|---:|---|
| Roadmap tasks complete | 88 / 188 (46.8%) | All checked items in `ROADMAP.md`; includes research proofs, foundations, and shipped prototype capabilities |
| JavaScript tests | 219 passing | Automated checks across desktop workflows, parsing, local history, review, security, and sync foundations |
| Python proof tests | 24 passing | Automated checks for Resolve XML/API proof tooling |
| Initial editor target | Resolve Free 21.1.2 + FCPXML 1.10 | Explicitly bounded compatibility target, not a general format guarantee |
| Deployed cloud services | 0 | Collaboration code is currently an executable local foundation rather than a hosted product |

### Product and productivity metrics to measure in pilots

No production telemetry has been collected, so Frameline does **not** claim measured time savings yet. Pilot measurement should establish a baseline for each team, then compare the same workflows with Frameline.

| Metric | Why it matters |
|---|---|
| Time from receiving a revision to completing a review decision | Measures review speed and friction |
| Time spent finding, validating, or relinking required media | Measures media-readiness efficiency |
| Number of manual project-copy and folder-comparison steps avoided | Measures replacement of repetitive operational work |
| Successful verified review copies and restore points | Measures safety and recovery confidence |
| Conflicts resolved without modifying the original project | Measures protection of local work |
| Sync retry, reconciliation, and duplicate-revision rates | Measures collaboration reliability |
| Unsupported-input, validation, and recovery outcomes | Guides compatibility investment and prevents false confidence |

Use the following calculation only after collecting real baseline and pilot data:

```text
Weekly time saved (hours) =
  review cycles per week × (baseline minutes per cycle − Frameline minutes per cycle) / 60
```

For illustration only: 10 review cycles per week with an observed 15-minute reduction per cycle would equal **2.5 hours saved per week**. That is a measurement model, not a current product claim.

### Initial planning estimates for a finished product

These are proposed targets for a small-team pilot after Frameline supports a proven editor write path and hosted collaboration. They are planning estimates, not current measurements or guarantees.

| Area | Initial target | Assumption or definition |
|---|---:|---|
| Time saved | 15–30 minutes per review cycle | Compared with a team's documented manual baseline for a typical revision review, media check, and safe handoff |
| Team time saved | 2.5–5 hours per week | 10 review cycles per week, each shortened by 15–30 minutes |
| Review speed | ≤15 minutes median for a routine revision | Excludes complex editorial conflicts and unsupported editor constructs |
| Safe-pull reliability | ≥99.5% completed without rollback | Applies only to inputs inside the declared compatibility boundary |
| Data-loss incidents | 0 | A non-negotiable target; any incident requires investigation and release gating |
| Restore verification | 100% before in-place apply | A restore point must be created and verified before modifying a supported project |
| Media readiness | ≥85% of required assets verified automatically | Remaining assets must be shown as explicit confirmation-required or blocked cases |
| Sync success | ≥99% completed without manual intervention | Includes normal network retries; excludes intentional conflict reconciliation |
| Retry recovery | ≥95% of transient sync failures recover automatically | Measured after a connection returns, without duplicate remote revisions |
| Reconciliation rate | <5% of sync attempts | Divergent branches should remain uncommon and always preserve both histories |
| Performance | Scan a 1,000-clip supported export in ≤10 seconds | Measured on the published reference hardware and supported editor/version |
| Availability | ≥99.9% monthly hosted-service availability | Applicable only after a production service, monitoring, and incident process exist |
| Crash-free sessions | ≥99.5% | Excludes developer builds and explicitly unsupported environments |
| Pilot retention | ≥60% of invited editors active after 30 days | Active means completing at least one review, revision, or sync workflow |
| Accessibility | 100% of core workflows keyboard-operable | Core workflows: select, scan, review, resolve, create copy, restore, and sync |

Suggested evaluation window: run these targets against at least four weeks of pilot data, segment results by editor version and project-size range, and publish unsupported/ambiguous cases alongside the success rate.

## Success criteria

Frameline should be considered successful when it can demonstrate all of the following for each supported editor/version combination:

1. Editors can create and restore immutable project history without losing work.
2. Incoming changes can be reviewed with clear, frame-accurate context and explicit unresolved cases.
3. A pull either applies transactionally and validates in the target editor, or fails safely with a recoverable original.
4. Media requirements are visible and no asset is silently substituted or uploaded.
5. Concurrent work never overwrites a collaborator's remote head or a user's local project.
6. Security, privacy, accessibility, performance, and support behavior meet the published release boundary.
7. Pilot teams show a measurable reduction in manual review/recovery effort without increased project-risk incidents.

## Non-negotiable product principles

- Make the affected change visible before altering a project.
- Fail closed on ambiguous identity, unsupported constructs, stale inputs, or unsafe write conditions.
- Keep source paths, media locations, credentials, and unnecessary project details out of public UI and telemetry.
- Keep review-copy and in-place update workflows distinct.
- Treat media transfer as explicit, inspectable, and reversible.
- Expand to additional editors only after the first adapter is proven reliable.

For detailed evidence and task-level status, see `README.md`, `PRODUCT.md`, `SYSTEM_DESIGN.md`, `SERVICE_FOUNDATION.md`, `SECURITY_MODEL.md`, and `ROADMAP.md`.
