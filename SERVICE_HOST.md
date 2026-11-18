# Running a single-host metadata service

Frameline includes a standalone HTTPS launcher and trusted local account tools. They use the encrypted identity/access/history store and the same API as the desktop Service history panel. The default configuration serves metadata; optional [asset storage](ASSET_NETWORK_SYNC.md) adds authenticated media chunks. These tools do not choose a hosting provider or deploy infrastructure. The filesystem stores remain a single-host foundation; production database, managed keys, monitoring, backups, and disaster recovery remain separate gates.

Use Node.js 24 and a dedicated service account on a local filesystem. Keep configuration and TLS material outside the repository and outside the state directory. The account that can read the configuration holds the state-encryption keys and is a trusted operator.

## Configuration

Create a regular JSON file with mode `0600` in an operator-controlled directory. Use absolute paths. This example describes the shape; its key placeholder deliberately cannot start a service:

```json
{
  "schemaVersion": 1,
  "directory": "/srv/frameline/state",
  "host": "127.0.0.1",
  "port": 8443,
  "tls": {
    "certFile": "/etc/frameline/tls/fullchain.pem",
    "keyFile": "/etc/frameline/tls/private-key.pem"
  },
  "keyring": {
    "activeKeyId": "initial",
    "keys": { "initial": "<base64 encoding of 32 random bytes>" }
  }
}
```

Generate the encryption key with a cryptographic random generator and write it directly into the private configuration through your secret provisioning process. Preserve it securely: a new random key cannot decrypt existing state. Do not put keys, passwords, or session tokens in shell arguments, shell history, repository files, or logs. The TLS private key must also be a regular file with mode `0600`. The loader rejects symlink files, unsafe permissions, malformed fields, configuration over 64 KiB, certificates over 1 MiB, and private keys over 64 KiB.

The default bind address is `127.0.0.1`; a numeric non-loopback address must be explicit. Use a certificate valid for the service hostname and trusted by the desktop. The launcher serves TLS directly. A reverse proxy must connect to this launcher over TLS too; forwarded headers do not substitute for an encrypted socket. Test certificates under `tests/fixtures/network-tls` are public test material and must never serve an external deployment.

## Initialize and launch

Run these commands from the repository with the service account. Only the configuration path appears in the argument list:

```sh
npm run service -- initialize --config /etc/frameline/service.json
npm run service -- serve --config /etc/frameline/service.json
```

Initialization creates encrypted state and exits without opening a listener. Repeating it validates existing state rather than resetting it. Ordinary `serve` refuses a missing state file. A ready event appears only after a successful listen. Configuration changes and certificate renewal require a controlled restart; no live reload is provided. Changing `activeKeyId` alone does not rotate stored data: ordinary writes refuse a different active key. Preserve the current key ID until a separately reviewed rotation has completed.

The launcher requires TLS 1.2 or later. It caps TCP connections at 128, active handlers at 256, headers at 100 / 16 KiB, and requests per socket at 100. Timeouts are 5 seconds for TLS handshake, 10 seconds for headers, 30 seconds for receiving a request or an inactive socket, and 5 seconds for keepalive. Metadata bodies retain the API's 8 MiB limit and authentication bodies its 8 KiB limit.

Shutdown first stops admission and closes idle connections. It closes remaining sockets after one second, waits for accepted handlers, then closes the store, with a ten-second overall deadline. `SIGTERM` and `SIGINT` request this shutdown. A shutdown failure exits unsuccessfully; investigate before restarting or retrying a mutation whose acknowledgment was lost. The local encrypted store's uncertain-write rules still apply. Node's server shutdown APIs distinguish idle and active connections; see the [Node 24 HTTP documentation](https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections).

There is no HTTP administration route or health endpoint exposing state. An external supervisor can observe the process's ready/stopped/error events and its exit status. Request-level monitoring and a production readiness probe remain open.

## Provision accounts and projects locally

The admin command reads one JSON request of at most 16 KiB from standard input. Use a protected input file or an approved secret manager that streams input. Set the input file to mode `0600`, and remove it according to your secret handling policy after use. Do not paste real credentials into a shell command.

```sh
npm run service:admin -- --config /etc/frameline/service.json < /secure/account-request.json
```

Create an account with this request shape:

```json
{"action":"account-create","email":"owner@example.com","password":"<password of at least 12 characters>"}
```

Create a project owned by that account:

```json
{"action":"project-create","email":"owner@example.com","password":"<owner password>","projectId":"pilot-project","name":"Pilot project","teamName":"Pilot team"}
```

Add an existing account as a viewer or editor:

```json
{"action":"member-add","ownerEmail":"owner@example.com","ownerPassword":"<owner password>","memberEmail":"collaborator@example.com","memberPassword":"<collaborator password>","projectId":"pilot-project","role":"viewer"}
```

