# Collaboration and media identity foundations

The service foundations run locally. The [standalone host](SERVICE_HOST.md), [encrypted collaboration runtime](DURABLE_COLLABORATION_SERVICE.md), and [desktop service connection](DESKTOP_SERVICE_SYNC.md) now build on the authorized HTTP boundary and asynchronous metadata client. Hosted deployment and managed delivery remain open. See [revision network sync](REVISION_NETWORK_SYNC.md) for transport scope and validation status.

## Read-only sharing

`createProjectShareLinks` issues a random 256-bit bearer token for one immutable revision, with a caller-chosen expiration bounded by policy. Only a project owner can create, list, revoke, or copy a link. The stored record and listings contain a token digest, not the token. `read` returns only that revision and its manifest; it rechecks expiration, revocation, and project deletion. URLs require HTTPS and put the token in a fragment so a future web client can redeem it without sending it in the initial page request. `copy` writes through a trusted clipboard callback and revokes the link if copying fails. A hosted redemption endpoint, deployed web viewer, and desktop copy control remain open.

## Notifications and activity

`createProjectActivity` records append-only, hash-linked project events and recipient-scoped notification receipts. The combined runtime now commits revision/branch and membership events atomically with domain changes, suppresses no-op/idempotent replay duplicates, and persists explicit read receipts. Authorized project members can page activity and their own inbox over HTTPS; the desktop adds explicit refresh, mark-read, and an opt-in 30-second app-open watch. `pull.completed` has no validated producer. No email, operating-system notification, digest, or delivery while the app is closed is configured.

The combined runtime validates the activity hash chain, recipient receipts, and cross-state references on recovery. Schema-1 collaboration state upgrades to schema 2 with empty activity; it does not backfill or replay history. Standalone callers of `createProjectActivity` still own persistence of its snapshot. Public events contain safe IDs, type codes, and timestamps, omitting recipients, file paths, invitation tokens, and media names. Removed members immediately lose project feed/inbox access. See [project activity](PROJECT_ACTIVITY.md) for cursor scope, capacities, desktop limits, and the passed HTTPS restart proof; all 690 tests, packaging validation, and [browser/native checks](phase-0/project-activity-desktop-observation.json) passed within the documented loopback and app-open limits.

## Membership and deletion

Project ownership moves only to an existing project member who also belongs to its team. The previous owner becomes an editor. `setProjectRole` cannot silently create or remove owners. Owners can remove nonowner members; removal immediately revokes access. Project deletion is a tombstone: it disables authorization, invitation acceptance, and share-link redemption, while retaining immutable history for a future retention and recovery policy. It does not erase stored revisions or media. Account-deletion planning ignores tombstoned projects; team ownership still needs transfer.

## Media asset identity

`identifyMediaFile` reuses the safe streaming SHA-256 fingerprint, checks file stability, and returns a path-free identity with byte count and explicit asset class and media type. Matching content IDs mean matching observed bytes, while `assetClass` preserves original/proxy distinctions. Storage namespace, cross-project deduplication, resumable transfer, and expected-identity provenance remain open.
