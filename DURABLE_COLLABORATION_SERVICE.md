# Durable local collaboration service

`createDurableCollaborationService` in `src/durable-collaboration-service.js` combines identity, access control, and immutable revision history in one encrypted, versioned local state. Disposable process-restart and injected-failure checks passed, alongside the full 495-test suite and packaging validation. This runtime does not configure a deployed service, desktop account connection, or production database.

## State and trust boundary

The combined schema-1 state contains a generation, a private random pagination-signing secret, identity and access snapshots, and schema-3 immutable history. Its private records include salted password hashes, hashed session/recovery credentials, team and project memberships, invitation digests, project tombstones, revisions/manifests, branch heads, and exact-request idempotency records. Bearer tokens are returned when issued and are represented by digests in saved state. Private snapshots contain emails and credential hashes; they are trusted service inputs, not public response objects or renderer data.

The host supplies an encryption keyring, and the runtime writes AES-256-GCM envelopes with a key ID to `collaboration.enc.json`. It does not create a key file. Keys must be kept outside that file and supplied again when opening it. The private directory requires mode `0700`, and state files use `0600`; symlink state files are refused. The decrypted state is bounded to 64 MiB and the encrypted file to 96 MiB. Missing keys, tampering, unsupported schemas, or invalid cross-state references fail closed. Encryption does not replace host security or per-request authorization.

Opening defaults to `initialize: false` and refuses a missing directory or state file. Trusted first-time provisioning must explicitly pass `initialize: true` to create a blank store; it creates no accounts. Once a runtime has opened successfully, losing its state file fails closed even if it was originally initialized with that flag. Reopening does not silently recreate lost state or fall back to a backup. A trusted caller can deliberately initialize an empty directory as a separate provisioning action.

Recovery validates identity/access/history together. Access registrations must match history projects, membership and revision authors must reference known users, and active project roles and team owners require active accounts. Historical authors and permitted tombstone references can remain after account deletion. Manifest hashes, revision parent/project bindings, cycle checks, and saved idempotency results are revalidated. Restoring the snapshots does not replay membership events.

History schema 3 stores manifests by a project-scoped key while preserving their public canonical `sha256:` IDs. Identical manifest bytes can therefore belong independently to two projects without a collision or cross-project lookup. Opening valid history schema 1 or 2 validates its original scope, migrates it, and atomically publishes the upgraded encrypted state. Existing revision IDs, branch heads, and available idempotency records are preserved. Encrypted-upgrade and same-content/two-project regression checks passed in the later 539-test desktop-integration suite, which had no failures or skips and passed packaging validation.

The combined state does not persist activity/inbox records, audit trails, rate-limit buckets, share links, or branch approval policy. Those separate foundations still need durable integration.

## Transaction behavior

The asynchronous factory returns identity, team, project, membership, and authorized history facades, plus status, encryption rotation, and close operations. It exposes no mutable domain-store handles. Every operation joins the runtime's serialized queue, obtains a cooperative local metadata lock, rereads current disk state, and hydrates fresh stores. A mutation validates the combined result and canonical encrypted envelope, then decrypts that envelope to verify an exact validated-state round trip before replacement. An invalid or mismatched keyring cannot replace the old file. The runtime writes a private temporary file, flushes it, renames it over the state file, and flushes the directory before returning success. This also lets cooperating local runtime instances merge against the latest committed state.

An operation or persistence failure before a rename is attempted returns no committed acknowledgment, leaves the previous file intact, and discards that operation's hydrated stores. Any failure after a rename attempt, including a rename that took effect before reporting an error, leaves durability uncertain. Directory-flush and lock-release failures are also treated as uncertain. That runtime then refuses further operations until it is reopened; the caller must not assume the mutation failed to reach disk. A reopened runtime validates the current file and does not automatically restore an older backup.

The HTTP handler receives the authorized `service` facade. Authentication and authorization run for every project request, including after reopening. Persisted idempotency and compare-and-swap records let retry recover a committed result; the disposable restart proof verified revision reuse without duplicates after reopening the encrypted store.

Recovery delivery is optional and host supplied. Beginning recovery without a configured callback is refused. When configured, the callback is scheduled after the recovery-token digest is committed; delivery is detached so a pending provider cannot stall later transactions or close. Callback failure remains generic and does not roll back committed state. There is no durable delivery outbox or delivery guarantee.

`rotateEncryption` writes the combined state with the supplied next keyring before switching this runtime to it. Ordinary mutations cannot change the saved key ID and return `collaboration-key-rotation-required` if their keyring would do so. This prevents an older instance that can decrypt both keys from silently reverting the active key policy. Other instances must hold a keyring that can decrypt the new key ID and encrypt ordinary writes with it. `close` rejects new operations and waits for already-queued transactions, without awaiting detached delivery callbacks. The host owns the listening server, TLS, timeouts, key custody, and service shutdown.

The local lock is not a distributed lease, and the file protocol is not a production database transaction system. Filesystem- and hardware-specific power-loss guarantees require separate validation. Generation matching detects inconsistent envelopes but provides no anti-replay guarantee: restoring an older valid encrypted file can restore older session or permission state. Trusted restore policy and external rollback protection remain open.

## Validation

The [disposable process/network observation](phase-0/durable-collaboration-live-observation.json), reproduced with `node scripts/durable-network-sync-proof.js`, recorded 38 actual HTTP requests across three owned server processes on fresh loopback ports. Two authorized accounts used the same encrypted local store and externally supplied key. The proof verified:

- An acknowledged branch update survived `SIGKILL`; sessions, owner/editor roles, and two immutable revisions recovered in a fresh process.
- Retrying recovered history created no duplicate revisions, and new revision authors remained bound to the authenticated session.
- Forged authentication was denied, and member removal, refresh rotation, sign-out, and refresh-token revocation remained effective after later process restarts.
- The state file had mode `0600`, credentials were absent from plaintext storage, and all owned child processes were verified terminal before replacement and final cleanup. The saved observation contains no credentials or local paths.

Separate runtime checks passed for cooperating concurrent writers, domain-failure rollback, recovery state and detached delivery, temporary-file flush failure before publication, and uncertain rename/directory-flush failures followed by validated reopen. They also cover invalid or mutating keyring output, refusal of stale-key downgrades, dangling references, history cycles, future schemas, tampering, file permissions, symlinks, missing-state refusal, and account deletion with historical references and email-reuse isolation. Strict identity and access snapshot tests passed as part of the same full suite.

The full suite passed all 495 tests with no failures or skips; packaging validation and scoped source/diff checks passed. The process kill followed an acknowledged update. These results do not claim a crash during a write, a machine power-loss test, production key custody, or deployed cross-device operation. Project tombstone/account-removal recovery was covered by local runtime tests rather than the HTTP process fixture.

## Remaining product and deployment work

This runtime remains a local service foundation. Production hosting and database/object-storage adapters, managed encryption keys, off-device backups, disaster recovery, distributed coordination, account/recovery delivery, and operational monitoring remain open. A later [desktop service integration](DESKTOP_SERVICE_SYNC.md) adds sign-in and explicit metadata operations against an existing service, with verified browser/native HTTPS and desktop restart behavior. Media storage/transfer and safe editor apply are separate gates.

See [revision network sync](REVISION_NETWORK_SYNC.md) for the already-tested transport boundary and its loopback/TLS scope, [service foundations](SERVICE_FOUNDATION.md) for immutable history and maintenance contracts, and the [security model](SECURITY_MODEL.md) for trust boundaries.
