# Security model

This model covers the local executable collaboration foundation. It does not claim that a hosted service has been deployed or audited.

A [combined encrypted local service runtime](DURABLE_COLLABORATION_SERVICE.md) persists private identity, permissions, and history together, with cross-state validation and host-supplied keys. A separate encrypted-store process-restart proof verified session, permission, history, and revocation recovery; injected-failure checks cover rollback and uncertain writes. These local results do not establish production durability. An older valid encrypted snapshot can still be replayed; no external rollback protection is provided.

## Trust boundaries

- The Electron renderer is untrusted. A user-entered sign-in password exists briefly in the form and dedicated IPC request; the form clears immediately on submission. The renderer receives display-safe state but never receives stored access/refresh tokens, media paths, or credential-vault methods. Passwords are absent from saved credentials and state/events. See `DESKTOP_SERVICE_SYNC.md` for verified browser/native behavior and unsigned-development-app limits.
- The Electron main process may read user-selected project files and use the operating system protected secret facility through `safeStorage`.
- Project API requests require an authenticated session and a project-scoped authorization decision. A resource ID alone grants no access.
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
| Unauthorized project or asset access | Owner/editor/viewer permissions are checked by the authorized service; revision HTTP routes use that wrapper | Production database enforcement and hosted boundary review |
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
7. A credential or encryption key is never written in plaintext or exposed through preload.
