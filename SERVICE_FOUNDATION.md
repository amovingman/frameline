# Project service foundation

This repository now contains a local, dependency-free domain prototype for the first project-service contracts. It is not a deployed service and does not add accounts, authorization, networking, or cloud storage.

## Contracts

`src/project-api-contracts.js` defines the initial versioned resource surface for users, teams, projects, members, branches, revisions, manifests, pull plans, and activity. Every response envelope carries the API version and request ID. Mutating requests can carry an idempotency key. List cursors are signed and bounded rather than exposing database offsets directly.

## Immutable history

`src/cloud-history-store.js` is an executable domain store for content-addressed manifests, immutable revisions, and project branch heads. A manifest ID is its canonical SHA-256 digest. Revision creation never changes a prior record. Branch movement requires the caller's expected head and a revision whose parent is that head, so concurrent updates fail with `branch-head-changed` rather than replacing work.

Idempotency records bind a key to the exact operation and input. Retrying the same request returns the first result; reusing the key for different input is rejected.

## Maintenance

`src/service-maintenance.js` provides versioned state migration, hash-verified backup and restore, a restore drill, and a non-destructive retention report. The report separates manifests retained by revisions from unreferenced manifests eligible for a future policy. It deliberately performs no deletion.

## Remaining deployment gates

Before this becomes a network service, Frameline still needs deployment/data-processing region decisions, durable database and object-storage adapters, hosted identity and database enforcement for the proven authentication/authorization rules, managed transport and encryption keys, operational monitoring, and tested disaster recovery in the chosen environment.

## Identity, authorization, and sync

The executable foundation now includes rotating access/refresh sessions, recovery and revocation, teams and expiring invitations, owner/editor/viewer permissions, a mandatory authorization wrapper, a main-process `safeStorage` credential vault, authenticated stored-record encryption, rate limits, audit events, and account deletion safeguards. `SECURITY_MODEL.md` records the trust boundaries and remaining hosted controls.

`src/revision-sync.js` validates local revision transfer bundles before idempotently adding their manifests and revisions to the remote domain store. Branch heads advance by compare-and-swap. A durable local queue deduplicates exact push inputs, pauses while offline, and retries transient failures with bounded backoff. Branch races preserve the concurrent remote head and require fetch/reconciliation. Fetch returns branch history and manifests only, and its content-addressed local cache verifies metadata before offline browsing or pull planning. This is still an in-process proof; hosted network transport remains open.

The queue now records revision-level upload progress and exposes explicit retry and cancel operations. The desktop History view reports queued, retry-wait, and blocked states with path-free recovery guidance. It honestly reports "Local only" until a hosted service connection is configured; these controls do not imply a deployed transport.

Project owners can now create expiring editor or viewer invitations for a specific project. Pending-invitation listings omit acceptance tokens, acceptance grants both team membership and the intended project role, and duplicate active invitations are rejected. The desktop access panel records invitations locally and states that email delivery is not configured.
