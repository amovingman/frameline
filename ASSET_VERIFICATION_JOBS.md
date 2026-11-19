# Self-hosted stored-media verification jobs

This batch adds ten capabilities for checking already-published service media. Jobs never upload, copy, relink, render, or delete media and never change an editor project. They provide recorded integrity evidence for the service's encrypted chunks, not canonical revision-to-media bindings or proof of camera-original identity.

## Ten delivered features

1. [x] Explicitly submit a durable verification job for an existing, published, currently transferable content ID.
2. [x] Deduplicate active exact inputs per actor/project and preserve scoped request receipts through lost acknowledgments and restart.
3. [x] Read project-scoped job status and ordered pages of up to 100 jobs, with private worker tokens withheld.
4. [x] Cancel queued/running jobs as the submitter or current owner, with a logical-run guard and exact retry receipts.
5. [x] Explicitly retry failed/cancelled work under a new logical run, preserving a maximum of three worker attempts per job.
6. [x] Claim bounded worker leases under the cooperative local storage lock, preventing two workers from owning one live attempt.
7. [x] Persist monotonic byte progress and renew leases; each chunk read rechecks current lease, membership, class policy, and archive state.
8. [x] Recover expired/interrupted leases without accepting stale worker results; orderly shutdown requeues unfinished work when its attempt budget permits.
9. [x] Rehash the complete published content in the standalone host's background worker and persist a successful result only after exact size/SHA-256 validation.
10. [x] Expose backlog/status counts, attempts, verified bytes, processing time, and a credential-private stdin CLI for submission, status, paging, cancellation, retry, and metrics.

These are service workflow features under the broader background-job roadmap items. Desktop job controls, thumbnails, proxies, timeline rendering, multi-host scheduling, production quotas, cost/billing telemetry, and garbage collection remain separate work.

## API and authorization

All routes use the existing HTTPS asset API, bearer session, API-version header, request-ID binding, body/response limits, and browser-origin refusal. No worker claim, lease, heartbeat, or completion route is exposed.

| Method | Route under `/projects/:projectId/assets` | Input |
|---|---|---|
| POST | `/jobs` | `{assetId, idempotencyKey}` |
| POST | `/jobs/list` | `{afterJobId, limit}` |
| GET | `/jobs/:jobId` | No body |
| POST | `/jobs/:jobId/cancel` | `{expectedRun, idempotencyKey}` |
| POST | `/jobs/:jobId/retry` | `{expectedRun, idempotencyKey}` |
| GET | `/jobs/metrics` | No body |

Current owners/editors can submit jobs. All current project members can read scoped status, pages, results, and metrics. Cancellation/retry additionally requires the original submitter or a current project owner, and the caller must retain write access. A viewer cannot submit or mutate work. Cross-project job IDs reveal no job data. Other editors cannot cancel a collaborator's job. Authorization and the authenticated actor are rechecked before acknowledgment; owner authority is rechecked for cross-author mutations.

Only published media can be submitted. A disabled transfer class or archived asset rejects a new verification request. A prior exact submission receipt can still return that job's metadata without requeuing work. Hold/retention policy does not substitute for byte-read permission. Worker access is an in-process capability tied to the original submitter's current active account/project membership; job state stores no bearer or refresh tokens. Session expiration does not invalidate accepted background work by itself, while membership removal, account deactivation, class exclusion, and archive state still gate reads.

## Deduplication, logical runs, and retries

Save the exact request and key until its acknowledgment is known. Request keys are actor/project scoped across submit/cancel/retry operations. Reusing a key with changed input returns `asset-job-idempotency-conflict`. Replaying a known key returns the same job's **current** metadata and does not repeat the mutation.

Different keys for the same actor/project/content while a verification is queued or running reuse one job. A new key after that job finishes creates an explicit new integrity check. Another actor's job is not borrowed. The service retains bounded request receipts rather than silently discarding retry evidence.

Each job starts at logical `run: 1`. Explicit retry increments that run. Cancellation/retry requires the run the caller reviewed; a delayed new request for an old run is rejected. An exact old cancel receipt cannot cancel a later retry. Claims increment the separate `attempts` count, including automatic recovery after an expired lease. A job receives at most three worker attempts. After exhaustion, a new submitted check is a new job and should be an explicit operator decision.

Cancellation atomically retires the lease. A worker already reading a chunk may finish that read, but its next lease check, progress update, or completion is fenced. Cancelled work cannot publish success. Retry revalidates publication and current transfer policy and rereads content from zero; partial hash state is never resumed.

## Worker and recovery

