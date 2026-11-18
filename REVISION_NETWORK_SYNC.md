# Revision metadata network sync

This milestone adds an injectable HTTP boundary and asynchronous client, sync service, and durable push processing for revision metadata. Disposable two-account loopback, local TLS, full-suite, and packaging checks have passed. It does not configure a service connection in the desktop app or deploy a service.

## Transport and authorization

`createRevisionHttpHandler` in `src/revision-http-transport.js` receives an authorized project service from its host. The host owns the listening server, TLS, request timeouts, header limits, service-state persistence, and shutdown. Creating a handler does not start a server or provision an account. `createRevisionHttpClient` in `src/revision-http-client.js` provides the asynchronous history operations used by the sync service.

Requests carry an API version and a bearer credential in the `Authorization` header. Credentials are not accepted in URLs or JSON bodies. Request IDs and idempotency keys use headers. The boundary returns versioned JSON envelopes with request IDs and bounded error codes; it does not expose stack traces or credentials. Browser `Origin` requests are rejected and no CORS access is enabled.

HTTPS is required by default. An explicit disposable-fixture option permits HTTP only for loopback connections. The server checks the actual socket address and encryption state, rather than trusting forwarded headers. The client accepts only a root service origin without embedded credentials, path, query, or fragment; HTTP fixtures require a numeric loopback address. Redirects are refused. Its default request timeout is 30 seconds, and streamed response bytes are bounded even when no content length is provided. It checks the API version and returned request ID before accepting a response.

The client obtains the current access token from a supplied callback for each request. It belongs in the main-process service layer; this milestone does not wire it into the desktop app, add a renderer token API, or provide a desktop sign-in/configuration flow.

The metadata routes cover content-addressed manifest writes/reads, immutable revision creation/read/source lookup, and branch reads/compare-and-swap updates. Request and response bodies are each capped at 8 MiB. This surface transfers revision metadata and manifests, without media bytes or arbitrary server file access.

Every operation goes through authentication and project-scoped authorization before history access. The history store also verifies that referenced manifests, parents, and revisions belong to the requested project. The authenticated user becomes a new revision's author; a body-supplied author cannot select another identity. Removing membership or deleting a project must prevent subsequent requests even if the client still holds a session.

## Asynchronous sync and offline work

`createAsyncRevisionSyncService` in `src/revision-sync-async.js` validates the same local revision bundles as the existing in-process proof. It awaits remote reads and writes, propagates cancellation, reports revision-level progress, and retains the metadata-only fetched cache. Remote history is bounded to at most 10,000 revisions, rejects cycles and project mismatches, and validates path-free manifests and content hashes before publishing fetched metadata to the cache.

An in-sync verdict checks the matched revision's exact manifest, message, and immediate parent's source identity. It does not recursively re-prove every ancestor's manifest. Fetch validates the complete captured ancestry before cache publication. Neither result establishes editor apply readiness.

The durable queue deduplicates exact push inputs, leaves work queued while offline, and retries transient network failures with bounded exponential delay. Its `processAsync()` entry point allows one processor at a time and removes an intent only after awaiting and validating an in-sync acknowledgment. Progress and completion reread the latest journal so enqueueing or canceling during an awaited request is preserved. The existing synchronous entry point rejects a Promise-returning push rather than treating it as completed.

Reconnecting retries immutable writes with stable, bounded idempotency keys. Revision-creation keys identify the project and source revision; branch-update keys also identify the branch, so the same immutable history can advance separate branches. If a response is lost after a write succeeds, retry must recover that write rather than create a second revision.

Branch movement remains compare-and-swap against an expected head and the new revision's parent. Concurrent remote work is preserved. A changed head requires fetch and reconciliation instead of an overwrite. Aborting processing preserves its pending intent for another attempt; explicit queue cancellation removes that intent and aborts the active request. Cancellation cannot retract a remote mutation that has already committed.

The queue journal and fetched cache are local metadata. They do not store access credentials or media contents. Production use still needs an account-to-service binding and a configured credential provider; this milestone does not make the desktop History view connected.

## Validation

The recorded [disposable network exercise](phase-0/revision-network-sync-live-observation.json), run with `node scripts/network-sync-proof.js`, used two authorized accounts and one outsider over an actual loopback HTTP server. Its saved evidence contains no credentials or local paths. It verified:

- An offline push intent survived on disk, and an unavailable server caused retry.
- A committed branch update whose acknowledgment was lost recovered from a fresh queue instance without duplicate revisions.
- A second authorized account fetched two revisions with session-bound authors; verified cached metadata remained available offline.
- An outsider could not read the branch or source-revision lookup, and a removed member was denied on the next read.
- A competing editor's compare-and-swap update survived the other writer's conflict.

Targeted automated checks passed: 28 asynchronous/legacy sync and queue tests, 9 real-loopback handler tests, 4 client tests plus the network exercise, and 2 actual HTTPS tests. The core checks include reusing immutable revisions across two branches without an idempotency-key collision. The HTTPS checks use the default client and secure handler: an untrusted fixture certificate is refused, while an isolated child process trusting the disposable test CA completes metadata and authorization requests. They do not change system trust or disable certificate verification.

The transport milestone's full suite passed all 466 tests with no failures or skips, and packaging validation passed. The security test command includes the client, handler, and HTTPS checks.

The HTTP loopback fixture is an explicit test exception to HTTPS. Identity and server history were held in memory; server restart and durable hosted state recovery were not exercised. The local HTTP/HTTPS checks cannot establish production TLS operations, internet availability, representative project performance, or hosted account delivery.

A later [durable local collaboration runtime](DURABLE_COLLABORATION_SERVICE.md) now binds and persists identity, access, and history together. Its separate encrypted-store process-restart proof, injected-failure checks, and expanded 495-test suite passed. The earlier in-memory network checks above remain distinct evidence for the transport contract.

## Remaining deployment work

Deployment/data-processing regions, production TLS hosting, durable service storage and backup operations, managed keys, account provisioning/recovery delivery, operational monitoring, and desktop authentication/configuration remain open. Sharing links, cross-device notifications, media transfer, synced-base integration, and safe project apply also remain separate roadmap work.

The transport uses Node's documented [HTTP server APIs](https://nodejs.org/api/http.html) and [fetch API](https://nodejs.org/api/globals.html#fetch), while the authorization and immutable-history rules remain repository domain contracts.
