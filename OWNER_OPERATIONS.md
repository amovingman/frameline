# Owner recovery, lifecycle and publication privacy

This batch completes three existing roadmap items within the [personal-project scope](PROJECT_SCOPE.md): incident response/backups/service recovery/security disclosure, advanced asset lifecycle controls, and project-data privacy. It uses the installed desktop and local/self-hosted service. It requires no additional users, managed hosting or public release.

## Review before publishing

History's **Push revisions**, **Push observations**, and queued retry actions first open **Review revision upload**. Preparing the review reads local immutable records and queues; it sends no service request. The review names the HTTPS destination, service project and branch, counts records and review bytes, and pages through the complete submitted metadata document. It includes revision messages, source revision IDs and canonical manifests, including represented editor properties and media identities. Other local branches are excluded. Already-shared ancestry may appear to cover idempotent retries; reviewing it does not cause those records to be resent unnecessarily.

The review excludes media file bytes. Session credentials authorize HTTPS requests only to the selected service and are never rendered in the review. Project/media display labels remain project content, so the user can inspect them rather than assuming “metadata” means anonymous data.

Publication requires the explicit approval checkbox and a matching one-use review ID and SHA-256. The main process rechecks current immutable history, account, project/branch, permissions, pending queue payloads and the five-minute review lifetime before enqueueing or sending. Every queued payload must belong to the reviewed set. A restart requires a fresh review; queued work is never silently published. Changed sources, role loss or account replacement refuse old approvals, and scope changes clear rendered JSON and consent.

The media CLI also requires a read-only `inspect` step before `publish`. Its artifact includes the exact canonical manifest, trusted source basenames, unique required identities/byte counts, upload choice, destination, account, branch/head and message. Publication requires its `reviewHash` and rehashes the current source/media before any upload or metadata write. Both metadata-only and media publication require review; upload remains a separate explicit `uploadMedia` choice. See [revision media](PERSONAL_MEDIA.md).

Existing single-file desktop uploads retain their byte/content review and source checks. Media policy starts with no classes enabled, paths stay in trusted local code, canonical transfers reject path-like labels, and diagnostics require their separate explicit export review. No telemetry or new background upload is introduced.

## Complete desktop lifecycle controls

History → **Asset lifecycle** now loads authoritative schema-2 owner reports and reference-aware plans. Details show retained revisions, missing retained assets, holds, archive age, shared content and active verification. Incomplete legacy revision coverage remains a deletion blocker.

Select loaded assets, prepare a collection plan, review every affected content ID and blocker, then explicitly confirm collection. The server rechecks the exact state/plan and owner role. Other projects' backing references are preserved. Byte totals distinguish project payload bytes from uniquely stored payloads; they do not measure encryption overhead or disk space freed.

Before the request, a private schema-2 intent journal records the exact action and retry key. Lost acknowledgments survive a full desktop restart. A matching owner can explicitly retry that original request, receive its historical receipt, and export the verified receipt without needing a fresh report. A completed retry never repeats a logical deletion or replaces later state. Reports, plans and receipts each have reviewed, path-free JSON exports. Schema-1 journals migrate while preserving pending holds and retention requests.

## Backups and owner incident handling

`npm run service:backup --silent` reads private JSON from stdin and supports `backup`, `verify`, `restore` and `record-incident`. Backups cover the encrypted collaboration store and optional encrypted media store together, including identity/access/history, partial uploads, jobs, holds, canonical references, GC work and receipts. Keys, TLS material and configuration remain separate.

The snapshot locks assets before collaboration, validates schema/ciphertext without hydrating the original runtime, and streams copied files with source identity/hash checks. It does not migrate or clean the original. Unknown files and unsafe paths fail closed; cancelled work cleans only owned unchanged staging files. A sealed or uncertain destination is preserved for inspection.

Restoration requires the exact verified backup hash and explicit confirmation, and creates a new private root exclusively. It never overwrites live storage or automatically starts a host, notification delivery, or editor. Historical sessions, permissions and consent are restored as data; this is not credential revocation or rollback protection. Stop the host/workers before a routine backup and review security/outbox state before activating a recovery.

The project owner handles local incidents and records only allowed categories/stages, versions, generic codes and optional backup hashes in private files. There is no operated external disclosure inbox or on-call service in this personal scope. The [incident procedure](INCIDENT_RESPONSE.md) specifies containment, evidence preservation, restoration and any future private external disclosure.

## Evidence and checks

The [desktop observation](phase-0/owner-operations-desktop/verification.json) uses two actual shipped Electron main/preload/renderer processes, fixture-CA HTTPS, small synthetic media, a 50-clip export and a saved synthetic Resolve observation. It verifies real publication in both formats, consent/stale-source/account refusal, retained protection, lost cleanup acknowledgment, full restart recovery and receipt export. Layout captures cover 390, 768 and 1440 pixels.

The [backup HTTPS observation](phase-0/service-backup-https-observation.json) restores into new directories, explicitly starts a fresh host, and verifies old sessions/owner roles, canonical history, exact downloaded media, partial upload resume and retained-reference collection protection. Its source exports and encrypted source stores remain unchanged. This is no editor write, real-user, power-loss or managed disaster-recovery claim.

Run `npm run test:owner-operations` for focused checks and `npm run verify:owner-operations` for the desktop proof. The earlier `verify-asset-lifecycle-desktop.cjs` and adjacent observation record the historical injected schema-1 panel, rather than the current shipped-main workflow.

Validation passed 1,645 full regression tests, the final nine publication/controller/renderer checks, 1,186 security tests, 185 migration checks and three fixture checks, without skips. The universal macOS helper and package archive checks passed; the production-dependency audit reported no vulnerabilities. One parallel security run hit its HTTPS child timeout while packaging and migrations were active; the complete standalone security rerun passed. The [bounded visual review](phase-0/owner-operations-desktop/visual-review.md) records the existing design direction and two inspection rounds.
