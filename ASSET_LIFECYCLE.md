# Self-hosted asset lifecycle controls

This batch adds five features to the encrypted asset service and its owner-facing HTTPS API/CLI:

1. **Durable asset holds.** A current project owner can place a manual, contractual, or investigation hold on a published content ID, optionally with an expiration. Holds are project-scoped and versioned.
2. **Reviewed hold release.** Releasing a hold requires its current version. A retained tombstone prevents an old request from reinstating it. Exact request retries return their historical receipt without replacing later state.
3. **Retention settings.** Owners configure a minimum archive age from zero through 3,650 days. The default is 30 days. Archive timestamps survive restart; restoring and rearchiving starts a new waiting period. Transfer-class policy is independent.
4. **Owner lifecycle reports.** Bounded, ordered pages show published media IDs/classes/sizes, archive age, holds, shared-content status, and cleanup blockers. Other project IDs and storage locations are omitted.
5. **Reviewed cleanup plans.** A plan binds selected asset IDs to the reviewed report's state hash and freshly recomputes blockers and candidate bytes. It detects changed holds, settings, archive state, asset membership, and shared-content status. Plans always report `ready: false` and `deletionPerformed: false` while canonical revision references remain unverified.

These features run on a self-hosted service with its existing account/owner authorization. They do not add desktop lifecycle controls, automatic deletion, media transfers, or project/editor changes. The older `asset-lifecycle-policy.js` is a standalone reference planner; production API operations use `service-asset-lifecycle.js` inside the durable asset transaction.

## API

All routes require HTTPS, the existing API version/request headers, and a current project owner's bearer session. All mutations and their exact-input receipts commit in the same encrypted asset-index generation. Current authorization is rechecked before acknowledgment, including on historical retries. Editors and viewers cannot read lifecycle reports or change lifecycle policy.

| Method | Route under `/projects/:projectId/assets` | Input |
|---|---|---|
| GET | `/:assetId/hold` | No body |
| PUT | `/:assetId/hold` | `{expectedVersion, held, reason, until, idempotencyKey}` |
| GET | `/retention` | No body |
| PUT | `/retention` | `{expectedVersion, minimumArchiveAgeMs, idempotencyKey}` |
| POST | `/lifecycle/report` | `{afterAssetId, limit}` |
| POST | `/lifecycle/plan` | `{assetIds, expectedStateHash}` |

`assetId` is a lowercase `sha256:` content ID. `expectedVersion` is zero for a new hold or retention setting. To release a hold, set `held: false`, `reason: null`, and `until: null`; use the currently observed hold version. New holds require one of `manual`, `contractual`, or `investigation`; `until` is null or a future epoch-millisecond timestamp.

Save each mutation's exact input and idempotency key until its acknowledgment is known. Keys are account/project scoped. Reuse with different input returns `asset-lifecycle-idempotency-conflict`; a new key with a stale expected version returns `asset-lifecycle-version-conflict`. Replaying an old successful hold after a later release returns the old receipt but leaves the hold released. Read current state explicitly when needed. Receipt capacity is bounded; the service refuses new mutations rather than dropping retry evidence.

Report pages accept a null `afterAssetId` for the first page and a limit of 1–100. Use the returned `nextAssetId` for the next page. Pages are fresh reads, not a retained database snapshot. Their `stateHash` lets an owner detect intervening changes. Reports omit partial uploads and list at most the service's 10,000 published assets per project. Plans accept 1–100 unique IDs plus the reviewed `stateHash`. Passage of time is recomputed when planning; an expired hold or completed waiting period may change candidate status without changing stored state. `generatedAt` records the observation time.

Blockers distinguish `not-archived`, `retention-period`, `active-hold`, `shared-project`, and `revision-references-unverified`. `cleanupCandidate` means only that the archive/age/hold/shared checks passed. It never means that deletion is safe. Every plan retains the unverified-reference blocker. No deletion execution endpoint exists.

## CLI

`npm run service:asset-lifecycle --silent` reads one JSON request from standard input and writes a JSON result to standard output. Credentials are not accepted as command arguments. Keep input and report files private; for example, create them under `umask 077` and pass the input using shell redirection.

Every request includes `origin` (HTTPS service origin), `accessToken` (an existing account session), `projectId`, and `action`. The five actions are `hold-set`, `hold-release`, `retention-set`, `report`, and `plan`. `hold-get` and `retention-get` read current state. Hold operations also require `assetId`.

For a hold, `input` contains `expectedVersion`, `reason`, `until`, and `idempotencyKey`; the CLI supplies `held: true`. For a release, `input` contains only `expectedVersion` and `idempotencyKey`; it supplies the release fields. Other action inputs match the API table. Read actions take no `input` field. Unknown fields and oversized or invalid requests are rejected before contacting the service. Errors contain allowlisted codes, never private exception messages or credentials.

An illustrative report request (replace the origin and token):

```json
{
  "origin": "https://your-service.example",
  "accessToken": "REPLACE_WITH_AN_EXISTING_43_CHARACTER_SESSION",
  "projectId": "film-001",
  "action": "report",
  "input": { "afterAssetId": null, "limit": 100 }
}
```

The CLI deliberately does not sign in or persist tokens. Use the service's existing account/session workflow to obtain the owner's credential. The JavaScript asset client exposes the same operations as `getHold`, `setHold`, `getRetentionPolicy`, `setRetentionPolicy`, `getLifecycleReport`, and `planCleanup`.

## Storage, migration, and recovery

Encrypted asset-index **schema 3** adds holds, hold-release tombstones, retention policies, exact-request receipts, and archive timestamps. The outer encrypted envelope stays at version 1. Combined collaboration schema 7 is unchanged. Existing private file/directory modes, cooperative locks, write-ahead byte checks, atomic index replacement, file/directory flushes, and uncertain-publication refusal remain in use.

Valid schema-1 and schema-2 indexes migrate atomically without changing upload IDs, chunk bytes, identities, publication receipts, or existing transfer policy. Schema-1 assets begin unarchived and transfer classes remain disabled. An asset already archived in schema 2 has no provable archive time, so migration starts its waiting period at the migration time. Existing unarchived media receives no archive timestamp. Newer schemas and inconsistent lifecycle records fail closed; an interrupted or uncertain publication can be inspected by a fresh runtime. Migration creates no new asset-byte files and does not collect old files.

## Validation and remaining work

Unit/integration coverage exercises restart, exact retries after later changes, stale versions, permission loss, owner identity changes during commit, expiry, rearchive clocks, shared content, paging, corrupt lifecycle records, uncertain writes, and schema migration. API/client tests reject malformed scope, false deletion readiness, browser origins, wrong methods, query ambiguity, and unknown fields. CLI tests cover all five actions, input bounds, and private-error redaction.

The [disposable HTTPS process proof](phase-0/asset-lifecycle-https-observation.json) runs the actual standalone service, authenticated clients, and three host processes with certificate verification. It preserves holds and retention across host restart, verifies historical replay after release, denies viewer reads, rejects stale plans, and confirms that planning preserves media. No external service or studio media is used.

The completed batch passed all 1,320 full-suite tests without skips, including 21 new lifecycle tests, and packaging validation. Its disposable three-host HTTPS run made 96 authenticated requests.

Canonical revision-to-media bindings, authoritative retained-reference checks, transactional garbage collection, partial-upload/orphan cleanup, retention of lifecycle receipts, owner review in the desktop UI, physical cross-device testing, and production operations remain open. The broader advanced-lifecycle roadmap item remains unchecked.
