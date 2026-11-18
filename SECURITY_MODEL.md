# Security model

This model covers the local executable collaboration foundation. It does not claim that a hosted service has been deployed or audited.

A [combined encrypted local service runtime](DURABLE_COLLABORATION_SERVICE.md) persists private identity, permissions, and history together, with cross-state validation and host-supplied keys. A separate encrypted-store process-restart proof verified session, permission, history, and revocation recovery; injected-failure checks cover rollback and uncertain writes. These local results do not establish production durability. An older valid encrypted snapshot can still be replayed; no external rollback protection is provided.

## Trust boundaries

- The Electron renderer is untrusted. A user-entered sign-in password exists briefly in the form and dedicated IPC request; the form clears immediately on submission. The renderer receives display-safe state but never receives stored access/refresh tokens, media paths, or credential-vault methods. Passwords are absent from saved credentials and state/events. See `DESKTOP_SERVICE_SYNC.md` for verified browser/native behavior and unsigned-development-app limits.
- The Electron main process may read user-selected project files and use the operating system protected secret facility through `safeStorage`.
- Project API requests require an authenticated session and a project-scoped authorization decision. A resource ID alone grants no access.
- Self-hosted configuration and local provisioning run in a trusted operator process. Private configuration contains the externally supplied encryption and ticket-signing keys and optional SMTP credentials and must remain separate from service state. It is not a managed secret vault. Stdin provisioning credentials, SMTP credentials, keys, and tokens never enter the desktop renderer or HTTP administration routes.
- Desktop media IPC accepts a class, rate, content ID, or opaque review/job ID. Native dialogs supply filesystem paths in the main process. A private, account/project/branch-bound review precedes upload; public transfer state contains no source/destination paths or stored tokens. Content-ID reuse lookup is disclosed separately from file-byte confirmation. See [desktop media transfers](DESKTOP_MEDIA_TRANSFERS.md).
- FCPXML, JSON snapshots, revision bundles, archives, filenames, and collaborator-controlled metadata are untrusted input.

## Threats and current controls

| Threat | Current control | Remaining deployment work |
|---|---|---|
| Malicious XML or JSON | Bounded reads, strict schemas, entity rejection, extra-field rejection, generic path-free errors | Fuzzing and production telemetry |
| Archive traversal | Revision transfer accepts structured records rather than extracting archives; destination filenames are generated or validated | Recheck any future archive importer before shipping |
| Symlink and path substitution | Project, media, restore-point, and review-copy workflows reject symlinks and recheck file identity around reads | Platform-specific race testing and sandbox review |
| Local path disclosure | Paths stay in the main process; renderer, logs, audits, and public reports use opaque IDs and sanitized names | Privacy review of every new diagnostic field |
| Token theft | Tokens are hashed in session state; refresh tokens rotate; recovery revokes sessions; the renderer has no token bridge | Hosted session storage, secure cookies or native client binding |
| Stored-secret theft | The main-process credential vault requires Electron `safeStorage`; service records use AES-256-GCM envelopes with key IDs | Managed key service, access policy, and rotation drills |
| Network interception | Service endpoints must be HTTPS and may not contain URL credentials | TLS termination and certificate policy in the selected region |
| Unauthorized project or asset access | Owner/editor/viewer permissions are checked by the authorized service; revision and optional asset HTTP routes use current sessions and project roles | Production database enforcement and hosted boundary review |
| Unauthorized media policy or archive changes | Only current project owners can change class policy or archive state; expected-version/state checks refuse stale writes, and chunk tickets recheck current transfer policy | Deployment review and retention/deletion policy |
| Corrupt or substituted media chunks | Encrypted chunks bind project/upload/index/checksum; publication streams the full content hash, and downloads recheck each chunk | Canonical revision/media binding and reference-aware deletion |
| Stolen or altered chunk ticket | Five-minute HMAC binds method and canonical project/resource/index/expiry; redemption also requires current project access | Production key custody, quotas, and operational abuse monitoring |
| Brute force or abuse | Bounded per-principal/action rate limiter and hash-chained audit events | Distributed rate storage, alerting, retention, and incident response |
| Concurrent history overwrite | Idempotent revision creation and expected-head compare-and-swap branch updates | Durable transactional database adapter |
| Account deletion orphaning data | Deletion refuses while the user is a sole team or project owner and revokes sessions on success | Ownership-transfer UI and statutory deletion/export policy |

## Security invariants

