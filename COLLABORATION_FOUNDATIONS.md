# Collaboration and media identity foundations

The service code in this repository runs in process. It has no hosted route, cross-device event delivery, or persistent deployment. The following APIs establish safe behavior for the next five roadmap items without representing them as shipped cloud features.

## Read-only sharing

`createProjectShareLinks` issues a random 256-bit bearer token for one immutable revision, with a caller-chosen expiration bounded by policy. Only a project owner can create, list, revoke, or copy a link. The stored record and listings contain a token digest, not the token. `read` returns only that revision and its manifest; it rechecks expiration, revocation, and project deletion. URLs require HTTPS and put the token in a fragment so a future web client can redeem it without sending it in the initial page request. `copy` writes through a trusted clipboard callback and revokes the link if copying fails. A hosted redemption endpoint, deployed web viewer, and desktop copy control remain open.

## Notifications and activity

`createProjectActivity` records append-only, hash-linked project events and recipient-scoped notification receipts. Authorized project members can list activity and their own inbox, and mark their own items read. Its event types cover revisions, branch changes, completed pulls, and membership lifecycle. The authorized history service now records revision and branch events when an activity store is provided. The access-control constructor accepts `onProjectEvent` to record invitation, join, role, removal, ownership, and deletion events. A future pull service must emit `pull.completed` after validated success. No email, push, polling transport, or desktop notification is configured.

The activity store is serializable and validates its hash chain on recovery. The caller owns durable storage and must persist `snapshot()` atomically. Events contain IDs and type codes only, avoiding file paths, invitation tokens, and media names. Removed members immediately lose access to project history and their project inbox; an external delivery system may send a generic permission-change notice without project details.

## Membership and deletion

Project ownership moves only to an existing project member who also belongs to its team. The previous owner becomes an editor. `setProjectRole` cannot silently create or remove owners. Owners can remove nonowner members; removal immediately revokes access. Project deletion is a tombstone: it disables authorization, invitation acceptance, and share-link redemption, while retaining immutable history for a future retention and recovery policy. It does not erase stored revisions or media. Account-deletion planning ignores tombstoned projects; team ownership still needs transfer.

## Media asset identity

`identifyMediaFile` reuses the safe streaming SHA-256 fingerprint, checks file stability, and returns a path-free identity with byte count and explicit asset class and media type. Matching content IDs mean matching observed bytes, while `assetClass` preserves original/proxy distinctions. Storage namespace, cross-project deduplication, resumable transfer, and expected-identity provenance remain open.
