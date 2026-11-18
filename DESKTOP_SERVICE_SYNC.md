# Desktop service history

The later [Project media panel](DESKTOP_MEDIA_TRANSFERS.md) adds separately confirmed file transfers through the same private connection manager. The history operations described here remain metadata-only.

The History view now connects to an existing HTTPS Frameline service account, discovers authorized projects and branches, and explicitly pushes or fetches saved revision metadata. It uses `src/desktop-service-connection.js` and `src/desktop-revision-sync.js` in the main process. Browser HTTPS workflow, native Electron/OS-vault restart, responsive, full-suite, and packaging checks passed. This milestone does not deploy a service or provision accounts/projects.

## Using an existing service

1. In History → Service history, enter the root HTTPS service URL supplied by the service administrator, account email, and password. URLs cannot include a path, query, fragment, or embedded credentials. The desktop has no HTTP bypass.
2. Select a local FCPXML export and local branch. Save a scan revision before pushing. Choose an accessible service project and one of its existing branches, then choose **Link selected branch**.
3. Use **Check history** to compare the saved local history with the linked service branch. **Push revisions** is available for a ready saved branch that is locally ahead and has editor or owner access. Viewers can fetch history; the server still rechecks authorization on every request.
4. Use **Fetch history** to verify and cache remote revisions and manifests. The fetched-history section shows the fetch time and read-only revision rows. It receives at most the latest 100 revision summaries and displays them in batches of 20. Fetch can record a verified service-scoped shared ancestor; it does not import revisions, move a local branch, pull edits, or apply anything to an editor.

The nearby Local invitations panel remains a local foundation; it does not provision service membership or send invitations. Account creation, project provisioning, password recovery delivery, and production hosting must be supplied separately.

## Connection and credentials

The password is sent only for the sign-in request, and its input is cleared immediately on submission. The connection manager verifies the account and project response before committing the connection. It saves one encrypted vault entry containing the canonical service origin, issued session, and verified account. It does not save the password. Session tokens and vault methods never cross preload into display state or events.

The main-process credential vault requires Electron `safeStorage` encryption. If encryption or credential persistence is unavailable, the app reports a storage error and requires sign-in rather than falling back to plaintext. An expired access token triggers one shared refresh operation; the rotated session must be saved before requests use it. An ambiguous credential-save failure clears the private session and requires sign-in without retrying the old refresh rotation. A server-revoked session also requires sign-in. Network failure preserves the saved connection and permits explicit retry.

Each private authenticated client is bound to its connection generation, service origin, and account. Sign-out or replacement aborts and drains earlier requests and vault writes before credential removal or replacement can finish. Stale clients cannot obtain a later account's token. Sign-out attempts remote session revocation and removes the local vault entry; local removal still proceeds if the service cannot be reached. A failed replacement sign-in preserves the previously saved connection until a verified replacement commits, so the prior connection can be restored on a later launch.

On ordinary app quit, the main process aborts and drains sync/connection work while retaining the vault for startup restoration. Opening the app reads that encrypted entry and rechecks the account/projects; an offline startup preserves it. Public state contains connection status, sanitized origin/account/project summaries, counts, IDs, timestamps, and bounded error codes. It contains no password, session token, media path, or client object.

## Branch mapping, queue, and cache

Linking is an explicit local mapping. Its identity includes the service origin, account ID, local project/branch, and remote project/branch. Queues and fetched caches use that full scope, so changing account, service, project, or destination branch cannot send an older intent to a new destination. The binding file stores a hash of the origin and safe IDs/names/role; credentials remain in the separate encrypted vault. Unlinking removes the mapping without deleting remote revisions.

Push stores a durable exact-input intent and sends only the selected branch's saved revision chain and manifests. Retry uses stable idempotency keys and expected-head compare-and-swap. A concurrent remote update is preserved and requires fetch/reconciliation; this desktop does not implement reconciliation. Queued pushes expose progress, retry, and cancel controls. Cancellation cannot retract a remote write that has already committed. Account or selection changes abort active work and suppress stale results.

Fetched metadata is integrity checked, scoped, and stored locally with a fetch receipt timestamp. Cached rows describe the last successful fetch, not a live view of the service. Neither that cache nor the push queue contains media bytes or credentials. Service branch comparison is reported separately from historical shared-base evidence.

The service stores manifest records within each project while preserving canonical content IDs. Identical saved manifest bytes can be pushed independently to two projects; sharing an ID does not grant access to another project's record. Valid legacy history is migrated to this scoped representation without changing revision IDs or branch heads.