1. Authentication establishes a user; authorization still runs for every project-scoped operation.
2. Viewer roles cannot mutate revisions, branches, projects, memberships, or assets.
3. Branch heads move only from the expected parent.
4. A local revision maps to at most one remote revision in a project.
5. Sync never uploads media as a side effect of fetching history.
6. Recovery, password change, sign-out, and account deletion revoke affected sessions.
7. Stored session tokens and encryption keys never enter renderer state, project payloads, transfer receipts, public logs, or preload accessors. User-entered passwords have the transient boundary described above. Service keys are supplied separately in private operator configuration; production secret custody remains a deployment gate.
8. Project media classes default to disabled. Exclusion and archive block further transfers while retaining bytes, metadata, and historical receipts. Availability and logical-usage responses are project-scoped index evidence, not local/collaborator inventory, disk accounting, or proof of global absence. The integrated controls passed all 659 tests, a three-process authenticated HTTPS proof, and browser/native permission and stale-write checks; see `ASSET_NETWORK_SYNC.md` and `DESKTOP_MEDIA_TRANSFERS.md`.

9. Project activity pages omit recipient lists, private hashes, credentials, and paths. Inbox reads and receipts belong to the authenticated recipient; signed cursors bind account, project, feed kind, and append anchor. Events and receipts commit with the encrypted collaboration state. The desktop clears private rows on scope/access loss, fails closed when scope is unreadable, and watches only after opt-in for the current app session. See `PROJECT_ACTIVITY.md` for restart, permission, and UI evidence.

10. Shared-base evidence is bound to the complete service/account/local-project-and-branch/remote-project-and-branch scope. Legacy branch-only values do not establish service sharing. Expected head/base-version checks, exact local record hashes, canonical manifests, immutable private witnesses, and prior remote-prefix continuity constrain new receipts. Public state exposes historical revision IDs/time rather than private proof hashes. Sign-out, rebinding, and freshly known access loss hide the evidence; it never authorizes import, media transfer, or editor apply. See `SERVICE_SHARED_BASES.md`.

11. Account notification pages belong to the authenticated recipient and expose only currently accessible event details. Own removal/deletion notices after access loss contain null project ID/name, actor ID, and subject ID; other inaccessible events are hidden. Actor/filter/append-bound signed cursors cannot select another account. Reads and filtering never acknowledge an item; explicit receipts persist before success. Preference responses expose only the current account's email, never another recipient's address.

12. Notification preferences default off and can change only for the authenticated account. Current project access is required for project preference reads/saves; account-wide opt-out remains available after project loss. Version checks and intent-bound receipts protect retries. Consent epochs, capability digests, outbox jobs, leases, and delivery outcomes commit with the encrypted schema-6 state. Restoring an older valid backup can restore older consent or pending mail; no external replay protection exists.

13. Unsubscribe capabilities grant only current-project-consent opt-out, never identity, project, media, or comment read access. Valid, unknown, malformed, expired-consent, and already-used tokens receive the same generic receipt. The public HTTPS page clears its fragment immediately and posts only after an explicit action, without cookies, storage, bearer headers, third-party assets, or referrers. Static responses have strict CSP and no caching. The anonymous endpoint accepts at most 512 bytes, eight concurrent requests, 20 requests per peer/minute and 120 globally/minute, with at most 256 hashed peer buckets. These per-process limits are not distributed abuse protection.

## Notification delivery boundary

SMTP credentials, recipient addresses, lease capabilities, unsubscribe tokens, and prepared messages remain in the trusted host/worker. The renderer receives validated inbox/preferences state rather than those private delivery objects. Logs and errors contain allowed codes rather than SMTP bodies, credentials, or provider responses. Email contains counts and a currently authorized project name; permission-loss notices omit the former name. Revision messages, comments, clip/media names, and local paths are excluded.

Submission starts with TLS and verifies the server certificate chain and hostname using Node's trust configuration; optional AUTH PLAIN runs only inside that encrypted connection. There is no STARTTLS, plaintext fallback, or configurable verification bypass. See [implicit TLS submission](https://www.rfc-editor.org/rfc/rfc8314.html#section-3.3) and [Node certificate verification](https://nodejs.org/api/tls.html#tlsconnectoptions-callback). Test CAs are scoped to disposable child processes. Configuring mail does not configure account signup, recovery delivery, sender-domain authentication, or a production provider.

The worker prepares current unread/access/consent evidence before sending and again before SMTP DATA, outside the durable transaction lock. It has bounded leases, at most five attempts per job, and stable Message-IDs. An SMTP success accepts responsibility at the submission server; it is not an end-user receipt. If the DATA acknowledgment or durable delivery acknowledgment is lost, the retry may duplicate an accepted message. This follows SMTP's inherent [handoff/duplicate ambiguity](https://www.rfc-editor.org/rfc/rfc5321.html#section-6.1); the outbox does not provide exactly-once email or recall accepted mail. Host shutdown stops and drains its worker before closing state. Process-restart and injected failure tests do not establish machine power-loss durability.

List-Unsubscribe opens a manual HTTPS page with an explicit opt-out action. The sender does not advertise automated [RFC 8058 one-click unsubscribe](https://www.rfc-editor.org/rfc/rfc8058.html#section-3.1). An old capability cannot disable a newer consent epoch. See [host configuration and retry limits](SERVICE_HOST.md#optional-notification-email) and [account update privacy](PROJECT_ACTIVITY.md#account-updates-and-email-preferences).
