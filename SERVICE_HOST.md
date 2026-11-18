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

### Optional notification email

Email is unavailable when `notifications` is absent. To enable it, add this optional object to the private configuration and restart the host:

```json
"notifications": {
  "publicOrigin": "https://frameline.example.com",
  "from": "updates@example.com",
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "username": null,
    "password": null
  }
}
```

Use the service's externally reachable HTTPS origin, without a path, query, credentials, or fragment. The sender is one ASCII mailbox. The SMTP port is required and may be any integer from 1 through 65535; it must serve implicit TLS. Port 465 is the standard submissions port described in [RFC 8314](https://www.rfc-editor.org/rfc/rfc8314.html#section-3.3). There is no STARTTLS or plaintext fallback. If authentication is required, replace both null fields with the operator's SMTP username and password; only AUTH PLAIN over the verified TLS connection is supported. Keep these credentials in the `0600` configuration, never command arguments or logs. Configuration loading validates fields without connecting to SMTP or resolving its hostname.

The SMTP certificate chain and hostname must validate against Node's configured trust roots. Certificate verification cannot be disabled through this configuration; establish private-CA trust through the service process's approved trust configuration when necessary. See [Node TLS verification](https://nodejs.org/api/tls.html#tlsconnectoptions-callback). The disposable tests add a test CA only to isolated child processes; those certificates are not deployment credentials.

Each account starts with email off. In History → **Account updates** → **Your email preferences**, choose a project, load preferences, and explicitly save Immediate email or Daily UTC digest. Delivery uses the account's saved email address. First enablement starts at the current activity append position, without mailing older events. Immediate mode is processed by the next available worker tick; daily mode batches eligible unread updates once per project UTC day after the chosen hour. Downtime catches up with a batch rather than replaying every missed day. Messages contain counts and a currently authorized project name; media, clip names, revision messages, and comment bodies are excluded.

The worker runs in this server process independently of the desktop. Its default interval is 30 seconds, with at most 100 newly scheduled jobs and 10 leased submissions per tick. Each lease lasts 60 seconds. A job has at most five attempts; transient retries wait 30, 60, 120, then 240 seconds, plus scheduling delay. Permanent failures and exhausted jobs stop automatically. Stored jobs and expired-lease recovery survive host restart. Rechecks before SMTP DATA can cancel work after consent, read status, or access changes; already accepted mail cannot be recalled.

A final SMTP `250` means the submission server accepted responsibility, not that the recipient read or received the message. A lost DATA acknowledgment may cause a retry of mail the server already accepted. Retries retain a stable Message-ID, but use bounded at-least-once submission semantics and may duplicate; see [SMTP acceptance and duplicate risk](https://www.rfc-editor.org/rfc/rfc5321.html#section-6.1). Provider delivery, bounce processing, sender-domain authentication, quotas, and monitoring remain operator responsibilities.

The email's unsubscribe link opens `/unsubscribe#token`; the page removes the fragment immediately and sends nothing until **Turn off email** is chosen. It disables only the linked project's current consent. A subsequent explicit change of mode/hour or re-enablement invalidates the older link. **Turn off all email** in the authenticated desktop also covers projects the account can no longer access. The List-Unsubscribe header supplies this manual page; it does not implement the automated one-click protocol in [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html#section-3.1).

## Initialize and launch

Run these commands from the repository with the service account. Only the configuration path appears in the argument list:

```sh
npm run service -- initialize --config /etc/frameline/service.json
npm run service -- serve --config /etc/frameline/service.json
```

Initialization creates encrypted state and exits without opening a listener. Repeating it validates existing state rather than resetting it. Ordinary `serve` refuses a missing state file. A ready event appears only after a successful listen. Configuration changes and certificate renewal require a controlled restart; no live reload is provided. Changing `activeKeyId` alone does not rotate stored data: ordinary writes refuse a different active key. Preserve the current key ID until a separately reviewed rotation has completed.

The launcher requires TLS 1.2 or later. It caps TCP connections at 128, active handlers at 256, headers at 100 / 16 KiB, and requests per socket at 100. Timeouts are 5 seconds for TLS handshake, 10 seconds for headers, 30 seconds for receiving a request or an inactive socket, and 5 seconds for keepalive. Metadata bodies retain the API's 8 MiB limit and authentication bodies its 8 KiB limit.

Shutdown first stops admission and the notification worker, and closes idle connections. It closes remaining sockets after one second, drains accepted handlers and worker activity, then closes the store, with a ten-second overall deadline. `SIGTERM` and `SIGINT` request this shutdown. A shutdown failure exits unsuccessfully; investigate before restarting or retrying a mutation whose acknowledgment was lost. The local encrypted store's uncertain-write rules still apply. Node's server shutdown APIs distinguish idle and active connections; see the [Node 24 HTTP documentation](https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections).

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

## Review protected publications

In desktop History, **Branch approvals** can select an accessible service project and branch without a local FCPXML export. An owner can require zero through five independent approvals. A protected push saves immutable metadata and leaves its queue entry blocked until a review request for the exact head/proposal/policy has enough eligible approvals. The requester then retries the queued push. Reviewers cannot be the requester or revision author, and current access is rechecked before publication. Viewers can read the review status. See [branch approvals](COLLABORATION_FOUNDATIONS.md#branch-approvals-on-a-self-hosted-service) for expiry, policy changes, capacities, and historical acknowledgment retry. These are metadata controls and do not apply editor changes.

Branch protection was introduced in combined schema 4 and is preserved by the current schema-6 upgrade described below.

## Read-only revision links

The launcher serves `/share` and its bundled static assets over the same TLS listener. Owners use History → **Read-only sharing** to select a service branch, verify its head, choose expiration, and create/copy a link. Anyone holding that link can read its pinned revision metadata until expiry, revocation, loss of the issuer's owner access, or project deletion. The link cannot read media, comments, account details, or other revisions and cannot write. The branch may advance while the link remains pinned to its original revision.

The recipient opens the shared page and explicitly chooses **Open shared revision**. The capability is removed from the address before redemption and is sent only in a same-origin JSON request. Query tokens, authorization headers, and cross-origin redemption are refused. Responses are not cached; static assets use bundled fonts, strict CSP, no-referrer policy, and no framing. Anonymous redemption has bounded body, concurrency, peer, and global rate limits. A public deployment still needs its own trusted hostname/certificate and operational protections. See [sharing behavior and limits](COLLABORATION_FOUNDATIONS.md#read-only-sharing).

Sharing was introduced in combined schema 5. The current schema 6 upgrades valid schemas 1–5, preserving their existing domains and adding empty notification preferences, consents, receipts, and outbox state. Earlier domains absent from an older schema are likewise initialized empty; no activity, comments, links, or email jobs are backfilled. Take a consistent service/configuration backup before upgrading; older runtimes refuse newer state.

## Optional media service

The private configuration can include separate encrypted asset storage and a signing key. See [asset network sync](ASSET_NETWORK_SYNC.md) for initialization, API calls, signed tickets, verification polling, cancellation, and backup requirements. Host shutdown cancels active asset verification before closing either store. The [Project media panel](DESKTOP_MEDIA_TRANSFERS.md) offers explicit transfers; History push/fetch continues to sync metadata only. Canonical revision/media bindings and editor relinking remain open.

Projects start with no media classes enabled. A project owner must explicitly save allowed classes through Project media or the authenticated asset policy API before transfers. Upgrading an earlier asset index retains existing bytes and partial uploads but likewise defaults classes to disabled. Class exclusion and owner archive controls retain bytes; they are not deletion or storage reclamation. Logical project usage excludes disk overhead and billing. The integrated controls passed the 659-test suite, a three-process HTTPS proof, and browser/native checks; see the linked documents for the workflow and bounded evidence.

## Recovery and deployment gates

Retain the private encryption configuration separately from the state file. Stop the service and all local admin writers before taking a consistent filesystem copy, protect the encrypted backup off-device, and test restoration in isolation before replacing live state. The complete encrypted state includes notification preferences, consent epochs, jobs, delivery receipts, and leases. Restoring older state can restore old sessions, permissions, consent, or pending mail; the runtime provides no rollback protection. Isolate restoration from a live SMTP server until the recovered delivery state has been reviewed to avoid unintended or duplicate email. The metadata-only backup helpers do not include accounts and access rules and must not be presented as a complete service backup. See [durability](DURABLE_COLLABORATION_SERVICE.md) and [incident response](INCIDENT_RESPONSE.md).

Before external operation, choose the provider and data-processing region, certificate ownership/renewal, firewall policy, secret custody, backup retention and restore owner, monitoring, recovery delivery, abuse controls, and support coverage. The bounded local store and cooperative lock do not provide distributed database guarantees or horizontal scaling. Per-process authentication throttling is not a distributed limiter. Running this launcher locally does not close those roadmap items.

## Validation

The initial [disposable process observation](phase-0/service-host-live-observation.json) recorded 44 HTTPS requests across two complete launcher processes. Local CLI requests provisioned two accounts, a project, and viewer access. Two revisions were published and fetched; viewer manifest, revision, and branch writes were refused before and after restart. Acknowledged history, sessions, roles, and idempotent retry survived graceful `SIGTERM` shutdown and a fresh process. Reinitializing existing state preserved its bytes. Missing state, broadly readable configuration, and broadly readable TLS keys were rejected. All owned child processes were terminal before replacement and cleanup.

Configuration/factory tests separately cover schema and byte bounds, invalid UTF-8, private permissions, symlinks and aliases, hard-linked TLS/config files, invalid TLS before state creation, occupied ports without state replacement, raw pre-handshake sockets during shutdown, and draining an admitted durable request after its client disconnects. Admin tests cover exact action validation before state access, unsuccessful authentication cleanup, partial setup, and safe output. These checks use disposable data and test-only certificates; they do not establish production hosting, a crash during a write, or machine power-loss behavior.

The initial host milestone passed all 558 tests with no failures or skips. After optional asset integration, the full suite passed all 603 tests with no failures or skips, and package-input validation passed with the host, operator, and asset modules included. See the separate [asset transfer evidence](ASSET_NETWORK_SYNC.md#validation) for its scope.

The later [activity restart proof](phase-0/project-activity-network-observation.json), reproduced with `node scripts/service-host-proof.js`, recorded 68 HTTPS requests across three launcher processes. It preserved activity, read receipts, and scoped cursors across restart, suppressed retry duplicates, and rejected a removed member’s feed and old cursor after another restart. The integrated activity milestone passed all 690 tests and packaging validation; [desktop evidence](PROJECT_ACTIVITY.md#validation) covers app-open checks and native receipt recovery.

The notification process test, `node --test tests/self-hosted-notifications-proof.test.js`, passed 44 actual HTTPS requests across three complete host and three client processes. An owned loopback implicit-TLS fake MTA accepted a background message; durable read receipts, exact lost-acknowledgment preference retry, current-consent unsubscribe, generic access-loss notices, and all-project opt-out survived restart. No mail was sent to an external server. These checks do not validate public hosting, provider delivery, an elapsed daily delivery cycle, or power-loss behavior.
