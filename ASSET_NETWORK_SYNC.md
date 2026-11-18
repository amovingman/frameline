# Self-hosted asset transfer

The optional media service adds authenticated, resumable HTTPS chunks to the [single-host launcher](SERVICE_HOST.md). It uses `src/durable-asset-service.js`, `src/asset-http-transport.js`, and `src/asset-http-client.js`. Revision-history sync remains metadata-only. Enabling this service does not upload desktop media automatically, bind assets to a revision, or enable editor apply.

## Enable storage

Add this optional object to the private host configuration:

```json
"assets": {
  "directory": "/srv/frameline/assets",
  "signingKey": "<base64 encoding of 32 independent random bytes>"
}
```

Use a cryptographically random signing key supplied through the same private provisioning process as the encryption key. The complete configuration remains mode `0600`. Asset storage must be separate from the identity/history directory: neither may contain the other, and neither may contain configuration or TLS files. The loader checks canonical paths as well as lexical paths. The asset store reuses the configured encryption keyring; the signing key has a separate purpose.

Stop the host, add the configuration, run `npm run service -- initialize --config /absolute/private-config.json`, then start `serve` normally. Initialization creates missing stores and validates existing ones without replacing valid state. Each store initializes separately; a later failure can leave the other initialized, and rerunning initialization validates it. Ordinary startup refuses a missing configured store. Omitting `assets` leaves media routes unavailable.

Keep the signing key stable across restarts if existing tickets should remain usable until expiry. Replacing it invalidates outstanding tickets; clients can request fresh ones. Changing the encryption key ID is not a rotation workflow: ordinary writes refuse an undeclared change. There is no asset key-rotation command yet. Retain the keys required to decrypt existing chunks.

## Transfer protocol

The API uses the existing API-version and request-ID headers. Every call requires a bearer session with current project access. Only owners and editors can upload or inspect partial uploads; viewers can read published assets. A content ID in another project grants no access.

| Method and project-relative path | Behavior |
| --- | --- |
| `POST assets/uploads` | Begin or resume an exact asset identity. |
| `GET assets/uploads/:uploadId` | Return acknowledged chunk indexes and publication status. |
| `POST assets/tickets` | Issue a short-lived GET or PUT chunk ticket. |
| `PUT assets/uploads/:uploadId/chunks/:index` | Accept a signed, checksum-verified binary chunk. |
| `POST assets/uploads/:uploadId/complete` | Start or poll whole-content verification. |
| `DELETE assets/uploads/:uploadId/complete` | Cancel active verification without deleting uploaded chunks. |
| `GET assets/:assetId` | Read published identity and chunk geometry. |
| `GET assets/:assetId/chunks/:index` | Read a signed, verified binary chunk. |

The prefix is `/projects/:projectId/`; path segments are canonically percent-encoded. Upload identity requires all six fields: `version: 1`, `algorithm: "sha256"`, `contentId`, `size`, `assetClass`, and `mediaType`. Set `mediaType` to `null` when unknown. The host uses 1 MiB chunks, with one empty chunk for an empty asset. Each chunk carries a SHA-256 checksum, and publication requires a fresh streaming verification of the complete size and SHA-256. Receiving every chunk does not publish an asset.

Chunks may arrive out of order. Begin, chunk retries, and completion retries reuse durable state. Beginning the same exact identity in the same project returns the same upload; a published asset is reused. Identical content in another project uses separate storage. Conflicting size, class, or media type for an existing project/content ID is refused rather than silently treating a proxy as an original. Cross-project/team deduplication remains a separate privacy-policy decision.

Ticket issuance checks the authorized object and chunk index. A ticket contains a signed relative path and expires after five minutes. Its HMAC binds the HTTP method, project, resource, index, and expiry. The client builds the URL only under its configured HTTPS origin. Redemption still requires a current bearer session and project permission; a copied ticket cannot bypass membership removal. Browser Origin requests are refused, redirects do not receive credentials, and responses are not cached. Do not log or publish signed paths.

## Completion, cancellation, and refresh

Completion returns `202` while a bounded background verification runs, then a verified `200` receipt after publication. Polls check current permissions without waiting behind the asset store's verification lock. The client polls automatically, with a default 30-minute verification deadline configurable up to 24 hours; each individual request retains its own timeout. Verification is independent of the initiating response closing.