## Shared-base observations

Check, successful Push/Retry, and Fetch can now record a [service-scoped shared base](SERVICE_SHARED_BASES.md) after full saved-local/remote ancestry verification. The service row shows historical local/remote IDs and verification time; History rows and open details label the matching revision **Last shared base** and descendants **After shared base**. Sign-out and binding changes remove the old scope's display. The receipt is separate from legacy unscoped bases, which migration preserves without promotion.

Check/Push proof reads save immutable evidence without advancing the explicit fetched-history display. A lost acknowledgment or failed base save retains prior confirmed evidence and requires explicit Check/Retry repair. Restart checks saved witnesses and original local bytes; ordinary in-session display may reuse a historical validation until the scope/generation/receipt changes. Public state omits proof hashes, origin hashes, private paths, and publisher-only receipt fields. These observations do not verify current source/editor edits, media, or apply readiness.

## Project activity

The linked service project's **Project activity** panel adds explicit refresh of **Inbox** or **All activity**, recipient-owned **Mark read**, and older-page loading with a 500-item display cap. Opening the list does not mark items read. Its opt-in 30-second watch operates only while the app is open, starts off, and resets when the origin/account/local or remote branch scope changes. Access loss clears rows and reports a generic permission change. Read receipts persist on the service; this feature adds no operating-system notification, email, digest, or closed-app delivery. See [project activity](PROJECT_ACTIVITY.md) for durable schema-2 migration, cursor bounds, and the passed HTTPS process proof. This later milestone passed all 690 tests, packaging validation, and [browser/native checks](phase-0/project-activity-desktop-observation.json), including a full native restart with a retained read receipt and watching off.

## Validation and limits

Connection-manager automated checks passed for safe display-state projection, vault restore, single-flight refresh, persistence failures, offline retry, revocation, generation-bound clients, sign-out/replacement races, and shutdown without credential removal. Targeted controller/durable-state and authorization/history migration/backup/retention checks passed, including the same-content/two-project and encrypted legacy-upgrade regressions.

The [recorded live observation](phase-0/desktop-service-sync-live-observation.json) covers real HTTPS sign-in, explicit branch linking, two-revision push/fetch, immediate password clearing, viewer fetch with push disabled, and fetched-row removal on sign-out in the browser. Viewer UI checks preceded the independent manifest-scope correction; the final automated suite rechecks viewer authorization with scoped storage. At widths 1440, 768, and 390, the browser had no horizontal overflow; service buttons were at least 44 pixels tall at the phone width.

Native development Electron on macOS signed in over HTTPS, saved one local revision, pushed it, and fetched it. A full app quit exited successfully. Relaunch restored the account without retyping credentials; reselecting the matching export recovered the branch mapping and fetched cache, and an explicit history check reported matching heads. The vault file remained mode `0600`, its ciphertext hash was unchanged after restoration, and raw password/email/origin were absent from the stored bytes. Final sign-out left no saved service entry. The browser and native fixture projects had the same canonical manifest ID with distinct project-owned records.

The final suite passed all 539 tests with no failures or skips, and packaging validation passed. Test sign-ins were removed, the disposable HTTPS server stopped, the browser tab closed and viewport reset, and the ordinary app relaunched without the test CA override. The test CA was trusted only in test processes; system trust was not changed.

Injected-vault tests establish connection control flow; the native save/restart check is separate OS-backed evidence from this Mac. It used an unsigned development app and does not establish the credential-access policy of a signed/notarized release. Local test certificates do not configure production trust or hosting.

The later shared-base milestone passed all 717 tests, packaging, a 114-request proof across three hosts and three controller processes, and browser row/detail/sign-out/rebinding/viewer checks. The separate [native restart and schema-4-to-5 migration checks](phase-0/service-shared-base-desktop-observation.json) passed, preserving existing project rows and restoring the exact historical base IDs/time with current heads unchecked; the expanded security suite passed 273 tests. See its [recorded scope and limits](SERVICE_SHARED_BASES.md).

Production deployment/regions, service operations, self-service account provisioning and recovery delivery, signed release behavior, revision import/reconciliation, revision-selected media integration, and safe project apply remain open. The earlier [transport proof](REVISION_NETWORK_SYNC.md) and [encrypted service restart proof](DURABLE_COLLABORATION_SERVICE.md) remain useful evidence for their own boundaries.