This is an operator-assisted local workflow. The operator supplies both accounts' credentials for invitation acceptance; it is not an invitation delivery or self-service signup flow. Output contains selected account/project identifiers and the resulting role, never passwords, bearer tokens, refresh tokens, or invitation tokens. Outputs containing email addresses remain private operator records. Errors contain only allowed codes.

Successful completion requires temporary-session revocation. Cleanup failure returns `service-admin-cleanup-failed`; killing an admin process before cleanup can also leave its temporary sessions valid until expiry or revocation. Project setup spans team creation and project creation; a later failure may retain an empty team. Member setup spans invitation and acceptance; a later failure may retain an invitation. These workflows are not a single transaction. Do not blindly rerun a partially completed request; inspect accessible projects first.

The CLI requires initialized state and uses the normal durable APIs and role checks. It cannot reset missing state. It does not offer account recovery delivery, password reset, account deletion, ownership transfer, or encryption-key rotation commands. Those operations require a separately reviewed operator workflow.

## Connect a desktop

Start the service with its intended trusted certificate. In desktop History, sign in with the HTTPS origin and a provisioned account, select an accessible project and branch, then link the selected local branch. Check, push, and fetch operate on revision metadata. A viewer can fetch but cannot publish. Fetched history remains read-only; this does not apply edits or transfer media. See [desktop sync](DESKTOP_SERVICE_SYNC.md).

## Optional media service

The private configuration can include separate encrypted asset storage and a signing key. See [asset network sync](ASSET_NETWORK_SYNC.md) for initialization, API calls, signed tickets, verification polling, cancellation, and backup requirements. Host shutdown cancels active asset verification before closing either store. The [Project media panel](DESKTOP_MEDIA_TRANSFERS.md) offers explicit transfers; History push/fetch continues to sync metadata only. Canonical revision/media bindings and editor relinking remain open.

Projects start with no media classes enabled. A project owner must explicitly save allowed classes through Project media or the authenticated asset policy API before transfers. Upgrading an earlier asset index retains existing bytes and partial uploads but likewise defaults classes to disabled. Class exclusion and owner archive controls retain bytes; they are not deletion or storage reclamation. Logical project usage excludes disk overhead and billing. The integrated controls passed the 659-test suite, a three-process HTTPS proof, and browser/native checks; see the linked documents for the workflow and bounded evidence.

## Recovery and deployment gates

Retain the private encryption configuration separately from the state file. Stop the service and all local admin writers before taking a consistent filesystem copy, protect the encrypted backup off-device, and test restoration in isolation before replacing live state. Restoring older state can restore old session or permission state; the runtime provides no rollback protection. The metadata-only backup helpers do not include accounts and access rules and must not be presented as a complete service backup. See [durability](DURABLE_COLLABORATION_SERVICE.md) and [incident response](INCIDENT_RESPONSE.md).

Before external operation, choose the provider and data-processing region, certificate ownership/renewal, firewall policy, secret custody, backup retention and restore owner, monitoring, recovery delivery, abuse controls, and support coverage. The bounded local store and cooperative lock do not provide distributed database guarantees or horizontal scaling. Per-process authentication throttling is not a distributed limiter. Running this launcher locally does not close those roadmap items.

## Validation

The initial [disposable process observation](phase-0/service-host-live-observation.json) recorded 44 HTTPS requests across two complete launcher processes. Local CLI requests provisioned two accounts, a project, and viewer access. Two revisions were published and fetched; viewer manifest, revision, and branch writes were refused before and after restart. Acknowledged history, sessions, roles, and idempotent retry survived graceful `SIGTERM` shutdown and a fresh process. Reinitializing existing state preserved its bytes. Missing state, broadly readable configuration, and broadly readable TLS keys were rejected. All owned child processes were terminal before replacement and cleanup.

Configuration/factory tests separately cover schema and byte bounds, invalid UTF-8, private permissions, symlinks and aliases, hard-linked TLS/config files, invalid TLS before state creation, occupied ports without state replacement, raw pre-handshake sockets during shutdown, and draining an admitted durable request after its client disconnects. Admin tests cover exact action validation before state access, unsuccessful authentication cleanup, partial setup, and safe output. These checks use disposable data and test-only certificates; they do not establish production hosting, a crash during a write, or machine power-loss behavior.

The initial host milestone passed all 558 tests with no failures or skips. After optional asset integration, the full suite passed all 603 tests with no failures or skips, and package-input validation passed with the host, operator, and asset modules included. See the separate [asset transfer evidence](ASSET_NETWORK_SYNC.md#validation) for its scope.

The later [activity restart proof](phase-0/project-activity-network-observation.json), reproduced with `node scripts/service-host-proof.js`, recorded 68 HTTPS requests across three launcher processes. It preserved activity, read receipts, and scoped cursors across restart, suppressed retry duplicates, and rejected a removed member’s feed and old cursor after another restart. The integrated activity milestone passed all 690 tests and packaging validation; [desktop evidence](PROJECT_ACTIVITY.md#validation) covers app-open checks and native receipt recovery.