Authenticated polls can renew the verification credential only for the same actor identified by the authorization service. A different writer cannot replace that credential. The store rechecks the current credential and permissions before publication, so session refresh does not bypass revocation. Tokens remain in process memory and are not written into asset state or receipts.

An aborted client poll stops that caller's wait. Use `cancelVerification` explicitly to stop shared server verification. Stop polling before cancelling: another client that continues to POST can start verification again. Cancellation cannot undo publication that won the race. A client timeout or lost response also does not prove the server failed to publish; retry the same upload and inspect its result.

Host shutdown aborts verification and drains it before closing storage. Uploaded chunks remain resumable. Verification jobs are process-local; after a restart an uncompleted verification starts again from the retained chunks. The final verified receipt is durable. Whole-content verification currently holds the local asset lock, so other asset-store operations may wait behind it; completion polls and cancellation use the independent job map. Distributed workers and parallel verification remain open.

## Storage and operational limits

The encrypted index and chunks use AES-256-GCM. Chunk plaintext is bound to project, upload, index, and checksum, and every returned chunk is decrypted and checked again. Storage directories are private and regular files are mode `0600`; bounded reads refuse symlinks and malformed state. Chunk acknowledgment follows flushed chunk publication and flushed index publication. A failure after a rename attempt latches an uncertain writer until validated reopen. No automatic rollback or deletion is performed.

The service permits at most eight active HTTP asset requests and eight active verification jobs, with at most 128 settled verification results cached in memory. Requests are limited to 64 KiB JSON or 1 MiB binary; JSON responses are limited to 1 MiB. Validation caps an asset at 64 GiB / 65,536 chunks, with separate limits of 10,000 uploads and 10,000 asset records, one million chunk references, and a 32 MiB plaintext index ceiling. These are bounds, not measured capacity or throughput guarantees. Disk quotas, abandoned-upload cleanup, bandwidth policy, billing, and production storage monitoring remain open.

For a consistent backup, stop the host and all local writers and preserve both stores, all encrypted chunk files, and required private key configuration. Restoring only the asset index or only identity/history is not a complete service restore. Older identity state can restore revoked access. Off-device backup, trusted rollback protection, and disaster recovery in the intended environment remain unverified.

Desktop upload/download controls, durable asset-class policies, canonical revision/media bindings, revision-selected download plans, editor relinking, reference-aware deletion, and production deployment remain roadmap work. This API does not infer any of those from a successful transfer.

## Validation

The [disposable process observation](phase-0/asset-network-sync-live-observation.json), reproduced with `node scripts/asset-network-proof.js`, recorded 52 actual HTTPS requests across three complete launcher processes, three accounts, and two projects. It uploaded a 2 MiB + 17 byte synthetic asset out of order, retained a chunk and signed capability across graceful restart, resumed the same upload, and published only after full-content verification. A viewer downloaded the exact bytes; duplicate begin/completion calls reused the stored asset. Wrong checksums, oversized chunks, altered tickets, wrong methods, outsiders, and cross-project access were refused. After membership removal and another restart, the viewer's still-unexpired ticket was denied while the owner could still download the content. Private file permissions, absent plaintext markers, process logs, terminal-before-restart behavior, and final cleanup were checked.

Separate real-filesystem tests cover corruption, awaited and repeated authorization, cancellation during streaming verification, cooperative writers, write ordering before acknowledgment, pre-publication failures, uncertain replacement and reopen, malformed encryption output, and undeclared key changes. Transport/client tests cover true expiry by advancing the verifier clock, header/body/response bounds, request binding, nonblocking verification polling, explicit cancellation, bounded job caches, same-actor token renewal, revoked and different actors, and queued-request disconnects that previously could stall shutdown. Simulated slow-job tests verify lifecycle behavior; they are not large-media throughput measurements.

The integrated suite passed all 603 tests with no failures or skips. Packaging validation passed. The process fixture used public test-only TLS material trusted only inside isolated clients; it did not configure a public deployment, native desktop media controls, production key custody, a mid-write process crash, or machine power-loss recovery.
