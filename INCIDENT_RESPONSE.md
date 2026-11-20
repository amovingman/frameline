# Owner incident response and service recovery

This procedure covers the [personal project](PROJECT_SCOPE.md). The project owner operates the local app and optional self-hosted service, handles incidents, controls the keys and decides when recovery is complete. This is not an operated hosting service, on-call team, public security inbox or automatic off-device backup. Editor identity and safe-apply gates remain unchanged.

## Contain and record

1. Stop risky writes, transfers and update attempts. For suspected unauthorized access, stop the service or isolate its listener before investigating. Preserve the original service directories, editor files and private configuration. Do not reset or repeatedly reopen damaged state.
2. Record the build, broad category, stage and generic error codes using the private intake below. A security record does not revoke sessions or repair a database.
3. Export app diagnostics only after reviewing their exact JSON. Keep credentials, original paths, media names, project content and exploit details out of public issues. Keep sensitive investigation material separately under the owner's private protection.
4. Classify the incident as corruption, access, compatibility, transfer, update, security or recovery. A successful scan or restored service does not establish safe editor apply.

The owner is responsible for acknowledging and investigating their local records. There is no background notification, external delivery, response-time guarantee or second responder. For this personal build, security disclosure means recording a finding privately for the owner and withholding sensitive details from public compatibility issues. A future public distribution needs a separately configured reporting channel and response policy.

Desktop history is separate from the service snapshot below. Preserve the app's metadata directory, its `.bak` file and damaged primary before using the validated local recovery path in [local metadata](LOCAL_METADATA.md). Keep editor projects and exports separately through the editor's normal backup workflow; a service backup does not collect those original files.

## Private local intake

`npm run service:backup --silent` reads one JSON request of at most 64 KiB from standard input. It accepts no command-line credentials. Keep request files private, for example under `umask 077`, and remove them according to the owner's private-data policy.

```json
{"action":"record-incident","directory":"/absolute/private/owner-incidents","record":{"category":"recovery","severity":"medium","stage":"opened","buildVersion":"0.1.0","errorCodes":["asset-storage-uncertain"],"backupSha256":null}}
```

Categories are `corruption`, `access`, `compatibility`, `transfer`, `update`, `security` and `recovery`. Severity is `low`, `medium` or `high`; stage is `opened`, `contained`, `verified` or `closed`. Codes come from a fixed allowlist. The version is a numeric three-part version; the optional backup field is an exact SHA-256. Unknown fields, freeform notes, arbitrary error text, paths, tokens and usernames are refused. The tool generates a timestamp and record ID, writes an immutable mode-`0600` JSON file in a mode-`0700` folder, flushes it and returns its hash. Record a later stage as a new observation; preserve earlier records.

## What the encrypted backup contains

The complete encrypted collaboration state includes identity/session state, access, immutable revisions and canonical media bindings, activity, comments, approvals, share links, notification consent/outbox state and retry receipts. If asset storage is configured, the snapshot also includes the encrypted asset index and indexed ciphertext chunks: shared backing blobs, acknowledged partial uploads, verification jobs, holds, retention, deletion receipts and pending physical collection.

An acknowledged live chunk must be present and valid. Present unacknowledged chunks inside an indexed upload's geometry are preserved without promoting them to acknowledged or published content. A pending-deletion journal may legitimately describe files already removed before interrupted cleanup; the snapshot preserves exactly the remaining files and journal. Missing live data, unknown files/directories, unsafe links, invalid schemas and corrupt ciphertext fail closed. Unknown evidence is never deleted to make a backup succeed.

The backup contains **no encryption keys, asset signing key, TLS private key, host configuration, SMTP credentials, editor source project or original media outside the encrypted asset store**. Retain the private configuration, active encryption-key identity and all required decryption keys separately. Without those keys the snapshot cannot recover the service. Signing-key continuity affects existing tickets; TLS/configuration must be provisioned separately.

This is an explicit owner-selected filesystem copy. Another owner-controlled device can be chosen, but a copy on the same disk does not protect against losing that disk. There is no scheduler, remote provider or automatic backup-retention policy. Keep an appropriate last-known-good copy and verify a new one before removing an older copy.

## Create and verify

The private service configuration supplies storage locations and the keyring. The tool never starts an original service runtime, migrates its state, executes its pending collection or sends email. It locks assets first, then collaboration, and retains both locks through the copy. Cooperative service/admin writes wait, producing a consistent pair. Stopping other writers first remains the simplest operational choice. Lock waits and file copying are cancellable through the JavaScript API.

