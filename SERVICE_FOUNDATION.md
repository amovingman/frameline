# Project service foundation

This repository now contains a local, dependency-free domain prototype for the first project-service contracts. It is not a deployed service or cloud storage adapter. The authorization and transport layers are described below.

## Contracts

`src/project-api-contracts.js` defines the initial versioned resource surface for users, teams, projects, members, branches, revisions, manifests, pull plans, and activity. Every response envelope carries the API version and request ID. Mutating requests can carry an idempotency key. List cursors are signed and bounded rather than exposing database offsets directly.

## Immutable history

`src/cloud-history-store.js` is an executable domain store for content-addressed manifests, immutable revisions, and project branch heads. A manifest ID is its canonical SHA-256 digest. Schema 3 stores each manifest under a project-scoped key, so identical bytes can exist independently in multiple projects while public IDs remain unchanged. Reads and revision bindings still require the requested project. Revision creation never changes a prior record. Branch movement requires the caller's expected head and a revision whose parent is that head, so concurrent updates fail with `branch-head-changed` rather than replacing work.

Idempotency records bind a key to the exact operation and input. Retrying the same request returns the first result; reusing the key for different input is rejected.

## Maintenance

`src/service-maintenance.js` provides versioned state migration, hash-verified backup and restore, a restore drill, and a non-destructive retention report. Legacy history schemas 1 and 2 are validated before migration to schema 3, preserving revisions, heads, and existing idempotency records. Backup restore accepts validated legacy state. Retention report schema 2 lists explicit `{projectId, manifestId}` pairs for retained and eligible unreferenced manifests, avoiding ambiguity when projects share a canonical content ID. It deliberately performs no deletion.

A [combined encrypted local runtime](DURABLE_COLLABORATION_SERVICE.md) now persists private identity, access, and history state together, with serialized operations, cooperative local locking, and acknowledgment after flushed file/directory replacement. Its disposable process-restart proof and injected-failure checks passed. The earlier network proof used in-memory server state; the newer proof reopens the same encrypted store across owned server processes.

## Remaining deployment gates

The [standalone HTTPS host](SERVICE_HOST.md) now provides explicit initialization, strict private configuration, bounded network admission, graceful shutdown, and local stdin-based account/project provisioning. A disposable two-process HTTPS proof preserved acknowledged revisions, sessions, roles, and idempotent retries. It is runnable single-host tooling; no provider or processing region is selected and no external service is deployed.

Before this becomes a hosted service, Frameline still needs deployment/data-processing region decisions, production database and object-storage adapters, hosted identity and database enforcement for the proven authentication/authorization rules, managed transport and encryption keys, operational monitoring, and tested disaster recovery in the chosen environment.

## Identity, authorization, and sync

The executable foundation now includes rotating access/refresh sessions, recovery and revocation, teams and expiring invitations, owner/editor/viewer permissions, a mandatory authorization wrapper, a main-process `safeStorage` credential vault, authenticated stored-record encryption, rate limits, audit events, and account deletion safeguards. `SECURITY_MODEL.md` records the trust boundaries and remaining hosted controls.

`src/revision-sync.js` validates local revision transfer bundles before idempotently adding their manifests and revisions to the remote domain store. Branch heads advance by compare-and-swap. A durable local queue deduplicates exact push inputs, pauses while offline, and retries transient failures with bounded backoff. Branch races preserve the concurrent remote head and require fetch/reconciliation. Fetch returns branch history and manifests only, and its content-addressed local cache verifies metadata before offline browsing or pull planning. An injected authorized HTTP boundary and asynchronous client/sync/queue path passed a disposable two-account loopback exchange; see `REVISION_NETWORK_SYNC.md` for validation scope and deployment gaps. The later `DESKTOP_SERVICE_SYNC.md` integration passed browser/native HTTPS sign-in, explicit metadata operations, and full desktop restart recovery against a disposable service. Hosted deployment remains open.

The queue now records revision-level upload progress and exposes explicit retry and cancel operations. The desktop History view reports queued, retry-wait, and blocked states with path-free recovery guidance. It reports "Local only" until an existing service account is connected; adding that desktop connection does not deploy a service.

Project owners can now create expiring editor or viewer invitations for a specific project. Pending-invitation listings omit acceptance tokens, acceptance grants both team membership and the intended project role, and duplicate active invitations are rejected. The desktop access panel records invitations locally and states that email delivery is not configured.
