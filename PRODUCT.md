# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron hosts a local HTML/CSS/JavaScript interface on desktop. The interface supports pointer and keyboard input. Editor-backed validation targets macOS; the fixture demo runs without an editor.

## Users

Frameline is a résumé portfolio project. The owner uses it to demonstrate desktop engineering, revision models, and careful integration with an external editor. A reviewer should be able to understand the problem, run the fixture demo, and inspect the code without a Resolve installation or cloud account. See [the project scope](PROJECT_SCOPE.md).

## Product Purpose

Save video-editing decisions as revisions, compare changes, review conflicts, and preserve a way back before changing a project. The prototype demonstrates that workflow through local history, a bounded native Apply operation, and separate self-hosted collaboration experiments.

## Operating Context

The editor target is **DaVinci Resolve Free 21.1.2, build 21.1.20010, on macOS**. FCPXML 1.10 supplies a read-only picture and media inventory. Authenticated closed native checkpoints support a separate comparison and Name Apply workflow. Each path has its own evidence and limits; neither represents arbitrary project-file support. See [exact compatibility](PERSONAL_COMPATIBILITY.md).

Development uses small, disposable synthetic fixtures. The [demo](DEMO.md) exercises the real scanner, revision store, and comparison code locally. The [setup guide](SETUP.md) explains the desktop and deeper verification paths. Hosted deployment, public installers, and further editors are outside the required portfolio scope.

## Capabilities and Constraints

**Local history.** Read and rescan the first top-level picture sequence of an FCPXML file or bundle, report exact frame counts and media availability, and save immutable revisions on named branches. Parent comparison covers sequence metadata and media inventory. Backup import creates separate history rather than replacing existing work. FCPXML occurrence identity across exports, clip-level merge, and Apply remain unsupported.

**Change review.** Compare base, local, and incoming Resolve captures or authenticated native checkpoints. Show observed field changes, conflicts, coverage gaps, and source hashes; retain review choices against exact source bytes. Native checkpoint review also checks ancestry and persistent UUID/generation bindings. Opaque fields remain explicit. Review does not grant permission to execute every represented change. See [checkpoint review](NATIVE_CHECKPOINT_REVIEW.md) and [pull planning](NATIVE_PULL.md).

**Scoped edits and recovery.** Apply one reviewed existing video clip Name to a verified closed local Resolve project, or create a reviewed native copy in another configured local disk library. Verify the backup and unrelated stored fields, validate the result in Resolve, and retain restoration and interruption state. Result audits preserve the decisions behind both Apply and restoration. General timeline edits and lossless SDK Save remain unproven. See [Safe Apply](SAFE_APPLY.md), [native review copies](NATIVE_REVIEW_COPY.md), and [result audits](NATIVE_RESULT_AUDIT.md).

**Media.** Audit local original/proxy references, stream content checks, and inspect moved-file candidates. A bounded proxy-safe FCPXML workflow patches only reviewed source attributes into a new copy; its optional Resolve import creates a derived representation. It does not establish lossless in-place native relinking. Background scans and media checks provide cancellation and explicit recovery. See [media relinking](MEDIA_RELINK.md) and [crash recovery](CRASH_RECOVERY.md).

**Service experiments.** The optional self-hosted HTTPS service includes account sessions, project roles, encrypted records, immutable history, compare-and-swap branch updates, and idempotent requests. Desktop controls provide sign-in, reviewed metadata push/fetch, comments, branch approvals, and explicit resumable media transfers with content verification. These workflows have disposable local HTTPS and desktop evidence. No managed cloud service is deployed, and service-derived review does not authorize native Apply. See [service setup](SERVICE_HOST.md), [desktop history sync](DESKTOP_SERVICE_SYNC.md), and [media transfers](DESKTOP_MEDIA_TRANSFERS.md).

## Evidence on Hand

[The README](README.md) introduces the working paths and engineering choices. [The roadmap](ROADMAP.md) preserves the completed scoped implementation record; former public-release and expansion requirements are future ideas. [System design](SYSTEM_DESIGN.md) documents the architecture and its original goals. The current application lives in `src/`.

Public fixtures and automated tests let a reviewer exercise local behavior. Some historical native audits need owner-retained private payloads and an installed Resolve build; running the public demo does not repeat those live editor checks. The operation-specific guides distinguish synthetic desktop checks from actual editor observations.

## Product Principles

- Make the affected edit visible before changing a project file.
- Bind review to the source bytes that will be used.
- Preserve local work and make recovery explicit.
- Keep review copies and in-place edits separate.
- Label sample data, unknown values, and unsupported operations clearly.
- Keep the portfolio walkthrough useful without accounts or paid infrastructure.