Stop the host and its notification worker before a recovery backup when possible. An external SMTP submission may be in flight while state is copied; its remote acceptance is outside the metadata locks. Restoring such a snapshot can replay a message whose acknowledgment was not captured. Neither live snapshots nor recovery provide exactly-once mail delivery.

```json
{"action":"backup","configPath":"/absolute/private/service.json","destination":"/absolute/private/backups/snapshot-001"}
```

The destination must be new and separate from the live stores, with an existing safe parent directory. Existing files or directories are never overwritten. Private payload files are rechecked and flushed before `backup.json` seals the snapshot. Failed incomplete work is cleaned individually only when ownership remains proven; unknown or replaced files are preserved. A process crash or uncertain filesystem failure can leave an incomplete private destination. Inspect it and choose a different new destination rather than replacing it blindly.

The result reports the backup ID, exact manifest hash, encrypted-file count/bytes, inner schemas/generations and whether assets were included. It omits paths, credentials and project labels. `assetsIncluded: false` means metadata only, not a backup of an asset-enabled service.

```json
{"action":"verify","configPath":"/absolute/private/service.json","backupDirectory":"/absolute/private/backups/snapshot-001"}
```

Verification is read only. It checks the manifest, exact file/directory classification, ciphertext hashes, authenticated decryption, schemas, chunk identities/checksums and complete hashes for published backing media. It never hydrates or repairs the snapshot. An unfinished upload stays unfinished. Verification proves the snapshot's integrity and represented contents; it does not prove physical-device health or editor-project equivalence.

## Restore into a new location

1. Stop/isolate the affected service and preserve its original files. Keep damaged state for investigation.
2. Verify the selected backup with the separately retained keys. Review its exact `sha256`, included assets and schemas.
3. Explicitly confirm a new out-of-place restore:

```json
{"action":"restore","configPath":"/absolute/private/service.json","backupDirectory":"/absolute/private/backups/snapshot-001","destination":"/absolute/private/recovered-service-001","expectedSha256":"REPLACE_WITH_THE_EXACT_VERIFIED_64_CHARACTER_HASH","confirmed":true}
```

The tool creates `collaboration/` and, if included, `assets/` below the destination, verifies the copied bytes and writes `restore.json` last. It never replaces the old stores, changes live configuration, copies secrets, starts a listener or enables SMTP. A changed review hash or existing destination is refused. Keep the original and backup until recovery has been checked.

4. Prepare a separate private recovery configuration pointing to the restored folders, with the retained keyring and separately provisioned TLS/signing settings. Initially use an isolated loopback listener and omit notification/SMTP configuration. Opening the restored runtime can migrate older schemas and resume authorized pending collection in the restored copy.
5. Verify accounts, owner access, branch heads, revision/manifest hashes, canonical retained references, required media bytes, partial-upload continuation, job/receipt state and refusal to collect retained assets. Record the backup hash and outcome privately. Retained references must still block collection after restart.
6. Decide separately whether to switch normal service configuration to the recovered locations. The tool never activates a restore.

**Historical access and consent return too.** An older snapshot can restore previously valid sessions, permissions, invitations, share links, notification consent and queued messages. Backup hashes provide no rollback protection. Restoring data neither revokes compromised credentials nor repairs access policy. Review/remediate access through supported identity/access workflows before reconnecting a security recovery. Keep SMTP disabled until historical consent, queued mail and delivery receipts have been reviewed; old outbox state can otherwise cause unintended or duplicate mail.

## Errors and evidence

`backup-source-busy`: stop competing writers and retry. `backup-source-changed`: preserve evidence and create a fresh snapshot. `backup-source-unclassified`: unexpected files were retained for private investigation. `backup-key-unavailable`: supplied keys could not authenticate a record; do not reset the store. `backup-storage-uncertain`: verify/inspect the destination before retrying; an error acknowledgment is never treated as success.

Filesystem checks cover full and metadata-only snapshots, canonical references, partial chunks, legitimate pending-deletion omissions, cancellation, concurrent writers, source mutation, unsafe links, private modes, unknown-file preservation, exact review binding and historical-session restoration. The separate recovery HTTPS drill checks fresh restored processes and retained-asset protection. These are small disposable fixtures, not a power-loss, managed disaster-recovery, external reporting or general editor-apply claim.