The standalone service starts one verification worker when asset storage is configured. It checks the queue at startup and roughly every second thereafter, processing one job per tick. No media is read until someone explicitly submits a job. Worker leases default to 30 seconds, with a private domain supporting bounded 1–300-second leases for tests/controlled workers. Idle timers do not keep a process alive.

The worker reads/decrypts existing chunks and checks their stored checksums. It computes a new SHA-256 digest across the complete ordered content, checks the final byte count/hash, and only then records `verified: true`, the digest, size, and check time. Metadata validation and chunk reads occur under short asset transactions; hashing occurs outside the queue lock so cancellations and unrelated jobs can proceed. Progress renewals are throttled to roughly one second, while every chunk still checks its lease and permissions. A slow filesystem operation can delay cooperative shutdown/cancellation; this is not preemptive I/O cancellation.

Expired leases are reclaimed on the next queue claim. The new attempt receives a fresh private token; late results from the retired token are rejected. Graceful host shutdown stops admission, lets a current chunk operation finish, and requeues unfinished work when possible before storage closes. Abrupt process loss leaves a lease that must expire; a restarted worker then rereads the file from the beginning. Clock correctness, a local filesystem, and the cooperative locking contract remain prerequisites. These leases are not a distributed-database scheduler.

Failed checks use bounded error codes for access denial, exclusion, archive, corrupt chunks, content mismatch, or worker failure. They do not change the original asset's publication or remove its bytes. A successful result describes the completed check time, not continuous monitoring or future availability.

## Status, metrics, and CLI

Job states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Public status includes content ID/class/size, project and submitter IDs, run/attempt counts, timestamps, persisted byte progress, processing duration, lease expiration, result, and safe error code. Private lease tokens and request hashes are omitted. Status and metrics reads do not themselves claim or recover jobs; a running record can remain visible until an expired lease is processed by a worker.

`verifiedBytes` sums successful verification work, including separate explicit checks of the same content. It is not unique storage usage or billable transfer. Processing duration accumulates completed/interrupted attempt wall time; expired attempts stop contributing at their last lease deadline, so downtime awaiting recovery is excluded. An active attempt contributes when it closes. Counters are project-scoped and integer-bounded. No storage-price or production cost estimate is invented.

`npm run service:asset-jobs --silent` accepts one private JSON request on stdin and prints a JSON result. Credentials are refused as command arguments. Keep request/result files private, for example under `umask 077`. Common fields are `origin` (HTTPS origin), `accessToken` (existing session), `projectId`, and `action`. Actions are `submit`, `get`, `list`, `cancel`, `retry`, and `metrics`. Use `jobId` for get/cancel/retry and `input` matching the API table for submit/list/cancel/retry. Get/metrics omit `input`. The CLI validates shape, identifiers, HTTPS origin, and size before service access and prints only allowlisted error codes.

## Storage and validation

Encrypted asset-index **schema 4** adds job records and request receipts in the same atomic generation as asset metadata. Older schema-1/2/3 indexes migrate without changing acknowledged uploads, media bytes, lifecycle holds/releases, retention policies, archive timestamps already present, or their receipts. Existing conservative migration of unknown schema-2 archive times remains unchanged. Combined collaboration schema 7 and the outer encryption envelope are unchanged.

Limits are 10,000 jobs, 20,000 job request receipts, and the existing bounded asset index. Capacity exhaustion refuses new mutations; it does not drop old records. Jobs and receipts currently need operator backup/retention planning; automatic pruning is not implemented. Newer schemas, invalid cross-record references, broad private file modes, corrupted state, and uncertain index publication retain the existing fail-closed behavior.

Automated tests cover deduplication, current-author/owner permissions, run guards, private token exclusion, lease expiry/reclaim, monotonic renewal, cancellation during reads, concurrent claimants, attempt exhaustion, restart, corrupt chunks, full-file mismatch, policy/access loss, migration, uncertain publication, API response substitution, absent worker routes, and CLI privacy.

The [three-host HTTPS proof](phase-0/asset-verification-jobs-https-observation.json) uses the actual standalone launcher, real account sessions, certificate-verified clients, and disposable encrypted media. A verification submission survives a host restart, completes with the expected full-file digest, and returns the same job on exact retry. It also checks viewer read/mutation boundaries, post-revocation denial, and metrics. Existing lifecycle/read proofs continue to run in the same fixture. This does not claim a mid-write process kill, physical cross-device use, production load, editor rendering, or a public deployment.

The completed batch passed all 1,361 full-suite tests without skips, including 26 new verification-job tests, and packaging validation. Final authorization-window tests verify that a lease expiring during awaited authorization cannot acknowledge a chunk read, persist a renewal, or publish success.
